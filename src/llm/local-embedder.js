// src/llm/local-embedder.js - 本地向量模型适配器 (可选依赖, 零强制)
//
// 定位: 让向量记忆**真内嵌** —— 不配云端 API 也能本地跑 dense 语义检索 (离线可用)。
// 依赖 transformers.js (@huggingface/transformers, ONNX Runtime Web/Node):
//   - 这是**可选 peer 依赖**: 动态 import, 包未安装时返回 null, 上层自动降级
//     (云端 embedding API → BM25), 主包依旧零运行时依赖。
//   - 安装: npm i @huggingface/transformers (首次用某模型时自动从 HF Hub 下载权重并缓存)
//
// 推荐模型 (config.embedding.model 可换):
//   Xenova/multilingual-e5-small  384 维, 多语言含中文, ~130MB  (默认, 中文场景稳)
//   Xenova/all-MiniLM-L6-v2       384 维, 英文为主,   ~25MB   (轻量英文)
//
// config.embedding = { backend: "local", model?, batch?, prefix_query?, prefix_passage? }
import { warn, debug } from "../utils/logger.js";

// 模块级单例: pipeline 加载一次复用 (模型加载秒级, 不能每条记忆都加载)
let _pipelinePromise = null;
let _loadedModel = null;

async function _getPipeline(model) {
  if (_pipelinePromise && _loadedModel === model) return _pipelinePromise;
  _loadedModel = model;
  _pipelinePromise = (async () => {
    // 依次尝试新旧包名 (v1-v2 为 @xenova/transformers, v3+ 迁移到 @huggingface/transformers)
    let mod = null;
    for (const pkg of ["@huggingface/transformers", "@xenova/transformers"]) {
      try { mod = await import(pkg); break; } catch (e) { debug(`[local-embedder] ${pkg} 不可用: ${e.message}`); }
    }
    if (!mod) return null;
    return mod.pipeline("feature-extraction", model);
  })();
  return _pipelinePromise;
}

// 检测本地后端是否可用 (包已安装即视为可用; 模型懒加载到首次 embed)
export async function localEmbedderAvailable() {
  for (const pkg of ["@huggingface/transformers", "@xenova/transformers"]) {
    try { await import(pkg); return true; } catch { /* 试下一个 */ }
  }
  return false;
}

// 创建本地 embedder: text -> number[] | null (失败返回 null 触发上层降级)
export function createLocalEmbedder(config = {}) {
  const model = String(config.model || "Xenova/multilingual-e5-small");
  // e5 系列模型要求输入带前缀 ("query: " / "passage: ") 才有最佳检索效果
  const isE5 = /e5/i.test(model);
  const pq = config.prefix_query ?? (isE5 ? "query: " : "");
  const pp = config.prefix_passage ?? (isE5 ? "passage: " : "");
  const embedTexts = async (texts, prefix) => {
    const pipe = await _getPipeline(model);
    if (!pipe) return null; // 包未安装 → 降级信号
    const out = [];
    for (const t of texts) {
      try {
        const r = await pipe(prefix + String(t).slice(0, 4000), { pooling: "mean", normalize: true });
        out.push(Array.from(r.data));
      } catch (e) {
        warn(`[local-embedder] 单条向量化失败(降级为 null): ${e.message}`);
        out.push(null);
      }
    }
    return out;
  };

  return async function embed(text, role = "query") {
    // role 决定前缀 (2026-10-04 修复): e5 是**非对称**检索模型, query 和 passage 必须分别加
    //   "query: " / "passage: "。旧实现单条入口一律用 pq, 而 FactStore.querySemantic 既用它编
    //   查询也用它编事实正文 —— 于是所有事实都被当成查询, e5 的检索精度直接掉下来
    //   (曾经的批量入口固定用 pp, 与单条入口口径互相不一致; 因无任何调用者, 已随本次清理移除)。
    //   云端 embedder 忽略第二个参数 (OpenAI 兼容端点无前后缀概念), 上层无需分支。
    const prefix = role === "passage" ? pp : pq;
    const [v] = (await embedTexts([text], prefix)) || [null];
    return v && v.length ? v : null;
  };
}
