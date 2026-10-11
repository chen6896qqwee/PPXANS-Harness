// src/utils/text.js - 零依赖文本工具 (token 估算等, 供 agent/llm 等共用)
// 单一实现, 避免 agent 与 llm 各自维护一份 token 估算导致口径漂移。

// 估算 token 数: 中文字符约 1 字 ≈ 0.6 token, 1 token ≈ 4 字符; 统一按字符数 /1.6 估。
export function estimateTokens(s) {
  return Math.ceil(String(s || "").length / 1.6);
}