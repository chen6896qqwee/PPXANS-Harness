// src/utils/canonical.js - 稳定序列化 (键序无关的 JSON 取值)
//
// 为什么需要 (2026-10-30):
//   重复调用检测 / 失败归因 / 审计去重都靠"参数签名"判等, 而 JSON.stringify 的输出
//   跟随对象的属性插入顺序 —— {a:1,b:2} 与 {b:2,a:1} 是同一组参数, 却给出两个不同签名。
//   后果不是崩溃, 而是**静默漏判**: 模型换个键序重发一模一样的调用, 重复计数器不动,
//   熔断/熔断文案来得比设定晚好几轮, 排障时看日志还以为"每次调用都不一样"。
//
// 口径: 纯函数、零依赖; 键名升序; 深度上限防环; 截断长度按需 (默认不截断)。

const MAX_DEPTH = 12;

function enc(v, depth) {
  if (depth > MAX_DEPTH) return '"[deep]"';
  if (v === null || v === undefined) return "null";
  const t = typeof v;
  if (t === "number") return Number.isFinite(v) ? String(v) : "null";
  if (t === "boolean") return v ? "true" : "false";
  if (t === "string") return JSON.stringify(v);
  if (t === "bigint") return JSON.stringify(String(v));
  if (t === "function" || t === "symbol") return JSON.stringify(String(v));
  if (Array.isArray(v)) return "[" + v.map((x) => enc(x, depth + 1)).join(",") + "]";
  if (t === "object") {
    // 只取自有可枚举键 (与 JSON.stringify 一致), 但按键名升序输出
    const keys = Object.keys(v).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + enc(v[k], depth + 1)).join(",") + "}";
  }
  return JSON.stringify(String(v));
}

/**
 * 稳定序列化: 同一组数据无论键序如何, 输出字节一致。
 * @param {*} value 任意值
 * @param {number} maxLen >0 时截断到该长度 (签名比对常用); 0/缺省 = 不截断
 * @returns {string}
 */
export function stableJson(value, maxLen = 0) {
  let s;
  try {
    s = enc(value, 0);
  } catch {
    // 取值器抛错/代理对象异常: 退化为字面量, 绝不因"算签名"打断主链路
    s = JSON.stringify(String(value));
  }
  const n = Number(maxLen) || 0;
  return n > 0 && s.length > n ? s.slice(0, n) : s;
}
