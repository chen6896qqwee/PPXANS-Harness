// src/memory/fact-store.js - 记忆存储 (高斯衰减遗忘)
// 架构参考 openhanako: 每条记忆有 importance, 高斯衰减, 命中加分
import path from "node:path";
import { ensureDir, readJson, writeJson, nowISO, logicalDay } from "./store.js";

export class FactStore {
  constructor(dataDir, opts = {}) {
    this.dir = path.join(dataDir, "memory");
    ensureDir(this.dir);
    this.file = path.join(this.dir, "facts.json");
    this.opts = {
      decayPerDay: 0.02,   // lambda
      hitBonus: 5,
      baseImportance: 10,
      forgetSpeed: 1.0,
      ...opts,
    };
    this.facts = readJson(this.file, []);
    this.save();
  }

  save() {
    writeJson(this.file, this.facts);
  }

  // 高斯衰减: score = score * exp(-lambda * t^2), t = days since last access
  _decay(score, days) {
    if (days <= 0) return score;
    const lambda = this.opts.decayPerDay * this.opts.forgetSpeed;
    return score * Math.exp(-lambda * days * days);
  }

  _nowDays() {
    return Date.now() / 86400000;
  }

  add(content, { importance = this.opts.baseImportance, type = "general", source = "manual" } = {}) {
    const now = nowISO();
    const fact = {
      id: cryptoRandomId(),
      content,
      type,
      source,
      importance,
      score: importance,
      created: now,
      lastAccess: now,
      hits: 0,
    };
    this.facts.push(fact);
    this.save();
    return fact;
  }

  // 检索: 简单关键词 + 衰减分排序
  query(q, { limit = 5, minScore = 1 } = {}) {
    const nowD = this._nowDays();
    const ql = q.toLowerCase();
    const scored = [];
    for (const f of this.facts) {
      const days = Math.max(0, nowD - new Date(f.lastAccess).getTime() / 86400000);
      let score = this._decay(f.score, days);
      // 关键词相关加成
      if (ql && f.content.toLowerCase().includes(ql)) score += 10;
      if (score >= minScore) scored.push({ ...f, effectiveScore: score });
    }
    scored.sort((a, b) => b.effectiveScore - a.effectiveScore);
    return scored.slice(0, limit);
  }

  hit(id) {
    const f = this.facts.find((x) => x.id === id);
    if (!f) return;
    f.hits += 1;
    f.lastAccess = nowISO();
    f.score += this.opts.hitBonus;
    this.save();
  }

  addMemory(message) {
    // 从对话中提取记忆: 简单启发式, 过滤掉问候/无信息量
    const STOP = ["你好", "在吗", "谢谢", "好的", "嗯", "ok", "哈喽", "hello", "hi", "再见", "拜拜"];
    const clean = (message || "").trim();
    if (!clean || clean.length < 4) return null;
    const lower = clean.toLowerCase();
    if (STOP.some((s) => lower === s.toLowerCase())) return null;
    return this.add(clean, { source: "conversation" });
  }

  list() {
    return [...this.facts].sort((a, b) => b.score - a.score);
  }

  count() {
    return this.facts.length;
  }
}

function cryptoRandomId() {
  return "f_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
