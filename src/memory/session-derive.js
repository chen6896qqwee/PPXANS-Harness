// src/memory/session-derive.js - 日志投影: 模型可见历史 / 压缩后视图 / 回放 (mixin, 从 session.js 拆出)
// 全部方法是事件日志的**纯读投影**, 不落盘、不改日志; 增量缓存字段 (_compactedCache) 由宿主构造器初始化。
// 依赖约束: 不得 import session.js (宿主), 否则成环。
import { EVENTS } from "./session-events.js";

export const sessionDeriveMethods = {
  // 从日志投影模型可见历史 (user/assistant), 无可变状态
  deriveMessages(key) {
    return this._log(this._safe(key))
      .filter((e) => e.type === EVENTS.USER || e.type === EVENTS.ASSISTANT)
      .map((e) => ({ role: e.type === EVENTS.USER ? "user" : "assistant", content: e.data?.content }));
  },

  // 投影「压缩后」的模型可见历史: 最后一条 compaction 事件之前 (seq <= upToSeq) 的消息被摘要替换
  // 设计溯源 docs/PROVENANCE.md#openclaw compaction: 摘要作为单一 surface node 替换被压缩区间, 日志本身不可变
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
  },

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
  },

  // 完整事件流 (回放/审计/轨迹)
  replay(key) { return [...this._log(this._safe(key))]; },

  // count: 事件条数
  count(key) { return this._log(this._safe(key)).length; },
};
