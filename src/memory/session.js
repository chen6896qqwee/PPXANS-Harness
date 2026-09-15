// src/memory/session.js - 会话事件日志 (吸收 dsh "会话即唯一事实源")
// 新架构: 不可变 append-only 事件日志, 每条 = {seq, ts, type, data}
//  - 模型可见历史 = deriveMessages() 从日志投影 (无可变状态, 仅从日志重建)
//  - replay() 回放完整事件流 | fork() 从边界派生新会话
//  - 兼容旧 get/set/has/delete 接口 (agent 无需全量改动)
// 吸收自 DeepSeek Harness: "model-visible means logged" (能进模型的必须能从日志重建)
//
// v1.1.x 第九轮 review P2: default 主会话按天分片 (default-YYYY-MM-DD.jsonl),
// 单文件不再无限增长。设计要点:
//  - 仅 key === "default" 走按天分片; 非 default 会话保持单文件 (不扩散改动面)
//  - 命名: default-YYYY-MM-DD.jsonl (取事件 ts 所在本地自然日, 与 eventsByDay/logicalDay 一致)
//  - 兼容旧文件: 若历史遗留 default.jsonl, 读取时纳入合并, 不丢历史
//  - seq 跨天连续递增: 同一 default 会话所有分片共用一个 seq 序列, 不从 1 重头数
//    (否则 compaction 的 upToSeq / fork / replay 会错乱)
//  - 所有读取路径把多天分片合并成按 seq(ts) 升序的单一事件流
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../utils/store.js";

// 事件类型集 (对齐 dsh 事件域: user/assistant/tool/system)
export const EVENTS = {
  USER: "user/message",
  ASSISTANT: "assistant/message",
  SYSTEM: "system",
  TOOL_CALL: "tool/call",
  TOOL_RESULT: "tool/result",
  COMPACTION: "compaction/summary",
};

// default 会话按天分片: default-YYYY-MM-DD.jsonl
const DEFAULT_SHARD_RE = /^default-\d{4}-\d{2}-\d{2}\.jsonl$/;

