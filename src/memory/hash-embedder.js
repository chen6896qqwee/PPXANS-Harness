// src/memory/hash-embedder.js - 内置零依赖语义 embedder (2026-10-24)
// 特征哈希 (feature hashing) 字符 n-gram → 定长稀疏向量。确定性、零模型、零网络。
// 定位: querySemantic 的"默认兜底通道" —— 此前不配云端 embedding 时语义检索整个关闭,
//   记忆系统只剩 BM25 关键词匹配 (同义改写/跨语言全靠字面命中)。内置哈希向量:
//   · 抓得住子词/词形变化 (running≈runs, 用户名大小写) 与 CJK 字面近义
//   · 抓不住真正语义 ("汽车" vs "轿车" 零分) —— 需要 strong 语义时配 config.embedding 云端
//     端点或 backend:"local" (transformers.js), 本模块自动让位
// 维度 256, L2 归一化, FNV-1a 双哈希定桶定符号 (碰撞期望均匀)。

const DIM = 256;

function fnv1a(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// 分词: 拉丁词 (≥2 字符) + CJK 单字与二字组。纯标点/空白丢弃。
function tokenize(text) {
  const s = String(text || "").toLowerCase();
  const tokens = [];
  const latin = s.match(/[a-z0-9][a-z0-9._-]*/g) || [];
  for (const w of latin) tokens.push(w);
  const cjkChars = [];
  for (const ch of s) {
    const code = ch.codePointAt(0);
    const isCjk = (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
    if (isCjk) cjkChars.push(ch);
  }
  for (let i = 0; i < cjkChars.length; i++) {
    tokens.push(cjkChars[i]);
    if (i + 1 < cjkChars.length) tokens.push(cjkChars[i] + cjkChars[i + 1]);
  }
  return tokens;
}

// text -> number[256] (L2 归一化)。role 参数保留 (与云端非对称 embedder 同签名, 此处无差异)。
export function hashEmbed(text, role = "query") {
  const tokens = tokenize(text);
  const vec = new Array(DIM).fill(0);
  if (!tokens.length) return vec;
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  for (const [t, c] of counts) {
    const h1 = fnv1a(t);
    const h2 = fnv1a(t, 0x9dc5811c);
    const idx = h1 % DIM;
    const sign = (h2 & 1) === 1 ? 1 : -1;
    // 亚线性词频加权 (1+log tf), 长文本不因重复词淹没主体
    vec[idx] += sign * (1 + Math.log(c));
  }
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm);
  if (!norm) return vec;
  for (let i = 0; i < DIM; i++) vec[i] /= norm;
  return vec;
}

// embedder 身份指纹 (向量落盘缓存的失效键)
export const HASH_EMBEDDER_ID = "builtin-hash-256-v1";

export default hashEmbed;
