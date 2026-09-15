// src/memory/l0.js - L0 原始对话记录 (腾讯风格)
// 每日一个 JSONL 文件, 每条消息一行, 含 sessionKey/时间戳/角色
// 过滤噪音: 短消息/命令/注入标签
import fs from "node:fs";
import path from "node:path";
import { ensureDir, logicalDay } from "./store.js";

// 短消息/命令/噪音过滤
function shouldCapture(content) {
  const c = String(content || "").trim();
  if (!c) return false;
  if (c.length < 2) return false;                       // 太短
  if (/^(\/|!|\.)/.test(c)) return false;               // 命令
  if (c.length < 3) return false;                           // 太短(含2字寒暄)
  if (["你好","您好","在吗","哈喽","拜拜","再见","晚安","早上好","下午好","晚上好"].includes(c)) return false; // 纯寒暄
  if (/\b(hi|hello|ok|thanks)\b/i.test(c) && c.length < 8) return false;
  return true;
}

export class L0Recorder {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "memory", "l0");
    ensureDir(this.dir);
  }

  _file() {
    return path.join(this.dir, `${logicalDay()}.jsonl`);
  }

  record({ role, content, sessionKey = "default" }) {
    if (!shouldCapture(content)) return null;
    const line = JSON.stringify({
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      role,
      content: String(content).slice(0, 4000),
      sessionKey,
      timestamp: Date.now(),
    });
    fs.appendFileSync(this._file(), line + "\n", "utf8");
    return line;
  }

  // 读取某天的原始对话 (最近 N 条)
  read(day = logicalDay(), limit = 50) {
    const file = path.join(this.dir, `${day}.jsonl`);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  count() {
    const file = this._file();
    if (!fs.existsSync(file)) return 0;
    try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length; } catch { return 0; }
  }
}