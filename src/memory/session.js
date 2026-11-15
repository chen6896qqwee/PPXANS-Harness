// src/memory/session.js - 会话事件日志 (设计溯源 docs/PROVENANCE.md#dsh "会话即唯一事实源")
// 新架构: 不可变 append-only 事件日志, 每条 = {seq, ts, type, data}
//  - 模型可见历史 = deriveMessages() 从日志投影 (无可变状态, 仅从日志重建)
//  - replay() 回放完整事件流 | fork() 从边界派生新会话
//  - 兼容旧 get/set/has/delete 接口 (agent 无需全量改动)
// 设计溯源 docs/PROVENANCE.md#dsh; 自研不变量: "model-visible means logged" (能进模型的必须能从日志重建)
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
import { noteCatch } from "../utils/catch-log.js";
import { readTailSeq } from "../utils/tail-read.js";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, logicalDay, withFileLock, withFileLocks } from "../utils/store.js";
// EVENTS 拆到独立模块: session.js 与各 mixin 都要用它, 留在宿主里会成环。
import { EVENTS } from "./session-events.js";
import { sessionMetaMethods } from "./session-meta.js";
import { sessionDayIndexMethods } from "./session-day-index.js";
import { sessionFlushMethods } from "./session-flush.js";
import { sessionDeriveMethods } from "./session-derive.js";

// 事件类型集 (对齐设计溯源 docs/PROVENANCE.md#dsh 事件域: user/assistant/tool/system)
// 定义在 session-events.js, 这里转出, 既有 import { EVENTS } from "./session.js" 的调用方不变。
export { EVENTS };

// default 会话按天分片: default-YYYY-MM-DD.jsonl
const DEFAULT_SHARD_RE = /^default-\d{4}-\d{2}-\d{2}\.jsonl$/;

// 进程退出兜底: 一个进程只装一个监听器, 写后置实例登记在模块级集合里。
// 原实现每个实例各挂一个 process.once("exit") —— 构造 N 个 agent 就有 N 个监听器
// (20 个 agent 的基准就触发了 MaxListenersExceededWarning), 且存的 _exitHandler 从不摘除。
const LIVE_WRITE_BEHIND = new Set();
let _exitHookInstalled = false;
function _trackForExit(store) {
  LIVE_WRITE_BEHIND.add(store);
  if (_exitHookInstalled) return;
  _exitHookInstalled = true;
  process.once("exit", () => {
    for (const s of [...LIVE_WRITE_BEHIND]) {
      try { s.flushAll({ sync: true }); } catch (e) { noteCatch(e); /* 退出路径不抛 */ }
    }
  });
}

