// src/core/selfcheck.js - 最终回答自检 (确定性, 零 LLM 成本)
//
// 背景 (2026-10-09): 项目里"输入侧"闸门齐备 (记忆写回有 Auditor.gate, 工具错误有 selfReviewError),
// 但【用户直接看到的那段回答】全程没有任何检查 —— grep critic|selfCheck|verifyReply = 0 命中。
// 于是内部错误原文 (`ERR_HTTP_HEADERS_SENT` / 栈帧 / `[object Object]`)、未渲染的工具调用信封
// (DSML / ⟪tool⟫ 残留)、纯 JSON 日志都能直接漏给用户。
//
// 本模块做确定性自检 (不调 LLM, 不增加成本与延迟), 输出结构化报告, 供 chat() 记录/告警/净化。
import { isInternalErrorText, messageOf } from "../utils/public-error.js";

export const SELFCHECK_CODES = {
  EMPTY: "empty",                 // 空回复
  INTERNAL_LEAK: "internal_leak", // 内部实现细节外泄 (错误对象/栈帧/ERR_*)
  TOOL_ENVELOPE: "tool_envelope", // 未渲染的工具调用信封残留
  JSON_DUMP: "json_dump",         // 回复就是一段裸 JSON (多半是工具输出未加工)
};

// 未渲染的工具调用信封: DSML / 围栏 / 各家标记
const ENVELOPE_RE = /⟪\s*tool\s*⟫|<\/?(?:tool_call|tool_use|function_call)\b|<\|tool|invoke\s+name\s*=|antml:invoke/i;
// 栈帧 / 错误对象序列化残留
const STACK_RE = /\[object\s+Object\]|^\s*at\s+\S+\s+\(.*:\d+:\d+\)|\bERR_[A-Z_]+\b|UnhandledPromiseRejection/i;

/**
 * 对最终回答做确定性自检。
 * @param {unknown} reply 待发用户的回答
 * @param {{usedTools?: boolean}} [ctx]
 * @returns {{ok: boolean, issues: Array<{code:string, detail:string}>}}
 */
export function selfCheckReply(reply, ctx = {}) {
  const issues = [];
  const s = messageOf(reply);
  const t = s.trim();

  if (!t) {
    issues.push({ code: SELFCHECK_CODES.EMPTY, detail: "回答为空" });
    return { ok: false, issues };
  }
  if (isInternalErrorText(t) || STACK_RE.test(t)) {
    issues.push({ code: SELFCHECK_CODES.INTERNAL_LEAK, detail: "回答包含内部错误原文/栈帧, 不应外泄" });
  }
  if (ENVELOPE_RE.test(t)) {
    issues.push({ code: SELFCHECK_CODES.TOOL_ENVELOPE, detail: "回答残留未渲染的工具调用信封" });
  }
  // 纯 JSON 且没有一句自然语言 (去掉 JSON 后基本为空) → 多半是工具输出直接透传
  const stripped = t.replace(/```[\s\S]*?```/g, "").trim();
  if (stripped.startsWith("{") && stripped.endsWith("}")) {
    try {
      JSON.parse(stripped);
      issues.push({ code: SELFCHECK_CODES.JSON_DUMP, detail: "回答是一段裸 JSON, 缺少给用户的说明" });
    } catch { /* 不是合法 JSON: 只是从花括号开头, 不判问题 */ }
  }
  return { ok: issues.length === 0, issues };
}

/**
 * 对"内部错误外泄"这一类做净化: 用统一人话替换掉内部细节。
 * 其余类型只报告不擅自改写 (避免替模型说谎)。
 */
export function sanitizeReply(reply, report) {
  const s = messageOf(reply);
  const codes = new Set((report?.issues || []).map((i) => i.code));
  if (!codes.has(SELFCHECK_CODES.INTERNAL_LEAK)) return s;
  return s
    .split("\n")
    .filter((line) => !STACK_RE.test(line) && !isInternalErrorText(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim() || "[皮皮虾] 上一轮回复包含内部错误信息, 已屏蔽。请重试或查看服务端日志。";
}
