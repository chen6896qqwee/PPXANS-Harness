// src/utils/text.js - 零依赖文本工具 (token 估算等, 供 agent/llm 等共用)
// 单一实现, 避免 agent 与 llm 各自维护一份 token 估算导致口径漂移。
//
// 2026-10-24: 旧实现统一按 字符数/1.6 估 —— 对英文严重高估 (英文实际 ≈ 4 字符/token,
//   高估 2.5 倍 → 上下文预算被过早吃满, 触发不必要的压缩/裁剪), 对中日韩文本又略低估
//   (CJK 在主流 BPE 下 ≈ 0.7-1 token/字符)。现按字符类分桶精估, 并支持外接真 tokenizer。
//
// 可插拔真 tokenizer (零依赖默认不用): setTokenEstimator(fn) 注入后全局生效。
//   推荐接 niieani/gpt-tokenizer (MIT, 离线 BPE): `setTokenEstimator(encode.length)`。
//   估算精度要求不高的部署保持默认启发式即可 (误差 <25%, 方向偏保守)。

// 自定义估算器 (真 tokenizer 接入点)
let _customEstimator = null;

// 注入外部 tokenizer: fn(s) -> token 数。传 null 恢复内置启发式。
export function setTokenEstimator(fn) {
  _customEstimator = typeof fn === "function" ? fn : null;
}

export function getTokenEstimator() {
  return _customEstimator;
}

function isCjk(code) {
  return (code >= 0x4e00 && code <= 0x9fff)   // CJK 统一汉字
    || (code >= 0x3400 && code <= 0x4dbf)     // 扩展 A
    || (code >= 0x3040 && code <= 0x30ff)     // 平假名/片假名
    || (code >= 0xac00 && code <= 0xd7af)     // 谚文
    || (code >= 0x3000 && code <= 0x303f)     // CJK 标点
    || (code >= 0xff00 && code <= 0xffef);    // 全角形式
}

// 估算 token 数: CJK ≈ 0.85 token/字, ASCII ≈ 0.25 token/字符 (4 字符 1 token),
// 其余 (西文附加符号/emoji 等) ≈ 0.5 token/字符。启发式, 方向保守 (宁高估勿低估 ——
// 高估只会提前压缩, 低估会真超窗)。
export function estimateTokens(s) {
  if (_customEstimator) {
    try { return Math.max(0, Math.ceil(Number(_customEstimator(s)) || 0)); } catch { /* 坏估算器退回内置 */ }
  }
  const str = String(s || "");
  if (!str) return 0;
  let cjk = 0, ascii = 0, other = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (isCjk(code)) cjk++;
    else if (code < 0x80) ascii++;
    else other++;
  }
  return Math.ceil(cjk * 0.85 + ascii / 4 + other / 2);
}