export class SessionStore {
  // 2026-11-02 (L3 写盘批量化): writeBehind 模式把"请求栈内的同步落盘"推迟到下一个
  //   setImmediate —— 同一轮 tick 里多个 append/flush 合并成每 key 一次写入, 事件循环
  //   不再为每条会话记录付一次 appendFileSync + 文件锁。内存日志仍是唯一事实源 (先写内存,
  //   derive/replay 立即可见); 崩溃窗口 = 最多一个 tick 的会话事件, 优雅退出由 flushAll()
  //   收口 (agent.shutdown / process exit 均接线)。
  //   注意: 这不是 worker 线程并行 I/O —— 真正的并行需要重写 withFileLock 为异步锁
  //   (见 docs/OPTIMIZATION-2026-10-30.md §11.3), 本模式只消除"调用方等待磁盘"。
  //   直接 new SessionStore(dir) 默认仍是同步语义 (测试/短脚本/显式耐久调用不受影响)。
  constructor(dataDir, { writeBehind = false, writeBehindDelayMs = 0 } = {}) {
    this.dir = path.join(dataDir, "sessions");
    ensureDir(this.dir);
    this._writeBehind = writeBehind === true;
    this._writeBehindDelayMs = Number.isFinite(Number(writeBehindDelayMs)) && Number(writeBehindDelayMs) > 0
      ? Math.trunc(Number(writeBehindDelayMs)) : 0;
    this._pendingFlushKeys = new Set();
    this._flushTimer = null;
    this._deferredBatches = 0;
    this._deferredEvents = 0;
    this._lastDeferredAt = 0;
    if (this._writeBehind) {
      // 兜底: 正常退出路径会显式 flushAll, 但 process.exit 可能绕过 agent.shutdown。
      //   'exit' 里只允许同步操作, 正好复用同步落盘; 监听器进程级唯一, 见 _trackForExit。
      _trackForExit(this);
    }
    this._logs = new Map();    // key -> event[] (不可变, append-only)
    this._nextSeq = new Map(); // key -> 下一个 seq
    this._flushedSeq = new Map(); // key -> 已落盘的最大 seq (增量追加用)
    // 会话归档标记 (2026-10-11): { key: archivedAt }, 独立于事件日志
    this._archived = this._loadArchive();
    this._archivedBase = { ...this._archived }; // 加载基线: 落盘时只叠加相对基线的变更 (跨进程不吞键)
    // 会话标题覆盖 (2026-10-11): { key: title }, 独立于事件日志内容 (改名不改内容/归属/排序)
    this._titles = this._loadTitles();
    this._titlesBase = { ...this._titles };
    // 孤儿标题回收 (评测-II P2-3): 历史存量对账 —— 正文已被删除/轮转的 s_* 标题移出台账
    //   (备份到 _titles.orphans.json); 11-14 已落地 delete 前归档, 新孤儿不会再产生。
    this._reconcileOrphanTitles();
    // 会话置顶 (2026-11-03): { key: pinnedAt }, 只影响列表排序, 不动事件日志
    this._pinned = this._loadPinned();
    this._pinnedBase = { ...this._pinned };
    this._loadAll();
    // --- 派生缓存 (v1.1.1 性能优化) ---
    // eventsByDay / deriveCompacted 在每一轮/每一工具轮都被调用, 旧实现每次全量扫描 O(T)。
    // 事件日志是 append-only 不可变, 一个 key 的 events 数组只增不改（set/rename/fork 会换新数组）。
    //   · deriveCompacted: 以"数组引用标识"做增量缓存——数组没换就只把尾部新事件追加进 msgs, 命中 O(Δ)；
    //     数组被替换(重命名/重建)则重算。compaction 事件追加时检测到也整体重算（它会重投影历史）。
    //   · eventsByDay: 版本门控的全库按天缓存; v4.2 起版本变化不再整库重扫 —— 同样按"数组引用
    //     游标"增量: append 原地 push → 只索引尾部新事件 O(Δ); set/rename/fork/load 换新数组或
    //     删键 → purge 该键旧条目后按键重建 (罕见路径)。每轮成本从 O(全库事件数) 降到 O(当日新增)。
    this._version = 0;                  // 全局版本: 任何 write 递增
    this._dayCache = new Map();         // day -> 该天结果 (增量演进, 版本只作命中门控)
    this._dayCacheAt = 0;               // 生成该缓存时的 _version
    this._dayCursors = new Map();       // key -> { ref, count } 已索引到该 key 事件数组的第几条
    // deriveCompacted 增量缓存: key -> { arrRef, msgs, lastCompSeq }
    this._compactedCache = new Map();
    // OPT-2 (2026-10-30) 批次内磁盘尾读缓存: key -> 本批次开始时读到的磁盘最大 seq。
    //   append() 的尾读 (_diskMaxSeq: existsSync + open/fstat/read末8KB/close) 只是**乐观预读**,
    //   目的是缩小跨进程撞号窗口; 一次 _pushTurn (set/多事件轮) 有 2~4 条 skipFlush append,
    //   每条都重读同一份磁盘末行是纯浪费。同一批未落盘事件之间磁盘尾行不会因本进程变化, 故
    //   每个 key 只读一次; 权威判定仍是 _flush 锁内的 _ensureUniqueSeq 重排 —— 本缓存绝不参与
    //   唯一性判定, 乐观值撞号/过期都只会被锁内重排纠正 (缓存过期 = 碰撞窗口回到优化前大小)。
    // 失效: 每个 _flush 结尾清空 (下一批必须重新读盘); set/delete 这类"磁盘内容作废"的路径
    //   在入口也清空, 防上一批的残值被带进重建。
    this._tailCache = new Map();
    // _ensureUniqueSeq 在锁内实际读到的磁盘最大 seq (最近一次), 供 _flushLegacy 判定
    //   "磁盘上有没有行 (追加 or 整文件写)" 复用同一次锁内尾读, 不再重复读一遍。
    this._ensureDiskMax = 0;
    // _diskMaxSeq 最近一次尾读命中的文件 (default 的锚分片), 供 _flushDaily 在逐日尾读时
    //   复用同一个读数 (同一把锁内, 同一文件不会变)。
    this._diskMaxFile = null;
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
    } catch (e) { noteCatch("src/memory/session.js#_defaultFiles", e); }
    return files.map((f) => path.join(this.dir, f));
  }
  _removeDefaultFiles() {
    // v2026-10-05 (W1): 每把删除都在该文件的锁内做, 且多文件一次性全部持锁 (路径升序) ——
    // 无锁 rmSync 会与并发写者的"尾读+追加"交错: 它的锁内判定刚看到磁盘末行, 文件就被我们
    // 删掉了 (Windows 上还会因写入方占用句柄直接 EPERM 让删除静默失败)。
    withFileLocks(this._defaultFiles(), () => {
      for (const f of this._defaultFiles()) {
        this._archivePathLocked(f);
        try { fs.rmSync(f, { force: true }); } catch (e) { noteCatch(e); }
      }
    });
  }

  // 读取单个 jsonl 文件的事件序列
  _readEventsFromFile(file) {
    const events = [];
    try {
      for (const l of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
        try { const e = JSON.parse(l); if (e && e.seq && e.type && e.data) events.push(e); } catch (e) { noteCatch(e); }
      }
    } catch (e) { noteCatch(e); }
    return events;
  }

  _loadAll() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".jsonl")); } catch (e) { if (e?.code !== "ENOENT") noteCatch(e); return; }
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
    //   _flush 里加锁 —— 军团子 agent / ppx serve 与 CLI 共用同一 dataDir 时, 两个进程都从
    //   同一个起点 +1, 写出重复 seq。seq 唯一性是下游一切游标的前提 (memory-ticker 按 seq
    //   增量消费、deriveCompacted 按 seq 投影、fork 按 seq 截断), 重复即跳过或重复消费。
    //   现在 append 前读目标文件末行拿磁盘真实最大 seq, 取 max(内存, 磁盘) 再递增。
    //   但这只是乐观预读 (缩小碰撞窗口): 读完到写盘之间别的进程仍可读到同一 diskMax。
    //   权威兜底在 _flushLegacy/_flushDaily 的锁内 —— 序列化前经 _ensureUniqueSeq 重排撞号批次。
    //
    // OPT-2 (2026-10-30): 乐观预读按"未落盘批次"缓存, 同批每个 key 只读一次盘。
    //   乐观预读只是缩小碰撞窗口, 权威在锁内重排 (_ensureUniqueSeq); 因此这里读到的是本批
    //   第一次读到的盘面, 本批后续 append 复用它 —— 期间别的进程再写只会让碰撞窗口略大,
    //   锁内重排会把整批 seq 抬到真实盘面之上, 唯一性不依赖本缓存。_flush 结束时清空缓存,
    //   下一批必须重新读盘 (上一批落盘后的盘面才是下一批的起点)。
    let diskMax = this._tailCache.get(k);
    if (diskMax === undefined) {
      diskMax = this._diskMaxSeq(k);
      this._tailCache.set(k, diskMax);
    }
    if (diskMax > (this._nextSeq.get(k) || 0)) this._nextSeq.set(k, diskMax);
    const seq = (this._nextSeq.get(k) || 0) + 1;
    const ev = { seq, ts: Number.isFinite(ts) ? ts : Date.now(), type, data };
    this._log(k).push(ev);
    this._nextSeq.set(k, seq);
    // 新会话自动命名 (2026-10-11): 该 key 第一条用户消息、无自定义标题、且非 default 主会话时,
    //   按 "MMDD|类型|主题" 自动生成标题 (纯规则, 不改内容/归属)。default 豁免 (主会话兜底, 不自动改名)。
    if (type === EVENTS.USER && k !== "default" && !this._titles[k]) {
      const hasPriorUser = this._log(k).some((e) => e !== ev && e.type === EVENTS.USER);
      if (!hasPriorUser) {
        const auto = this._autoTitleRule(data && data.content, ev.ts);
        if (auto) { this._titles[k] = auto; this._saveTitles(); }
      }
    }
    // writeBehind: 普通 append 不直接落盘, 排到下一 tick 与同批 flush 合并;
    // skipFlush 的批量路径仍由调用方 flush(k) 统一收口。
    if (!skipFlush) {
      if (this._writeBehind) this._scheduleFlush(k);
      else this._flush(k);
    }
    this._bump(); // 使派生缓存失效
    return ev;
  }

  _removeFile(k) { this._removePathLocked(this._file(k)); }

  // 2026-11-14 (评测 P2-3): 删除前先归档 —— 会话轨迹是评测/追责的唯一事实源,
  //   不该随 delete/清理消失 (实测 13 个历史会话只剩 5 份 jsonl)。归档到
  //   <sessions>/archive/ (原名 + 时间戳 + pid 防碰撞), 归档失败不阻断删除。
  //   只挂在本方法: 清盘重写路径 (_rmSyncQuiet, 删后同文件重写) 不归档, 否则会自复制。
  _archivePathLocked(file) {
    try {
      if (!fs.existsSync(file)) return;
      const archDir = path.join(this.dir, "archive");
      fs.mkdirSync(archDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
      const dest = path.join(archDir, `${path.basename(file, ".jsonl")}-${stamp}-${process.pid}.jsonl`);
      // rename 同盘原子优先; 失败 (跨设备/占用) 走 copy+rm 兜底, 数据不丢
      let renamed = false;
      try { fs.renameSync(file, dest); renamed = true; } catch { renamed = false; /* swallowed-ok(2026-11-14): rename 失败走下方 copy+rm 兜底, 数据不丢 */ }
      if (renamed) return;
      fs.copyFileSync(file, dest);
    } catch (e) { noteCatch("src/memory/session.js#_archivePathLocked", e); }
  }

  // 单个文件的锁内删除 (W1: 所有 unlink 都走这里, 不再裸 rmSync)
  _removePathLocked(file) {
    withFileLock(file, () => {
      this._archivePathLocked(file);
      try { fs.rmSync(file, { force: true }); } catch (e) { noteCatch("src/memory/session.js#withFileLock", e); }
    });
  }

  // 读磁盘上该会话已落盘的最大 seq (拿不到就返回 0, 退回内存计数器 —— 绝不因此丢写)
  _diskMaxSeq(k) {
    try {
      if (k !== "default") return this._tailMaxSeq(this._file(k));
      const anchor = this._defaultAnchorFile();
      this._diskMaxFile = anchor; // OPT-2: 记下本次尾读命中的分片 (读失败时为 null, 不复用)
      return anchor ? this._tailMaxSeq(anchor) : 0;
    } catch (e) { if (e?.code !== "ENOENT") noteCatch(e); return 0; }
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
  // (2026-11-03 收口: 取尾 + seq 回退语义都在 utils/tail-read.js, 与 protocol._tailSeq 同源)
  _tailMaxSeq(file) {
    return readTailSeq(file, 8192);
  }

  // 显式落盘: 把 skipFlush 延后的待写事件写入磁盘 (供批量写入后调用)。
  // writeBehind 模式下默认"排到下一 tick"(合并同 tick 的多次 flush), 需要立刻耐久时
  // 传 { sync: true } —— 压缩/重建等强顺序路径用同步, 普通回合结束用默认。
  flush(key, { sync = false } = {}) {
    const k = this._safe(key);
    if (this._writeBehind && !sync) { this._scheduleFlush(k); return; }
    this._flush(k);
  }

  // 排一次写盘: 同一 tick 内可重复调用, 只保留一个 timer 和一组 key。
  _scheduleFlush(k) {
    this._pendingFlushKeys.add(k);
    if (this._flushTimer) return;
    const run = () => {
      this._flushTimer = null;
      this._drainScheduled();
    };
    this._flushTimerIsTimeout = this._writeBehindDelayMs > 0;
    this._flushTimer = this._flushTimerIsTimeout ? setTimeout(run, this._writeBehindDelayMs) : setImmediate(run);
    if (typeof this._flushTimer?.unref === "function") this._flushTimer.unref(); // 不阻止进程退出
  }

  // timer 到期: 每个 key 只落盘一次 (内部再按 flushedSeq 增量取整批事件)
  _drainScheduled() {
    if (!this._pendingFlushKeys.size) return;
    const keys = [...this._pendingFlushKeys];
    this._pendingFlushKeys.clear();
    const before = keys.reduce((n, k) => n + (this._flushedSeq.get(k) || 0), 0);
    for (const k of keys) this._flush(k);
    const after = keys.reduce((n, k) => n + (this._flushedSeq.get(k) || 0), 0);
    this._deferredBatches += 1;
    this._deferredEvents += Math.max(0, after - before);
    this._lastDeferredAt = Date.now();
  }

  // 优雅收口: 同步落盘后从退出兜底登记里摘除。
  //   不摘除 = 模块级集合永久强引用旧实例 (长进程里每次 shutdown 都留下整个会话库)。
  dispose() {
    LIVE_WRITE_BEHIND.delete(this);
    return this.flushAll({ sync: true });
  }

  // 收口: 把所有待写 key 立刻写盘 (优雅退出/测试断言用)。返回处理的 key 数。
  flushAll({ sync = true } = {}) {
    if (!this._writeBehind) {
      for (const [k, evs] of this._logs) {
        if (evs.length && evs[evs.length - 1].seq > (this._flushedSeq.get(k) || 0)) this._flush(k);
      }
      return this._logs.size;
    }
    if (!sync) {
      for (const [k, evs] of this._logs) {
        if (evs.length && evs[evs.length - 1].seq > (this._flushedSeq.get(k) || 0)) this._scheduleFlush(k);
      }
      return this._pendingFlushKeys.size;
    }
    if (this._flushTimer) {
      try {
        if (this._flushTimerIsTimeout) clearTimeout(this._flushTimer);
        else clearImmediate(this._flushTimer);
      } catch (e) { noteCatch(e); /* 已触发 */ }
      this._flushTimer = null;
    }
    const keys = new Set(this._pendingFlushKeys);
    for (const [k, evs] of this._logs) {
      if (evs.length && evs[evs.length - 1].seq > (this._flushedSeq.get(k) || 0)) keys.add(k);
    }
    this._pendingFlushKeys.clear();
    for (const k of keys) this._flush(k);
    return keys.size;
  }

  // 诊断 (测试/健康检查): 写盘模式与合并统计
  stats() {
    return {
      writeBehind: this._writeBehind,
      pendingKeys: this._pendingFlushKeys.size,
      deferredBatches: this._deferredBatches,
      deferredEvents: this._deferredEvents,
      lastDeferredAt: this._lastDeferredAt || null,
    };
  }

  // fork: 从 boundarySeq 及更早派生新会话 (设计溯源 docs/PROVENANCE.md#dsh fork 语义, 保留不可变源)
  fork(fromKey, boundarySeq, toKey) {    const keep = this._log(this._safe(fromKey)).filter((e) => e.seq <= boundarySeq);
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

  // ---- 兼容旧接口 (agent/CLI 仍可用) ----
  get(key) { return this.deriveMessages(key); }
  set(key, history) {
    const k = this._safe(key);
    // "重建"意图 = 旧内容作废。W1 (2026-10-05): 清盘不再发生在锁外, 而是先 skipFlush 攒齐
    //   整批, 再由 _flush(k, batch, explicit=true) 在该 key 的锁内一次性 unlink + 整批写入。
    //   旧写法 (锁外 rmSync + 每条消息一次独立落盘) 有两处可见的坏结果: 并发写者的行可以落进
    //   "已删文件、未写新行"的缝隙里, 使重建后的会话以非 1 开头并夹着旧行 (半重建态); 而本进程
    //   的 N 条消息又分 N 次落盘, 别的进程读到的是只重建了一半的历史。default 同理 (所有分片)。
    this._tailCache.clear(); // OPT-2: 重建意图 = 上一批的乐观盘面作废, 下面 append 必须重新读盘
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
    // 目标键上一世 (若存在过) 的投影缓存必须作废: 缓存里握着旧消息 (内存泄漏面)。
    this._compactedCache.delete(t);
    // 新键必须从零整批重建 (W1: unlink 与写入同在一把锁内), 别追加到同名旧会话上
    this._flush(t, copied, true);
    this.delete(f);
    this._bump();
    return true;
  }
  delete(key) {
    const k = this._safe(key);
    this._tailCache.clear(); // OPT-2: 磁盘内容被删, 缓存里的旧盘面对后续 append 不再成立
    this._logs.delete(k); this._nextSeq.delete(k); this._flushedSeq.delete(k);
    // 2026-11-12: 投影缓存不随 _logs 一起删 —— 旧实现里删除/改名的会话消息一直留在
    //   _compactedCache, 长跑进程反复建删会话会无界增长 (且 deriveCompacted 有概率返回残影)。
    this._compactedCache.delete(k);
    try {
      if (k === "default") {
        // 删除 default 所有分片 (旧单文件 + 各日 shard) —— 锁内删 (W1)
        this._removeDefaultFiles();
      } else {
        this._removeFile(k);
      }
    } catch (e) { noteCatch(e); }
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
}

// 各方法组挂在 prototype 上: 调用方 (this._flush / eventsByDay / archive ...) 与拆分前一致。
Object.assign(SessionStore.prototype, sessionFlushMethods, sessionDayIndexMethods, sessionMetaMethods, sessionDeriveMethods);
