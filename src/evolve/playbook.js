// src/evolve/playbook.js - 语境 Playbook 引擎 v1 (P1④)
// 吸收 ACE (ICLR 2026, agentic-context-engineering) 的设计思想:
//   - 语境即 Playbook: 系统提示词 = 静态基底 + 动态 bullets 注入
//   - 增量 delta 合并 (ADD/UPDATE/REMOVE), 非 LLM 确定性应用, 防"整体重写→语境塌缩"
//   - grow-and-refine: 语义去重 + harmful 裁剪
//   - 门禁回滚: 任何进化必须过回归基准才 commit, 否则自动 rollback
// 仅借鉴思想, 源码自研。核心合并/裁剪/门禁纯代码 (可测), LLM 提炼教训走可选 adapter (无 LLM 时跳过)。
// 与 LearningService.refine (失败→经验库) 互补: refine 沉淀经验, playbook 反哺系统提示词 (零 token 成本时为空)。
// ⚠ 接线状态 (2026-09-17 核对): 已由 evolvePlugin 装配为 ctx.provide("playbook"), 但**无内置消费方**
//   —— 没有代码把 playbook bullets 注入 system prompt, 也没有代码在对话后产生 delta 操作。
//   属"引擎就绪、链路未接"; 待接入 (注入 + delta 生成) 才算生效。
import fs from "node:fs";
import path from "node:path";
import { ensureDir, readText, writeText } from "../utils/store.js";

// ---- 词法相似度 (grow-and-refine 用, 零依赖) ----
// 英文/空格分隔 → 词级 Jaccard; 中文等 CJK 连续串 → 字符 bigram Dice (单 token 时退化)。
// 这样"失败后查看审计链" 与 "失败后查看审计链重试" 也能算出高相似度。
export function lexicalSimilarity(a, b) {
  const ta = String(a || "");
  const tb = String(b || "");
  if (!ta || !tb) return 0;
  const tokensA = tokenize(ta);
  const tokensB = tokenize(tb);
  return diceSet(tokensA, tokensB);
}

function tokenize(s) {
  const words = s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // 有词分隔: 用词级
  if (words.length > 1) return words;
  // 无分隔 (中文连续串): 用字符 bigram (含单字符兜底)
  const chars = s.replace(/\s+/g, "").toLowerCase();
  const bigrams = [];
  for (let i = 0; i < chars.length - 1; i++) bigrams.push(chars.slice(i, i + 2));
  if (bigrams.length) return bigrams;
  return chars.split("");
}

function diceSet(A, B) {
  const setA = new Set(A);
  const setB = new Set(B);
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  return (2 * inter) / (setA.size + setB.size);
}

