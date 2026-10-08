// src/memory/failure-episode.js - 故障记忆 (P1⑥)
// 吸收 ReLoop / Vial / Aegis 的"故障即知识"设计:
//   每次失败存结构化 episode (错误类型/根因/修复/置信度), 下次相似故障检索历史辅助诊断, 自愈不再从零推理。
// 与经验库 (Experience, L4) 互补: 经验库是"学到的教训", 本模块是"故障的结构化病历" (可检索、可回放)。
// 纯代码可测, 检索用词法相似 (零依赖), 可升级 embedding。
// ✅ 接线状态 (2026-10-03 已接入): agent/_runTool 在工具失败时 record() 写入病历,
//   并在返回前 search() 检索历史同类故障, 把"已知根因/修法"附在错误结果后供模型参考
//   (闭环: 失败 → 病历 → 下次同类失败直接带出历史结论, 不必从零推理)。
import path from "node:path";
import fs from "node:fs";
import { ensureDir, readJsonGuarded, writeJson, withFileLock } from "../utils/store.js";
import { warn } from "../utils/logger.js";
import { shortId } from "../utils/id.js";
import { lexicalSimilarity } from "../evolve/playbook.js";

export const FAILURE_CATEGORY = ["throttle", "network", "validation", "auth", "unknown"];

// 按错误文本归类 (零依赖词法判据, 与 FAILURE_CATEGORY 一一对应)
// 顺序即优先级: 限流/网络属瞬态, 鉴权/参数属确定性错误, 二者处置方式完全不同
export function classifyFailure(text) {
  const s = String(text || "").toLowerCase();
  if (/429|rate.?limit|too many requests|限流|频率超限/.test(s)) return "throttle";
  if (/econn|etimedout|eai_again|enotfound|socket hang up|network|timeout|超时|连接失败|网络/.test(s)) return "network";
  if (/401|403|unauthor|forbidden|invalid.?(api.?)?key|鉴权|未授权|无权限|权限不足/.test(s)) return "auth";
  if (/参数|校验|应为|必填|非法|invalid|required|schema|enum|validation/.test(s)) return "validation";
  return "unknown";
}

export class FailureEpisodeStore {
  constructor(dataDir, { maxEpisodes = 500 } = {}) {
    this.dir = path.join(dataDir, "memory", "failures");
    ensureDir(this.dir);
    this.file = path.join(this.dir, "episodes.json");
    this.maxEpisodes = maxEpisodes;
    // 2026-10-04 (F3): 与 SceneStore/FactStore 同口径 —— 损坏文件原地保留并打标记,
    //   第一次写盘前改名 .corrupt-<ts> 留档, 不再"解析失败→空数组→整体覆盖"抹掉病历。
    const guarded = readJsonGuarded(this.file, []);
    this._episodes = Array.isArray(guarded.data) ? guarded.data : [];
    this._corruptPending = guarded.parseFailed;
  }

  // 锁内重读用的磁盘态读取 (调用方必须已持有文件锁)
  _load() {
    const d = readJsonGuarded(this.file, []);
    if (d.parseFailed) this._corruptPending = true;
    return Array.isArray(d.data) ? d.data : [];
  }

  // 磁盘态 ∪ 内存态 (按 id 取并集; 同 id 取 ts 较新的一份, **ts 相同则磁盘胜出**),
  // 统一按 ts 新→旧排序并裁剪到 maxEpisodes。
  // 为什么必须合并而不是"内存整体覆盖": episodes.json 是 CLI + Web + 自愈探针共写的共享文件,
  //   "构造时读一次 + 之后每次全量重写" 会把别的进程刚落盘的病历整段抹掉
  //   (实测两进程各 12 次 record() 后文件只剩 12 行, 丢 12 条)。
  // 为什么平局要给磁盘: 本进程每次都是全量原子写, 盘上不可能落后于自己的内存态;
  //   内存里"同 ts 但不同内容"只可能是别的进程在同一毫秒内改过同一条 (hit++),
  //   此时内存胜出就是丢更新 (lost update)。
  static mergeEpisodes(disk, mem, maxEpisodes = 0) {
    const byId = new Map();
    for (const e of [...(Array.isArray(disk) ? disk : []), ...(Array.isArray(mem) ? mem : [])]) {
      if (!e || !e.id) continue;
      const cur = byId.get(e.id);
      // 后入者 (内存/本进程) 仅在严格更新时胜出
      byId.set(e.id, !cur || Number(e.ts || 0) > Number(cur.ts || 0) ? e : cur);
    }
    const out = [...byId.values()].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
    const max = Number(maxEpisodes) || 0;
    return max > 0 && out.length > max ? out.slice(0, max) : out;
  }

