// src/flow/extract.js - 非结构化需求提炼 (Task Brief, 双通道) (2026-11-07)
//
// Super-agent 文章 §3.1「主动响应与需求提取」的后半句: 入站过滤只回答"要不要处理",
// 这里回答"要处理的是什么"。群聊/邮件里的任务请求往往夹在寒暄与闲聊里, 原文直接进
// Router 时模型要自己从噪音里捞指令 —— 提炼层把这一步显式化、可观测、可配置。
//
// 双通道与 trigger_policy (flow/policy.js) 同构:
//   程序层 draftTaskBrief (纯函数, 零成本): 指令动词/时限词/指代缺失的确定性启发;
//   语义层 refineTaskBrief (可选 LLM): 提炼目标/请求人/时限/优先级/缺信息, 严格 JSON
//     契约; fail-open —— LLM 不可用/超时/坏 JSON 一律回落程序层草稿
//     (提炼失败绝不能比不提炼更糟, 与 admitSemantic 同一条铁律)。
//
// 注入形态: 命中任务时以 `[需求提炼]` 前缀块拼在原文之前 (先例: delegate_memory_inject
//   的 [全局上下文] 前缀); 非任务消息不加前缀, 关闭时字节不变。
// 观测口径: 简报**元数据**进 EQ task_extracted 事件; 正文与提炼出的 goal 不进事件
//   (与 audit scrubArgs 的"正文折叠"口径一致 —— 事件面只回答"提炼发生了、置信多少")。
//
// 配置 (config/ppx.json → agent.task_extract, 防御式读取, 无配置 = 行为不变):
//   { enabled: false,      // 总开关 (默认关)
//     semantic: false,     // LLM 语义层 (关 = 只走程序层, 零 LLM 成本)
//     timeout_ms: 6000,    // 语义层单次调用超时
//     max_chars: 1200 }    // 送入语义层的正文上限
//
// 设计溯源: docs/PROVENANCE.md#superagent (仅设计思想对照, 本文件源码自研)。

// 防御式归一: 任何脏配置都收敛成安全默认 (enabled=false = 行为不变)
export function normalizeTaskExtract(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const num = (v, dflt, min) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : dflt;
  };
  return {
    enabled: p.enabled === true,
    semantic: p.semantic === true,
    timeout_ms: num(p.timeout_ms, 6000, 1),
    max_chars: num(p.max_chars, 1200, 1),
  };
}

// ---- 程序层: 确定性启发 (纯函数, 零成本) ----

// 指令动词 (中文按子串匹配 —— CJK 无 \b 边界; 英文按词边界)
const VERB_RE = /(帮|帮忙|请|麻烦|劳驾|安排|处理|完成|修复|修好|查一下|查查|搜一下|找一下|写|起草|整理|翻译|总结|汇总|审查|检查|部署|上线|发布|提交|回复|跟进|确认|预订|预定|提醒我|新建|创建|删除|下载|导出|统计|排查|评估|测算|对比|review|fix|deploy|write|draft|check|summar|translate|send|create|update|investigate|prepare)/i;
// 请求式前缀 (提高置信但不单独成任务)
const ASKING_RE = /^(请|麻烦|帮忙|帮我|烦请|恳请|please|kindly|could you|can you)\b/i;
// 时限词 (取首个命中作为 deadline 字段; 覆盖相对词/星期/日期/时刻/英文常用)
const DEADLINE_RE = /(今天|明天|后天|今晚|本周|本周末|本周内|下周一|下周二|下周三|下周四|下周五|月底|年底|[周星期][一二三四五六日天]|EOD|COB|today|tonight|tomorrow|this week|next monday|next friday|end of (?:day|week)|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}[日号]|\d{1,2}[:：]\d{2}(?:之前|前)?|\d{1,2}点(?:之前|前)?)/i;
// 疑问句 (纯提问不是任务 —— 提问应走对话, 不该被包装成"目标")
const QUESTION_RE = /[?？]\s*$/;
// 指代开头且无实义 (缺目标的最常见形态: "这个弄一下" "那个处理下")
const DEICTIC_RE = /^(这个|那个|这事|这件事|它|这个事)/;

function clampConfidence(n) { return Math.max(0, Math.min(0.95, Math.round(n * 100) / 100)); }

/**
 * 程序层任务草稿 (纯函数, 零 LLM 成本)。
 * @returns {{isTask, confidence, goal, deadline, missing: string[], source: "fast"}}
 *   goal 在程序层只给"首句提示" (goalHint 语义, ≤60 字符), 权威目标归语义层;
 *   missing 列出程序层能确定性判定的缺口 (缺指令动词 = 目标不明)。
 */
export function draftTaskBrief(text, { from = "" } = {}) {
  const t = String(text || "").trim();
  if (!t) return { isTask: false, confidence: 0, goal: "", deadline: "", missing: ["正文为空"], source: "fast" };
  const hasVerb = VERB_RE.test(t);
  const dl = DEADLINE_RE.exec(t);
  const deadline = dl ? dl[0] : "";
  const isQuestion = QUESTION_RE.test(t) && !hasVerb;
  const deictic = DEICTIC_RE.test(t) && !hasVerb;

  let conf = 0;
  if (hasVerb) conf += 0.45;
  if (deadline) conf += 0.2;
  if (ASKING_RE.test(t)) conf += 0.15;
  if (t.length >= 12) conf += 0.1;
  if (/\b(?:发给我|发我|给我|for me|to me)\b/i.test(t)) conf += 0.05;
  conf = clampConfidence(conf);

  const missing = [];
  if (!hasVerb) missing.push("目标(未检出指令动词)");
  if (deictic) missing.push("指代对象(‘这个/那个’无先行词)");

  // 纯提问不是任务: 疑问句且无指令动词 → 明确 isTask=false (置信压到 0.3 以下)
  const isTask = !isQuestion && hasVerb && conf >= 0.45;
  const goalHint = t.split(/[。;；\n]/)[0].slice(0, 60);
  return {
    isTask,
    confidence: isQuestion ? Math.min(conf, 0.3) : conf,
    goal: isTask ? goalHint : "",
    deadline: isTask ? deadline : "",
    requestor: String(from || ""),
    // 缺口信号即使非任务也保留 —— "这条消息缺什么"本身就是需要追问的事实
    missing,
    source: "fast",
  };
}

