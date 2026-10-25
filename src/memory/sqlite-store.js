// src/memory/sqlite-store.js - 内嵌记忆数据库 (SQLite, Node 内置 node:sqlite, 零运行时依赖)
//
// 为什么需要它: JSON 版 (fact-store.js) 每次 add/hit 都要「全量读盘 → 重建倒排索引 → 全量原子写」,
// 且靠文件锁 + 忙等保证并发 —— 高频写场景磁盘写放大严重, 多进程只能串行。
// SQLite 版把这三件事一次性解决: 增量写 (O(1))、FTS5 索引 (C 实现)、事务级并发安全 (WAL 模式)。
//
// 接口与 FactStore **完全对齐** (19 个公开方法), 因此可在 config.memory.backend 上一键切换。
//
// 中文检索说明: FTS5 内置 unicode61 把连续汉字当一个 token, trigram 又要求查询 ≥3 字符 ——
// 都不适合中文。故采用「应用层 bigram 切分 + FTS5 存切分文本」: 写入与查询走同一套切分,
// 中文子串检索正常工作 (与 JSON 版的倒排口径一致, 便于横向对比)。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ensureDir, nowISO } from "../utils/store.js";
import { setJaccard, setOverlap } from "../utils/similarity.js";
import { scrubPII } from "../utils/pii.js";
import { debug } from "../utils/logger.js";
import { importJsonIntoSqlite } from "./backend-migrate.js";
// v2026-10-XX (来源分级): 与 JSON 后端共用同一套判定规则 (provenance.js), 保证跨后端同口径
import {
  resolveWriteTier, tierOfRecord, normalizeTier, rankOf, canSupersede, isQuarantined, stripTierTags,
  matchesTierSelector,
} from "./provenance.js";

// node:sqlite 用**惰性 require** 加载, 不做静态 import ——
// 静态 import 会在任何 import 了本模块的进程里立刻加载 node:sqlite,
// 从而让"完全没用到 SQLite 后端"的场景也弹出 ExperimentalWarning。
// 改为首次真正打开数据库时才解析, 不使用 SQLite 的进程零感知。
const require = createRequire(import.meta.url);

export const LAYER_L1 = 1;
export const LAYER_L4 = 4;
export const SCHEMA_VERSION = 1;
// 墓碑行数与容量上限的倍数 —— 与 fact-store.js 的 FactStore.TOMBSTONE_FACTOR 同值 (json/sqlite 同口径)
const TOMBSTONE_FACTOR = 4;

const SNAKE_TO_CAMEL = {
  decay_per_day: "decayPerDay",
  hit_bonus: "hitBonus",
  base_importance: "baseImportance",
  forget_speed: "forgetSpeed",
  max_facts: "maxFacts",
};

// 检索切分: CJK 取 bigram (单字成词则保留单字), 英数取小写整词。
// 与写入端使用同一函数 —— 这是中文能被 FTS5 命中的前提。
export function tokenize(text) {
  const s = String(text || "").toLowerCase();
  const out = [];
  const re = /[a-z0-9_]+|[\u4e00-\u9fff]+/g;
  for (const m of s.matchAll(re)) {
    const t = m[0];
    if (/^[a-z0-9_]+$/.test(t)) {
      out.push(t);
      continue;
    }
    if (t.length === 1) {
      out.push(t);
      continue;
    }
    for (let i = 0; i + 1 < t.length; i++) out.push(t.slice(i, i + 2));
  }
  return out;
}

const FTS_QUERY_ESCAPE = (toks) => toks.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");

function cryptoRandomId() {
  return "f_" + globalThis.crypto.randomUUID();
}

export class SqliteFactStore {
  constructor(dataDir, opts = {}) {
    this.dir = path.join(dataDir, "memory");
    ensureDir(this.dir);
    this.file = path.join(this.dir, "facts.db");
    const normOpts = {};
    for (const [k, v] of Object.entries(opts || {})) normOpts[SNAKE_TO_CAMEL[k] || k] = v;
    this.opts = {
      decayPerDay: 0.02,
      hitBonus: 5,
      baseImportance: 10,
      forgetSpeed: 1.0,
      maxFacts: 1000,
      // F4 同口径 (fact-store.js): 墓碑 (status=deleted/archived) 回收参数
      purgeGraceDays: 30,  // 时效扫描里的墓碑物理保留期 (天); 0 = 不按年龄物理清理
      maxTombstones: 0,    // 墓碑行数上限; 0 = 按 maxFacts × TOMBSTONE_FACTOR 推导
      ...normOpts,
    };
    this.embedder = null;
    this._embedCache = new Map();
    this._open();
    // v2026-10-04 (P2#sqlite-parity): 后端切换一次性迁移 —— 空库 + 同目录存在 facts.json 时导入,
    // best-effort, 永不抛错 (详见 backend-migrate.js)
    importJsonIntoSqlite(this);
    // v2026-10-XX (来源分级 · 存量回灌): 空 provenance 的存量行按 source 登记表一次性落 tier。
    //   判定不依赖这一步 (_row2fact 读缺值时会即时回退), 这一步只让磁盘列本身可审计、可 SQL 统计。
    //   放在迁移之后: json→sqlite 导进来的行也一起被回灌 (迁移映射逐字保留 provenance, 见 backend-migrate)。
    this.backfillProvenance();
  }

