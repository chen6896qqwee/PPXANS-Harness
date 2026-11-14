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
      if (!STOP_TOKENS.has(t)) out.add(t);
      continue;
    }
    if (t.length === 1) {
      out.add(t);
      continue;
    }
    for (let i = 0; i + 1 < t.length; i++) {
      const bg = t.slice(i, i + 2);
      if (!STOP_TOKENS.has(bg)) out.add(bg);
    }
  }
  return out;
}

// CJK 功能词 bigram 停用表 (2026-11-03): 中文 2-gram 会产生大量跨词噪音 ——
// "帮我/这个/没有/需要" 这类功能词在 67 个技能描述里 df 高达 11/9, 与任意领域词
// 偶然重叠就能把无关技能顶成"高置信命中" (实测: "检查当前身体有没有需要优化的地方"
// → office/pdf; 真实库同款问题: "帮我记住这个偏好" → business/business-analysis)。
// 这些词不携带领域信息, 打分前剔除; 领域词 (检查/优化/文档/表格/报告) 一律保留。
const STOP_TOKENS = new Set([
  "帮我", "我想", "我要", "你能", "可以", "需要", "什么", "怎么", "如何", "这个", "那个",
  "这些", "那些", "一个", "一下", "现在", "然后", "就是", "不是", "还是", "有没", "没有",
  "我们", "你们", "他们", "自己", "因为", "所以", "但是", "如果", "时候", "地方", "这样",
  "那样", "进行", "使用", "相关", "以及", "的话",
  "the", "and", "for", "with", "this", "that", "you", "your", "how", "what", "from",
  "into", "when", "then", "will", "can",
]);

function overlap(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

// 分词缓存 (2026-11-03 热路径): L2 漏斗每轮对全部技能打分, 同一份 name/description 会被
// 反复 tokenize (67 个技能 × 2 字段 ≈ 0.3ms/轮)。字符串是不可变值, 按 id 缓存并在
// name/description 逐字相等时复用; 内容变更会自然失配重算。上限兜底防长跑进程无界增长。
const TOKENS = new Map(); // id -> { name, desc, nameTokens, descTokens }
const TOKENS_MAX = 512;
function tokensOf(s) {
  const id = String(s.id || "");
  const name = String(s.name || s.id || "");
  const desc = String(s.description || "");
  const hit = TOKENS.get(id);
  if (hit && hit.name === name && hit.desc === desc) return hit;
  const ent = { name, desc, nameTokens: tokenize(name), descTokens: tokenize(desc) };
  if (TOKENS.size >= TOKENS_MAX && !TOKENS.has(id)) TOKENS.clear();
  TOKENS.set(id, ent);
  return ent;
}

// 对全部技能打分并降序返回 (score > 0 才有条目)
export function scoreSkills(loader, query, { nameWeight = 3, descWeight = 1 } = {}) {
  const q = tokenize(query);
  if (!q.size) return [];
  const skills = typeof loader?.list === "function" ? loader.list() : [];
  const ranked = [];
  for (const s of skills) {
    const { nameTokens, descTokens } = tokensOf(s);
    const nHits = overlap(q, nameTokens);
    const dHits = overlap(q, descTokens);
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
