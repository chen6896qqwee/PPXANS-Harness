// src/memory/session-day-index.js - 按天派生索引 (mixin, 从 session.js 拆出)
// 只读事件日志, 维护宿主上的派生缓存 (_dayCache/_dayCacheAt/_dayCursors)。
// 依赖约束: 不得 import session.js (宿主), 否则成环。
import { EVENTS } from "./session-events.js";

export const sessionDayIndexMethods = {
  // L0 只读代理 / 按天审计: 遍历所有会话, 派生某天的对话事件 (消除 l0/*.jsonl 重复)
  // v1.1.1: 全库按天缓存, 版本未变则零成本; 保持"本地自然日"语义 (与 _dayOf/logicalDay 一致, 避免时区错位)
  // v4.2 (2026-11-01): 版本变化改走增量 —— 依据同 deriveCompacted: append 是原地 push (引用不变),
  //   索引只存不可变字段 (key/type/ts/content, 不含 seq —— _flush 锁内重排 seq 不影响本索引);
  //   set/rename/fork/load 换新数组 → purge 该键旧条目后按键重建; 键删除 → purge + 清游标。
  //   排序不变式 (2026-09-18) 保持: 每个被写入过的天在出缓存前都重排时间序。
  eventsByDay(day) {
    const dayStr = String(day).slice(0, 10);
    const dayMs = new Date(dayStr + "T00:00:00").getTime();
    if (Number.isNaN(dayMs)) return [];
    // 缓存命中: 版本未变时按 day 直接返回 (append 后 _bump 失效, 下轮走增量)
    if (this._dayCacheAt === this._version && this._dayCache.size) {
      const hit = this._dayCache.get(dayStr);
      if (hit) return hit;
    }
    const fresh = this._dayCacheAt !== this._version || !(this._dayCursors instanceof Map);
    if (fresh) {
      // 全库扫描一次 (构造后首次 / 内部状态被弃用), 按"事件 ts 的本地自然日"聚合
      const byDay = new Map();
      const cursors = new Map();
      for (const [key, events] of this._logs) this._indexDayEvents(byDay, cursors, key, events, 0, null);
      for (const arr of byDay.values()) arr.sort((a, b) => a.timestamp - b.timestamp);
      this._dayCache = byDay;
      this._dayCursors = cursors;
      this._dayCacheAt = this._version;
      return byDay.get(dayStr) || [];
    }
    // 增量: 键消失 → purge + 清游标; 引用未变 → 只索引尾部新增; 引用换新 → purge 后整键重建
    const byDay = this._dayCache;
    const cursors = this._dayCursors;
    const touched = new Set();
    for (const key of [...cursors.keys()]) {
      if (!this._logs.has(key)) { this._purgeDayIndex(byDay, key); cursors.delete(key); }
    }
    for (const [key, events] of this._logs) {
      const cur = cursors.get(key);
      if (cur && cur.ref === events && events.length >= cur.count) {
        if (events.length > cur.count) this._indexDayEvents(byDay, cursors, key, events, cur.count, touched);
      } else {
        if (cur) this._purgeDayIndex(byDay, key);
        this._indexDayEvents(byDay, cursors, key, events, 0, touched);
      }
    }
    for (const d of touched) {
      const arr = byDay.get(d);
      if (arr) arr.sort((a, b) => a.timestamp - b.timestamp);
    }
    this._dayCacheAt = this._version;
    return byDay.get(dayStr) || [];
  },

  // events[from..] 中的 user/assistant 事件按天索引进 byDay, 游标推进到 events.length
  // touched (可选): 收集本次新增过条目的天, 供调用方按天重排时间序; null = 全量重建路径 (调用方统一排序)
  _indexDayEvents(byDay, cursors, key, events, from, touched) {
    for (let i = from; i < events.length; i++) {
      const e = events[i];
      if (e.type !== EVENTS.USER && e.type !== EVENTS.ASSISTANT) continue;
      const d = this._dayOf(e.ts);
      let arr = byDay.get(d);
      if (!arr) { arr = []; byDay.set(d, arr); }
      arr.push({ sessionKey: key, role: e.type === EVENTS.USER ? "user" : "assistant", content: e.data?.content, timestamp: e.ts });
      if (touched) touched.add(d);
    }
    cursors.set(key, { ref: events, count: events.length });
  },

  // 把某 key 的旧索引条目从所有天里清出 (set/rename/fork/reset 等换数组/删键的罕见路径)
  // filter 保序: 幸存条目的时间序不变, 空天直接删除
  _purgeDayIndex(byDay, key) {
    for (const [d, arr] of byDay) {
      const kept = arr.filter((r) => r.sessionKey !== key);
      if (kept.length !== arr.length) {
        if (kept.length) byDay.set(d, kept);
        else byDay.delete(d);
      }
    }
  },

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
  },
};
