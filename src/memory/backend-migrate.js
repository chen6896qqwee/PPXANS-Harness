// src/memory/backend-migrate.js — 记忆后端切换的一次性迁移 (v2026-10-04, sqlite parity #3)
//
// 背景: L1 事实有两个等价后端 (fact-store.js JSON / sqlite-store.js SQLite), config.memory.backend
// 可切换。但直接翻转配置会让旧后端的数据"看起来消失了"。此处提供首次使用时的单向导入:
//   目标后端为空 + 源后端数据文件存在 → 一次性导入 (保留 id/时间戳/status/scope/版本链/TTL 时效窗口)。
// 约束: 目标非空绝不覆盖; 全程 best-effort, 永不抛错 (迁移失败不阻塞正常读写)。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { readJson } from "../utils/store.js";
import { debug, info } from "../utils/logger.js";

// node:sqlite 惰性 require: 纯 JSON 后端进程不应因加载本模块触发 ExperimentalWarning
const require = createRequire(import.meta.url);

const iso = (ms) => (typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

// ---- json → sqlite ----
// store: SqliteFactStore 实例 (构造末尾调用)。facts.json 是纯数组基线 (healer 契约), 直接读。
export function importJsonIntoSqlite(store) {
  try {
    if (store.count() > 0) return 0; // 目标非空: 不碰
    const file = path.join(store.dir, "facts.json");
    if (!fs.existsSync(file)) return 0;
    const items = readJson(file, []);
    if (!Array.isArray(items) || !items.length) return 0;
    const r = store.importAll({ items }, { mode: "merge" });
    if (r && r.ok && r.imported) {
      info(`[memory/backend-migrate] 后端切换 json→sqlite: 一次性导入 ${r.imported} 条事实 (源: ${file})`);
      return r.imported;
    }
  } catch (e) {
    debug(`[memory/backend-migrate] json→sqlite 迁移跳过 (best-effort): ${e && e.message ? e.message : e}`);
  }
  return 0;
}

// ---- sqlite → json ----
// store: FactStore 实例 (构造末尾调用, 仅当内存 facts 为空且未损坏时)。
// 不 import sqlite-store (避免模块环), 直接以 node:sqlite 读原始行。
export function importSqliteIntoJson(store) {
  let db = null;
  try {
    if (store.facts.length > 0) return 0; // 目标非空: 不碰
    const file = path.join(store.dir, "facts.db");
    if (!fs.existsSync(file)) return 0;
    const { DatabaseSync } = require("node:sqlite");
    try {
      db = new DatabaseSync(file, { readOnly: true });
    } catch {
      db = new DatabaseSync(file); // 只读打开失败 (如 WAL 附属文件缺失) → 普通打开只查不写
    }
    const rows = db.prepare("SELECT * FROM facts").all();
    if (!rows.length) return 0;
    const items = rows.map((r) => {
      let meta = null;
      try { meta = r.meta ? JSON.parse(r.meta) : null; } catch { meta = null; }
      return {
        id: r.id, content: r.content, type: r.type, source: r.source,
        // 来源分级逐字带过去 (v2026-10-XX): 后端切换不是洗白通道, 也不是降级通道 ——
        //   缺列/空值 (分级上线前的旧 db) 由 importAll→_normalizeFact 按 source 登记表回退。
        ...(r.provenance ? { provenance: r.provenance } : {}),
        importance: r.importance, score: r.score,
        created: iso(r.created), lastAccess: iso(r.last_access), hits: r.hits,
        scope: r.scope ?? null, layer: r.layer, status: r.status,
        prevId: r.prev_id ?? null, supersededBy: r.superseded_by ?? null,
        deleteReason: r.deleted_reason ?? null, deletedAt: iso(r.deleted_at),
        ttlDays: r.ttl_days ?? null, validFrom: iso(r.valid_from), validTo: iso(r.valid_to),
        meta,
      };
    });
    const r = store.importAll({ items }, { mode: "merge" });
    if (r && r.ok && r.imported) {
      info(`[memory/backend-migrate] 后端切换 sqlite→json: 一次性导入 ${r.imported} 条事实 (源: ${file})`);
      return r.imported;
    }
  } catch (e) {
    debug(`[memory/backend-migrate] sqlite→json 迁移跳过 (best-effort): ${e && e.message ? e.message : e}`);
    return 0;
  } finally {
    try { db && db.close(); } catch { /* 已关闭 */ }
  }
  return 0;
}
