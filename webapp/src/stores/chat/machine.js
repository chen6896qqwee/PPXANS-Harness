// webapp/src/stores/chat/machine.js - 一轮对话的阶段机 (纯函数, 可单测)
//
// 为什么单独拎出来:
//   界面上的「思考中 / 正在写回答 / 运行 bash / 等待你的批准」原先散在 chat.js 的 15 处
//   直接赋值里, 谁都能改, 谁都可能忘了收口 —— 表现就是"停了但状态条还在转"。
//   这里只做两件事: ① 阶段文案只有一份; ② 记录哪些跳变是合法的, 非法跳变留痕。
//   它是纯函数: 不 import vue / 不碰 DOM / 不发请求, 所以能在 node --test 里直接跑。
//
// 注意: 这里不存状态。状态仍然在 chat.phase 上 (组件读它), 本模块只提供判定与文案,
//   这样拆分不会改变任何既有行为。

/** 阶段文案常量 (与历史上写死在代码里的字符串逐字一致, 避免改动波及 UI) */
export const PHASE = {
  idle: "",
  thinking: "思考中",
  writing: "正在写回答",
  approval: "等待你的批准",
  answer: "等待你的回答",
};

/** 「运行 <工具名>」是唯一带参数的阶段 */
export function toolPhase(name) {
  return "运行 " + (name || "工具");
}

/** 把文案归类成语义状态; 未知文案归 other (老代码/后端新增文案不该报错) */
export function phaseKind(p) {
  if (!p) return "idle";
  if (p === PHASE.thinking) return "thinking";
  if (p === PHASE.writing) return "writing";
  if (p === PHASE.approval) return "approval";
  if (p === PHASE.answer) return "answer";
  if (String(p).startsWith("运行 ")) return "tool";
  return "other";
}

/**
 * 合法转移表 (from → 允许的 to)。
 * 只拦"物理上不该发生"的跳变, 不做严格有限状态机 —— 严格化会把现有分支改坏。
 * 真正要防的两条: 空闲态凭空进入 writing / tool (说明有回合没收口)。
 */
const ALLOWED = {
  idle: ["idle", "thinking", "approval", "answer"],
  thinking: ["idle", "thinking", "writing", "tool", "approval", "answer"],
  writing: ["idle", "thinking", "writing", "tool", "approval", "answer"],
  tool: ["idle", "thinking", "writing", "tool", "approval", "answer"],
  approval: ["idle", "thinking", "writing", "tool", "approval", "answer"],
  answer: ["idle", "thinking", "writing", "tool", "approval", "answer"],
  other: ["idle", "thinking", "writing", "tool", "approval", "answer", "other"],
};

/**
 * 判定一次跳变是否合法。
 * @returns {{ok:boolean, from:string, to:string, reason?:string}}
 */
export function checkTransition(fromText, toText) {
  const from = phaseKind(fromText);
  const to = phaseKind(toText);
  const allow = ALLOWED[from] || ALLOWED.other;
  if (allow.includes(to)) return { ok: true, from, to };
  return { ok: false, from, to, reason: from + " → " + to };
}

/** 该阶段是否代表"一轮正在进行" (供 UI / 自检使用) */
export function isBusyPhase(p) {
  return phaseKind(p) !== "idle";
}