  _open() {
    const { DatabaseSync } = require("node:sqlite"); // 惰性加载: 只有真正用 SQLite 后端时才引入
    this.db = new DatabaseSync(this.file);
    // WAL: 读写不互斥, 崩溃可恢复 (多进程安全的底座)
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        norm_key TEXT,
        toks TEXT,
        type TEXT DEFAULT 'general',
        source TEXT DEFAULT 'manual',
        importance REAL DEFAULT 10,
        score REAL DEFAULT 10,
        created INTEGER,
        last_access INTEGER,
        hits INTEGER DEFAULT 0,
        scope TEXT,
        layer INTEGER DEFAULT 1,
        status TEXT DEFAULT 'active',
        prev_id TEXT,
        superseded_by TEXT,
        deleted_reason TEXT,
        deleted_at INTEGER,
        ttl_days INTEGER,
        valid_from INTEGER,
        valid_to INTEGER,
        provenance TEXT,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(status);
      CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope);
      CREATE INDEX IF NOT EXISTS idx_facts_layer ON facts(layer);
      CREATE INDEX IF NOT EXISTS idx_facts_norm ON facts(norm_key);
      CREATE INDEX IF NOT EXISTS idx_facts_access ON facts(last_access);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
    // v2026-10-04 (P2#sqlite-parity): valid_from/valid_to 是后补的 TTL 时效窗口列 ——
    // CREATE TABLE IF NOT EXISTS 对存量旧库不生效, 必须走 ALTER TABLE 补列 (与 fact-store.js 的窗口语义对齐)
    const cols = new Set(this.db.prepare("PRAGMA table_info(facts)").all().map((c) => c.name));
    if (!cols.has("valid_from")) this.db.exec("ALTER TABLE facts ADD COLUMN valid_from INTEGER");
    if (!cols.has("valid_to")) this.db.exec("ALTER TABLE facts ADD COLUMN valid_to INTEGER");
    // 来源分级 (v2026-10-XX): 与 valid_* 同一套存量库补列路径 —— 分级上线前建好的库没有这列,
    //   不补列则每次写入都要先炸一次 "no such column" (sqlite 对未知列是硬错, 不是忽略)。
    if (!cols.has("provenance")) this.db.exec("ALTER TABLE facts ADD COLUMN provenance TEXT");
    // FTS5 索引表: 存"切分后的 token 文本", 检索时同口径切分。
    // 用标准 (非 contentless) 表 —— content='' 的表不支持普通 DELETE, 增量更新会失效。
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
          toks,
          tokenize='unicode61'
        );
      `);
      this.ftsReady = true;
    } catch {
      this.ftsReady = false; // 极端环境无 FTS5 时回落 LIKE 检索
    }
    this.db.exec(`INSERT OR REPLACE INTO meta(k,v) VALUES('schema', '${SCHEMA_VERSION}')`);
  }

  // ---- 内部工具 ----
  _norm(s) {
    return String(s || "").trim().replace(/\s+/g, " ");
  }

  _normKey(s) {
    return this._norm(s)
      .replace(/^(请记住|记一下|记得|别忘了|提醒我|记住)[:：,，\s]*/, "")
      .replace(/[。！？!?.,，、；;：:\s]+$/, "")
      .toLowerCase();
  }

  _row2fact(r) {
    if (!r) return null;
    return {
      id: r.id,
      content: r.content,
      type: r.type,
      source: r.source,
      // 来源分级: 列缺值 (存量行/旧版本写入) 时即时按 source 登记表回退, 使判定不依赖回灌是否跑过
      provenance: tierOfRecord({ provenance: r.provenance, source: r.source }),
      importance: r.importance,
      score: r.score,
      created: new Date(r.created).toISOString(),
      lastAccess: new Date(r.last_access).toISOString(),
      hits: r.hits,
      scope: r.scope,
      layer: r.layer,
      status: r.status,
      prevId: r.prev_id,
      supersededBy: r.superseded_by,
      // deleteReason 而非 deletedReason: 与 fact-store.js 的字段名对齐 (governance 工具按此显示)
      deleteReason: r.deleted_reason ?? null,
      deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null,
      ttlDays: r.ttl_days ?? null,
      validFrom: r.valid_from ? new Date(r.valid_from).toISOString() : null,
      validTo: r.valid_to ? new Date(r.valid_to).toISOString() : null,
      meta: this._parseMeta(r.meta),
    };
  }

  // v2026-10-04 (P2#sqlite-parity #4): meta 损坏 (手工编辑/半写入的行) 不再炸掉整库加载 ——
  // 坏值按空处理, 该行其余字段照常返回
  _parseMeta(raw) {
    if (raw == null || raw === "") return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      debug(`[memory/sqlite-store] meta 解析失败, 按空处理 (行保留): ${e && e.message ? e.message : e}`);
      return null;
    }
  }

  // 时效窗口 (对齐 fact-store.js _normTime/_isCurrent): 存毫秒 epoch, 读取侧转 ISO
  _normTimeMs(v) {
    if (v == null || v === "") return null;
    const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }

  _isCurrent(r, nowMs = Date.now()) {
    if (r.valid_from && nowMs < r.valid_from) return false; // 尚未生效
    if (r.valid_to && nowMs >= r.valid_to) return false; // 已失效
    return true;
  }

  setValidity(id, { validFrom = undefined, validTo = undefined } = {}) {
    const row = this.db.prepare("SELECT * FROM facts WHERE id = ?").get(String(id || ""));
    if (!row) return null;
    // 时效只影响检索可见性, 不改 status (与 fact-store.js 同口径)
    if (validFrom !== undefined) this.db.prepare("UPDATE facts SET valid_from = ? WHERE id = ?").run(this._normTimeMs(validFrom), row.id);
    if (validTo !== undefined) this.db.prepare("UPDATE facts SET valid_to = ? WHERE id = ?").run(this._normTimeMs(validTo), row.id);
    const r = this.db.prepare("SELECT * FROM facts WHERE id = ?").get(row.id);
    return { id: row.id, validFrom: r.valid_from ? new Date(r.valid_from).toISOString() : null, validTo: r.valid_to ? new Date(r.valid_to).toISOString() : null };
  }

  listOutOfWindow(scope = null) {
    const rows = this.db.prepare("SELECT * FROM facts WHERE status = 'active' AND (? IS NULL OR scope = ?)").all(scope, scope);
    return rows.filter((r) => !this._isCurrent(r)).map((r) => this._row2fact(r));
  }

  _lambdaOf(f) {
    const base = Number(f.layer) === LAYER_L4 ? 0.005 : this.opts.decayPerDay;
    return base * this.opts.forgetSpeed;
  }

  _decay(score, days, layer = LAYER_L1) {
    const lambda = (Number(layer) === LAYER_L4 ? 0.005 : this.opts.decayPerDay) * this.opts.forgetSpeed;
    const d = Math.max(0, Number(days) || 0);
    return score * Math.exp(-lambda * d * d);
  }

  _ftsUpsert(fact) {
    if (!this.ftsReady) return;
    const toks = tokenize(fact.content).join(" ");
    try {
      const row = this.db.prepare("SELECT rowid FROM facts WHERE id = ?").get(fact.id);
      if (row) {
        this.db.prepare("DELETE FROM facts_fts WHERE rowid = ?").run(row.rowid);
        this.db.prepare("INSERT INTO facts_fts(rowid, toks) VALUES(?, ?)").run(row.rowid, toks);
      }
    } catch { /* 索引失败不影响主数据 */ }
  }

  _ftsDelete(id) {
    if (!this.ftsReady) return;
    try {
      const row = this.db.prepare("SELECT rowid FROM facts WHERE id = ?").get(id);
      if (row) this.db.prepare("DELETE FROM facts_fts WHERE rowid = ?").run(row.rowid);
    } catch { /* 忽略 */ }
  }

  // ---- 写入 ----
  // 与 FactStore.add 语义一致: 归一化去重 (命中则 hits+1 并加分) / 容量裁剪 / 层级
  add(content, {
    importance = this.opts.baseImportance, type = "general", source = "manual",
    dedupe = true, scope = null, meta = null, similarThreshold = 0,
    layer = LAYER_L1, ttlDays = null, validFrom = null, validTo = null, supersedeId = null,
    provenance = null,
  } = {}) {
    // v2026-10-04 (P2#secrets-parity): 与 fact-store.js add() 同点脱密 (scrub→norm, keep email/phone)。
    //   sqlite 后端不走 add() 之外还有 update/importAll 两条独立落盘路径, 三处各自脱, 口径与 JSON 对齐;
    //   scrubPII 幂等, 迁移二次脱敏无害。缺此步则翻转 backend 到 sqlite 会重开凭证泄漏口 (记忆回注 prompt 且可导出)。
    // v2026-10-XX (来源分级 · 与 JSON 后端逐条同口径): 未声明 provenance 且 source 不在登记表 → unknown 隔离;
    //   写入侧剥伪装来源标签 (标签文本只来自 provenance.js 的闭集常量, 不来自 content)。
    const tier = resolveWriteTier({ provenance, source });
    const clean = this._norm(stripTierTags(scrubPII(String(content ?? ""), { keep: ["email", "phone"] }).cleaned));
    if (!clean) return null;
    const key = this._normKey(clean);

    if (dedupe && key) {
      const hit = this.db.prepare(
        "SELECT * FROM facts WHERE norm_key = ? AND status = 'active' AND (scope IS ? OR scope = ?) LIMIT 1",
      ).get(key, scope, scope);
      if (hit) return this._onDedupeHit(hit, tier);
    }

    if (similarThreshold > 0) {
      const sim = this.findSimilar(clean, { threshold: similarThreshold, scope });
      if (sim) {
        // 跨 tier: 低权限写入不得给高权限记录加分 (与 fact-store.js _onDedupeHit 同规则)
        if (!canSupersede(tier, tierOfRecord(sim))) return sim;
        this.db.prepare("UPDATE facts SET hits = hits + 1, score = score + ?, last_access = ? WHERE id = ?")
          .run(this.opts.hitBonus, Date.now(), sim.id);
        if (rankOf(tier) > rankOf(tierOfRecord(sim))) {
          this.db.prepare("UPDATE facts SET provenance = ? WHERE id = ?").run(tier, sim.id);
        }
        return this._row2fact(this.db.prepare("SELECT * FROM facts WHERE id = ?").get(sim.id));
      }
    }

    const f = {
      id: cryptoRandomId(),
      content: clean,
      normKey: key,
      // 切分结果随行落库: 查询精排时直接读, 避免对每条候选重复切分 (实测这是查询慢 50x 的主因)
      toks: tokenize(clean).join(" "),
      type, source,
      provenance: tier,
      importance: Number(importance) || this.opts.baseImportance,
      score: Number(importance) || this.opts.baseImportance,
      created: Date.now(),
      lastAccess: Date.now(),
      hits: 0,
      scope,
      layer: Number(layer) || LAYER_L1,
      status: "active",
      ttlDays: ttlDays == null ? null : Number(ttlDays),
      validFrom: this._normTimeMs(validFrom),
      validTo: this._normTimeMs(validTo),
      meta: meta ? JSON.stringify(meta) : null,
    };
    this.db.prepare(`
      INSERT INTO facts(id,content,norm_key,toks,type,source,provenance,importance,score,created,last_access,hits,scope,layer,status,ttl_days,valid_from,valid_to,meta)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(f.id, f.content, f.normKey, f.toks, f.type, f.source, f.provenance, f.importance, f.score, f.created, f.lastAccess, f.hits, f.scope, f.layer, f.status, f.ttlDays, f.validFrom, f.validTo, f.meta);

    this._ftsUpsert({ id: f.id, content: f.content });
    // v3.1 同口径 (fact-store.js): supersedeId 指定被本条取代的旧事实 → 其 validTo 收口到当前 (旧条不删, 只是不再命中)
    // 跨 tier 取代规则: 低权限写入不得收口高权限记录 (否则一次抓取就能静默"遗忘"用户事实)
    if (supersedeId && supersedeId !== f.id) {
      const old = this.db.prepare("SELECT * FROM facts WHERE id = ? AND valid_to IS NULL").get(supersedeId);
      if (old && canSupersede(tier, tierOfRecord(old))) {
        this.db.prepare("UPDATE facts SET valid_to = ? WHERE id = ? AND valid_to IS NULL").run(Date.now(), supersedeId);
      }
    }
    this._prune();
    return this._row2fact(this.db.prepare("SELECT * FROM facts WHERE id = ?").get(f.id));
  }

  addMemory(message) {
    return this.add(message, { source: "message", type: "message" });
  }

  // 去重命中的跨 tier 规则 (与 fact-store.js _onDedupeHit 逐条同口径, 调用方必须已传入刚读到的行):
  //   低权限写入撞高权限记录 → 原样返回, 不改 hits/score (隔离带刷不出用户事实的热度);
  //   同权或更高 → 照旧加分, 严格更高时把该行 provenance 晋级 (来源只会向上)。
  _onDedupeHit(hitRow, tier) {
    const cur = tierOfRecord(hitRow);
    if (!canSupersede(tier, cur)) return this._row2fact(hitRow);
    this.db.prepare(
      "UPDATE facts SET hits = hits + 1, score = score + ?, last_access = ? WHERE id = ?",
    ).run(this.opts.hitBonus, Date.now(), hitRow.id);
    if (rankOf(tier) > rankOf(cur)) {
      this.db.prepare("UPDATE facts SET provenance = ? WHERE id = ?").run(tier, hitRow.id);
    }
    this._ftsUpsert({ id: hitRow.id, content: hitRow.content });
    return this._row2fact(this.db.prepare("SELECT * FROM facts WHERE id = ?").get(hitRow.id));
  }

  /**
   * 存量库来源分级回灌 (与 fact-store.js 同名 API, 两端可互换调用)。
   * 单事务: 要么全灌要么不灌, 中途崩溃不会留下"半灌"的库 (半灌不影响判定, 但会让 by_provenance 读数失真)。
   * 只碰 provenance 为 NULL/空 的行 —— 已声明的值绝不重算 (用户晋级过的 tier 不会被回灌洗掉)。
   * @returns {{total:number, stamped:number, byTier:Object, quarantined:number, dryRun:boolean}}
   */
  backfillProvenance({ dryRun = false } = {}) {
    const rows = this.db.prepare("SELECT id, source, provenance FROM facts").all();
    const byTier = {};
    let quarantined = 0;
    const todo = [];
    for (const r of rows) {
      const t = tierOfRecord(r);
      byTier[t] = (byTier[t] || 0) + 1;
      if (isQuarantined(t)) quarantined++;
      if (r.provenance == null || String(r.provenance).trim() === "" || r.provenance !== t) todo.push({ id: r.id, t });
    }
    if (dryRun) return { total: rows.length, stamped: 0, byTier, quarantined, dryRun: true };
    if (todo.length) {
      this.db.exec("BEGIN");
      try {
        const upd = this.db.prepare("UPDATE facts SET provenance = ? WHERE id = ?");
        for (const x of todo) upd.run(x.t, x.id);
        this.db.exec("COMMIT");
      } catch (e) {
        try { this.db.exec("ROLLBACK"); } catch { /* 事务已结束 */ }
        debug(`[memory/sqlite-store] provenance 回灌事务回滚 (判定不依赖它, 行为不变): ${e && e.message ? e.message : e}`);
        return { total: rows.length, stamped: 0, byTier, quarantined, dryRun: false, failed: true };
      }
    }
    return { total: rows.length, stamped: todo.length, byTier, quarantined, dryRun: false };
  }

  // 容量裁剪: 超 maxFacts 时按「衰减分 × 重要性」淘汰最弱 (与 JSON 版同口径)
  // 2026-10-04 (F4): 同时给墓碑行数设上限 (maxFacts × TOMBSTONE_FACTOR) —— 软删/归档行不占
  // maxFacts 名额, 但一直躺在表里让库文件与 COUNT(*) 只增不减; 按删除时钟升序回收最老的。
  _prune() {
    const max = Number(this.opts.maxFacts);
    const explicitCap = Number(this.opts.maxTombstones) || 0;
    if ((!max || max <= 0) && explicitCap <= 0) return 0;
    let dropped = 0;
    if (max && max > 0) {
      const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE status = 'active'").get();
      if (n > max) {
        const now = Date.now();
        const rows = this.db.prepare("SELECT * FROM facts WHERE status='active'").all();
        const ranked = rows.map((r) => {
          const days = Math.max(0, (now - r.last_access) / 86400000);
          const eff = this._decay(r.score, days, r.layer) * (0.5 + 0.5 * Math.min(r.importance || 0, 20) / 20);
          // 来源分级 (fact-store.js _prune 同口径): 隔离带先出局, 抓取洪水不该挤掉用户事实。
          //   同类内部保持原「衰减分×重要性」升序, 单来源场景的淘汰次序逐字不变。
          return { id: r.id, eff, promotable: isQuarantined(tierOfRecord(r)) ? 0 : 1 };
        }).sort((a, b) => (b.promotable - a.promotable) || (a.eff - b.eff));
        const drop = ranked.slice(0, n - max);
        const del = this.db.prepare("DELETE FROM facts WHERE id = ?");
        for (const d of drop) {
          this._ftsDelete(d.id);
          del.run(d.id);
        }
        dropped += drop.length;
      }
    }
    const cap = explicitCap > 0 ? explicitCap : (max && max > 0 ? max * TOMBSTONE_FACTOR : 0);
    if (cap > 0) {
      dropped += this._purgeTombstones({ cap, olderThanMs: 0 }).length;
    }
    return dropped;
  }

  // 墓碑物理回收 (JSON/sqlite 同口径): 按删除时钟升序, 只保留最近 cap 条 / 或只留保留期内的那些。
  //   olderThanMs > 0  = 只删"早于该时间戳"的墓碑 (时效扫描用的年龄口径, 时间不靠墙钟之外的东西)
  //   cap > 0          = 只留最近的 cap 条墓碑 (容量口径)
  //   tier             = 来源分级选择器 (provenance.js matchesTierSelector); 缺省 null = 不分档,
  //                      传 "quarantined" 时 tombstone 回收也只碰隔离带 —— 让 sweepExpired({tier})
  //                      的语义闭合: "只动这一档", 不会顺手把用户事实的墓碑也清了。
  // 返回被回收的 id 列表 (与 JSON 后端的 purgedIds 同形)
  _purgeTombstones({ cap = 0, olderThanMs = 0, limit = 0, tier = null } = {}) {
    // deleted_at 只有软删才有; 归档行 (status='archived') 退到 last_access, 再退到 created
    const rows = this.db.prepare(
      "SELECT id, provenance, source, COALESCE(deleted_at, last_access, created) AS clock FROM facts WHERE status IN ('deleted','archived') ORDER BY clock ASC",
    ).all();
    let doomed = rows.filter((r) => matchesTierSelector(tierOfRecord(r), tier));
    if (olderThanMs > 0) doomed = doomed.filter((r) => Number(r.clock) <= olderThanMs);
    if (cap > 0) doomed = doomed.slice(0, Math.max(0, doomed.length - cap));
    else if (limit > 0) doomed = doomed.slice(0, limit);
    const del = this.db.prepare("DELETE FROM facts WHERE id = ?");
    const ids = [];
    for (const r of doomed) {
      this._ftsDelete(r.id);
      del.run(r.id);
      ids.push(r.id);
    }
    return ids;
  }

  // ---- 检索 ----
  // 粗召回走 FTS5 (C 实现, 远快于内存全扫), 精排复用 JSON 版公式, 保证结果口径一致
  query(q, { limit = 5, minScore = 1, scope = null, includeExpired = false } = {}) {
    const ql = String(q || "").toLowerCase();
    const toks = tokenize(ql);
    let rows = [];

    if (toks.length && this.ftsReady) {
      try {
        // ⚠ 关键: FTS 的 `ORDER BY bm25()` 必须隔离在**子查询**里。
        // 实测把 bm25 排序与外层 JOIN 写在一起会让 SQLite 走错执行计划 —— 同样的数据量
        // 从 0.16ms/次 劣化到 16ms/次 (100 倍)。子查询形式让"先按 bm25 取 rowid"和
        // "按 rowid 取列"两件事各自走最优路径。
        rows = this.db.prepare(`
          SELECT f.id, f.content, f.toks, f.type, f.source, f.provenance, f.importance, f.score,
                 f.created, f.last_access, f.hits, f.scope, f.layer, f.status,
                 f.prev_id, f.superseded_by, f.deleted_reason, f.deleted_at, f.ttl_days,
                 f.valid_from, f.valid_to, f.meta
          FROM facts f
          WHERE f.status = 'active' AND (? IS NULL OR f.scope = ?)
            AND f.rowid IN (
              SELECT rowid FROM facts_fts WHERE facts_fts MATCH ? ORDER BY bm25(facts_fts) LIMIT 200
            )
        `).all(scope, scope, FTS_QUERY_ESCAPE(toks));
      } catch { rows = []; }
    }
    if (!rows.length) {
      // 回落: LIKE 粗筛 (无 FTS5 或查询词过短)
      const like = `%${ql.slice(0, 60)}%`;
      rows = this.db.prepare(
        "SELECT * FROM facts WHERE status='active' AND (? IS NULL OR scope = ?) AND lower(content) LIKE ? LIMIT 300",
      ).all(scope, scope, like);
    }
    // 时效窗口过滤 (v3.1 / fact-store.js 同口径): 已失效/未生效的事实默认不命中, includeExpired=true 供治理检视
    if (!includeExpired) rows = rows.filter((r) => this._isCurrent(r));
    if (!rows.length) return [];

    const now = Date.now();
    const decayL1 = this.opts.decayPerDay * this.opts.forgetSpeed;
    const decayL4 = 0.005 * this.opts.forgetSpeed;
    const scored = [];
    // 精排阶段只碰原始 row: 不构造 Date/ISO 字符串 (对 300 个候选做两次 new Date().toISOString()
    // 是查询慢的主因 —— 实测 11ms/次 → 优化后 <1ms)。序列化留到最终 top-N。
    for (const r of rows) {
      const days = Math.max(0, (now - r.last_access) / 86400000);
      const lambda = Number(r.layer) === LAYER_L4 ? decayL4 : decayL1;
      const recency = Math.exp(-lambda * days * days);
      const docSet = new Set(String(r.toks || "").split(" ").filter(Boolean));
      let covered = 0;
      if (toks.length) {
        for (const t of toks) if (docSet.has(t)) covered++;
        covered /= toks.length;
      }
      const subHit = ql && String(r.content).toLowerCase().includes(ql) ? 5 : 0;
      let s = 10 * (0.4 + 0.6 * recency) * (0.3 + 0.7 * covered);
      s += subHit;
      s += r.hits > 0 ? Math.min(r.hits, 5) : 0;
      s += Math.min(r.importance || 0, 20) / 20 * 3;
      if (s >= minScore) scored.push({ r, s });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, limit).map((x) => ({ ...this._row2fact(x.r), effectiveScore: x.s }));
  }

  queryMulti(queries, { limit = 5, scope = null, minScore = 1, includeExpired = false } = {}) {
    const lists = (queries || []).filter(Boolean).map((q) => this.query(q, { limit: Math.max(limit * 2, 10), scope, minScore, includeExpired }));
    const K = 60;
    const acc = new Map();
    for (const list of lists) {
      list.forEach((f, rank) => {
        const cur = acc.get(f.id) || { fact: f, rrf: 0 };
        cur.rrf += 1 / (K + rank + 1);
        acc.set(f.id, cur);
      });
    }
    return [...acc.values()].sort((a, b) => b.rrf - a.rrf).slice(0, limit).map((x) => ({ ...x.fact, effectiveScore: x.rrf }));
  }

  findSimilar(content, { threshold = 0.6, scope = null } = {}) {
    const a = new Set(tokenize(content));
    if (!a.size) return null;
    const rows = this.db.prepare("SELECT * FROM facts WHERE status='active' AND (? IS NULL OR scope = ?) LIMIT 500").all(scope, scope);
    for (const r of rows) {
      const b = new Set(tokenize(r.content));
      if (setJaccard(a, b) >= threshold || setOverlap(a, b) >= threshold) return this._row2fact(r);
    }
    return null;
  }

  setEmbedder(fn) {
    this.embedder = typeof fn === "function" ? fn : null;
    this._embedCache.clear(); // 换模型后旧向量与新模型不同空间, 必须作废 (与 JSON 后端同口径)
  }

  // role ("query"|"passage"): 非对称模型 (e5) 的查询侧/文档侧前缀不同, 缓存键必须带上 role,
  //   否则同一串文本在两侧共用一条向量, 精度悄悄劣化 (2026-10-04)
  async _embed(text, role = "query") {
    if (!this.embedder) return null;
    const key = role + "\u0000" + text;
    if (this._embedCache.has(key)) {
      const cached = this._embedCache.get(key);
      this._embedCache.delete(key);
      this._embedCache.set(key, cached); // 命中即挪到队尾 = 真 LRU (旧实现满 1000 整体清空)
      return cached;
    }
    try {
      const v = await this.embedder(text, role);
      if (Array.isArray(v) && v.length) {
        this._embedCache.set(key, v);
        while (this._embedCache.size > 1000) {
          const oldest = this._embedCache.keys().next();
          if (oldest.done) break;
          this._embedCache.delete(oldest.value);
        }
        return v;
      }
    } catch { /* 向量化失败回落词法检索 */ }
    return null;
  }

  async querySemantic(q, { limit = 5, scope = null } = {}) {
    const lexical = this.query(q, { limit: limit * 2, scope });
    if (!this.embedder) return lexical.slice(0, limit);
    const qv = await this._embed(q, "query");
    if (!qv) return lexical.slice(0, limit);
    const rows = this.db.prepare("SELECT * FROM facts WHERE status='active' AND (? IS NULL OR scope = ?) LIMIT 500").all(scope, scope);
    const dense = [];
    for (const r of rows) {
      const v = await this._embed(r.content, "passage");
      if (!v) continue;
      dense.push({ ...this._row2fact(r), effectiveScore: cosine(qv, v) });
    }
    dense.sort((a, b) => b.effectiveScore - a.effectiveScore);
    const K = 60;
    const acc = new Map();
    lexical.forEach((f, i) => acc.set(f.id, { f, s: 1 / (K + i + 1) }));
    dense.slice(0, limit * 2).forEach((f, i) => {
      const cur = acc.get(f.id);
      if (cur) cur.s += 1 / (K + i + 1);
      else acc.set(f.id, { f, s: 1 / (K + i + 1) });
    });
    return [...acc.values()].sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.f);
  }

  hit(id) {
    const r = this.db.prepare("SELECT * FROM facts WHERE id = ?").get(id);
    if (!r) return null;
    this.db.prepare("UPDATE facts SET hits = hits + 1, last_access = ?, score = score + ? WHERE id = ?")
      .run(Date.now(), this.opts.hitBonus, id);
    return this._row2fact(this.db.prepare("SELECT * FROM facts WHERE id = ?").get(id));
  }

  // ---- 治理 ----
  // 来源分级 (fact-store.js forget 同口径): 默认不带 provenance = 治理动作不额外设闸;
  //   声明了来源则低权限声明不得删高权限记录 (防"抓来的内容唆使 agent 忘掉用户事实")。
  forget(idOrContent, { reason = null, provenance = null } = {}) {
    const key = String(idOrContent || "");
    let row = this.db.prepare("SELECT * FROM facts WHERE id = ?").get(key);
    if (!row) row = this.db.prepare("SELECT * FROM facts WHERE norm_key = ? AND status='active' LIMIT 1").get(this._normKey(key));
    if (!row) return null;
    // 已软删则不覆盖原 reason (幂等)
    if (row.status !== "deleted") {
      if (provenance != null && String(provenance).trim() !== ""
        && !canSupersede(normalizeTier(provenance), tierOfRecord(row))) return null;
      this.db.prepare("UPDATE facts SET status='deleted', deleted_reason=?, deleted_at=? WHERE id=?")
        .run(reason || null, Date.now(), row.id);
    }
    return this._row2fact(this.db.prepare("SELECT * FROM facts WHERE id = ?").get(row.id));
  }

  restore(id) {
    const row = this.db.prepare("SELECT * FROM facts WHERE id = ?").get(String(id || ""));
    if (!row || row.status !== "deleted") return null;
    // 恢复即视为一次访问, 避免刚恢复就被衰减清空
    this.db.prepare("UPDATE facts SET status='active', deleted_reason=NULL, deleted_at=NULL, last_access=?, hits=hits+1 WHERE id=?")
      .run(Date.now(), row.id);
    return this._row2fact(this.db.prepare("SELECT * FROM facts WHERE id = ?").get(row.id));
  }

  deletedList() {
    return this.db.prepare("SELECT * FROM facts WHERE status='deleted' ORDER BY deleted_at DESC").all().map((r) => this._row2fact(r));
  }

  update(id, patch = {}) {
    const row = this.db.prepare("SELECT * FROM facts WHERE id = ?").get(String(id || ""));
    if (!row) return null;
    // 跨 tier 取代规则 (fact-store.js update 同口径): 覆盖内容 = 最强形态的取代, 低权限写入直接拒绝。
    //   未声明 provenance 时按 patch.source (若给) 或该行现有 source 登记表定级, 登记不上 = unknown。
    const tier = resolveWriteTier({ provenance: patch.provenance, source: patch.source ?? row.source });
    if (!canSupersede(tier, tierOfRecord(row))) return null;
    // v2026-10-04 (P2#secrets-parity): 更新内容同样脱密 (对齐 fact-store.js update);
    //   row.content 是已脱敏存量, 不重复处理。
    const content = patch.content != null
      ? this._norm(stripTierTags(scrubPII(String(patch.content), { keep: ["email", "phone"] }).cleaned))
      : row.content;
    if (!content) return null;
    // 版本链: 旧条归档 + 新条指回 (只保留一层历史, 与 JSON 版一致)
    const newId = cryptoRandomId();
    this.db.prepare("UPDATE facts SET status='archived', superseded_by=? WHERE id=?").run(newId, row.id);
    this.db.prepare(`
      INSERT INTO facts(id,content,norm_key,toks,type,source,provenance,importance,score,created,last_access,hits,scope,layer,status,prev_id,ttl_days,valid_from,valid_to,meta)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?,?, 'active', ?,?,?,?,?)
    `).run(
      newId, content, this._normKey(content), tokenize(content).join(" "),
      patch.type ?? row.type, patch.source ?? row.source,
      // 晋级只向上 (canSupersede 已保证 tier 不低于现值); 同权保留现声明, 避免无谓 churn
      rankOf(tier) > rankOf(tierOfRecord(row)) ? tier : tierOfRecord(row),
      patch.importance ?? row.importance, patch.importance ?? row.score,
      Date.now(), Date.now(), row.scope, row.layer, row.id,
      // 时效窗口/TTL 随演化继承到新条 (fact-store.js 同口径: update 不换窗口)
      row.ttl_days ?? null, row.valid_from ?? null, row.valid_to ?? null, row.meta,
    );
    this._ftsUpsert({ id: newId, content });
    return this._row2fact(this.db.prepare("SELECT * FROM facts WHERE id = ?").get(newId));
  }

  // TTL 扫描 (fact-store.js 同口径): 逐条 ttl_days 优先于全局 ttlDays; 软归档而非硬删, 可 restore 回滚;
  // 返回 { swept, ids, dryRun, purged, purgedIds } (src/agent/index.js sweepMemoryTtl 按 swept 计数)
  // 2026-10-04 (F4) 同口径: 同一次扫描里顺带物理回收超过保留期 (purgeGraceDays) 的墓碑 ——
  //   归档行先由 TTL 规则软删 (扫描条件 status != 'deleted' 本就覆盖它们), 再过保留期才真删,
  //   所以"被取代但仍需审计"的版本链不会提前消失。时效窗口 (valid_from/valid_to) 不参与回收判定。
  // 来源分级 (v2026-10-XX) 新增可选 tier 选择器: 只扫该档的记录 (如 tier:"quarantined" = 只清抓来的
  //   证据, 用户事实不受波及)。缺省 null = 全量, 与旧调用方逐字同行为。
  sweepExpired({ ttlDays = 90, layer = null, dryRun = false, purgeGraceDays = null, tier = null } = {}) {
    const nowD = Date.now() / 86400000;
    const rows = this.db.prepare(
      "SELECT * FROM facts WHERE status != 'deleted' AND (? IS NULL OR layer = ?)",
    ).all(layer == null ? null : Number(layer), layer == null ? null : Number(layer));
    const targets = [];
    for (const r of rows) {
      if (!matchesTierSelector(tierOfRecord(r), tier)) continue;
      const ttl = Number(r.ttl_days || ttlDays);
      if (!ttl || ttl <= 0) continue;
      const days = Math.max(0, nowD - (r.last_access || nowD) / 86400000);
      if (days >= ttl) targets.push(r.id);
    }
    const grace = purgeGraceDays == null ? Number(this.opts.purgeGraceDays) : Number(purgeGraceDays);
    const purgeDays = Number.isFinite(grace) && grace > 0 ? grace : 0;
    const cutoffMs = purgeDays ? Date.now() - purgeDays * 86400000 : 0;
    const purgeableIds = () => purgeDays ? this.db.prepare(
      "SELECT id, provenance, source FROM facts WHERE status IN ('deleted','archived') AND COALESCE(deleted_at, last_access, created) <= ?",
    ).all(cutoffMs).filter((r) => matchesTierSelector(tierOfRecord(r), tier)).map((r) => r.id) : [];
    if (dryRun) {
      const ids = purgeableIds();
      return { swept: targets.length, ids: targets, dryRun: true, purged: ids.length, purgedIds: ids };
    }
    if (!targets.length && !purgeDays) {
      return { swept: 0, ids: targets, dryRun: false, purged: 0, purgedIds: [] };
    }
    // 单事务: 软归档 + 墓碑回收一起提交 (SQLite 事务级并发, 不需要文件锁)
    this.db.exec("BEGIN");
    try {
      const st = this.db.prepare("UPDATE facts SET status='deleted', deleted_reason=?, deleted_at=? WHERE id=? AND status != 'deleted'");
      let n = 0;
      for (const id of targets) n += st.run(`TTL ${ttlDays} 天未访问自动归档`, Date.now(), id).changes;
      const purgedIds = purgeDays ? this._purgeTombstones({ cap: 0, olderThanMs: cutoffMs, tier }) : [];
      this.db.exec("COMMIT");
      return { swept: n, ids: targets, dryRun: false, purged: purgedIds.length, purgedIds };
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* 忽略 */ }
      throw e;
    }
  }

  clearLayer(layer = LAYER_L1, { hard = false } = {}) {
    if (hard) {
      const ids = this.db.prepare("SELECT id FROM facts WHERE layer = ?").all(layer).map((r) => r.id);
      for (const id of ids) this._ftsDelete(id);
      const n = this.db.prepare("DELETE FROM facts WHERE layer = ?").run(layer).changes;
      return { cleared: n, hard: true };
    }
    const n = this.db.prepare("UPDATE facts SET status='deleted', deleted_reason=?, deleted_at=? WHERE layer=? AND status='active'")
      .run(`按层清理 L${layer}`, Date.now(), layer).changes;
    return { cleared: n, hard: false };
  }

  exportAll({ includeDeleted = true } = {}) {
    const rows = includeDeleted
      ? this.db.prepare("SELECT * FROM facts ORDER BY created").all()
      : this.db.prepare("SELECT * FROM facts WHERE status='active' ORDER BY created").all();
    // items (非 facts): 与 fact-store.js exportAll 同形 —— governance memory_export 产物
    // 需可被任一后端的 importAll 直接回灌 (v2026-10-04 parity 修复)
    return { version: SCHEMA_VERSION, exportedAt: nowISO(), count: rows.length, items: rows.map((r) => this._row2fact(r)) };
  }

  importAll(data, { mode = "merge" } = {}) {
    const list = Array.isArray(data)
      ? data
      : (data && Array.isArray(data.items) ? data.items : (data && Array.isArray(data.facts) ? data.facts : null));
    if (!list) return { ok: false, reason: "导入数据格式非法 (需数组或 {items:[]})" };
    if (mode === "replace") {
      const ids = this.db.prepare("SELECT id FROM facts").all().map((r) => r.id);
      for (const id of ids) this._ftsDelete(id);
      this.db.exec("DELETE FROM facts");
    }
    // merge 去重键 = norm_key 全表 (含软删/归档, 与 fact-store.js 的 seen 集合同口径); replace 不去重
    const seen = mode === "replace" ? null : new Set(this.db.prepare("SELECT content FROM facts").all().map((r) => this._normKey(r.content)));
    let imported = 0, skipped = 0;
    for (const it of list) {
      // 导入路径脱密 (与 fact-store.js _normalizeFact 对称): 外部 JSON / 其他后端导出可能夹带凭证。
      //   _insertImported 是本函数唯一的直插写入者, 在此归一前脱即覆盖 importAll + 后端切换迁移全路径。
      // 来源分级同口径: 同样剥伪装来源标签 (memory_import 是攻击者可控面最大的入口)。
      const content = this._norm(stripTierTags(scrubPII(String(it?.content ?? ""), { keep: ["email", "phone"] }).cleaned));
      if (!content) { skipped++; continue; }
      const k = this._normKey(content);
      if (seen && seen.has(k)) { skipped++; continue; }
      if (seen) seen.add(k);
      this._insertImported({ ...it, content });
      imported++;
    }
    return { ok: true, mode, imported, skipped };
  }

  // 导入直插: 保留源条目的 id/时间戳/status/scope/版本链/TTL 时效窗口 (后端切换迁移的前提,
  // 走 add() 会重新生成 id 并丢窗口)。INSERT OR REPLACE 按 id 幂等。
  _insertImported(it) {
    const nowMs = Date.now();
    const iso2ms = (v) => {
      if (v == null) return null;
      const t = typeof v === "number" ? v : new Date(v).getTime();
      return Number.isFinite(t) ? t : null;
    };
    const createdMs = iso2ms(it.created) ?? nowMs;
    const lastMs = iso2ms(it.lastAccess) ?? createdMs;
    const importance = Number(it.importance ?? this.opts.baseImportance) || this.opts.baseImportance;
    const status = it.status === "deleted" || it.status === "archived" ? it.status : "active";
    const id = it.id || cryptoRandomId();
    this.db.prepare(`
      INSERT OR REPLACE INTO facts(id,content,norm_key,toks,type,source,provenance,importance,score,created,last_access,hits,scope,layer,status,prev_id,superseded_by,deleted_reason,deleted_at,ttl_days,valid_from,valid_to,meta)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, it.content, this._normKey(it.content), tokenize(it.content).join(" "),
      it.type || "general", it.source || "import",
      // 来源分级逐字过迁移通道 (backend-migrate 两端同用此函数): 已声明的保留原值,
      //   旧行/外部 JSON 按 source 登记表回退, 登记不上一律 unknown 隔离 —— 绝不默认 user-stated。
      tierOfRecord({ provenance: it.provenance, source: it.source || "import" }),
      importance, Number(it.score ?? importance) || importance, createdMs, lastMs,
      it.hits || 0, it.scope ?? null,
      Number(it.layer) === LAYER_L4 ? LAYER_L4 : LAYER_L1, status,
      it.prevId ?? null, it.supersededBy ?? null,
      it.deleteReason ?? it.deletedReason ?? null, iso2ms(it.deletedAt),
      it.ttlDays ? Number(it.ttlDays) : null,
      this._normTimeMs(it.validFrom), this._normTimeMs(it.validTo),
      it.meta ? JSON.stringify(it.meta) : null,
    );
    this._ftsUpsert({ id, content: it.content });
  }

  list({ limit = 50, status = "active" } = {}) {
    return this.db.prepare("SELECT * FROM facts WHERE status = ? ORDER BY last_access DESC LIMIT ?")
      .all(status, limit).map((r) => this._row2fact(r));
  }

  // 表内总行数 (含 status=deleted/archived 的墓碑), 与 fact-store.js 的 count() 同口径。
  // "还能用的条数"是 countLive() —— 治理/展示要分开报, 否则遗忘越多这个数字越虚高 (F4)。
  count() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM facts").get().n;
  }

  countLive() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE status='active'").get().n;
  }

  stats() {
    const total = this.count();
    const active = this.countLive();
    const deleted = this.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE status='deleted'").get().n;
    const archived = this.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE status='archived'").get().n;
    const byLayer = {};
    for (const r of this.db.prepare("SELECT layer, COUNT(*) AS n FROM facts WHERE status='active' GROUP BY layer").all()) byLayer[String(r.layer)] = r.n;
    const bySource = {};
    for (const r of this.db.prepare("SELECT source, COUNT(*) AS n FROM facts WHERE status='active' GROUP BY source").all()) bySource[r.source || "unknown"] = r.n;
    // 来源分级可观测 (键名与 fact-store.js 一致): 按 (provenance, source) 分组后再归一, 让
    //   回灌前留下的 NULL provenance 也能按 source 登记表算出正确 tier (读数不失真)。
    const byProvenance = {};
    for (const r of this.db.prepare("SELECT provenance, source, COUNT(*) AS n FROM facts WHERE status='active' GROUP BY provenance, source").all()) {
      const t = tierOfRecord({ provenance: r.provenance, source: r.source });
      byProvenance[t] = (byProvenance[t] || 0) + r.n;
    }
    const quarantined = Object.keys(byProvenance)
      .filter((t) => isQuarantined(t))
      .reduce((acc, t) => acc + byProvenance[t], 0);
    const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    return {
      total, active, deleted, archived,
      // F4 同口径 (fact-store.js): rows=表内行数, tombstones=行数-活跃 (软删+归档)
      rows: total,
      tombstones: deleted + archived,
      max_facts: this.opts.maxFacts,
      max_tombstones: Number(this.opts.maxTombstones) || (this.opts.maxFacts ? this.opts.maxFacts * TOMBSTONE_FACTOR : 0),
      purge_grace_days: Number(this.opts.purgeGraceDays) || 0,
      by_layer: byLayer,
      by_source: bySource,
      by_provenance: byProvenance,
      quarantined,
      file: this.file,
      bytes: size,
      backend: "sqlite",
      fts: this.ftsReady,
    };
  }

  // SQLite 版即时落盘, 这两个方法保留只为接口对齐
  save() { return this; }
  flush() { return this; }
  rebuildIndex() { return 0; }

  close() {
    try { this.db.close(); } catch { /* 已关闭 */ }
  }
}

// 余弦相似度 (与 fact-store 同口径)
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export default SqliteFactStore;
