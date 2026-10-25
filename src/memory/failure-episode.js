// src/memory/failure-episode.js - 故障记忆 (P1⑥)
// 吸收 ReLoop / Vial / Aegis 的"故障即知识"设计:
//   每次失败存结构化 episode (错误类型/根因/修复/置信度), 下次相似故障检索历史辅助诊断, 自愈不再从零推理。
// 与经验库 (Experience, L4) 互补: 经验库是"学到的教训", 本模块是"故障的结构化病历" (可检索、可回放)。
// 纯代码可测, 检索用词法相似 (零依赖), 可升级 embedding。
// ⚠ 接线状态 (2026-09-17 核对): 已由 evolvePlugin 装配为 ctx.provide("failures"), 但**无内置消费方**
//   —— 没有代码在工具失败时写入 episode, 也没有代码在诊断时检索它。属"能力就绪、链路未接"。
//   当前失败沉淀走的是经验库 (Experience) + refine 闭环; 本模块待接入才算生效。
import path from "node:path";
import { ensureDir, mutateJsonCollection, readJson, withFileLock, unionById } from "../utils/store.js";
import { shortId } from "../utils/id.js";
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
    // 构造期只读不写 (仅 import/实例化不得产生磁盘副作用): 损坏时这里返回空数组,
    // 真正的留档发生在写路径的 _mutate 里 (那时才有必要改盘)。
    const d = readJson(this.file, null);
    return Array.isArray(d) ? d : [];
  }

  // 带锁的读-改-写 (2026-10-10 修复 F3): CLI/Web/自愈探针共写同一文件,
  //   旧实现"构造读一次 + 全量重写"会让后写者覆盖对手刚落盘的内容 (病历静默丢失)。
  //   现走 mutateJsonCollection: 取锁 → 锁内重读磁盘 → 与本实例内存态按 id 并集 →
  //   应用 mutate → 原子全量写。写失败 warn 出声但不抛 (内存态保留, 下次补齐)。
  _mutate(fn) {
    const r = mutateJsonCollection(
      this.file,
      () => [],
      (disk) => {
        const merged = fn(disk) || disk;
        // 上限裁剪 (最近优先, 与旧语义一致)
        return merged.length > this.maxEpisodes ? merged.slice(0, this.maxEpisodes) : merged;
      },
      { warnTag: "failure-episode", memory: this._episodes },
    );
    this._episodes = r.data; // 无论成败都对齐内存态 (失败时保留本次改动, 下次写补齐)
    return r;
  }

  // 读前对齐 (2026-10-10): 另一进程/另一实例可能已写盘, 内存快照可能落后。
  //   读操作 (search/list/stats) 前先在锁内重读并并入本实例内存态 ——
  //   保证"另一实例的写入对本实例可见", 也避免检索基于过期快照。
  _reload() {
    try {
      withFileLock(this.file, () => {
        const g = readJson(this.file, null);
        const disk = Array.isArray(g) ? g : [];
        this._episodes = unionById(disk, this._episodes);
      });
    } catch {
      // 锁竞争超时不阻断读 (读操作不写盘, 退化用内存快照即可)
    }
    return this._episodes;
  }

  // 记录一次失败 episode
  // { tool, error, category, rootCause, fix, confidence, traceRef }
  record(ep) {
    const e = {
      id: shortId("fe", 5),
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
    this._mutate((disk) => {
      disk.unshift(e);
      return disk;
    });
    return e;
  }

  // 相似故障检索: 按 错误文本 + 工具名 词法相似度排序, 返回 top N
  search({ tool = null, error = "", limit = 3, minScore = 0.25 } = {}) {
    this._reload(); // 检索前对齐磁盘 (对手进程新写的病历也要能被检索到)
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
    // 命中计数 (元学习): 写回**盘上那一条** (锁内重读后按 id 找), 不是改副本 ——
    //   否则同批命中的计数会随副本丢弃, 且可能抹掉另一进程的病历。
    if (scored.length) {
      const ids = new Set(scored.map((s) => s.id));
      this._mutate((disk) => {
        for (const e of disk) if (ids.has(e.id)) e.hit = (e.hit || 0) + 1;
        return disk;
      });
      for (const s of scored) {
        const orig = this._episodes.find((x) => x.id === s.id);
        if (orig) s.hit = orig.hit;
      }
    }
    return scored;
  }

  // 统计: 按类别分布 / 命中率
  stats() {
    this._reload();
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

  list(limit = 20) { this._reload(); return this._episodes.slice(0, limit); }
  clear() {
    this._mutate(() => []);
  }
}

export default FailureEpisodeStore;
