// src/core/trace.js - 结构化事件流 (重构第三刀, 2026-09-14)
// 目的: 给关键路径 (记忆升降级/工具失败/Agent spawn/自愈触发) 提供 traceId 贯穿的事件流,
//       作为后续「记忆+学习服务化」重构的行为等价验证基础设施。
// 设计:
//   - AsyncLocalStorage (node:async_hooks 原生, 零依赖) 贯穿 traceId: 一次 chat/chatStream
//     入口生成 traceId, 所有深层异步调用 (记忆提炼/压缩/检索/自愈/spawn) 自动继承, 无需手动传参。
//   - EventTracer 写 data/logs/traces/events-YYYY-MM-DD.jsonl (与工具轨迹 traces/ 同目录, 独立文件),
//     每条事件带 traceId/sessionId/seq/ts/type/payload, payload 落盘前 PII 脱敏。
//   - span() 包装子操作自动记录耗时, 失败自动带 error。
// 与 src/utils/trace.js (工具调用专用轨迹) 互补: 工具轨迹保留原结构不动, 事件流只做横切补充。
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, logicalDay } from "../utils/store.js";
import { scrubPII } from "../utils/pii.js";

const als = new AsyncLocalStorage();
const MAX_PAYLOAD = 2000; // 单条事件载荷上限, 防爆文件

export function genTraceId() {
  return "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 入口包装: 生成新 traceId, 所有异步子调用自动继承
// meta 可带 { sessionKey, channel, userMsg } 等上下文, 存于 ALS store
export function runWithTrace(fn, meta = {}) {
  const store = { traceId: genTraceId(), ...meta, t0: Date.now() };
  return als.run(store, fn);
}

// 任意深层调用取当前 traceId (无入口上下文时返回 null, 事件照记不丢)
export function currentTrace() {
  return als.getStore() || null;
}

// 当前 trace 是否存在 (测试用)
export function hasTrace() {
  return !!als.getStore();
}

// ---- 事件流写入器 (agent 构造时实例化一个, 全局复用) ----
export class EventTracer {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "logs", "traces");
    ensureDir(this.dir);
    this.sessionId = "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.count = 0;
  }

  _file(day = logicalDay()) { return path.join(this.dir, `events-${day}.jsonl`); }

  // 记录一条结构化事件。payload 对象落盘前序列化 + PII 脱敏。
  // 自动附加: ts/sessionId/traceId(ALS 继承)/seq/type/durationMs(可选)
  event(type, payload = {}, opts = {}) {
    const store = als.getStore();
    this.count += 1;
    let safe = {};
    try { safe = JSON.parse(scrubPII(JSON.stringify(payload ?? {})).cleaned); } catch { safe = { _raw: "(unserializable)" }; }
    const entry = {
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      traceId: store?.traceId || null,
      seq: this.count,
      type,
      ...safe,
    };
    if (opts.durationMs != null) entry.durationMs = Math.round(opts.durationMs);
    if (opts.error != null) entry.error = String(opts.error).slice(0, 500);
    const line = JSON.stringify(entry);
    try {
      fs.appendFileSync(this._file(), (line.length > MAX_PAYLOAD * 4 ? line.slice(0, MAX_PAYLOAD * 4) + "…" : line) + "\n", "utf8");
    } catch (e) { /* 事件写入失败不影响主流程 (可观测性降级不阻塞 agent) */ }
    return entry;
  }

  // 包装子操作: 自动记录 type 事件 + 耗时, fn 抛错时事件带 error 并重抛
  // 用法: await tracer.span("memory/extract", async () => {...})
  async span(type, fn, payload = {}) {
    const t0 = Date.now();
    try {
      const r = await fn();
      this.event(type, { ...payload, ok: true }, { durationMs: Date.now() - t0 });
      return r;
    } catch (e) {
      this.event(type, { ...payload, ok: false }, { durationMs: Date.now() - t0, error: e?.message || String(e) });
      throw e;
    }
  }
}
