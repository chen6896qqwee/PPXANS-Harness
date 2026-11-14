// src/workgraph/journal.js - 工单账本的可替换落盘后端 (2026-11-05 Step 9)
//
// 账本的内存态一直由 append-only 事实折叠而来 (store.js 的 _apply)。本文件只把
// "读到全部事实 / 追加一条 / 压缩重写 / 关闭" 抽成后端接口，让事实存储可替换：
//   - jsonl  (默认): 逐行 JSON 追加到 tickets.jsonl —— 行为与抽离前逐字一致；
//   - sqlite: node:sqlite 单表 journal(seq, at, body)，WAL 模式，事务内压缩。
//
// 边界: 只覆盖工单账本 (tickets/assignments)；检查点是 per-assignment 旁路文件，
//   任何后端下仍是 checkpoints/<assignmentId>.jsonl。切换后端不迁移旧数据 ——
//   换后端等于换账本位置，旧文件原样保留，不删除、不自动导入。
//
// node:sqlite 惰性解析 (与 memory/sqlite-store.js 同款): 默认 jsonl 的进程零感知，
//   Node < 22.5 只在显式选择 sqlite 时才报一条可读错误，而不是 import 期崩溃。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { noteCatch } from "../utils/catch-log.js";

const require = createRequire(import.meta.url);

const BACKENDS = Object.freeze(["jsonl", "sqlite"]);

function createJsonlJournal({ dir }) {
  const file = path.join(dir, "tickets.jsonl");

  function read() {
    if (!fs.existsSync(file)) return { records: [], lines: 0 };
    const records = [];
    let lines = 0;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      lines += 1;
      try { records.push(JSON.parse(s)); } catch { /* swallowed-ok(2026-11-05): 坏行跳过, 折叠口径与抽离前一致 */ }
    }
    return { records, lines };
  }

  function append(rec) {
    fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
  }

  // 压缩: 折叠结果写成快照后原子替换 (临时文件 + rename, 不留半截日志)。
  function rewrite(records) {
    const tmp = `${file}.${process.pid}.tmp`;
    const out = records.map((r) => JSON.stringify(r));
    fs.writeFileSync(tmp, out.length ? out.join("\n") + "\n" : "", "utf8");
    fs.renameSync(tmp, file);
  }

  return { kind: "jsonl", path: file, read, append, rewrite, close() {} };
}

function createSqliteJournal({ dir, now }) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (e) {
    throw new Error(`workgraph: state_backend=sqlite 需要 Node >= 22.5 (node:sqlite) — ${e?.message || e}`);
  }
  const file = path.join(dir, "tickets.sqlite3");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS journal (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        body TEXT NOT NULL
      )
    `);
  } catch (e) {
    try { db.close(); } catch { /* swallowed-ok(2026-11-05): 打开失败后的关闭失败不再覆盖原错误 */ }
    throw e;
  }
  const selectAll = db.prepare("SELECT body FROM journal ORDER BY seq");
  const insertOne = db.prepare("INSERT INTO journal (at, body) VALUES (?, ?)");
  const deleteAll = db.prepare("DELETE FROM journal");
  let closed = false;

  function read() {
    const rows = selectAll.all();
    const records = [];
    for (const row of rows) {
      try { records.push(JSON.parse(row.body)); } catch { /* swallowed-ok(2026-11-05): 坏行跳过, 与 jsonl 同口径 */ }
    }
    return { records, lines: rows.length };
  }

  function append(rec) {
    insertOne.run(Number(rec?.at) || now(), JSON.stringify(rec));
  }

  // 压缩: 同一事务内清空 + 写回折叠快照；失败整体回滚, 不会留下半份账本。
  function rewrite(records) {
    db.exec("BEGIN IMMEDIATE");
    try {
      deleteAll.run();
      for (const r of records) insertOne.run(Number(r?.at) || now(), JSON.stringify(r));
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch (e2) { noteCatch("src/workgraph/journal.js#rewrite", e2); /* 回滚失败不覆盖原始错误 */ }
      throw e;
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    db.close();
  }

  return { kind: "sqlite", path: file, read, append, rewrite, close };
}

/**
 * 按 kind 打开账本后端。未知值直接报错 (不静默回落) —— 配错后端却以为数据落在
 * 指定位置, 比启动失败更危险。
 */
export function createJournal({ dir, kind = "jsonl", now = Date.now } = {}) {
  const k = String(kind || "jsonl").trim().toLowerCase();
  if (!BACKENDS.includes(k)) {
    throw new Error(`workgraph: 未知 state_backend "${kind}" (支持 ${BACKENDS.join("|")})`);
  }
  return k === "sqlite" ? createSqliteJournal({ dir, now }) : createJsonlJournal({ dir, now });
}

export { BACKENDS };