// ---- 语义层: LLM 提炼 (可选, fail-open) ----

// 从 LLM 回复中提取首个 JSON 对象并防御式校验 (坏值一律回落默认, 不抛出)
function parseBriefJSON(reply) {
  const m = /\{[\s\S]*\}/.exec(String(reply || ""));
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const str = (v, cap) => (typeof v === "string" ? v.slice(0, cap) : "");
  const missing = Array.isArray(j.missing)
    ? j.missing.map((x) => String(x).slice(0, 60)).filter(Boolean).slice(0, 5)
    : [];
  const priority = ["low", "normal", "high"].includes(j.priority) ? j.priority : "normal";
  return {
    isTask: j.is_task === true,
    goal: str(j.goal, 200),
    requestor: str(j.requestor, 80),
    deadline: str(j.deadline, 60),
    priority,
    missing,
  };
}

/**
 * 语义层提炼 (可选 LLM, fail-open)。
 * 成功 → {source:"slow"} 的权威简报; 任何失败 → 回落 draft (failOpen 记录原因)。
 */
export async function refineTaskBrief(text, { agent = null, cfg = null, draft = null } = {}) {
  const d = draft || { isTask: false, confidence: 0, goal: "", deadline: "", missing: [], source: "fast" };
  const c = cfg || normalizeTaskExtract(null);
  const llm = agent?.auxLLM || agent?.llm;
  if (!llm || typeof llm.chat !== "function") {
    return { ...d, failOpen: "无 LLM, 回落程序层" };
  }
  try {
    const sys = [
      "你是需求提炼器。从一条(可能带寒暄/闲聊噪音的)消息中提炼任务简报。",
      "只输出一个 JSON 对象, 不要任何解释或代码围栏:",
      '{"is_task": true|false, "goal": "任务目标(≤120字, 不是任务时为空)", "requestor": "请求人(未知留空)", "deadline": "时限原文(无则空)", "priority": "low|normal|high", "missing": ["缺失的关键信息(≤5条, 如截止时间/目标对象/验收标准)"]}',
    ].join("\n");
    const r = await llm.chat(
      [
        { role: "system", content: sys },
        { role: "user", content: `消息: ${String(text || "").slice(0, c.max_chars)}` },
      ],
      { timeoutMs: c.timeout_ms, retryMax: 0 },
    );
    const b = parseBriefJSON(r?.content ?? r);
    if (!b) return { ...d, failOpen: "语义层返回不可解析, 回落程序层" };
    return {
      ...b,
      // 程序层高置信且语义层确认 → 保留程序层分数; 语义层确认任务 → 至少 0.6
      confidence: b.isTask ? Math.max(0.6, d.confidence) : Math.min(d.confidence, 0.3),
      source: "slow",
    };
  } catch (e) {
    return { ...d, failOpen: `语义层失败(${e?.message || e}), 回落程序层` };
  }
}

// 简报 → [需求提炼] 前缀块 (≤400 字符; 空字段省略; 非任务返回空串 = 不注入)
export function formatBriefPrefix(brief) {
  if (!brief?.isTask) return "";
  const parts = [];
  if (brief.goal) parts.push(`目标: ${brief.goal}`);
  if (brief.deadline) parts.push(`时限: ${brief.deadline}`);
  if (brief.requestor) parts.push(`请求人: ${brief.requestor}`);
  if (brief.priority && brief.priority !== "normal") parts.push(`优先级: ${brief.priority}`);
  if (Array.isArray(brief.missing) && brief.missing.length) parts.push(`缺信息: ${brief.missing.join("、")}`);
  parts.push(`置信: ${brief.confidence}(${brief.source === "slow" ? "语义层" : "程序层"}${brief.failOpen ? ",已降级" : ""})`);
  let s = "[需求提炼] " + parts.join(" | ");
  if (s.length > 400) s = s.slice(0, 397) + "…";
  return s;
}

/**
 * 总入口: Trigger → 简报 + 前缀。默认关闭返回 null (调用方零改动)。
 * 观测: tracer 埋点 + EQ task_extracted (仅元数据, 正文/goal 不入事件)。
 * 任何异常由调用方兜底 (base.handleTrigger 已 catch) —— 本函数内部也应尽量自愈。
 */
export async function enrichWithTaskBrief(trigger, agent, sessionKey = null) {
  const cfg = normalizeTaskExtract(agent?.config?.agent?.task_extract);
  if (!cfg.enabled) return null;
  const text = String(trigger?.text || "");
  const draft = draftTaskBrief(text, { from: trigger?.from });
  const brief = cfg.semantic
    ? await refineTaskBrief(text, { agent, cfg, draft })
    : draft;
  try {
    agent?.tracer?.event?.("flow/task-brief", {
      id: trigger?.id, isTask: brief.isTask, confidence: brief.confidence,
      source: brief.source, failOpen: brief.failOpen || null, thread: trigger?.thread || "",
    });
  } catch { /* 观测不阻断 */ }
  try {
    agent?.emitTaskExtracted?.(trigger, brief, sessionKey);
  } catch { /* 观测不阻断 */ }
  return { brief, prefix: formatBriefPrefix(brief) };
}
