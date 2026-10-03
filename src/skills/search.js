// src/skills/search.js - 技能检索与高置信匹配 (蓝皮书 2026: 发现机制是技能生态的瓶颈)
// 1) scoreSkills: name 命中加权 3 > description 命中 1, 按分数降序, 无交叠不返回
// 2) matchSkill: 高置信阈值 —— 单 bigram 噪音不触发 (需 >= 2 次命中), 并列同分不押注 (返回 null)
// tokenize: 英文/数字取整词, CJK 取 2-gram (与 memory/fact-store 的粗召回口径一致)
export function tokenize(text) {
  const s = String(text || "").toLowerCase();
  const out = new Set();
  const re = /[a-z0-9_]+|[\u4e00-\u9fff]+/g;
  for (const m of s.matchAll(re)) {
    const t = m[0];
    if (/^[a-z0-9_]+$/.test(t)) {
      out.add(t);
      continue;
    }
    if (t.length === 1) {
      out.add(t);
      continue;
    }
    for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  }
  return out;
}

function overlap(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

// 对全部技能打分并降序返回 (score > 0 才有条目)
export function scoreSkills(loader, query, { nameWeight = 3, descWeight = 1 } = {}) {
  const q = tokenize(query);
  if (!q.size) return [];
  const skills = typeof loader?.list === "function" ? loader.list() : [];
  const ranked = [];
  for (const s of skills) {
    const nHits = overlap(q, tokenize(s.name || s.id));
    const dHits = overlap(q, tokenize(s.description || ""));
    const score = nHits * nameWeight + dHits * descWeight;
    if (score <= 0) continue;
    ranked.push({ ...s, score, hits: nHits + dHits, nameHits: nHits, descHits: dHits });
  }
  // 稳定排序: 分数降序 → 原始顺序 (list 已按 id 排序)
  return ranked
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.score - a.r.score || a.i - b.i)
    .map((x) => x.r);
}

// 高置信单技能匹配: 命中不足以形成信号时返回 null, 并列歧义也不押注
export function matchSkill(loader, query, { minHits = 2 } = {}) {
  const ranked = scoreSkills(loader, query);
  if (!ranked.length) return null;
  const top = ranked[0];
  if (top.hits < minHits) return null;
  if (ranked[1] && ranked[1].score === top.score) return null; // 并列 → 不押注
  return top;
}
