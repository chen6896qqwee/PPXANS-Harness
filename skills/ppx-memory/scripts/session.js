// ppx-memory session - 会话持久化 (解决"会话仅内存存储重启丢失历史")
// 每个 sessionKey 一个 JSONL 文件, 落盘到 <data>/sessions/<key>.jsonl
import fs from "node:fs";
import path from "node:path";
import { ensureDir, logicalDay } from "./store.js";

const MAX_TURNS = 200;   // 单会话最多轮数
const MAX_TURN_CHARS = 2000; // 单条消息截断

export class SessionStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "sessions");
    ensureDir(this.dir);
  }

  _file(key) {
    const safe = String(key || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.dir, safe + ".jsonl");
  }

  // 追加一轮对话到会话
  push(key, { role, content, ts = Date.now() } = {}) {
    const f = this._file(key);
    const line = JSON.stringify({
      role, content: String(content || "").slice(0, MAX_TURN_CHARS), ts,
    });
    fs.appendFileSync(f, line + "\n", "utf8");
    // 截断超长会话
    const lines = fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
    if (lines.length > MAX_TURNS) {
      fs.writeFileSync(f, lines.slice(-MAX_TURNS).join("\n") + "\n", "utf8");
    }
    return line;
  }

  // 读取会话 (最近 N 轮)
  load(key, limit = 50) {
    const f = this._file(key);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).slice(-limit)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  // 列出所有会话
  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter((f) => f.endsWith(".jsonl")).map((f) => {
      const key = f.replace(/\.jsonl$/, "");
      const p = path.join(this.dir, f);
      const stat = fs.statSync(p);
      const count = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).length;
      return { key, turns: count, lastModified: stat.mtime.toISOString(), day: logicalDay(new Date(stat.mtime)) };
    }).sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  }

  // 清空某会话
  clear(key) {
    const f = this._file(key);
    if (fs.existsSync(f)) fs.unlinkSync(f);
    return true;
  }
}