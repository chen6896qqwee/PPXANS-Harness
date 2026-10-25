// src/llm/local-embedder.js - 本地向量兜底 (2026-10-03, 向量记忆开箱即用)
// 零配置零网络: 字符 n-gram 哈希向量化 (hashing trick, dim 256)。
// 语义边界 (诚实声明): 这不是语义理解 (同义词不相近), 它提供的是
//   模糊词形匹配 / 错别字容忍 / 子词相似度 — 与 BM25 词法匹配互补, 拼成开箱即用的 dense 兜底。
// 配置了外部 embedding (config.embedding) 时优先外部, 本地仅作无配置兜底。
import { createHash } from "node:crypto";

const DIM = 256;

// 分词: CJK 单字 + 双字 (保留语序信息) + 拉丁词元 (小写)
export function tokenize(text) {
  const t = String(text || "").toLowerCase();
  const tokens = [];
  const cjk = t.match(/[\u4e00-\u9fff]/g) || [];
  for (let i = 0; i < cjk.length; i++) {
    tokens.push(cjk[i]);
    if (i + 1 < cjk.length) tokens.push(cjk[i] + cjk[i + 1]);
  }
  for (const w of t.match(/[a-z0-9_]{2,}/g) || []) tokens.push(w);
  return tokens;
}

function tokenIndex(token) {
  return parseInt(createHash("md5").update(token).digest("hex").slice(0, 8), 16) % DIM;
}

// text → L2 归一化向量 (number[256])
export function localEmbed(text) {
  const v = new Array(DIM).fill(0);
  const tokens = tokenize(text);
  if (!tokens.length) return v;
  for (const tk of tokens) v[tokenIndex(tk)] += 1;
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => +(x / norm).toFixed(6));
}

// 与外部 embedder 同构: async (text) => number[]
export function createLocalEmbedder() {
  return async function embed(text) {
    return localEmbed(text);
  };
}
