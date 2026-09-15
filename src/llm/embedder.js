// src/llm/embedder.js - 文本向量化 (dense embedding, 零依赖)
// 从 config.embedding 读 OpenAI 兼容端点, 返回 embed 函数供 FactStore.setEmbedder 注入。
// 不配 embedding 时返回 null, 检索自动退化为 BM25 + LLM 查询扩展 (零依赖兜底)。
// config.embedding = { base_url, api_key_env 或 api_key, model, dimensions? }

export function createEmbedder(config = {}) {
  if (!config || !config.base_url) return null;
  const apiKey = config.api_key || process.env[config.api_key_env] || "";
  if (!apiKey) return null;
  const base = String(config.base_url).replace(/\/$/, "");
  const model = config.model || "text-embedding-3-small";

  // 嵌入函数: text -> number[] (null 表示失败, 触发调用方回退)
  return async function embed(text) {
    try {
      const r = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: String(text).slice(0, 8000) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return null;
      const j = await r.json();
      const v = j?.data?.[0]?.embedding;
      return Array.isArray(v) && v.length ? v : null;
    } catch {
      return null;
    }
  };
}

// 从已加载的 config 创建 embedder (供 agent 启动注入)
export function embedderFromConfig(config) {
  return createEmbedder(config?.embedding || {});
}