  // 纯写盘 (调用方必须已持有文件锁)。临界区全同步: reload → merge → write, 中间不 await,
  // 因为 withFileLock 在 fn 里一旦 await 就会提前释放锁 (utils/store.js 已知缺陷, 别处修)。
  _writeLocked() {
    if (this._corruptPending) {
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "")}`);
      } catch (e) { warn(`[memory/failure-episode] 损坏文件留档失败 (照常写盘): ${e && e.message ? e.message : e}`); }
      this._corruptPending = false;
    }
    writeJson(this.file, this._episodes);
  }

  // 整体落盘 (锁内先并入磁盘最新态) —— 兼容旧调用点
  _save() {
    try {
      withFileLock(this.file, () => {
        this._episodes = FailureEpisodeStore.mergeEpisodes(this._load(), this._episodes, this.maxEpisodes);
        this._writeLocked();
      });
    } catch (e) {
      warn(`[memory/failure-episode] 病历写盘失败 (内存态保留, 不阻断调用方): ${e && e.message ? e.message : e}`);
    }
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
    // 读-改-写全在锁内 (F3): 锁内重读磁盘 → 并入本次新病历 → 原子写
    try {
      return withFileLock(this.file, () => {
        this._episodes = FailureEpisodeStore.mergeEpisodes(this._load(), [e, ...this._episodes], this.maxEpisodes);
        this._writeLocked();
        return this._episodes.find((x) => x.id === e.id) || e;
      });
    } catch (err) {
      // 病历是辅助信号, 写失败不该影响工具结果 —— 但必须留痕, 不能静默丢数据
      // (调用点 src/agent/index.js 的 catch 是空的, 静默返回就等于永久丢失)
      warn(`[memory/failure-episode] 病历写入失败, 本次记录未落盘: ${err && err.message ? err.message : err}`);
      return e;
    }
  }

  // 只读刷新 (F3): 读路径 (search/list/stats) 先看一眼盘 —— 别的进程刚落盘的病历
  // 不该对本进程永久隐形 (search() 是"下次同类故障直接带出历史结论"的那一半)。
  // 不需要锁: atomicWrite = 临时文件 + rename, 读到的必是完整的旧版或新版, 不会是半截。
  _refresh() {
    try {
      this._episodes = FailureEpisodeStore.mergeEpisodes(this._load(), this._episodes, this.maxEpisodes);
    } catch (e) {
      warn(`[memory/failure-episode] 读盘刷新失败 (沿用内存态): ${e && e.message ? e.message : e}`);
    }
    return this._episodes;
  }

  // 相似故障检索: 按 错误文本 + 工具名 词法相似度排序, 返回 top N
  search({ tool = null, error = "", limit = 3, minScore = 0.25 } = {}) {
    const q = String(error || "");
    const scored = this._refresh()
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
    // 命中计数 (元学习): 锁内重读后写回原 episode, 不只是副本
    if (scored.length) {
      const bumped = this._bumpHits(scored.map((s) => s.id));
      for (const s of scored) {
        const hit = bumped.get(s.id);
        if (hit !== undefined) s.hit = hit;
      }
    }
    return scored;
  }

  // 命中计数写回 (锁内读-改-写, 全同步)。返回 id -> 新 hit 值
  _bumpHits(ids) {
    const want = new Set((ids || []).filter(Boolean));
    try {
      return withFileLock(this.file, () => {
        this._episodes = FailureEpisodeStore.mergeEpisodes(this._load(), this._episodes, this.maxEpisodes);
        const after = new Map();
        let touched = 0;
        for (const e of this._episodes) {
          if (!want.has(e.id)) continue;
          e.hit = (Number(e.hit) || 0) + 1;
          after.set(e.id, e.hit);
          touched++;
        }
        if (touched) this._writeLocked();
        return after;
      });
    } catch (e) {
      warn(`[memory/failure-episode] 命中计数写回失败 (不影响检索结果): ${e && e.message ? e.message : e}`);
      return new Map();
    }
  }

  // 统计: 按类别分布 / 命中率
  stats() {
    const items = this._refresh();
    const byCat = {};
    for (const e of items) byCat[e.category] = (byCat[e.category] || 0) + 1;
    const withFix = items.filter((e) => e.fix).length;
    const totalHit = items.reduce((a, e) => a + e.hit, 0);
    return {
      total: items.length,
      byCategory: byCat,
      withFix: withFix,
      fixRate: items.length ? (withFix / items.length * 100).toFixed(1) + "%" : "0%",
      totalHits: totalHit,
    };
  }

  list(limit = 20) { return this._refresh().slice(0, limit); }

  // 清空 (显式治理操作: 以调用方意图为准, 不并入磁盘态)
  clear() {
    try {
      return withFileLock(this.file, () => {
        this._episodes = [];
        this._writeLocked();
        return true;
      });
    } catch (e) {
      warn(`[memory/failure-episode] 清空失败: ${e && e.message ? e.message : e}`);
      return false;
    }
  }
}

export default FailureEpisodeStore;
