// src/selfcode/ledger.js — 自改账本 + 改动前内容备份 (2026-10-27)
//
// 定位: 「皮皮虾改自己的代码」这件事必须**有账可查、可回滚**。零 LLM、纯文件、零依赖。
//
// 目录布局 (dataDir/selfcode/):
//   ledger.jsonl          一行一条自改记录 (append-only, 永不重写)
//   backups/<id>/<n>.bak  该次自改前的原文件内容 (按序编号, 清单在记录的 files[] 里)
//   pending-reload.json   已落盘但尚未生效的改动清单 (进程重启即自然生效)
//
// 为什么单独备份而不复用 edit/snapshot.js: snapshot 是内存态, 随进程走。
// 自改跨会话、跨进程 —— 账本必须能活过重启, 否则"改坏了"就真的回不去了。
import fs from "node:fs";
import path from "node:path";

// 单文件备份上限 2MB: 超了不备份但整次自改被拒 (宁可拒绝, 不留"改得进、退不回"的局面)
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class SelfCodeLedger {
  constructor({ dataDir } = {}) {
    this.dataDir = dataDir || path.join(process.cwd(), "data");
    this.dir = path.join(this.dataDir, "selfcode");
    this.ledgerFile = path.join(this.dir, "ledger.jsonl");
    this.backupRoot = path.join(this.dir, "backups");
    this.pendingFile = path.join(this.dir, "pending-reload.json");
  }

  _ensure() {
    fs.mkdirSync(this.backupRoot, { recursive: true });
  }

  nextId() {
    return "sc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  // 备份改动前的文件内容。files: [{path, content|null}] (null = 该文件此前不存在)
  // 返回 { ok, id, count, files, skipped[] }
  backup(id, files = []) {
    this._ensure();
    const dir = path.join(this.backupRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = [];
    const skipped = [];
    files.forEach((f, i) => {
      const abs = f.path;
      if (f.content === null || f.content === undefined) {
        manifest.push({ path: abs, existed: false, bak: null, bytes: 0 });
        return;
      }
      const bytes = Buffer.byteLength(f.content, "utf8");
      if (bytes > MAX_FILE_BYTES) {
        skipped.push({ path: abs, reason: `超过备份上限 ${MAX_FILE_BYTES} 字节` });
        manifest.push({ path: abs, existed: true, bak: null, bytes });
        return;
      }
      const name = String(i).padStart(3, "0") + ".bak";
      fs.writeFileSync(path.join(dir, name), f.content, "utf8");
      manifest.push({ path: abs, existed: true, bak: name, bytes });
    });
    return { ok: skipped.length === 0, id, count: manifest.length, files: manifest, skipped };
  }

  // 读某次自改的备份内容, 供 rewind
  readBackup(id, entry) {
    if (!entry || !entry.bak) return null;
    const p = path.join(this.backupRoot, id, entry.bak);
    try { return fs.readFileSync(p, "utf8"); } catch { return null; }
  }

  append(record) {
    this._ensure();
    fs.appendFileSync(this.ledgerFile, JSON.stringify(record) + "\n", "utf8");
    return record;
  }

  all() {
    try {
      return fs.readFileSync(this.ledgerFile, "utf8").split("\n").filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  tail(n = 10) {
    const rows = this.all();
    return rows.slice(-Math.max(1, n));
  }

  get(id) {
    return this.all().find((r) => r.id === id) || null;
  }

  latest() {
    const rows = this.all();
    return rows.length ? rows[rows.length - 1] : null;
  }

  // ---- 待生效清单 ----
  // 自改代码落盘后, 进程内 ESM 模块不会热替换 —— 记进 pending, 重启即生效。
  // 这不是妥协, 是诚实的边界: 谎称"已生效"比要求重启危险得多。
  markPending(files = [], id = null) {
    this._ensure();
    const cur = this.readPending();
    const set = new Set(cur.files || []);
    for (const f of files) set.add(f);
    const next = { files: [...set], updatedAt: new Date().toISOString(), lastId: id || cur.lastId || null };
    fs.writeFileSync(this.pendingFile, JSON.stringify(next, null, 2), "utf8");
    return next;
  }

  readPending() {
    try { return JSON.parse(fs.readFileSync(this.pendingFile, "utf8")) || { files: [] }; } catch { return { files: [] }; }
  }

  clearPending() {
    try { fs.unlinkSync(this.pendingFile); return true; } catch { return false; }
  }
}
