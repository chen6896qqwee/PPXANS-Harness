// src/utils/public-error.js - 对外错误文案的【唯一真相源】
//
// 背景 (2026-10-09): 同一个项目里存在两套错误口径——
//   · provider 降级路径 (agent/index.js _shortReason) 会把错误转人话
//   · 硬失败路径 (core/policy.js LLM_FAILED_HINT) 把 ${e.message} 原样拼给用户
// 于是用户可能看到 "ERR_HTTP_HEADERS_SENT" / "EPIPE" / 一整坨原始 JSON 这类不该外泄的内容。
// 本模块把"判定 + 转译"收敛到一处, 两条路径共用, 防止再次漂移。

// 命中即视为【内部实现细节】, 一律不原文外泄, 统一转人话
const AUTH_RE = /40[13]|unauthor|api.?key|authentication|invalid_request_error/i;
const RATE_RE = /429|rate.?limit|too many requests|quota|insufficient/i;
const TIMEOUT_RE = /timeout|timed out|abort|ETIMEDOUT/i;
const CONN_RE = /ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|socket hang up|EAI_AGAIN|EPIPE/i;
const SERVER_RE = /\b50[0-9]\b/i;
const CONTEXT_RE = /context\s*(length|size|window)?\s*(exceed|overflow|too\s*long)|maximum\s*context|too\s*many\s*tokens|token\s*(limit|budget)|insufficient\s*context|超出.{0,4}(上下文|窗口)|上下文.{0,4}(超|溢出)/i;
const INTERNAL_RE = /ERR_[A-Z_]+|Cannot read propert|is not a function|is not defined|\[object Object\]|at\s+\S+\s+\(/i;

/**
 * 把任意错误值安全地取成字符串。
 * 注意: 不能写 String(e.message || e) —— 当 e.message === undefined 时结果会是 "[object Object]"。
 */
export function messageOf(e) {
  if (e == null) return "";
  if (typeof e === "string") return e;
  if (typeof e === "number" || typeof e === "boolean") return String(e);
  if (typeof e.message === "string" && e.message) return e.message;
  if (typeof e.code === "string" && e.code) return e.code;
  if (typeof e.reason === "string" && e.reason) return e.reason;
  try {
    const s = JSON.stringify(e);
    // "{}" / undefined 等无信息量的序列化结果 → 回空串, 交给 explainError 出通用文案,
    // 避免把 "[object Object]" 这种噪音漏给用户
    if (s && s !== "{}" && s !== "null") return s;
  } catch { /* 循环引用等 → 回空串 */ }
  return "";
}

// 字面量噪音: "undefined" / "null" / "NaN" / "[object Object]" 之类不应作为用户可见原因
const NOISE_RE = /^(undefined|null|NaN|\[object\s+Object\]|false|true|\?+)$/i;

/**
 * 错误 → 面向用户的短句 (不泄露内部实现细节)。
 * @param {unknown} err 错误对象或字符串
 * @returns {string} 人话短句
 */
export function explainError(err) {
  const s = messageOf(err);
  if (!s || NOISE_RE.test(s.trim())) return "调用失败 (原因未知)";
  if (AUTH_RE.test(s)) return "鉴权失败 (key 无效或已过期)";
  if (RATE_RE.test(s)) return "限流或额度不足";
  if (TIMEOUT_RE.test(s)) return "请求超时";
  if (CONN_RE.test(s)) return "连接失败 (模型服务未启动或网络不通)";
  if (SERVER_RE.test(s)) return "模型服务端错误";
  // 上下文超长: 属于用户可理解且可自救的情况 (缩短对话 / 清空会话 / 调大 context_window),
  // 必须给明确指引, 不能被下面的通用兜底吃掉。
  if (CONTEXT_RE.test(s)) return "本轮对话超出模型上下文窗口 (可清空会话、缩短输入, 或调大 memory.context_window)";
  // 未命中已知模式: 去掉可能的 JSON 尾巴与换行, 截短后再判断一次是否属于内部细节
  let brief = s.replace(/\{[\s\S]*$/, "").replace(/\s+/g, " ").trim();
  // "LLM HTTP 400:" 这类只剩前缀的残句对用户无意义 → 归一成可读文案
  const httpOnly = brief.match(/^(?:LLM\s+)?HTTP\s*(\d{3})\s*:?$/i);
  if (httpOnly) return `模型返回错误 (HTTP ${httpOnly[1]})`;
  brief = brief.replace(/[:：,，\s]+$/, "").trim();
  if (!brief || brief.length < 4 || INTERNAL_RE.test(brief)) return "调用失败 (内部错误, 详情见服务端日志)";
  return brief.slice(0, 80);
}

/**
 * 判断一段文本是否属于"不该给用户看的内部错误原文"。
 * 供 HTTP 层 / CLI 层复用, 统一出口。
 */
export function isInternalErrorText(text) {
  return INTERNAL_RE.test(messageOf(text));
}

/**
 * LLM 调用失败的完整兜底提示 (含排查指引)。
 * 用 explainError 摘要, 不再拼原始 message。
 */
export function llmFailedHint(err) {
  return `[皮皮虾] LLM 调用失败: ${explainError(err)}
排查指引: 1) 检查 config/ppx.json 的 providers 是否配置了可用的 API key (export XXX_API_KEY=...); 2) 本地模型 (lmstudio) 是否在运行; 3) 启动 ppx-serve 看日志确认模型加载。`;
}
