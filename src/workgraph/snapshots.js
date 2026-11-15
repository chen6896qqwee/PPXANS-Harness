// src/workgraph/snapshots.js - 工单账本的快照字段规整与只读拷贝
//
// 账本只接受契约允许的字段形态: 任意对象/数组不得直接落盘 (会污染折叠与查询),
// 大文本由调用方 clip 后再进来。拷贝函数保证调用方拿不到内部可变引用。
import { clip } from "../utils/text.js";
import { DELIVERY_STATE } from "./state.js";

// 契约对象只接受纯对象快照 (delivery.v1); 数组/标量视为无效。
export function plainObject(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return JSON.parse(JSON.stringify(v));
}

// token 统计只保留契约字段, 避免任意对象污染账本。
export function normalizeUsageSnapshot(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = {};
  for (const k of ["prompt", "completion", "cacheHit", "cacheHitPct", "total"]) {
    if (Number.isFinite(Number(v[k]))) out[k] = Number(v[k]);
  }
  return Object.keys(out).length ? out : null;
}

// deliveryReceipt 只是投递终态的**缓存** (I4 修订): 权威事实仍在 DELIVERY_* 事件流。
// 只接受终态, 避免把"投递中"误当成可收口的快照。
const RECEIPT_SNAPSHOT_STATES = new Set([
  DELIVERY_STATE.DELIVERED, DELIVERY_STATE.DEAD_LETTER, DELIVERY_STATE.UNKNOWN,
]);

export function deliveryReceiptSnapshot(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const assignmentId = String(v.assignmentId || "");
  const state = String(v.state || "");
  if (!assignmentId || !RECEIPT_SNAPSHOT_STATES.has(state)) return null;
  return {
    assignmentId,
    state,
    attempt: Number.isFinite(Number(v.attempt)) ? Math.max(0, Math.trunc(Number(v.attempt))) : 0,
    receiptId: v.receiptId == null ? null : clip(v.receiptId, 120),
    reason: v.reason == null ? null : clip(v.reason, 120),
    at: Number.isFinite(Number(v.at)) ? Number(v.at) : null,
  };
}

export function copyTicket(t) {
  if (!t) return null;
  return {
    ...t,
    tools: Array.isArray(t.tools) ? [...t.tools] : t.tools,
    deliveryReceipt: t.deliveryReceipt ? { ...t.deliveryReceipt } : null,
  };
}

export function copyAssignment(a) {
  if (!a) return null;
  return { ...a, tools: Array.isArray(a.tools) ? [...a.tools] : [] };
}
