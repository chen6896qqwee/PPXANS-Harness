// src/utils/text.js - 零依赖文本工具 (token 估算等, 供 agent/llm 等共用)
// 单一实现, 避免 agent 与 llm 各自维护一份 token 估算导致口径漂移。

// 估算 token 数: 中文字符约 1 字 ≈ 0.6 token, 1 token ≈ 4 字符; 统一按字符数 /1.6 估。
export function estimateTokens(s) {
  return Math.ceil(String(s || "").length / 1.6);
}

// 按 token 预算截断字符串: 保留头部信息 (供 persona/角色设定等需保留 key 信息的场景),
// 超预算时在尾部标注截断来源与总量。与 estimateTokens 同口径 (字符/1.6)。
export function truncateByTokens(s, budget) {
  const str = String(s || "");
  const maxLen = Math.floor(budget * 1.6);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `\n...[persona 已按预算截断, 共 ${str.length} 字符]...`;
}