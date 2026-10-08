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
//
// v2026-10-05 跨进程不变量 (多 OS 进程共用一个 dataDir 写同一批文件, 三条都靠 withFileLock):
//  ① seq 是"每 key 一个单调游标", 而磁盘末行是该游标的唯一真相: 分配只用乐观值, 落盘前在锁内
//     重排 (_ensureUniqueSeq); default 的多日批次里**每个被写分片的末行**都参与游标计算 (W2)。
//  ② 一切 unlink 都在该文件的锁内 (set/rename/fork/delete 的"清盘"与随后的整批写入不可被
//     并发写者插进中间) (W1)。
//  ③ 压缩事件的 data.upToSeq 跟着同批 seq 一起重排, 且永不追平自身 seq (W3)。
import fs from "node:fs";
import path from "node:path";
import { ensureDir, logicalDay, withFileLock, withFileLocks } from "../utils/store.js";
import { debug } from "../utils/logger.js";

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
  // 事件 ts 归属的本地自然日 (复用 utils/store.logicalDay, 与 eventsByDay 一致, 避免时区错位;
  // 2026-09-18 重构: 原先这里手写了一份与 logicalDay 相同的实现, 双份易漂移)
  _dayOf(ts) {
    return logicalDay(new Date(ts));
  }
  // 列出 default 相关的所有文件 (旧单文件 + 各日分片)
  _defaultFiles() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir)
        .filter((f) => f.endsWith(".jsonl") && (f === "default.jsonl" || this._isShard(f)));
    } catch (e) { debug(`[memory/session] 已忽略异常: ${e && e.message ? e.message : e}`); }
    return files.map((f) => path.join(this.dir, f));
  }
  _removeDefaultFiles() {
    // v2026-10-05 (W1): 每把删除都在该文件的锁内做, 且多文件一次性全部持锁 (路径升序) ——
    // 无锁 rmSync 会与并发写者的"尾读+追加"交错: 它的锁内判定刚看到磁盘末行, 文件就被我们
    // 删掉了 (Windows 上还会因写入方占用句柄直接 EPERM 让删除静默失败)。
    withFileLocks(this._defaultFiles(), () => {
      for (const f of this._defaultFiles()) {
        try { fs.rmSync(f, { force: true }); } catch (e) { debug(`[memory/session] 已忽略异常: ${e && e.message ? e.message : e}`); }
      }
    });
  }

  // 读取单个 jsonl 文件的事件序列
  _readEventsFromFile(file) {
    const events = [];
    try {
      for (const l of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
        try { const e = JSON.parse(l); if (e && e.seq && e.type && e.data) events.push(e); } catch (e) { debug(`[memory/session] 已忽略异常: ${e && e.message ? e.message : e}`); }
      }
    } catch (e) { debug(`[memory/session] 已忽略异常: ${e && e.message ? e.message : e}`); }
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
    // 跨进程 seq 校正 (2026-10-04): _nextSeq 是构造期从磁盘播种的**内存**计数器, 而落盘只在
    //   _flush 里加锁 —— 军团子 agent / ppx-serve 与 CLI 共用同一 dataDir 时, 两个进程都从
    //   同一个起点 +1, 写出重复 seq。seq 唯一性是下游一切游标的前提 (memory-ticker 按 seq
    //   增量消费、deriveCompacted 按 seq 投影、fork 按 seq 截断), 重复即跳过或重复消费。
    //   现在 append 前读目标文件末行拿磁盘真实最大 seq, 取 max(内存, 磁盘) 再递增。
    //   但这只是乐观预读 (缩小碰撞窗口): 读完到写盘之间别的进程仍可读到同一 diskMax。
    //   权威兜底在 _flushLegacy/_flushDaily 的锁内 —— 序列化前经 _ensureUniqueSeq 重排撞号批次。
    const diskMax = this._diskMaxSeq(k);
    if (diskMax > (this._nextSeq.get(k) || 0)) this._nextSeq.set(k, diskMax);
    const seq = (this._nextSeq.get(k) || 0) + 1;
    const ev = { seq, ts: Number.isFinite(ts) ? ts : Date.now(), type, data };
    this._log(k).push(ev);
    this._nextSeq.set(k, seq);
    if (!skipFlush) this._flush(k);
    this._bump(); // 使派生缓存失效
    return ev;
  }

  _removeFile(k) { this._removePathLocked(this._file(k)); }

  // 单个文件的锁内删除 (W1: 所有 unlink 都走这里, 不再裸 rmSync)
  _removePathLocked(file) {
    withFileLock(file, () => {
      try { fs.rmSync(file, { force: true }); } catch (e) { debug(`[memory/session] 已忽略异常: ${e && e.message ? e.message : e}`); }
    });
  }

  // 读磁盘上该会话已落盘的最大 seq (拿不到就返回 0, 退回内存计数器 —— 绝不因此丢写)
  _diskMaxSeq(k) {
    try {
      if (k !== "default") return this._tailMaxSeq(this._file(k));
      const anchor = this._defaultAnchorFile();
      return anchor ? this._tailMaxSeq(anchor) : 0;
    } catch { return 0; }
  }

  // default 的"锚分片" = _diskMaxSeq("default") 实际读的那个文件: 今日分片, 今日还没有则名字最新的一片。
  // 落盘时把它也并进锁集 (W2): 两个各写**互不相交**日分片的并发批次, 只有靠共同的锚才不会各自
  // 从同一个 seq 起编。常见批次写的就是今日分片, 去重后不多花一把锁。
  _defaultAnchorFile() {
    const today = this._shardFile(this._dayOf(Date.now()));
    if (fs.existsSync(today)) return today;
    const cand = this._defaultFiles().sort();
    return cand.length ? cand[cand.length - 1] : null;
  }

  // 只读文件末尾 8KB 拿最后一行的 seq (会话日志可达数十 MB, 不能整读)
  // 末行可能是别的进程刚写了一半, 逐行回退到第一条能解析的为止
  _tailMaxSeq(file) {
    if (!fs.existsSync(file)) return 0;
    let fd;
    try {
      fd = fs.openSync(file, "r");
      const size = fs.fstatSync(fd).size;
      if (!size) return 0;
      const len = Math.min(size, 8192);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const s = lines[i].trim();
        if (!s) continue;
        try {
          const e = JSON.parse(s);
          if (Number.isFinite(e.seq)) return e.seq;
        } catch { /* 半截行/首行残段, 继续往前找 */ }
      }
      return 0;
    } catch { return 0; } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
    }
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
    // 2026-09-18 修复: 每一天的缓存数组都必须在入缓存前排好时间序 ——
    //   原实现只对当次请求的 day 排序, 其余天命中缓存时返回的是事件追加顺序 (乱序)
    for (const arr of byDay.values()) arr.sort((a, b) => a.timestamp - b.timestamp);
    const out = byDay.get(dayStr) || [];
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
    // 目标会话按边界整批重建 (default = 所有分片): 清盘与写入在**同一把锁内**完成 (W1),
    // 且事件按值复制 —— 目标侧的 seq 重排不得改动源会话正在使用的同一批对象引用
    const copied = keep.map((e) => this._cloneEvent(e));
    this._logs.set(k, copied);
    this._nextSeq.set(k, copied.length ? copied[copied.length - 1].seq : 0);
    this._flushedSeq.delete(k);
    this._flush(k, copied, true);
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
    // "重建"意图 = 旧内容作废。W1 (2026-10-05): 清盘不再发生在锁外, 而是先 skipFlush 攒齐
    //   整批, 再由 _flush(k, batch, explicit=true) 在该 key 的锁内一次性 unlink + 整批写入。
    //   旧写法 (锁外 rmSync + 每条消息一次独立落盘) 有两处可见的坏结果: 并发写者的行可以落进
    //   "已删文件、未写新行"的缝隙里, 使重建后的会话以非 1 开头并夹着旧行 (半重建态); 而本进程
    //   的 N 条消息又分 N 次落盘, 别的进程读到的是只重建了一半的历史。default 同理 (所有分片)。
    this._logs.delete(k); this._nextSeq.set(k, 0); this._flushedSeq.delete(k);
    const fresh = [];
    for (const m of (history || [])) {
      fresh.push(this.append(k, m.role === "user" ? EVENTS.USER : EVENTS.ASSISTANT,
        { content: m.content }, undefined, { skipFlush: true }));
    }
    this._flush(k, fresh, true);
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
    // 按值复制: 目标会话的 seq 重排不能改到源会话仍在使用的同一批对象引用
    const copied = events.map((e) => this._cloneEvent(e));
    this._logs.set(t, copied);
    const lastSeq = copied.length ? copied[copied.length - 1].seq : 0;
    this._nextSeq.set(t, lastSeq);
    this._flushedSeq.delete(t);
    // 新键必须从零整批重建 (W1: unlink 与写入同在一把锁内), 别追加到同名旧会话上
    this._flush(t, copied, true);
    this.delete(f);
    this._bump();
    return true;
  }
  delete(key) {
    const k = this._safe(key);
    this._logs.delete(k); this._nextSeq.delete(k); this._flushedSeq.delete(k);
    try {
      if (k === "default") {
        // 删除 default 所有分片 (旧单文件 + 各日 shard) —— 锁内删 (W1)
        this._removeDefaultFiles();
      } else {
        this._removeFile(k);
      }
    } catch (e) { debug(`[memory/session] 已忽略异常: ${e && e.message ? e.message : e}`); }
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
  // pending / explicit (v2026-10-05 W1): 重建路径 (set/fork/rename) 由调用方给出整批待写事件,
  //   explicit=true 表示"该 key 的磁盘内容整批作废" —— 在同一把锁里先 unlink 再整批写入,
  //   并发写者插不进"文件已删/新行未写"的缝隙。普通增量路径两个参数都不传, 行为不变。
  _flush(key, pending = null, explicit = false) {
    const k = this._safe(key);
    const evs = this._logs.get(k) || [];
    const flushed = this._flushedSeq.get(k) || 0;
    const batch = Array.isArray(pending) ? pending
      : (explicit ? evs : evs.filter((e) => e.seq > flushed));
    if (!explicit && !batch.length) return;
    try {
      if (k === "default") this._flushDaily(k, batch, { rebuild: explicit });
      else this._flushLegacy(k, batch, flushed, { rebuild: explicit });
      // 落盘后的游标取"本批最大 seq" (多日重建后数组顺序 != seq 顺序, 不能取尾元素);
      // 重建时旧的 flushed 随清盘一起作废, 所以基准从 0 起算
      let mx = explicit ? 0 : flushed;
      for (const e of evs) if (e.seq > mx) mx = e.seq;
      for (const e of batch) if (e.seq > mx) mx = e.seq;
      this._flushedSeq.set(k, mx);
      this._bump(); // 锁内可能改过 seq / compaction 游标, 派生缓存必须作废
    } catch (e) {
      // v1.0.9: 落盘失败不再静默 (磁盘满/权限丢失消息不可见), 至少留日志
      try { console.warn(`[session] 会话 ${k} 落盘失败: ${e.message}`); } catch (e) { debug(`[memory/session] 已忽略异常: ${e && e.message ? e.message : e}`); }
    }
  }

  // 事件按值复制 (fork/rename 建目标会话用): 两侧各自重排 seq 时不得互相改到同一批对象
  _cloneEvent(e) {
    const data = e && typeof e.data === "object" && e.data ? { ...e.data } : e.data;
    return { seq: e.seq, ts: e.ts, type: e.type, data };
  }

  // 按事件 ts 的本地自然日分组 (保持批次内原有顺序)
  _dayGroups(pending) {
    const byDay = new Map();
    for (const e of pending) {
      const d = this._dayOf(e.ts);
      let g = byDay.get(d);
      if (!g) { g = []; byDay.set(d, g); }
      g.push(e);
    }
    return byDay;
  }

  // 已持锁时的静默删除
  _rmSyncQuiet(file) {
    try { fs.rmSync(file, { force: true }); } catch (e) { debug(`[memory/session] 已忽略异常: ${e && e.message ? e.message : e}`); }
  }

  // v2026-10-05 (跨进程 seq 竞态兜底): append 分配的 seq 是无锁乐观值, 两进程同时读到同一
  // diskMax 就会撞号 (~40 条里 14-16 条重复)。唯一安全的判定点是文件锁内、序列化落盘之前:
  // 重读磁盘真实 seq, 批次最低端 <= diskMax 就整批重排为 diskMax+1 起的连续段。
  // _logs 里存的是同一批事件对象引用, 原地改 e.seq 即内存/盘一致, 无需额外同步。
  // 代价: 每个落盘批次多一次 8KB 尾读。
  // floor (W2): 调用方可给出"这批不得低于的 seq" (default 多日批次逐个分片的游标);
  //             缺省仍读本 key 的磁盘末行。remap: 收集 旧seq->新seq 供压缩游标修正 (W3)。
  _ensureUniqueSeq(k, pending, floor, remap = null) {
    const map = remap || new Map();
    if (!pending.length) return map;
    const diskMax = Number.isFinite(floor) ? floor : this._diskMaxSeq(k);
    let low = pending[0].seq;
    for (const e of pending) if (e.seq < low) low = e.seq;
    if (low > diskMax) return map; // 整段已在磁盘序列之上, 无碰撞
    let next = diskMax + 1;
    for (const e of pending) {
      if (e.seq !== next) map.set(e.seq, next);
      e.seq = next++;
    }
    if ((this._nextSeq.get(k) || 0) < next - 1) this._nextSeq.set(k, next - 1);
    return map;
  }

  // W3 (2026-10-05): 压缩事件带的 data.upToSeq 是"压到哪个 seq 为止"的游标, 但它是在锁外
  //   按当时**内存里**的 seq 算出来的。上面一重排就把同批事件的 seq 全体上移了, upToSeq 却
  //   留在旧值上, 于是同一批次里同时存在两个 seq 世界: 被压缩的原文回到模型上下文 (重复历史),
  //   而没被压缩的后续消息反而被吞掉 (投影缺消息)。这里在锁内、序列化之前按 remap 修正,
  //   并兜底钳制: 游标永远不得追平/越过压缩事件自身 (磁盘末行才是游标的真相)。
  _repairCompactionCursors(pending, remap) {
    if (!pending || !pending.length) return;
    const map = remap && remap.size ? remap : null;
    for (const e of pending) {
      if (!e || e.type !== EVENTS.COMPACTION || !e.data || typeof e.data !== "object") continue;
      const raw = e.data.upToSeq;
      if (raw === undefined || raw === null) continue;
      const old = Number(raw);
      if (!Number.isFinite(old)) continue; // 非数字游标: 保留原值交给投影端处理
      let fixed = map && map.has(old) ? map.get(old) : old;
      if (fixed >= e.seq) fixed = e.seq - 1;
      if (fixed < 0) fixed = 0;
      if (fixed !== e.data.upToSeq) e.data.upToSeq = fixed;
    }
  }

  // 非 default 会话: 增量落盘 (盘上还没有这个会话时全量写, 已有则只追加)
  // v3.2.3 (P2#15): 追加段加跨进程文件锁 (与 facts 锁策略对齐) —— 多进程共用同一数据目录时,
  // 无锁 appendFileSync 在 Windows 上可能交错写坏行; 锁内失败由 _flush 的 catch 兜底告警
  // 2026-10-04: 是否全量重写改由"磁盘上有没有行"决定, 不再看本进程的 flushed 标志。
  //   原逻辑 flushed===0 就 writeFileSync 整文件覆盖 —— 另一个进程刚写的会话历史会被这一刀
  //   直接抹掉 (新实例构造时目录还是空的, 它的 flushed 永远是 0)。"重建"意图改由 rebuild
  //   表达 (锁内 unlink + 整批写), 这里只按磁盘事实走。flushed 参数保留仅为兼容既有调用签名。
  _flushLegacy(k, pending, _flushed = 0, { rebuild = false } = {}) {
    const file = this._file(k);
    void _flushed;
    withFileLock(file, () => {
      if (rebuild) {
        this._rmSyncQuiet(file);          // W1: 清盘与写入同在一把锁内, 不可被并发写者插入
        if (!pending.length) { this._rebuildSeqs(k, pending, false); return; } // 空历史: 清盘即全部动作
        this._rebuildSeqs(k, pending, false);
      } else {
        // W3: 没撞号也要过一遍钳制分支 —— 压缩游标可能是锁外算出的越界值 (upToSeq >= 自身 seq)
        this._repairCompactionCursors(pending, this._ensureUniqueSeq(k, pending));
      }
      // 序列化必须在锁内重排之后: 锁外 stringify 写进盘的还是过期的 seq 字节
      const line = pending.map((e) => JSON.stringify(e)).join("\n") + "\n";
      if (!rebuild && this._diskMaxSeq(k) > 0) fs.appendFileSync(file, line, "utf8");
      else fs.writeFileSync(file, line, "utf8");
    });
  }

  // default 会话: 按事件 ts 归属的天分片增量写
  //  - 按天分组: 每个文件只追加自己那天的行
  //  - 当天文件已有则追加, 首次创建则写入新文件
  // W2 (2026-10-05): 原实现整批只在**第一个分片的锁内**重排一次, 锚是 _diskMaxSeq("default")
  //   = 今天(或最新)分片的末行。跨天批次里较旧那天的文件由别的进程写到过更高的 seq, 于是
  //   本批分配的 seq 落进那天文件时与残存行撞号 (实测 40 条 union 出现 2 个重复)。
  //   现在: 每个被写分片的磁盘末行都参与游标计算, 并按日升序分配一条连续 seq 段。
  //   锁集 = 本批涉及的分片 (重建时再加上现存全部分片), 按路径升序一次性全部持有 ——
  //   并发写者同样按升序取锁, 所以不会互锁; 常见单天批次仍然只加一把锁、一次尾读。
  _flushDaily(k, pending, { rebuild = false } = {}) {
    const groups = this._dayGroups(pending);
    const days = [...groups.keys()].sort();
    const batchFiles = days.map((d) => this._shardFile(d));
    // 重建要作废"该 key 的全部磁盘内容", 所以锁集 = 现存全部分片 ∪ 本批要写的分片;
    // 增量路径再加上锚分片 (withFileLocks 去重, 单天常见批次仍只一把锁)
    const lockFiles = rebuild
      ? [...this._defaultFiles(), ...batchFiles]
      : [...batchFiles, this._defaultAnchorFile()];
    if (rebuild && !pending.length) {
      // 空历史的重建 (set(key, [])): 清盘本身就是全部动作
      withFileLocks(lockFiles, () => { for (const f of this._defaultFiles()) this._rmSyncQuiet(f); });
      return;
    }
    withFileLocks(lockFiles, () => {
      if (rebuild) {
        for (const f of this._defaultFiles()) this._rmSyncQuiet(f); // 锁内重新列举: 连并发者刚建出的分片一起作废
        this._rebuildSeqs(k, pending, true);
      } else {
        const remap = new Map();
        let cursor = this._diskMaxSeq(k);
        for (const d of days) {
          const g = groups.get(d);
          const tail = this._tailMaxSeq(this._shardFile(d));
          if (tail > cursor) cursor = tail;
          this._ensureUniqueSeq(k, g, cursor, remap);
          for (const e of g) if (e.seq > cursor) cursor = e.seq;
        }
        this._repairCompactionCursors(pending, remap);
      }
      for (const d of days) {
        const file = this._shardFile(d);
        const line = groups.get(d).map((e) => JSON.stringify(e)).join("\n") + "\n";
        if (!rebuild && fs.existsSync(file)) fs.appendFileSync(file, line, "utf8");
        else fs.writeFileSync(file, line, "utf8"); // 新的一天文件首次写入 / 重建整批覆盖
      }
    });
  }

  // 重建 (set/fork/rename) 的 seq 分配: 磁盘真相 = 本进程刚在同一把锁里删空的目标文件,
  // 所以游标从 1 起重新连续编号 (旧游标随清盘作废, _nextSeq 直接赋值不取 max)。
  // 多日批次按日升序分配, 保证"较旧分片的 seq 恒低于较新分片" —— default 的 seq 是跨分片的
  // 单一游标, 而 _diskMaxSeq 只认最新分片的末行, 区间一旦错位那个锚就会低估。
  // 兜底: rmSync 失败 (Windows EPERM) 时该分片尾读仍返回残存末行, 本批接着它往上编, 不撞号。
  _rebuildSeqs(k, batch, daily) {
    const remap = new Map();
    const groups = this._dayGroups(batch);
    let next = 1;
    for (const d of [...groups.keys()].sort()) {
      const g = groups.get(d);
      const floor = daily ? this._tailMaxSeq(this._shardFile(d)) : 0;
      if (floor >= next) next = floor + 1;
      for (const e of g) {
        if (e.seq !== next) remap.set(e.seq, next);
        e.seq = next++;
      }
    }
    this._repairCompactionCursors(batch, remap);
    let mx = 0;
    for (const e of batch) if (e.seq > mx) mx = e.seq;
    this._nextSeq.set(k, mx);
    return mx;
  }
}