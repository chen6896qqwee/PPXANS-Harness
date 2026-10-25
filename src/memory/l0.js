// src/memory/l0.js - L0 原始对话记录 (腾讯风格)
// 架构: 会话事件日志 (SessionStore) 为唯一事实源, L0 是其只读派生视图
// 不再独立维护 l0/*.jsonl -- 对话原文由 session 事件日志全量保存, 消除 today/l0/facts 三处重复
// 过滤噪音: 短消息/命令/注入标签 (保留, 用于判断"是否值得记录")
import path from "node:path";
import { ensureDir, logicalDay } from "../utils/store.js";
import { SessionStore, EVENTS } from "./session.js";

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
  // 兼容两种构造: (sessionStore[, dataDir]) 或 (dataDir) -- 后者内部新建 SessionStore
  constructor(sessionStoreOrDir, dataDir) {
    if (sessionStoreOrDir && typeof sessionStoreOrDir.eventsByDay === "function") {
      this.sessionStore = sessionStoreOrDir;
      this.dir = dataDir ? path.join(dataDir, "memory", "l0") : null;
    } else {
      const dir = sessionStoreOrDir;
      this.sessionStore = new SessionStore(dir);
      this.dir = path.join(dir, "memory", "l0");
    }
    if (this.dir) { try { ensureDir(this.dir); } catch {} }
  }

  // 记录: 代理到 session 事件日志 (session 是唯一事实源, 不再独立写 JSONL)
  record({ role, content, sessionKey = "default" } = {}) {
    if (!shouldCapture(content)) return null;
    const type = role === "assistant" ? EVENTS.ASSISTANT : EVENTS.USER;
    return this.sessionStore.append(sessionKey, type, { content: String(content).slice(0, 4000) });
  }

  // 读取某天的对话 (从 session 事件按天派生, 最近 N 条)
  read(day = logicalDay(), limit = 50) {
    return this.sessionStore.eventsByDay(day)
      .map((r) => ({ role: r.role, content: r.content, sessionKey: r.sessionKey, timestamp: r.timestamp }))
      .slice(-limit);
  }

  count() {
    return this.sessionStore.eventsByDay(logicalDay()).length;
  }
}
