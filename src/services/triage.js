// src/services/triage.js - 失败归因 (Agent 增强框架第 1 条的最后一环: "对失败归因")
// 框架原文: "对失败归因: 是知识不够、工具不会用、规划错、验证缺失, 还是记忆没复用"
// 本模块把这件事从"人工看日志"变成"从轨迹确定性判定", 零 LLM, 可复现, 可测。
//
// 输入: 一次任务的执行轨迹 (最终回复 + 工具调用序列 + 耗时 + 判分结果)
// 输出: { cause, confidence, evidence[], action } —— action 直接对应"按症状下药"表的处方

export const CAUSE = {
  /** 卡在 LLM 侧: 单次调用悬挂, 任务时限先到 */
  LLM_STALL: "llm_stall",
  /** 卡在规划侧: 重复调用同一工具/参数, 循环不收敛 */
  LOOP: "loop",
  /** 跑满时限但轨迹不足以判定 */
  TIMEOUT_UNKNOWN: "timeout_unknown",
  /** 工具不会用: 参数错/未知工具/被禁用/权限拦截 */
  TOOL_USE: "tool_use",
  /** 规划错: 一直在试但没收敛 (轮次逼近上限且无错误) */
  PLANNING: "planning",
  /** 验证缺失: 工具都成功了、有产出, 但结果不对 —— 没做自检 */
  VERIFICATION: "verification",
  /** 知识不够: 几乎没查就作答 */
  KNOWLEDGE: "knowledge",
  UNKNOWN: "unknown",
};

// 每类根的处方 (对齐框架"按症状下药"表)
const PRESCRIPTION = {
  [CAUSE.LLM_STALL]: "单次 LLM 超时 (provider.timeout_ms) 必须小于任务级时限; 并给工具循环加「心跳超时」",
  [CAUSE.LOOP]: "任务分解 + 验证器 + 重规划; 检查探索熔断阈值是否过松",
  [CAUSE.TIMEOUT_UNKNOWN]: "补全轨迹采集后重跑定位 (当前轨迹不足以归因)",
  [CAUSE.TOOL_USE]: "结构化输出 + 参数校验 + 失败重试 + 沙箱; 优先修该工具的 schema 与示例",
  [CAUSE.PLANNING]: "任务分解 + 验证器 + 重规划 (轮次逼近上限仍未收敛)",
  [CAUSE.VERIFICATION]: "生成 → 验证 → 修正: 给这类任务配确定性校验器, 让 agent 自查后再作答",
  [CAUSE.KNOWLEDGE]: "RAG + 引用核验 + 工具查询 (先查再答, 不要凭记忆作答)",
  [CAUSE.UNKNOWN]: "采集更多轨迹样本后重判",
};

// 工具调用签名 (同工具同参数视为重复)
function sig(c) {
  try {
    return `${c.tool}::${JSON.stringify(c.args || {}).slice(0, 120)}`;
  } catch {
    return String(c.tool);
  }
}

/**
 * 从轨迹归因一次失败
 * @param {object} o
 * @param {string} o.reply        最终回复
 * @param {Array}  o.toolCalls    工具调用序列 [{tool,args,ok,error,durationMs}]
 * @param {number} o.ms           总耗时
 * @param {number} o.budgetMs     任务时限 (默认 90000)
 * @param {number} o.maxRounds    工具循环轮次上限
 * @param {string} o.detail       判分说明
 * @returns {{cause:string, confidence:number, evidence:string[], action:string}}
 */
export function triageFailure({ reply = "", toolCalls = [], ms = 0, budgetMs = 90000, maxRounds = 8, detail = "" } = {}) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const evidence = [];
  const fail = (cause, confidence) => ({ cause, confidence, evidence, action: PRESCRIPTION[cause] });

  const failedCalls = calls.filter((c) => c && c.ok === false);
  const calledTools = new Set(calls.map((c) => c && c.tool).filter(Boolean));

  // ---- 1. 超时族: 跑满时限才被砍 ----
  const timedOut = ms >= budgetMs * 0.98 || /超时|timeout/i.test(String(reply || ""));
  if (timedOut) {
    evidence.push(`耗时 ${ms}ms 已达任务时限 ${budgetMs}ms`);
    // 1a. 重复签名 → 规划不收敛
    const counts = new Map();
    for (const c of calls) {
      const k = sig(c);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const worst = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (worst && worst[1] >= 3) {
      evidence.push(`同一调用重复 ${worst[1]} 次: ${worst[0]}`);
      return fail(CAUSE.LOOP, 0.85);
    }
    // 1b. 工具调用很少 → 时间花在 LLM 侧
    if (calls.length <= 2) {
      evidence.push(`整个任务只发生 ${calls.length} 次工具调用, 时间几乎全在 LLM 往返`);
      return fail(CAUSE.LLM_STALL, 0.7);
    }
    evidence.push(`工具调用 ${calls.length} 次, 无重复签名, 但仍未收敛`);
    return fail(CAUSE.TIMEOUT_UNKNOWN, 0.4);
  }

  // ---- 2. 工具不会用: 有工具返回错误 ----
  if (failedCalls.length) {
    const kinds = new Map();
    for (const c of failedCalls) {
      const e = String(c.error || "");
      const k = /参数错误|应为|必填/.test(e) ? "参数校验被拦"
        : /未知工具|已禁用/.test(e) ? "工具不可用"
        : /策略拦截|权限|审批/.test(e) ? "权限/策略拦截"
        : /超时/.test(e) ? "工具超时"
        : "执行报错";
      kinds.set(k, (kinds.get(k) || 0) + 1);
    }
    for (const [k, n] of kinds) evidence.push(`${k} × ${n} (涉及工具: ${[...new Set(failedCalls.map((c) => c.tool))].slice(0, 3).join(", ")})`);
    return fail(CAUSE.TOOL_USE, 0.9);
  }

  // ---- 3. 规划错: 轮次逼近上限仍未收敛 ----
  if (maxRounds > 0 && calls.length >= Math.max(3, Math.floor(maxRounds * 0.75))) {
    evidence.push(`工具调用 ${calls.length} 次, 逼近轮次上限 ${maxRounds}, 无错误但未收敛`);
    return fail(CAUSE.PLANNING, 0.7);
  }

  // ---- 4. 验证缺失: 该查的都查了、没错、有产出, 但结果不对 ----
  if (calls.length >= 1) {
    evidence.push(`工具调用 ${calls.length} 次且全部成功, 但判分失败 (${detail || "结果不符"})`);
    evidence.push(`涉及工具: ${[...calledTools].join(", ")}`);
    return fail(CAUSE.VERIFICATION, 0.75);
  }

  // ---- 5. 知识不够: 几乎没查就作答 ----
  evidence.push(`工具调用 ${calls.length} 次 —— 基本没查就作答, 判分失败 (${detail || "结果不符"})`);
  return fail(CAUSE.KNOWLEDGE, 0.8);
}

// 汇总一批归因结果 → 按根因分布 (供 self_diagnose / 报告展示)
export function summarizeCauses(triages = []) {
  const byCause = {};
  for (const t of triages) {
    if (!t || !t.cause) continue;
    byCause[t.cause] = (byCause[t.cause] || 0) + 1;
  }
  const top = Object.entries(byCause).sort((a, b) => b[1] - a[1])[0];
  return {
    total: triages.filter((t) => t && t.cause).length,
    byCause,
    dominant: top ? top[0] : null,
    dominantAction: top ? PRESCRIPTION[top[0]] : null,
  };
}
