// src/llm/embedder.js - 文本向量化 (dense embedding, 零依赖)
// 从 config.embedding 读 OpenAI 兼容端点, 返回 embed 函数供 FactStore.setEmbedder 注入。
// 不配 embedding 时返回 null, 检索自动退化为 BM25 + LLM 查询扩展 (零依赖兜底)。
// config.embedding = { base_url, api_key_env 或 api_key, model, dimensions? }

export function createEmbedder(config = {}) {
  if (!config) return null;

  // ---- local: 本地语义向量 (transformers.js 为**可选依赖**) ----
  // 包未安装/模型拉取失败时, 每次调用返回 null 而不是抛 —— null 是约定的"降级信号",
  // 调用方 (FactStore.querySemantic) 据此回落 BM25。首次调用只尝试加载一次。
  if (String(config.backend || "").toLowerCase() === "local") {
    let modelPromise = null;
    const loadPipe = () => {
      if (!modelPromise) {
        modelPromise = (async () => {
          try {
            const mod = await import("@xenova/transformers");
            return await mod.pipeline("feature-extraction", config.model || "Xenova/multilingual-e5-small");
          } catch {
            return null; // 可选包缺失 → 永久降级 (不再反复尝试)
          }
        })();
      }
      return modelPromise;
    };
    return async function embedLocal(text) {
      try {
        const pipe = await loadPipe();
        if (!pipe) return null;
        const out = await pipe(String(text).slice(0, 8000), { pooling: "mean", normalize: true });
        const arr = Array.from(out?.data || []);
        return arr.length ? arr : null;
      } catch {
        return null;
      }
    };
  }

  if (!config.base_url) return null;
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
// 2026-10-03 开箱即用: 未配置外部 embedding 时回落本地哈希向量化 (零网络零 Key),
//   FactStore 自动获得 dense+BM25 RRF 混合检索; 配置了外部端点则优先外部 (真语义)。
// 2026-10-04 熔断降级: 外部端点连续 2 次失败 (LM Studio 没开/断网) → 本会话切本地,
//   不再每次查询都等 15s 超时 — 死端点不拖慢记忆检索。
import { createLocalEmbedder } from "./local-embedder.js";

export function embedderWithFallback(external, local, { maxFails = 2 } = {}) {
  let fails = 0;
  return async function embed(text) {
    if (external && fails < maxFails) {
      const v = await external(text).catch(() => null);
      if (v) { fails = 0; return v; }
      fails++;
    }
    return local(text);
  };
}

export function embedderFromConfig(config) {
  const local = createLocalEmbedder();
  const external = createEmbedder(config?.embedding || {});
  if (!external) return local;
  return embedderWithFallback(external, local);
}
