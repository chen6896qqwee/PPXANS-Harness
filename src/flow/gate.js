// src/flow/gate.js - 元认知门控 (行动前一阶不确定性观测) (2026-11-15, 默认关闭)
//
// 定位: 不新增动作、不阻断、不重试 —— 在 planIngress 决策之后、执行之前, 用一次轻量
//   LLM 调用给这条 Assignment 打上 {confidence, rationale, suggested_action} 观测字段。
//   审计链从此不只记录"做了什么", 还记录"当时有多确信"。
//   改道决策 (2026-11-16): 本模块**不自行改道**; 但导出的纯函数 decideReroute 是消费方
//   的统一决策位 (规则三), 由 channels/base.js 在显式开启 reroute_enabled 时问它。
//   门控与执行严格分离: gate 只出观测, 谁消费、怎么消费在 base。
//
// 约束:
//   · 只对 async/sync 生效 —— thread 直通契约不变, ans 自触发不观测 (自己的内部消息
//     没有用户在等, 观测价值为零);
//   · 默认关闭: config.agent.metacognition_gate.enabled !== true 时返回 null, 调用方
//     字节不变 (无 LLM 调用、无元数据写入);
//   · fail-open: 门控自身任何故障 (超时/解析失败/模型缺席) 都降级为 {skipped: 原因}
//     写进字段, 绝不影响消息处理主链路。
//
// 设计溯源: MARTA 式"行动前掂量不确定性"的最小工程形态 —— 一次结构化 LLM 调用,
// 不引入第二个评分器 (防讨好评分者, 与 audit/verifier.js 同一哲学)。

const GATE_TIMEOUT_MS = 3500; // 门控是观测不是闸门, 超时从严 (同步路径上多等 3.5s 是上限)
const SUGGESTED_ACTIONS = new Set(["proceed", "clarify", "retrieve"]);

// 从模型回复里抠 JSON (与 learning-service 同策略: 剥代码围栏 + 花括号截取)
function parseGateReply(text) {
  const raw = String(text || "").trim().replace(/```(?:json|JSON)?\s*/g, "").replace(/```/g, "").trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * 行动前一阶置信度观测。
 * @param {object} opts
 * @param {object} opts.agent   提供 config / llm
 * @param {object} opts.plan    planIngress 的 plan (用 action 与 ticket.origin)
 * @param {object} opts.trigger 归一后的 Trigger (用 text)
 * @returns {Promise<object|null>} null = 门控未启用 (调用方零成本); 否则观测对象
 */
export async function metacognitionGate({ agent = null, plan = null, trigger = null, timeoutMs = GATE_TIMEOUT_MS } = {}) {
  const cfg = agent?.config?.agent?.metacognition_gate;
  if (!cfg || cfg.enabled !== true) return null; // 默认关闭: 调用方字节不变
  const llm = agent?.llm;
  if (!llm || typeof llm.chat !== "function") return { skipped: "llm_unavailable" };
  if (!plan || (plan.action !== "async" && plan.action !== "sync")) return { skipped: "route_not_gated" };
  if (plan.ticket?.origin === "ans") return { skipped: "ans_self_triggered" };
  const text = String(trigger?.text || "").trim();
  if (!text) return { skipped: "empty_text" };

  const threshold = Number(cfg.threshold) > 0 ? Number(cfg.threshold) : 0.5;
  try {
    const r = await llm.chat([
      { role: "system", content:
        "你是执行前的自我置信度评估器。对下面这条即将执行的任务, 只输出 JSON: "
        + '{"confidence": 0到1的小数, "rationale": "一句话理由", "suggested_action": "proceed|clarify|retrieve"}。'
        + " confidence=你对「不加额外信息也能把这件事做对」的确信度; 任务含糊/缺关键上下文/高风险不可逆时降低置信度; "
        + " suggested_action: proceed=直接做, clarify=应先向用户澄清, retrieve=应先检索/收集信息。不要解释, 只输出 JSON。" },
      { role: "user", content: text.slice(0, 1200) },
    ], { timeoutMs, retryMax: 0 });
    const parsed = parseGateReply(r?.content);
    const confidence = Number(parsed?.confidence);
    const action = SUGGESTED_ACTIONS.has(String(parsed?.suggested_action)) ? String(parsed.suggested_action) : "proceed";
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { skipped: "bad_model_output", raw: String(parsed?.confidence || "").slice(0, 40) };
    }
    return {
      confidence: Math.round(confidence * 1000) / 1000,
      rationale: String(parsed?.rationale || "").slice(0, 200),
      suggested_action: action,
      threshold,
      lowConfidence: confidence < threshold, // 标记位; 是否真改道由 decideReroute 决定
      gatedAt: new Date().toISOString(),
    };
  } catch (e) {
    return { skipped: "gate_failed", reason: String(e?.message || e).slice(0, 120) };
  }
}

// ---- 规则三: 低置信真改道 (2026-11-16) ----
// 前两条规则 (双路透传 / 重复低置信升级) 只把观测送出去, 系统照旧执行 —— 观测不改变
//   行为, 那"知道自己不确定"就只剩仪表盘意义。本函数是这条链的**决策位**: 纯函数,
//   不调 LLM、不写状态, 只回答"这次观测该不该改道"。
//
// 刻意保守的三个门槛 (任一不满足就照旧执行):
//   ① 配置显式开启 (reroute_enabled === true) —— 默认关闭, 关闭时调用方字节不变;
//   ② 模型自己给的 suggested_action 必须是 clarify —— 它说"该直接做/该去检索"时不越权
//      替它改成提问 (retrieve 要接检索执行面, 不在本函数射程内);
//   ③ confidence 必须严格低于 threshold —— lowConfidence 字段是同一判据的派生量, 这里
//      重算而不信任上游字段, 防调用方传入过期/伪造的标记把正常任务打成提问。
//
// @returns {null | {kind:"clarify", reason, confidence, threshold}}
export function decideReroute(metacog, cfg = {}) {
  if (!cfg || cfg.reroute_enabled !== true) return null;
  if (!metacog || metacog.skipped) return null;
  const conf = Number(metacog.confidence);
  if (!Number.isFinite(conf)) return null;
  const threshold = Number(cfg.threshold) > 0
    ? Number(cfg.threshold)
    : (Number(metacog.threshold) > 0 ? Number(metacog.threshold) : 0.5);
  if (conf >= threshold) return null;
  if (String(metacog.suggested_action || "") !== "clarify") return null;
  return {
    kind: "clarify",
    reason: String(metacog.rationale || "").slice(0, 200) || "执行前置信度低于阈值",
    confidence: conf,
    threshold,
  };
}

// 改道后的提问文案: 零 LLM, 把模型自己给的理由摊给来源方 —— 比"请补充信息"这种空话
//   有用得多: 用户能看懂它卡在哪一条上, 补的东西才对得上。文案跟随项目既有中文口径。
export function clarifyText(metacog, decision) {
  const r = String(decision?.reason || "").trim();
  const conf = Number.isFinite(Number(decision?.confidence)) ? Number(decision.confidence).toFixed(2) : "?";
  const th = Number.isFinite(Number(decision?.threshold)) ? Number(decision.threshold).toFixed(2) : "?";
  return [
    `[需要澄清] 这条任务我把握不足 (置信 ${conf} < 阈值 ${th}), 先不执行, 免得做错方向。`,
    r ? `我的顾虑: ${r}` : null,
    "请补充关键信息或确认理解无误, 我会立刻接着做。",
  ].filter(Boolean).join("\n");
}
