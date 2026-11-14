// src/memory/contradiction.js - 事实冲突检测 (2026-11-13, 评测 P2-2)
//
// 病根: facts.json 里同时存在「never 模式下 run_command 会被拒绝」与「并非必然被拒」
//   两条 importance=10 的 active 事实 (旧结论没有失效), 检索会把两条都可能注入。
//   写入侧需要一次保守的冲突检测: 只在高文本相似 + 同一工具/主体 + 极性相反时报警,
//   绝不因为一个"不"字就自动删除记忆 (误删用户事实比留下矛盾更糟)。
//
// 纯函数、零依赖、确定性。不调用 LLM。
const NEG = /(不会|不能|不可|不是|并非|拒绝|禁止|失效|无效|失败|不再|尚未|没有|无需|不用|不要)/g;
const POS = /(会|可以|能|允许|成功|有效|仍然|已经|需要|必须|总是|必然)/g;
const CORRECTION = /(更正|纠正|此前|之前|曾经|不再|并非|不是|已变更|已失效|实测|验证|推翻)/;

function asciiIds(s) {
  return new Set((String(s || "").match(/[a-z_][a-z0-9_.-]{2,}/gi) || []).map((x) => x.toLowerCase()));
}

function cjkBigrams(s) {
  const out = [];
  for (const run of String(s || "").match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) { out.push(run); continue; }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

function tokenSet(s) {
  return new Set([...asciiIds(s), ...cjkBigrams(s)]);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function polarity(s) {
  const t = String(s || "");
  const neg = (t.match(NEG) || []).length + (t.match(/并非必然/g) || []).length;
  const pos = (t.match(POS) || []).length;
  return pos - neg;
}

// 返回 { conflict, similarity, sharedIds, correction, polarity: [newScore, oldScore] }
export function detectContradiction(newText, oldText) {
  const a = String(newText || "").trim();
  const b = String(oldText || "").trim();
  if (!a || !b) return { conflict: false, similarity: 0, sharedIds: [], correction: false, polarity: [0, 0] };
  const idsA = asciiIds(a);
  const idsB = asciiIds(b);
  const sharedIds = [...idsA].filter((x) => idsB.has(x));
  const similarity = jaccard(tokenSet(a), tokenSet(b));
  const pa = polarity(a);
  const pb = polarity(b);
  const correction = CORRECTION.test(a);
  const opposite = (pa > 0 && pb < 0) || (pa < 0 && pb > 0);
  // 判据: 必须有共同主体 (工具名/英文标识) 或较高文本相似度; 且要么极性相反,
  //   要么新文本明确是"更正/此前/并非"的修正句。
  const related = sharedIds.length > 0 || similarity >= 0.55;
  const generic = new Set(["never", "should", "will", "test", "code", "true", "false"]);
  const strongShared = sharedIds.filter((x) => x.length >= 4 && !generic.has(x));
  // 修正句通常比旧结论长 (带"此前/实测/并非"解释), Jaccard 会被稀释;
  //   只要共享同一工具/主体, 且明确是更正语气, 就按冲突处理 —— 是否取代由 tier 判定。
  const correctionHit = correction && strongShared.length > 0;
  const conflict = related && (opposite || (correction && similarity >= 0.5) || correctionHit);

  return {
    conflict,
    similarity: Math.round(similarity * 1000) / 1000,
    sharedIds: sharedIds.slice(0, 8),
    correction,
    polarity: [pa, pb],
  };
}

export default { detectContradiction };
