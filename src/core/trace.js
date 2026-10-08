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
import { logsDir, logicalDay } from "../utils/store.js";
import { shortId } from "../utils/id.js";
import { scrubPII } from "../utils/pii.js";

const als = new AsyncLocalStorage();
const MAX_PAYLOAD = 2000; // 单个字符串字段上限, 防爆文件
const MAX_LINE = MAX_PAYLOAD * 4; // 整行硬上限 (字段都裁过后仍超限才走"骨架行"兜底)

// 载荷裁剪 (2026-10-04 修复): 原实现裁的是"序列化后的整行"再补 "…", 等于把 JSON 从中间剪断 ——
//   这行永远无法 JSON.parse, 大 payload 事件 (工具输出/审批摘要/playbook) 在持久事件流里静默消失,
//   replay/verifyReplay 还会把它们记成 parse 错误。现在只裁"值", 落盘行始终是合法 JSON。
function shrinkPayload(node, cap, depth = 0) {
  if (depth > 6) return "(嵌套过深, 已省略)";
  if (typeof node === "string") return node.length > cap ? node.slice(0, cap) + "…" : node;
  if (Array.isArray(node)) return node.slice(0, 100).map((v) => shrinkPayload(v, cap, depth + 1));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = shrinkPayload(v, cap, depth + 1);
    return out;
  }
  return node;
}

export function genTraceId() {
  return shortId("t_", 8);
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
    this.dir = logsDir(dataDir); // 与 utils/trace.js 同一目录 (logs/traces)
    this.sessionId = shortId("s_", 6);
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
      // ...safe 在 type 之前 (2026-09-18 修复): payload 自带 type 键时不得覆盖埋点事件类型,
      //   否则 events-*.jsonl 中 type 与实际语义不符, 基于 type 的检索/统计失真
      ...shrinkPayload(safe, MAX_PAYLOAD),
      type,
    };
    if (opts.durationMs != null) entry.durationMs = Math.round(opts.durationMs);
    if (opts.error != null) entry.error = String(opts.error).slice(0, 500);
    let line;
    try {
      line = JSON.stringify(entry);
      // 极端情况 (海量小字段堆出来的对象) 兜底: 换成只留事件骨架的一行, 而不是把 JSON 剪断
      if (line.length > MAX_LINE) {
        line = JSON.stringify({
          ts: entry.ts, sessionId: entry.sessionId, traceId: entry.traceId, seq: entry.seq,
          type, _payloadDropped: line.length,
        });
      }
      fs.appendFileSync(this._file(), line + "\n", "utf8");
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