// ---- delta 操作 (确定性合并, 非 LLM) ----
// ops: [{ op:'ADD', kind, content, evidence_ref? } | { op:'UPDATE', id, content, counters? } | { op:'REMOVE', id }]
// 返回 { playbook, applied, rejected: [{op, reason}] }
export function applyDelta(playbook, ops = [], { maxBullets = 200 } = {}) {
  const pb = clonePlaybook(playbook);
  const applied = [];
  const rejected = [];
  for (const op of ops) {
    if (!op || !op.op) { rejected.push({ op, reason: "缺 op 字段" }); continue; }
    if (op.op === "ADD") {
      const content = String(op.content || "").trim();
      if (!content) { rejected.push({ op, reason: "ADD 缺内容" }); continue; }
      // 新增前查重: 与已有 bullet 词法相似 > 0.6 视为重复, 拒收 (grow-and-refine)
      const dup = pb.bullets.find((b) => lexicalSimilarity(b.content, content) > 0.6);
      if (dup) { rejected.push({ op, reason: "重复: " + dup.id }); continue; }
      const id = op.id || ("b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
      const kind = ["strategy", "pitfall", "domain"].includes(op.kind) ? op.kind : "strategy";
      pb.bullets.push({ id, kind, content, counters: { helpful: 0, harmful: 0 }, evidence_ref: op.evidence_ref || null, createdAt: Date.now() });
      applied.push({ op: "ADD", id });
    } else if (op.op === "UPDATE") {
      const b = pb.bullets.find((x) => x.id === op.id);
      if (!b) { rejected.push({ op, reason: "UPDATE 未知 id: " + op.id }); continue; }
      if (op.content && String(op.content).trim() !== b.content) {
        b.content = String(op.content).trim();
        b.updatedAt = Date.now();
      }
      if (op.evidence_ref) b.evidence_ref = op.evidence_ref;
      if (op.counters) {
        b.counters.helpful += Number(op.counters.helpful) || 0;
        b.counters.harmful += Number(op.counters.harmful) || 0;
      }
      applied.push({ op: "UPDATE", id: op.id });
    } else if (op.op === "REMOVE") {
      const i = pb.bullets.findIndex((x) => x.id === op.id);
      if (i < 0) { rejected.push({ op, reason: "REMOVE 未知 id: " + op.id }); continue; }
      pb.bullets.splice(i, 1);
      applied.push({ op: "REMOVE", id: op.id });
    } else {
      rejected.push({ op, reason: "未知 op: " + op.op });
    }
  }
  // 容量保护: 超上限裁剪最弱 (harmful 最高) bullets —— 保留质量高 (harmful-净额小) 的在前
  if (pb.bullets.length > maxBullets) {
    pb.bullets.sort((a, b) => (a.counters.harmful - a.counters.helpful) - (b.counters.harmful - b.counters.helpful));
    pb.bullets = pb.bullets.slice(0, maxBullets);
  }
  return { playbook: pb, applied, rejected };
}

// ---- grow-and-refine: 去重 + 裁剪 ----
// harmful - helpful >= pruneAt 的 bullet 移除 (持续有害的策略自动淘汰)
export function growAndRefine(playbook, { pruneAt = 3 } = {}) {
  const pb = clonePlaybook(playbook);
  const pruned = [];
  const before = pb.bullets.length;
  pb.bullets = pb.bullets.filter((b) => {
    const net = b.counters.harmful - b.counters.helpful;
    if (net >= pruneAt) { pruned.push({ id: b.id, net }); return false; }
    return true;
  });
  return { playbook: pb, pruned, removed: before - pb.bullets.length };
}

// ---- 门禁: 进化必须过回归基准才 commit, 否则 rollback ----
// gate(check: (playbook)=>boolean|Promise<boolean>) — 基准通过返回 true 才落盘
export function createGate(regressionCheck, { onReject = null } = {}) {
  return {
    async commit(store, playbook, ops, meta = {}) {
      const pass = typeof regressionCheck === "function" ? await regressionCheck(playbook) : true;
      if (!pass) {
        // 回滚: 不落盘, 保留原 playbook
        onReject?.(playbook, meta);
        return { committed: false, reason: "回归基准未通过", applied: [] };
      }
      store.save(playbook);
      return { committed: true, applied: ops };
    },
  };
}

// ---- 渲染: bullets -> 注入串 (空时返回空串, 零 token 成本) ----
export function renderBullets(playbook, { maxBullets = 30 } = {}) {
  const bullets = (playbook?.bullets || []).slice(0, maxBullets);
  if (!bullets.length) return "";
  const lines = bullets.map((b, i) => `${i + 1}. [${b.kind}] ${b.content}`);
  return `\n# 经验策略 (Playbook, 基于过往实践)\n${lines.join("\n")}\n`;
}

// ---- 存储 ----
export class PlaybookStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "evolve");
    ensureDir(this.dir);
    this.file = path.join(this.dir, "playbook.json");
    this._playbook = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
        if (d && Array.isArray(d.bullets)) return d;
      }
    } catch {}
    return { base: "", bullets: [], version: 1 };
  }

  get playbook() { return this._playbook; }

  setBase(text) {
    this._playbook.base = String(text || "");
    return this;
  }

  save(pb = this._playbook) {
    this._playbook = pb;
    writeText(this.file, JSON.stringify(pb, null, 2));
    return pb;
  }

  // 便捷: 应用 delta + 门禁
  async apply(ops, { gate = null, maxBullets } = {}) {
    const { playbook: next, applied, rejected } = applyDelta(this._playbook, ops, { maxBullets });
    if (gate) {
      const r = await gate.commit(this, next, ops);
      return { ...r, rejected };
    }
    this.save(next);
    return { committed: true, applied, rejected };
  }
}

function clonePlaybook(pb) {
  return {
    base: pb?.base || "",
    version: pb?.version || 1,
    bullets: (pb?.bullets || []).map((b) => ({
      id: b.id,
      kind: b.kind,
      content: b.content,
      counters: { helpful: b.counters?.helpful || 0, harmful: b.counters?.harmful || 0 },
      evidence_ref: b.evidence_ref || null,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    })),
  };
}

export default PlaybookStore;
