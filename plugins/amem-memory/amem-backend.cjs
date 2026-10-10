// plugins/amem-memory/amem-backend.js — A-Mem 式记忆后端示范插件 (2026-10-09)
//
// 论文锚点: A-Mem: Agentic Memory for LLM Agents (NeurIPS 2025, arXiv 2502.12110)。
//   核心机制: 记忆以卡片 (note) 组织, 新卡片入库时自动与旧卡建立链接 (Zettelkasten),
//   并触发被链接邻居卡片的"记忆演化" (context 注记更新)。
//
// 皮皮虾映射 (轻内核路线图第七节): 这是 config.memory.backend 插槽的**首个真实消费方**。
//   实现 = extends 内置 MemoryTicker (委托复用 recordTurn/_compileDaily//stats 全部管线),
//   只 override 两个点:
//     ① _appendLongterm: 长期记忆归档的每一段蒸馏内容, 同步吸收为记忆卡 (关键词抽取 +
//        Jaccard 链接 + 邻居演化), 落 dataDir/memory/amem-notes.json;
//     ② context(userMsg): 原有热窗口输出之后, 追加"关联记忆卡"段 (查询词匹配 + 1-hop 链接游走)。
//   零依赖: 关键词/链接用启发式 (CJK 2-gram + 词频), 不调用 LLM —— A-Mem 原文的 LLM 卡片
//   生成留作 trait 接口落地后的增强位。
// 诚实边界: extends 依赖 MemoryTicker 的 _appendLongterm 内部钩子, 与当前内核实现耦合;
//   待缺口 2 第②步 (MemoryStore trait) 落地后, 本插件改为面向接口实现, 这正是插槽化
//   分步路线的验证样本。
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { MemoryTicker } = require("../../src/memory/index.js");

const STOP = new Set(["的", "了", "是", "在", "我", "有", "和", "就", "不", "人", "都", "一个", "我们", "你们", "他们", "这", "那", "也", "到", "要", "会", "着", "没有", "the", "a", "an", "of", "to", "in", "is", "are", "and", "or", "for", "on", "it", "this", "that", "with", "as", "be", "was"]);

function extractKeywords(text, topN = 6) {
  const freq = Object.create(null);
  const latin = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [];
  for (const w of latin) if (!STOP.has(w)) freq[w] = (freq[w] || 0) + 1;
  const cjkRuns = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of cjkRuns) {
    if (run.length <= 4 && !STOP.has(run)) freq[run] = (freq[run] || 0) + 2; // 短语整词加权
    for (let i = 0; i + 2 <= run.length; i++) {
      const g = run.slice(i, i + 2);
      if (!STOP.has(g)) freq[g] = (freq[g] || 0) + 1;
    }
  }
  return Object.keys(freq).sort((a, b) => freq[b] - freq[a]).slice(0, topN);
}

function jaccard(a, b) {
  const sa = new Set(a), sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter || 1);
}

class AmemMemory extends MemoryTicker {
  constructor(services) {
    super(services.dataDir, services.facts, null, services.sessions);
    this.amemFile = path.join(this.dir, "amem-notes.json");
    this.amem = { notes: [], seq: 0 };
    try { this.amem = JSON.parse(fs.readFileSync(this.amemFile, "utf8")) || this.amem; } catch { /* 首次无档 */ }
  }

  _saveAmem() {
    try { fs.writeFileSync(this.amemFile, JSON.stringify(this.amem, null, 1), "utf8"); } catch { /* 存储失败不阻断记忆主链路 */ }
  }

  // ① 长期归档同步吸收为记忆卡 (A-Mem note construction + link generation + evolution)
  _appendLongterm(chunk) {
    super._appendLongterm(chunk);
    try {
      const lines = String(chunk).split("\n").map((l) => l.replace(/^-\s*/, "").trim())
        .filter((l) => l && !l.startsWith("#") && l.length >= 8 && l.length <= 300);
      for (const text of lines.slice(0, 10)) { // 单日蒸馏上限 10 卡, 防爆炸
        this._amemAddCard(text);
      }
      if (lines.length) this._saveAmem();
    } catch { /* 吸收失败不影响归档主链路 */ }
  }

  _amemAddCard(text) {
    const kw = extractKeywords(text);
    if (!kw.length) return;
    const id = `n${++this.amem.seq}`;
    const links = [];
    for (const n of this.amem.notes) {
      const sim = jaccard(kw, n.keywords);
      if (sim >= 0.12) links.push({ id: n.id, sim: +sim.toFixed(2) });
    }
    links.sort((a, b) => b.sim - a.sim);
    const topLinks = links.slice(0, 3); // Zettelkasten 链接受限防全连通
    this.amem.notes.push({ id, text, keywords: kw, links: topLinks, context: "", created: new Date().toISOString(), evolved: 0 });
    // 邻居演化: 被链接的旧卡记一笔 (A-Mem memory evolution 的轻量版)
    for (const l of topLinks) {
      const n = this.amem.notes.find((x) => x.id === l.id);
      if (n && n.evolved < 3) {
        n.context = `${n.context ? n.context + " " : ""}[${id} 关联]`;
        n.evolved++;
      }
    }
  }

  _amemRetrieve(userMsg, limit = 3) {
    const qkw = extractKeywords(String(userMsg || ""), 10);
    if (!qkw.length || !this.amem.notes.length) return [];
    const scored = this.amem.notes
      .map((n) => {
        let inter = 0;
        for (const k of n.keywords) if (qkw.includes(k)) inter++;
        // 双口径: Jaccard (对称) 与卡覆盖度 (查询命中卡关键词比例, 短查询不因查询长而稀释)
        const s = Math.max(jaccard(qkw, n.keywords), inter / (n.keywords.length || 1));
        return { n, s };
      })
      .filter((x) => x.s > 0.08)
      .sort((a, b) => b.s - a.s);
    const picked = [];
    const seen = new Set();
    for (const { n, s } of scored) {
      if (picked.length >= limit) break;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      picked.push({ n, s });
      for (const l of n.links) { // 1-hop 链接游走 (A-Mem 检索的链接扩展)
        const m = this.amem.notes.find((x) => x.id === l.id && !seen.has(x.id));
        if (m && picked.length < limit) { seen.add(m.id); picked.push({ n: m, s: l.sim }); }
      }
    }
    return picked;
  }

  // ② 热窗口之后追加"关联记忆卡"段
  context(userMsg) {
    const base = super.context(userMsg);
    try {
      const hits = this._amemRetrieve(userMsg);
      if (!hits.length) return base;
      const seg = hits.map(({ n, s }) => `- [${s.toFixed(2)}] ${n.text}${n.context ? ` (${n.context.trim()})` : ""}`).join("\n");
      return `${base}\n## 关联记忆卡 (A-Mem)\n${seg}\n`;
    } catch { return base; }
  }

  stats() {
    const s = super.stats();
    s.amem = { cards: this.amem.notes.length, linked: this.amem.notes.filter((n) => n.links.length).length, evolved: this.amem.notes.reduce((a, n) => a + n.evolved, 0) };
    return s;
  }
}

// 插件入口: 只注册插槽工厂, 不抢默认实现 —— config.memory.backend="amem" 才会启用。
// 工厂签名见 src/plugin/builtin.js applyMemoryBackend 契约 ({dataDir, facts, sessions, userName})。
module.exports = function amemMemoryPlugin(ctx) {
  ctx.provide("memoryBackend:amem", (svc) => new AmemMemory(svc));
};
module.exports.AmemMemory = AmemMemory;
