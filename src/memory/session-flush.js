// src/memory/session-flush.js - 会话落盘 (mixin, 从 session.js 拆出)
// 只有这一组方法碰文件锁与 seq 重排; 宿主 SessionStore 提供 dir/_file/_shardFile/_dayOf/
// _diskMaxSeq/_tailMaxSeq/_defaultFiles/_defaultAnchorFile 等路径与读盘原语。
// 依赖约束: 不得 import session.js (宿主), 否则成环。
import { warn as logWarn } from "../utils/logger.js";
import { noteCatch } from "../utils/catch-log.js";
import fs from "node:fs";
import { withFileLock, withFileLocks } from "../utils/store.js";
import { EVENTS } from "./session-events.js";

export const sessionFlushMethods = {
  // 增量落盘: 只追加 flushedSeq 之后的新事件 (P1#5, 消除大会话全量重写)
  // default 按天落盘: 只把当天分片写到对应 default-YYYY-MM-DD.jsonl, 非当前天文件不再改写
  // pending / explicit (v2026-10-05 W1): 重建路径 (set/fork/rename) 由调用方给出整批待写事件,
  //   explicit=true 表示"该 key 的磁盘内容整批作废" —— 在同一把锁里先 unlink 再整批写入,
  //   并发写者插不进"文件已删/新行未写"的缝隙。普通增量路径两个参数都不传, 行为不变。
  _flush(key, pending = null, explicit = false) {
    const k = this._safe(key);
    // 显式/立即落盘覆盖了本 key 的排程意图 (下面会写到最新水位), 不必再被 timer 重复写一次。
    this._pendingFlushKeys.delete(k);
    const evs = this._logs.get(k) || [];
    const flushed = this._flushedSeq.get(k) || 0;
    const batch = Array.isArray(pending) ? pending
      : (explicit ? evs : evs.filter((e) => e.seq > flushed));
    if (!explicit && !batch.length) return;
    try {
      if (k === "default") this._flushDaily(k, batch, { rebuild: explicit });
      else this._flushLegacy(k, batch, { rebuild: explicit });
      // 落盘后的游标取"本批最大 seq" (多日重建后数组顺序 != seq 顺序, 不能取尾元素);
      // 重建时旧的 flushed 随清盘一起作废, 所以基准从 0 起算
      let mx = explicit ? 0 : flushed;
      for (const e of evs) if (e.seq > mx) mx = e.seq;
      for (const e of batch) if (e.seq > mx) mx = e.seq;
      this._flushedSeq.set(k, mx);
      this._bump(); // 锁内可能改过 seq / compaction 游标, 派生缓存必须作废
    } catch (e) {
      // v1.0.9: 落盘失败不再静默 (磁盘满/权限丢失消息不可见), 至少留日志
      try { logWarn(`[session] 会话 ${k} 落盘失败: ${e.message}`); } catch (e) { noteCatch(e); }
    } finally {
      // OPT-2: 本批已落盘 (无论成功/失败), 乐观尾读缓存一律作废 —— 下一批必须重新读盘:
      //   成功时盘面已因本批追加而前进; 失败时更不能再拿旧盘面当起点。
      this._tailCache.clear();
    }
  },

  // 事件按值复制 (fork/rename 建目标会话用): 两侧各自重排 seq 时不得互相改到同一批对象
  _cloneEvent(e) {
    const data = e && typeof e.data === "object" && e.data ? { ...e.data } : e.data;
    return { seq: e.seq, ts: e.ts, type: e.type, data };
  },

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
  },

  // 已持锁时的静默删除
  _rmSyncQuiet(file) {
    try { fs.rmSync(file, { force: true }); } catch (e) { noteCatch("src/memory/session.js#_rmSyncQuiet", e); }
  },

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
    // 记下锁内实际读到的盘面 (OPT-2): 调用方 (_flushLegacy) 还要判断"磁盘上有没有行",
    //   这里复用同一次锁内尾读, 避免同一把锁内对同一文件读两遍。判定点是锁内真实盘面, 不是缓存。
    this._ensureDiskMax = diskMax;
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
  },

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
  },

  // 非 default 会话: 增量落盘 (盘上还没有这个会话时全量写, 已有则只追加)
  // v3.2.3 (P2#15): 追加段加跨进程文件锁 (与 facts 锁策略对齐) —— 多进程共用同一数据目录时,
  // 无锁 appendFileSync 在 Windows 上可能交错写坏行; 锁内失败由 _flush 的 catch 兜底告警
  // 2026-10-04: 是否全量重写改由"磁盘上有没有行"决定, 不再看本进程的 flushed 标志。
  //   原逻辑 flushed===0 就 writeFileSync 整文件覆盖 —— 另一个进程刚写的会话历史会被这一刀
  //   直接抹掉 (新实例构造时目录还是空的, 它的 flushed 永远是 0)。"重建"意图改由 rebuild
  //   表达 (锁内 unlink + 整批写), 这里只按磁盘事实走。
  _flushLegacy(k, pending, { rebuild = false } = {}) {
    const file = this._file(k);
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
      // OPT-2: 上面 _ensureUniqueSeq 已在同一把锁内读过本文件的末行 (_ensureDiskMax),
      //   这里直接复用该盘面判定"追加 or 整文件写", 不再对同一文件重复尾读一遍。
      if (!rebuild && this._ensureDiskMax > 0) fs.appendFileSync(file, line, "utf8");
      else fs.writeFileSync(file, line, "utf8");
    });
  },

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
    // OPT-2: 锚分片路径留一份 —— 锁内游标播种读的就是它的末行, 逐日尾读遇到同一文件时直接复用。
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
        // OPT-2: _diskMaxSeq 刚读过的那个分片 (= 游标播种来源), 逐日尾读遇到它时无需再读一遍。
        //   注意用 "_diskMaxFile" 而不是锁外取的 anchorFile: 两者之间并发进程可能刚建出新的
        //   今日分片, 用错文件会低估真实末行 —— 只复用"确实刚读过"的那一个。
        const seededFile = this._diskMaxFile;
        for (const d of days) {
          const g = groups.get(d);
          const shard = this._shardFile(d);
          // 权威仍是锁内读到的磁盘末行 (cursor 的播种值); append 的乐观缓存不参与本判定。
          const tail = shard === seededFile ? cursor : this._tailMaxSeq(shard);
          if (tail > cursor) cursor = tail;
          this._ensureUniqueSeq(k, g, cursor, remap);
          for (const e of g) if (e.seq > cursor) cursor = e.seq;
        }
        this._repairCompactionCursors(pending, remap);
      }
      for (const d of days) {
        const file = this._shardFile(d);
        const line = groups.get(d).map((e) => JSON.stringify(e)).join("\n") + "\n";
        // OPT-2: 非重建路径一律 appendFileSync —— 目标文件不存在/为空时它与 writeFileSync 逐字节
        //   等价 (都以本批内容建出文件), 原先的 existsSync 分支是每批多一次系统调用。
        //   重建路径必须 writeFileSync (整文件覆盖, 兜 Windows rmSync 失败留下的残存行)。
        if (rebuild) fs.writeFileSync(file, line, "utf8");
        else fs.appendFileSync(file, line, "utf8");
      }
    });
  },

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
  },
};
