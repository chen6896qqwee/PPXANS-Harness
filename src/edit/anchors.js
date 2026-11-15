// src/edit/anchors.js - 按内容锚点编辑 (架构优化 ⑩, 2026-11-13): 抄 omp 的 hashline 思路
//
// 问题: 现在的 `apply_patch` 要求模型把**旧内容原样复述**一遍 (SEARCH 块)。两处代价:
//   ① 改一行长代码, 要把那行长代码再吐一遍 —— 输出 token 直接翻倍;
//   ② 模型记错一个空格, SEARCH 匹配不上, 整块作废重来。
// omp 的做法是"按内容哈希锚点改": 读文件时每行带一个短哈希, 编辑时只说"改 a3f2 这行",
//   不重打旧内容; 锚点对不上 = 文件已变 (stale), 立即拒绝而不是改错地方。
//
// 本文件只放**纯函数** (给定文本 → 新文本), 不碰磁盘、不碰权限, 便于离线断言:
//   lineHash(line)                    行内容 → 4 字符锚点 (同内容同锚点, 与行号无关)
//   renderAnchored(text, opts)        渲染带锚点的视图 (`12#a3f2| 原文`)
//   applyAnchorEdits(text, edits)     应用 [{anchor,content}] / [{from,to,content}]
//
// 锚点与行号的区别很重要: 行号会因上方插删而整体漂移, 锚点只认内容 ——
//   这正是"stale edit 被拒绝"的来源, 也是行号编辑最容易改错地方的原因。
const HASH_LEN = 4;
const BASE36 = 36;

// FNV-1a → base36 前 4 位。不追求抗碰撞, 只求"内容变了锚点大概率变", 碰撞由唯一性检查兜底。
export function lineHash(line) {
  const s = String(line ?? "").replace(/\s+$/g, ""); // 尾随空白不算内容差异
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const str = h.toString(BASE36);
  return str.length >= HASH_LEN ? str.slice(0, HASH_LEN) : str.padStart(HASH_LEN, "0");
}

// 行号从 1 开始渲染, 形如: `12#a3f2| const x = 1;`
export function renderAnchored(text, { start = 1, end = null, maxLines = 2000 } = {}) {
  const lines = String(text ?? "").split("\n");
  // 文件以换行结尾时 split 会多出一个空元素 —— 那是行终止符, 不是一行内容, 别渲染成 `N#hash| `
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const from = Math.max(1, Number(start) || 1);
  const to = Math.min(lines.length, Number(end) || lines.length, from + Math.max(1, Number(maxLines) || 2000) - 1);
  const out = [];
  for (let i = from; i <= to; i++) {
    const raw = lines[i - 1] ?? "";
    out.push(`${i}#${lineHash(raw)}| ${raw}`);
  }
  if (to < lines.length) out.push(`…(共 ${lines.length} 行, 只显示 ${from}-${to}; 用 start/end 续读)`);
  return out.join("\n");
}

// 文件里该锚点的所有行号 (1 基)
function findLines(lines, anchor) {
  const hit = [];
  for (let i = 0; i < lines.length; i++) if (lineHash(lines[i]) === anchor) hit.push(i + 1);
  return hit;
}

/**
 * 应用锚点编辑。edits 支持两种形态:
 *   { anchor, content }        替换该行 (content 为空字符串 = 删除该行)
 *   { from, to, content }      替换 from..to 闭区间 (含两端)
 * 全部校验通过才返回新文本; 任一条失败 → { ok:false, errors } 且 text 原样返回 (原子性)。
 */
export function applyAnchorEdits(text, edits) {
  const src = String(text ?? "");
  const lines = src.split("\n");
  const trailingNewline = src.endsWith("\n");
  if (!Array.isArray(edits) || !edits.length) {
    return { ok: false, text: src, applied: [], errors: ["edits 不能为空"] };
  }

  const errors = [];
  const resolved = [];
  edits.forEach((e, idx) => {
    const label = `编辑 #${idx + 1}`;
    if (!e || typeof e !== "object") { errors.push(`${label}: 不是对象`); return; }
    const fromAnchor = e.from || e.anchor;
    const toAnchor = e.to || e.anchor;
    if (!fromAnchor || !toAnchor) { errors.push(`${label}: 缺少 anchor/from/to`); return; }

    const fromHits = findLines(lines, String(fromAnchor));
    if (!fromHits.length) { errors.push(`${label}: 锚点 ${fromAnchor} 未命中 (文件已变化, 请重新读取)`); return; }
    if (fromHits.length > 1) { errors.push(`${label}: 锚点 ${fromAnchor} 命中 ${fromHits.length} 行 (${fromHits.slice(0, 5).join(",")}) — 请改用行号或更长上下文`); return; }

    const toHits = e.to ? findLines(lines, String(toAnchor)) : fromHits;
    if (!toHits.length) { errors.push(`${label}: 锚点 ${toAnchor} 未命中 (文件已变化, 请重新读取)`); return; }
    if (toHits.length > 1) { errors.push(`${label}: 锚点 ${toAnchor} 命中 ${toHits.length} 行 (${toHits.slice(0, 5).join(",")}) — 请改用行号或更长上下文`); return; }

    const start = fromHits[0];
    const end = toHits[0];
    if (end < start) { errors.push(`${label}: 区间反了 (from 在 ${start}, to 在 ${end})`); return; }

    // 允许用 line/endLine 直接指定行号 (锚点仍是主路径, 行号只作歧义兜底)
    resolved.push({ idx, start, end, content: e.content == null ? "" : String(e.content) });
  });

  // 区间不得重叠 (重叠 = 模型算错了, 硬改会悄悄吃掉内容)
  const sorted = [...resolved].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= sorted[i - 1].end) {
      errors.push(`编辑 #${sorted[i - 1].idx + 1} 与 #${sorted[i].idx + 1} 区间重叠 (${sorted[i - 1].start}-${sorted[i - 1].end} / ${sorted[i].start}-${sorted[i].end})`);
    }
  }

  if (errors.length) return { ok: false, text: src, applied: [], errors };

  // 从后往前替换, 前面的行号才不会失效
  const out = [...lines];
  for (const r of sorted.slice().sort((a, b) => b.start - a.start)) {
    const insert = r.content === "" ? [] : r.content.split("\n");
    out.splice(r.start - 1, r.end - r.start + 1, ...insert);
  }
  let next = out.join("\n");
  if (trailingNewline && !next.endsWith("\n")) next += "\n";
  if (!trailingNewline && next.endsWith("\n")) next = next.slice(0, -1);
  return {
    ok: true,
    text: next,
    applied: sorted.map((r) => ({ index: r.idx + 1, from: r.start, to: r.end, lines: r.content === "" ? 0 : r.content.split("\n").length })),
    errors: [],
  };
}
