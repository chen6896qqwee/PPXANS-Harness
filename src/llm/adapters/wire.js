// src/llm/adapters/wire.js - 协议适配器共用的内部 wire 工具
// 三个适配器 (completions / responses / anthropic) 共享同一套 usage 归一与多模态解析语义,
// 放在这里避免各自复制一份。仅被 adapters/ 内部使用, 不属于对外协议面。

// 把内部 usage 形态统一成 OpenAI 形状 {prompt_tokens, completion_tokens, total_tokens}
export function normUsage(u) {
  if (!u || typeof u !== "object") return null;
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(u.total_tokens ?? (prompt + completion)) || (prompt + completion),
    ...(u.cost != null ? { cost: u.cost } : {}),
  };
}

// data URL / http URL -> {kind:"base64", media_type, data} | {kind:"url", url} | null
export function parseImageSource(url) {
  const s = String(url || "");
  const m = s.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
  if (m) {
    if (m[2]) return { kind: "base64", media_type: m[1] || "image/png", data: m[3] };
    return null; // data: 非 base64 (如 url-encoded) 不支持, 调用方跳过
  }
  if (/^https?:\/\//i.test(s)) return { kind: "url", url: s };
  return null;
}

export function safeJsonParse(s, fallback = {}) {
  try { return JSON.parse(s); } catch { return fallback; /* swallowed-ok(2026-11-03): 解析契约就是返回 fallback */ }
}
