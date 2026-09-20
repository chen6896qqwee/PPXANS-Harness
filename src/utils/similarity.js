// src/utils/similarity.js - 中文文本相似度的公共基元 (唯一实现, 2026-09-18 重构收敛)
// 背景: "字符级 bigram + 交集" 的相似度思路在 fact-store / experience / eviction 三处各写一份,
//       集合运算 (交集大小 / Jaccard / overlap) 完全重复。这里只收敛「集合级运算 + 字符 bigram 分词」,
//       各模块保留自己的分词策略与阈值 (fact-store 用 scope 感知的 _bigramSet, 语义不同, 不强行合并)。
// 零依赖, 纯函数。

// 字符级 bigram: 去空白 + 按码点取相邻两字符 (对中文简繁/词序变化有容错)
// 与 experience/_bigrams、eviction/_bigramSet 原实现一致 (Array.from 按码点切分, astral 字符不劈半)
export function charBigrams(s) {
  const chars = Array.from(String(s ?? "").replace(/\s+/g, ""));
  const out = new Set();
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
  return out;
}

// 集合交集大小
export function intersectSize(A, B) {
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter;
}

// Jaccard 系数: 交集 / 并集 (0~1)
export function setJaccard(A, B) {
  if (!A.size || !B.size) return 0;
  const union = A.size + B.size - intersectSize(A, B);
  return union ? intersectSize(A, B) / union : 0;
}

// overlap 系数: 交集 / 较短集合 (0~1) —— 对"共享核心词但词序/措辞大变"比 Jaccard 更敏感
export function setOverlap(A, B) {
  if (!A.size || !B.size) return 0;
  return intersectSize(A, B) / Math.min(A.size, B.size);
}

// 文本级便捷封装 (字符 bigram)
export function overlapCoefficient(a, b) {
  return setOverlap(charBigrams(a), charBigrams(b));
}

export function jaccardCoefficient(a, b) {
  return setJaccard(charBigrams(a), charBigrams(b));
}
