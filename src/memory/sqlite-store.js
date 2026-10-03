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

// node:sqlite 用**惰性 require** 加载, 不做静态 import ——
// 静态 import 会在任何 import 了本模块的进程里立刻加载 node:sqlite,
// 从而让"完全没用到 SQLite 后端"的场景也弹出 ExperimentalWarning。
// 改为首次真正打开数据库时才解析, 不使用 SQLite 的进程零感知。
const require = createRequire(import.meta.url);

export const LAYER_L1 = 1;
export const LAYER_L4 = 4;
export const SCHEMA_VERSION = 1;

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
      ...normOpts,
    };
    this.embedder = null;
    this._embedCache = new Map();
    this._open();
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
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(status);
      CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope);
      CREATE INDEX IF NOT EXISTS idx_facts_layer ON facts(layer);
      CREATE INDEX IF NOT EXISTS idx_facts_norm ON facts(norm_key);
      CREATE INDEX IF NOT EXISTS idx_facts_access ON facts(last_access);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
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
      deletedReason: r.deleted_reason,
      meta: r.meta ? JSON.parse(r.meta) : null,
    };
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
    layer = LAYER_L1, ttlDays = null,
  } = {}) {
    const clean = this._norm(content);
    if (!clean) return null;
    const key = this._normKey(clean);

    if (dedupe && key) {
      const hit = this.db.prepare(
        "SELECT * FROM facts WHERE norm_key = ? AND status = 'active' AND (scope IS ? OR scope = ?) LIMIT 1",
      ).get(key, scope, scope);
      if (hit) {
        this.db.prepare(
          "UPDATE facts SET hits = hits + 1, score = score + ?, last_access = ? WHERE id = ?",
        ).run(this.opts.hitBonus, Date.now(), hit.id);
        this._ftsUpsert({ id: hit.id, content: hit.content });
        return this._row2fact(this.db.prepare("SELECT * FROM facts WHERE id = ?").get(hit.id));
      }
    }

    if (similarThreshold > 0) {
      const sim = this.findSimilar(clean, { threshold: similarThreshold, scope });
      if (sim) {
        this.db.prepare("UPDATE facts SET hits = hits + 1, score = score + ?, last_access = ? WHERE id = ?")
          .run(this.opts.hitBonus, Date.now(), sim.id);
        return sim;
      }
    }

    const f = {
      id: cryptoRandomId(),
      content: clean,
      normKey: key,
      // 切分结果随行落库: 查询精排时直接读, 避免对每条候选重复切分 (实测这是查询慢 50x 的主因)
      toks: tokenize(clean).join(" "),
      type, source,
      importance: Number(importance) || this.opts.baseImportance,
      score: Number(importance) || this.opts.baseImportance,
      created: Date.now(),
      lastAccess: Date.now(),
      hits: 0,
      scope,
      layer: Number(layer) || LAYER_L1,
      status: "active",
      ttlDays: ttlDays == null ? null : Number(ttlDays),
      meta: meta ? JSON.stringify(meta) : null,
    };
    this.db.prepare(`
      INSERT INTO facts(id,content,norm_key,toks,type,source,importance,score,created,last_access,hits,scope,layer,status,ttl_days,meta)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(f.id, f.content, f.normKey, f.toks, f.type, f.source, f.importance, f.score, f.created, f.lastAccess, f.hits, f.scope, f.layer, f.status, f.ttlDays, f.meta);

    this._ftsUpsert({ id: f.id, content: f.content });
    this._prune();
    return this._row2fact(this.db.prepare("SELECT * FROM facts WHERE id = ?").get(f.id));
  }

  addMemory(message) {
    return this.add(message, { source: "message", type: "message" });
  }

  // 容量裁剪: 超 maxFacts 时按「衰减分 × 重要性」淘汰最弱 (与 JSON 版同口径)
  _prune() {
    const max = Number(this.opts.maxFacts);
    if (!max || max <= 0) return 0;
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE status = 'active'").get();
    if (n <= max) return 0;
    const now = Date.now();
    const rows = this.db.prepare("SELECT * FROM facts WHERE status='active'").all();
    const ranked = rows.map((r) => {
      const days = Math.max(0, (now - r.last_access) / 86400000);
      const eff = this._decay(r.score, days, r.layer) * (0.5 + 0.5 * Math.min(r.importance || 0, 20) / 20);
      return { id: r.id, eff };
    }).sort((a, b) => a.eff - b.eff);
    const drop = ranked.slice(0, n - max);
    const del = this.db.prepare("DELETE FROM facts WHERE id = ?");
    for (const d of drop) {
      this._ftsDelete(d.id);
      del.run(d.id);
    }
    return drop.length;
  }

  // ---- 检索 ----
  // 粗召回走 FTS5 (C 实现, 远快于内存全扫), 精排复用 JSON 版公式, 保证结果口径一致
  query(q, { limit = 5, minScore = 1, scope = null } = {}) {
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
          SELECT f.id, f.content, f.toks, f.type, f.source, f.importance, f.score,
                 f.created, f.last_access, f.hits, f.scope, f.layer, f.status,
                 f.prev_id, f.superseded_by, f.deleted_reason, f.meta
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

  queryMulti(queries, { limit = 5, scope = null, minScore = 1 } = {}) {
    const lists = (queries || []).filter(Boolean).map((q) => this.query(q, { limit: Math.max(limit * 2, 10), scope, minScore }));
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
  }

  async _embed(text) {
    if (!this.embedder) return null;
    if (this._embedCache.has(text)) return this._embedCache.get(text);
    try {
      const v = await this.embedder(text);
      if (Array.isArray(v) && v.length) {
        if (this._embedCache.size > 1000) this._embedCache.clear();
        this._embedCache.set(text, v);
        return v;
      }
    } catch { /* 向量化失败回落词法检索 */ }
    return null;
  }

  async querySemantic(q, { limit = 5, scope = null } = {}) {
    const lexical = this.query(q, { limit: limit * 2, scope });
    if (!this.embedder) return lexical.slice(0, limit);
    const qv = await this._embed(q);
    if (!qv) return lexical.slice(0, limit);
    const rows = this.db.prepare("SELECT * FROM facts WHERE status='active' AND (? IS NULL OR scope = ?) LIMIT 500").all(scope, scope);
    const dense = [];
    for (const r of rows) {
      const v = await this._embed(r.content);
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
  forget(idOrContent, { reason = null } = {}) {
    const key = String(idOrContent || "");
    let row = this.db.prepare("SELECT * FROM facts WHERE id = ?").get(key);
    if (!row) row = this.db.prepare("SELECT * FROM facts WHERE norm_key = ? AND status='active' LIMIT 1").get(this._normKey(key));
    if (!row) return null;
    // 已软删则不覆盖原 reason (幂等)
    if (row.status !== "deleted") {
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
    const content = patch.content != null ? this._norm(patch.content) : row.content;
    if (!content) return null;
    // 版本链: 旧条归档 + 新条指回 (只保留一层历史, 与 JSON 版一致)
    const newId = cryptoRandomId();
    this.db.prepare("UPDATE facts SET status='archived', superseded_by=? WHERE id=?").run(newId, row.id);
    this.db.prepare(`
      INSERT INTO facts(id,content,norm_key,toks,type,source,importance,score,created,last_access,hits,scope,layer,status,prev_id,meta)
      VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?, 'active', ?, ?)
    `).run(
      newId, content, this._normKey(content), tokenize(content).join(" "),
      patch.type ?? row.type, patch.source ?? row.source,
      patch.importance ?? row.importance, patch.importance ?? row.score,
      Date.now(), Date.now(), row.scope, row.layer, row.id, row.meta,
    );
    this._ftsUpsert({ id: newId, content });
    return this._row2fact(this.db.prepare("SELECT * FROM facts WHERE id = ?").get(newId));
  }

  sweepExpired({ ttlDays = 90, layer = null, dryRun = false } = {}) {
    const cutoff = Date.now() - Number(ttlDays) * 86400000;
    const rows = this.db.prepare(
      "SELECT * FROM facts WHERE status='active' AND last_access < ? AND (? IS NULL OR layer = ?)",
    ).all(cutoff, layer, layer);
    if (!dryRun) {
      const st = this.db.prepare("UPDATE facts SET status='deleted', deleted_reason=?, deleted_at=? WHERE id=?");
      for (const r of rows) st.run(`ttl 超期 (${ttlDays}天未访问)`, Date.now(), r.id);
    }
    return { count: rows.length, ids: rows.map((r) => r.id) };
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
    return { version: SCHEMA_VERSION, exportedAt: nowISO(), count: rows.length, facts: rows.map((r) => this._row2fact(r)) };
  }

  importAll(data, { mode = "merge" } = {}) {
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.facts) ? data.facts : []);
    if (mode === "replace") {
      const ids = this.db.prepare("SELECT id FROM facts").all().map((r) => r.id);
      for (const id of ids) this._ftsDelete(id);
      this.db.exec("DELETE FROM facts");
    }
    let added = 0;
    for (const f of list) {
      if (!f || !f.content) continue;
      const exists = this.db.prepare("SELECT id FROM facts WHERE norm_key = ? LIMIT 1").get(this._normKey(f.content));
      if (exists && mode === "merge") continue;
      this.add(f.content, {
        importance: f.importance, type: f.type, source: f.source,
        scope: f.scope, layer: f.layer, dedupe: false, meta: f.meta,
      });
      added++;
    }
    return { mode, added, total: list.length };
  }

  list({ limit = 50, status = "active" } = {}) {
    return this.db.prepare("SELECT * FROM facts WHERE status = ? ORDER BY last_access DESC LIMIT ?")
      .all(status, limit).map((r) => this._row2fact(r));
  }

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
    const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    return {
      total, active, deleted, archived,
      max_facts: this.opts.maxFacts,
      by_layer: byLayer,
      by_source: bySource,
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
