// src/memory/failure-episode.js - 故障记忆 (P1⑥)
// 吸收 ReLoop / Vial / Aegis 的"故障即知识"设计:
//   每次失败存结构化 episode (错误类型/根因/修复/置信度), 下次相似故障检索历史辅助诊断, 自愈不再从零推理。
// 与经验库 (Experience, L4) 互补: 经验库是"学到的教训", 本模块是"故障的结构化病历" (可检索、可回放)。
// 纯代码可测, 检索用词法相似 (零依赖), 可升级 embedding。
// ⚠ 接线状态 (2026-09-17 核对): 已由 evolvePlugin 装配为 ctx.provide("failures"), 但**无内置消费方**
//   —— 没有代码在工具失败时写入 episode, 也没有代码在诊断时检索它。属"能力就绪、链路未接"。
//   当前失败沉淀走的是经验库 (Experience) + refine 闭环; 本模块待接入才算生效。
import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeText } from "../utils/store.js";
import { lexicalSimilarity } from "../evolve/playbook.js";

export const FAILURE_CATEGORY = ["throttle", "network", "validation", "auth", "unknown"];

export class FailureEpisodeStore {
  constructor(dataDir, { maxEpisodes = 500 } = {}) {
    this.dir = path.join(dataDir, "memory", "failures");
    ensureDir(this.dir);
    this.file = path.join(this.dir, "episodes.json");
    this.maxEpisodes = maxEpisodes;
    this._episodes = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
        if (Array.isArray(d)) return d;
      }
    } catch {}
    return [];
  }

  _save() {
    writeText(this.file, JSON.stringify(this._episodes, null, 2));
  }

  // 记录一次失败 episode
  // { tool, error, category, rootCause, fix, confidence, traceRef }
  record(ep) {
    const e = {
      id: "fe" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      tool: ep.tool || "unknown",
      error: String(ep.error || "").slice(0, 500),
      category: FAILURE_CATEGORY.includes(ep.category) ? ep.category : "unknown",
      rootCause: String(ep.rootCause || "").slice(0, 500) || null,
      fix: String(ep.fix || "").slice(0, 500) || null,
      confidence: Number(ep.confidence) || 0,
      traceRef: ep.traceRef || null,   // 事件日志引用 (trace.js 行号/seq)
      hit: 0,                          // 被检索命中次数 (元学习信号)
      ts: Date.now(),
    };
    this._episodes.unshift(e);
    if (this._episodes.length > this.maxEpisodes) this._episodes = this._episodes.slice(0, this.maxEpisodes);
    this._save();
    return e;
  }

  // 相似故障检索: 按 错误文本 + 工具名 词法相似度排序, 返回 top N
  search({ tool = null, error = "", limit = 3, minScore = 0.25 } = {}) {
    const q = String(error || "");
    const scored = this._episodes
      .map((e) => {
        let score = 0;
        if (q) score = Math.max(score, lexicalSimilarity(e.error, q));
        if (tool && e.tool === tool) score = Math.max(score, 0.5); // 同工具强信号
        if (e.rootCause && q) score = Math.max(score, lexicalSimilarity(e.rootCause, q) * 0.8);
        return { ...e, score };
      })
      .filter((e) => e.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    // 命中计数 (元学习): 写回原 episode, 不只是副本
    for (const s of scored) {
      const orig = this._episodes.find((x) => x.id === s.id);
      if (orig) { orig.hit++; s.hit = orig.hit; }
    }
    if (scored.length) this._save();
    return scored;
  }

  // 统计: 按类别分布 / 命中率
  stats() {
    const byCat = {};
    for (const e of this._episodes) byCat[e.category] = (byCat[e.category] || 0) + 1;
    const withFix = this._episodes.filter((e) => e.fix).length;
    const totalHit = this._episodes.reduce((a, e) => a + e.hit, 0);
    return {
      total: this._episodes.length,
      byCategory: byCat,
      withFix: withFix,
      fixRate: this._episodes.length ? (withFix / this._episodes.length * 100).toFixed(1) + "%" : "0%",
      totalHits: totalHit,
    };
  }

  list(limit = 20) { return this._episodes.slice(0, limit); }
  clear() { this._episodes = []; this._save(); }
}

export default FailureEpisodeStore;