export class SessionStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "sessions");
    ensureDir(this.dir);
    this._logs = new Map();    // key -> event[] (不可变, append-only)
    this._nextSeq = new Map(); // key -> 下一个 seq
    this._flushedSeq = new Map(); // key -> 已落盘的最大 seq (增量追加用)
    this._loadAll();
    // --- 派生缓存 (v1.1.1 性能优化) ---
    // eventsByDay / deriveCompacted 在每一轮/每一工具轮都被调用, 旧实现每次全量扫描 O(T)。
    // 事件日志是 append-only 不可变, 一个 key 的 events 数组只增不改（set/rename/fork 会换新数组）。
    //   · deriveCompacted: 以"数组引用标识"做增量缓存——数组没换就只把尾部新事件追加进 msgs, 命中 O(Δ)；
    //     数组被替换(重命名/重建)则重算。compaction 事件追加时检测到也整体重算（它会重投影历史）。
    //   · eventsByDay: 版本门控的全库按天缓存, 版本变化时整库重扫一次（每轮兜底, 仍远优于每次 O(T)）。
    this._version = 0;                  // 全局版本: 任何 write 递增
    this._dayCache = new Map();         // day -> 该天结果 (当期 version)
    this._dayCacheAt = 0;               // 生成该缓存时的 _version
    // deriveCompacted 增量缓存: key -> { arrRef, msgs, lastCompSeq }
    this._compactedCache = new Map();
  }

  _bump() { this._version += 1; }

  _safe(key) { return String(key || "default").replace(/[^\w.-]/g, "_"); }
  // 旧单文件路径 (仅非 default 会话使用)
  _file(key) { return path.join(this.dir, this._safe(key) + ".jsonl"); }

  _log(key) {
    const k = this._safe(key);
    if (!this._logs.has(k)) { this._logs.set(k, []); this._nextSeq.set(k, 0); }
    return this._logs.get(k);
  }

  // 判断文件名是否为 default 的日分片
  _isShard(fname) { return DEFAULT_SHARD_RE.test(fname); }
  // default 分片文件路径 (day 形如 YYYY-MM-DD)
  _shardFile(day) { return path.join(this.dir, `default-${day}.jsonl`); }
  // 事件 ts 归属的本地自然日 (与 eventsByDay/logicalDay 一致, 避免时区错位)
  _dayOf(ts) {
    const d = new Date(ts);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  }
  // 列出 default 相关的所有文件 (旧单文件 + 各日分片)
  _defaultFiles() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir)
        .filter((f) => f.endsWith(".jsonl") && (f === "default.jsonl" || this._isShard(f)));
    } catch {}
    return files.map((f) => path.join(this.dir, f));
  }
  _removeDefaultFiles() {
    for (const f of this._defaultFiles()) { try { fs.rmSync(f, { force: true }); } catch {} }
  }

  // 读取单个 jsonl 文件的事件序列
  _readEventsFromFile(file) {
    const events = [];
    try {
      for (const l of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
        try { const e = JSON.parse(l); if (e && e.seq && e.type && e.data) events.push(e); } catch {}
      }
    } catch {}
    return events;
  }

  _loadAll() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".jsonl")); } catch { return; }
    for (const f of files) {
      // default 的旧单文件 + 日分片 → 归并到同一个 key="default"
      if (f === "default.jsonl" || this._isShard(f)) {
        const events = this._readEventsFromFile(path.join(this.dir, f));
        if (events.length) {
          const k = "default";
          const cur = this._logs.get(k) || [];
          this._logs.set(k, cur.concat(events));
        }
        continue;
      }
      const k = f.replace(/\.jsonl$/, "");
      const events = this._readEventsFromFile(path.join(this.dir, f));
      if (events.length) {
        events.sort((a, b) => a.seq - b.seq);
        this._logs.set(k, events);
        this._nextSeq.set(k, events[events.length - 1].seq);
        this._flushedSeq.set(k, events[events.length - 1].seq);
      }
    }
    // default: 跨文件合并后按 seq(ts 兜底) 升序 + 统一 next/flushed seq (跨天连续递增)
    if (this._logs.has("default")) {
      const evs = this._logs.get("default");
      evs.sort((a, b) => a.seq - b.seq || a.ts - b.ts);
      this._nextSeq.set("default", evs[evs.length - 1].seq);
      this._flushedSeq.set("default", evs[evs.length - 1].seq);
    }
  }

  // 追加事件 (唯一写入路径, append-only, 永不重写/裁剪日志文件)
  // ts 可选: 测试/回溯时可注入固定时间戳; 缺省用 Date.now() (向后兼容)
  // 追加事件 (唯一写入路径, append-only, 永不重写/裁剪日志文件)
  // ts 可选: 测试/回溯时可注入固定时间戳; 缺省用 Date.now() (向后兼容)
  // opts.skipFlush: true 时延后落盘 (调用方需随后显式 flush(key) 或下次 append), 用于一次性批量写入
  append(key, type, data, ts, { skipFlush = false } = {}) {
    const k = this._safe(key);
    const seq = (this._nextSeq.get(k) || 0) + 1;
    const ev = { seq, ts: Number.isFinite(ts) ? ts : Date.now(), type, data };
    this._log(k).push(ev);
    this._nextSeq.set(k, seq);
    if (!skipFlush) this._flush(k);
    this._bump(); // 使派生缓存失效
    return ev;
  }

  // 显式落盘: 把 skipFlush 延后的待写事件写入磁盘 (供批量写入后调用)
  flush(key) { this._flush(this._safe(key)); }

  // 从日志投影模型可见历史 (user/assistant), 无可变状态
  deriveMessages(key) {
    return this._log(this._safe(key))
      .filter((e) => e.type === EVENTS.USER || e.type === EVENTS.ASSISTANT)
      .map((e) => ({ role: e.type === EVENTS.USER ? "user" : "assistant", content: e.data?.content }));
  }

  // 投影「压缩后」的模型可见历史: 最后一条 compaction 事件之前 (seq <= upToSeq) 的消息被摘要替换
  // 吸收 OpenClaw compaction: 摘要作为单一 surface node 替换被压缩区间, 日志本身不可变
  // v1.1.1: 增量缓存——数组引用没变时只 O(Δ) 追加尾部消息; 数组被替换或追加 compaction 时整体重算。
  deriveCompacted(key) {
    const k = this._safe(key);
    const evs = this._log(k);
    const cached = this._compactedCache.get(k);
    // 数组引用未变 (append-only 稳定), 且无新 compaction: 只把尾部新 user/assistant 追加进 msgs
    if (cached && cached.arrRef === evs) {
      if (cached.consumed === evs.length) return cached.msgs; // 无新增, 直接命中
      // 检查新增区间是否含 compaction (compaction 会重投影历史, 需整体重算)
      for (let i = cached.consumed; i < evs.length; i++) {
        if (evs[i].type === EVENTS.COMPACTION) return this._deriveCompactedFrom(evs, k);
      }
      // 只有 user/assistant 追加: 把可见的尾部消息追加进 msgs
      for (let i = cached.consumed; i < evs.length; i++) {
        const e = evs[i];
        if (e.type === EVENTS.USER || e.type === EVENTS.ASSISTANT) {
          cached.msgs.push({ role: e.type === EVENTS.USER ? "user" : "assistant", content: e.data?.content });
        }
      }
      cached.consumed = evs.length;
      return cached.msgs;
    }
    // 无缓存 / 数组被替换 (set/rename/fork/delete): 整体重算
    return this._deriveCompactedFrom(evs, k);
  }

  _deriveCompactedFrom(evs, k) {
    let lastComp = null;
    for (const e of evs) if (e.type === EVENTS.COMPACTION) lastComp = e;
    const upToSeq = lastComp?.data?.upToSeq || 0;
    const msgs = [];
    let consumed = 0;
    if (lastComp?.data?.summary) {
      msgs.push({ role: "system", content: String(lastComp.data.summary) });
    }
    for (const e of evs) {
      consumed++;
      if (e.seq <= upToSeq) continue;
      if (e.type === EVENTS.USER || e.type === EVENTS.ASSISTANT) {
        msgs.push({ role: e.type === EVENTS.USER ? "user" : "assistant", content: e.data?.content });
      }
    }
    this._compactedCache.set(k, { arrRef: evs, msgs, consumed, lastCompSeq: lastComp?.seq || 0 });
    return msgs;
  }

  // 完整事件流 (回放/审计/轨迹)
  replay(key) { return [...this._log(this._safe(key))]; }

  // L0 只读代理 / 按天审计: 遍历所有会话, 派生某天的对话事件 (消除 l0/*.jsonl 重复)
  // v1.1.1: 全库按天缓存, 版本未变则零成本; 保持"本地自然日"语义 (与 _dayOf/logicalDay 一致, 避免时区错位)
  eventsByDay(day) {
    const dayStr = String(day).slice(0, 10);
    const dayMs = new Date(dayStr + "T00:00:00").getTime();
    if (Number.isNaN(dayMs)) return [];
    // 缓存: 版本未变时按 day 命中 (append 后 _bump 使整个缓存失效, 下轮重扫一次)
    if (this._dayCacheAt === this._version && this._dayCache.size) {
      const hit = this._dayCache.get(dayStr);
      if (hit) return hit;
    }
    // 全库扫描一次, 按"事件 ts 的本地自然日"聚合缓存所有天 → 之后所有 eventsByDay 调用都命中
    const byDay = new Map();
    for (const [key, events] of this._logs) {
      for (const e of events) {
        if (e.type !== EVENTS.USER && e.type !== EVENTS.ASSISTANT) continue;
        const d = this._dayOf(e.ts);
        let arr = byDay.get(d);
        if (!arr) { arr = []; byDay.set(d, arr); }
        arr.push({ sessionKey: key, role: e.type === EVENTS.USER ? "user" : "assistant", content: e.data?.content, timestamp: e.ts });
      }
    }
    this._dayCache = byDay;
    this._dayCacheAt = this._version;
    const out = byDay.get(dayStr) || [];
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
  }

  // 返回某自然日的对话事件(带 seq/type/data), 供 memory-ticker 按 seq 去重滚动归档
  // (防止 _compileDaily_Rolling 每次把今日全文再次追加, 造成 longterm 内容重复累积)
  replayDay(day) {
    const dayStr = String(day).slice(0, 10);
    const out = [];
    for (const [, events] of this._logs) {
      for (const e of events) {
        if (e.type !== EVENTS.USER && e.type !== EVENTS.ASSISTANT) continue;
        if (this._dayOf(e.ts) !== dayStr) continue;
        out.push(e);
      }
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  // fork: 从 boundarySeq 及更早派生新会话 (吸收 dsh fork 语义, 保留不可变源)
  fork(fromKey, boundarySeq, toKey) {
    const keep = this._log(this._safe(fromKey)).filter((e) => e.seq <= boundarySeq);
    const k = this._safe(toKey);
    // 目标为 default 时先清掉旧分片, 再按边界重建 (避免 keep 追加到已有同 seq 行造成重复)
    if (k === "default") this._removeDefaultFiles();
    this._logs.set(k, [...keep]);
    this._nextSeq.set(k, keep.length ? keep[keep.length - 1].seq : 0);
    this._flushedSeq.delete(k);
    this._flush(k);
    this._bump();
    return keep;
  }

  // count: 事件条数
  count(key) { return this._log(this._safe(key)).length; }

  // 列出所有会话: {key, count, lastTs, title} (title 取首条 user 消息前 20 字)
  // 供 Web UI 多会话管理 (P1#6)
  list() {
    const out = [];
    for (const [key, events] of this._logs) {
      if (!events.length) continue;
      const firstUser = events.find((e) => e.type === EVENTS.USER);
      const title = firstUser?.data?.content ? String(firstUser.data.content).slice(0, 20) : key;
      out.push({
        key,
        count: events.length,
        lastTs: events[events.length - 1].ts,
        title,
      });
    }
    out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    return out;
  }

  // ---- 兼容旧接口 (agent/CLI 仍可用) ----
  get(key) { return this.deriveMessages(key); }
  set(key, history) {
    const k = this._safe(key);
    // default 为分片存储: 清掉内存前先删旧分片, 保证重建后磁盘与内存一致 (无残留旧文件)
    if (k === "default") this._removeDefaultFiles();
    this._logs.delete(k); this._nextSeq.set(k, 0); this._flushedSeq.delete(k);
    for (const m of (history || [])) this.append(k, m.role === "user" ? EVENTS.USER : EVENTS.ASSISTANT, { content: m.content });
    return history;
  }
  has(key) { return this._logs.has(this._safe(key)); }
  // 重命名会话: 复制事件到新 key 并删除旧 key (保留 seq 顺序) [P1#6]
  rename(fromKey, toKey) {
    const f = this._safe(fromKey), t = this._safe(toKey);
    if (f === t) return false;
    if (!this._logs.has(f)) return false;
    if (this._logs.has(t)) return false; // 目标已存在, 拒绝覆盖防数据丢失 [复审 P1]
    const events = this._logs.get(f);
    this._logs.set(t, [...events]);
    const lastSeq = events.length ? events[events.length - 1].seq : 0;
    this._nextSeq.set(t, lastSeq);
    this._flushedSeq.delete(t);
    this._flush(t);
    this.delete(f);
    this._bump();
    return true;
  }
  delete(key) {
    const k = this._safe(key);
    this._logs.delete(k); this._nextSeq.delete(k); this._flushedSeq.delete(k);
    try {
      if (k === "default") {
        // 删除 default 所有分片 (旧单文件 + 各日 shard)
        this._removeDefaultFiles();
      } else {
        fs.rmSync(this._file(k), { force: true });
      }
    } catch {}
    this._bump();
  }

  // 清理过期会话: 删除超过 maxAgeDays 天未活跃的非 default 会话文件
  // 返回删除的会话 key 列表。default 主会话始终保留 (防误删主对话历史)
  // 分片说明: default 的各日分片在 _logs 中只对应一个 key="default", 不会被误当独立会话删除
  pruneOld({ maxAgeDays = 30, keep = [] } = {}) {
    const now = Date.now();
    const cutoff = now - maxAgeDays * 86400000;
    const keepSet = new Set([...keep, "default"].map((k) => this._safe(k)));
    const removed = [];
    for (const [key, events] of this._logs) {
      if (keepSet.has(key)) continue;
      const lastTs = events.length ? events[events.length - 1].ts : 0;
      if (!lastTs || lastTs < cutoff) {
        this.delete(key);
        removed.push(key);
      }
    }
    return removed;
  }

  // 增量落盘: 只追加 flushedSeq 之后的新事件 (P1#5, 消除大会话全量重写)
  // default 按天落盘: 只把当天分片写到对应 default-YYYY-MM-DD.jsonl, 非当前天文件不再改写
  _flush(key) {
    const k = this._safe(key);
    const evs = this._logs.get(k) || [];
    if (!evs.length) return;
    const flushed = this._flushedSeq.get(k) || 0;
    const pending = evs.filter((e) => e.seq > flushed);
    if (!pending.length) return;
    try {
      if (k === "default") this._flushDaily(pending);
      else this._flushLegacy(k, pending, flushed);
      this._flushedSeq.set(k, evs[evs.length - 1].seq);
    } catch (e) {
      // v1.0.9: 落盘失败不再静默 (磁盘满/权限丢失消息不可见), 至少留日志
      try { console.warn(`[session] 会话 ${k} 落盘失败: ${e.message}`); } catch {}
    }
  }

  // 非 default 会话: 原单文件增量写 (首次全量覆盖重建, 之后追加)
  _flushLegacy(k, pending, flushed) {
    const line = pending.map((e) => JSON.stringify(e)).join("\n") + "\n";
    if (flushed === 0) {
      fs.writeFileSync(this._file(k), line, "utf8");
    } else {
      fs.appendFileSync(this._file(k), line, "utf8");
    }
  }

  // default 会话: 按事件 ts 归属的天分片增量写
  //  - 按天分组: 每个文件只追加自己那天的行
  //  - 当天文件已有则追加, 首次创建则写入新文件
  _flushDaily(pending) {
    const byDay = new Map();
    for (const e of pending) {
      const d = this._dayOf(e.ts);
      let g = byDay.get(d);
      if (!g) { g = []; byDay.set(d, g); }
      g.push(e);
    }
    for (const [d, group] of byDay) {
      const file = this._shardFile(d);
      const line = group.map((e) => JSON.stringify(e)).join("\n") + "\n";
      if (fs.existsSync(file)) fs.appendFileSync(file, line, "utf8");
      else fs.writeFileSync(file, line, "utf8"); // 新的一天文件首次写入
    }
  }
}