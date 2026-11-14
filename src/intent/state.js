// src/intent/state.js - 意图漏斗的会话状态与层流量统计 (v4.2, 2026-11-01)
// 职责 (视频"上下文层"的状态管理要求 —— 状态比模型本身更重要):
//   1) 每会话轻状态: lastUserMsg / lastIntent / lastLayer / turns —— L2 判断"延续还是新任务"的依据。
//      任务本体 (taskType/slots) 不在这里重复维护: WorkStack 是任务栈的唯一事实源, 漏斗只读。
//   2) 层流量统计: rule / context / llm 三层各接了多少请求, 落盘 <dataDir>/intent-state.json +
//      <dataDir>/intent-stats.json, 重启不丢 —— 漏斗是否健康 (大部分流量应在 rule/context 消化,
//      进入 LLM 层的保持较低比例) 用数据说话。
// 原则: 任何 IO 失败静默吞掉, 绝不因观测层故障阻断主链路。

import { noteCatch } from "../utils/catch-log.js";
import fs from "node:fs";
import path from "node:path";

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 会话状态 7 天过期 (过期即视为新任务)
const MAX_SESSIONS = 200;                     // 状态条目上限 (防 Map 无界增长)

export class IntentFunnelState {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, "intent-state.json");
    this.statsFile = path.join(dataDir, "intent-stats.json");
    this.sessions = this._read(this.file, {});
    this.stats = this._read(this.statsFile, { rule: 0, context: 0, llm: 0, total: 0 });
  }

  _read(file, fallback) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const j = JSON.parse(raw);
      return j && typeof j === "object" ? j : fallback;
    } catch { return fallback; }
  }

  _write(file, data) {
    const body = JSON.stringify(data, null, 2);
    // 每轮 recordTurn 要写 2 个文件; 目录在构造期/首次写之后就一直存在, 常态不必每轮再
    // mkdirSync (Windows 上比一次 writeFileSync 还慢)。缺目录 (首次/被外部删) 才补建重试。
    try {
      fs.writeFileSync(file, body, "utf8");
    } catch (e) {
      if (!e || e.code !== "ENOENT") { noteCatch("src/intent/state.js#_write", e); return; }
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(file, body, "utf8");
      } catch (e2) { noteCatch("src/intent/state.js#_write", e2); /* 观测层绝不抛 */ }
    }
  }

  /** 取某会话状态 (过期/缺失返回 null —— 过期状态等同于"没有上下文", 不得误导 L2) */
  get(sessionKey) {
    const s = this.sessions[sessionKey];
    if (!s) return null;
    if (Date.now() - (s.updatedAt || 0) > SESSION_TTL_MS) return null;
    return s;
  }

  /** 每轮记录一次: 更新会话状态 + 层计数 + 落盘 (文件极小, 直写; 低频调用无 IO 压力) */
  recordTurn(sessionKey, { userMsg, layer, intent } = {}) {
    try {
      const now = Date.now();
      // 会话状态 (截断防膨胀: 只存判断连续性所需的最小信息)
      this.sessions[sessionKey] = {
        lastUserMsg: String(userMsg || "").slice(0, 200),
        lastIntent: intent || null,
        lastLayer: layer || null,
        turns: ((this.sessions[sessionKey] || {}).turns || 0) + 1,
        updatedAt: now,
      };
      // LRU: 超 MAX_SESSIONS 时淘汰最旧
      const keys = Object.keys(this.sessions);
      if (keys.length > MAX_SESSIONS) {
        keys.sort((a, b) => (this.sessions[a].updatedAt || 0) - (this.sessions[b].updatedAt || 0));
        while (keys.length > MAX_SESSIONS) delete this.sessions[keys.shift()];
      }
      // 层计数
      if (["rule", "context", "llm"].includes(layer)) {
        this.stats[layer] = (this.stats[layer] || 0) + 1;
        this.stats.total = (this.stats.total || 0) + 1;
      }
      this._write(this.file, this.sessions);
      this._write(this.statsFile, this.stats);
    } catch (e) { noteCatch(e); /* 静默 */ }
  }

  /** 观测快照: 三层流量 + 占比 (供 GET /api/intent/stats 与 ppx doctor) */
  snapshot() {
    const s = this.stats || {};
    const total = s.total || 0;
    const pct = (n) => (total > 0 ? Math.round(((n || 0) / total) * 100) : null);
    return {
      byLayer: { rule: s.rule || 0, context: s.context || 0, llm: s.llm || 0 },
      pct: { rule: pct(s.rule), context: pct(s.context), llm: pct(s.llm) },
      total,
      sessions: Object.keys(this.sessions || {}).length,
    };
  }

  /** 兼容旧名 (agent 里有的地方想要 stats()) */
  stats() { return this.snapshot(); }
}
