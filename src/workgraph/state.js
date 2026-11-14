// src/workgraph/state.js - DSH 吸收 Step 2 的枚举/归一化/投递状态折叠
//
// 只放纯函数, 不 import 任何模块 (workgraph L2)。契约见 docs/dsh-absorb/:
//   00-EVENTS.md      事件与字段
//   01-delivery.v1.*  投递契约
//   02-STATE-MATRIX.md deliveryState × ticket.status 判定
//   03-INVARIANTS.md  I6 去重优先级 / I18 版本

export const ORIGIN = Object.freeze({
  INGRESS: "ingress",
  DELEGATE: "delegate",
  ANS: "ans",
  EXTERNAL: "external",
  REQUEUE: "requeue",
});
const ORIGIN_SET = new Set(Object.values(ORIGIN));

// 未知来源按 external 处理 (I19), 不拒绝消息也不崩溃。
export function normalizeOrigin(value, fallback = ORIGIN.INGRESS) {
  if (value === undefined || value === null || value === "") return fallback;
  const s = String(value).trim().toLowerCase();
  if (ORIGIN_SET.has(s)) return s;
  return ORIGIN.EXTERNAL;
}

// 去重策略 (I6 三段式): 显式键 > origin:externalId > source:from:messageId。
// 键在准入时一次算定并落账, 重投时不再依赖"平台这次有没有带 messageId"。
export const DEDUPE_STRATEGY = Object.freeze({
  EXPLICIT: "explicit",
  EXTERNAL_ID: "external_id",
  SOURCE_MESSAGE: "source_message",
  NONE: "none",
});
const DEDUPE_STRATEGY_SET = new Set(Object.values(DEDUPE_STRATEGY));

export function isDedupeStrategy(value) {
  return DEDUPE_STRATEGY_SET.has(String(value || ""));
}

// 各段做 percent-encode, 避免字段内的 ":" 把键拼错 (普通值输出不变, 如 feishu:u1:m1)。
export function buildDedupeKey({
  explicitKey = null, origin = null, externalId = null,
  source = "", from = "", messageId = "",
} = {}) {
  if (explicitKey) return String(explicitKey);
  if (externalId) {
    const o = normalizeOrigin(origin, ORIGIN.INGRESS);
    return `${o}:${encodeURIComponent(String(externalId))}`;
  }
  if (messageId) {
    return [source, from, messageId].map((v) => encodeURIComponent(String(v ?? ""))).join(":");
  }
  return null;
}

export function dedupeStrategyOf({
  explicitKey = null, externalId = null, messageId = "",
} = {}) {
  if (explicitKey) return DEDUPE_STRATEGY.EXPLICIT;
  if (externalId) return DEDUPE_STRATEGY.EXTERNAL_ID;
  if (messageId) return DEDUPE_STRATEGY.SOURCE_MESSAGE;
  return DEDUPE_STRATEGY.NONE;
}

export const DELIVERY_ROUTE = Object.freeze({
  SYNC: "sync",
  ASYNC: "async",
  THREAD: "thread",
});
const ROUTE_SET = new Set(Object.values(DELIVERY_ROUTE));

export function normalizeRoute(value) {
  if (value === undefined || value === null || value === "") return null;
  const s = String(value).trim().toLowerCase();
  return ROUTE_SET.has(s) ? s : null;
}

export const DELIVERY_STATE = Object.freeze({
  NONE: "none",
  ACCEPTED: "accepted",
  FAILED: "failed",
  DEAD_LETTER: "dead_letter",
  DELIVERED: "delivered",
  UNKNOWN: "unknown",
});
const DELIVERY_STATE_SET = new Set(Object.values(DELIVERY_STATE));

export function isDeliveryState(value) {
  return DELIVERY_STATE_SET.has(String(value || ""));
}

export function isTerminalDeliveryState(value) {
  return value === DELIVERY_STATE.DELIVERED || value === DELIVERY_STATE.DEAD_LETTER;
}

function _typeOf(event) {
  const raw = typeof event === "string" ? event : event?.type;
  return String(raw || "").toLowerCase();
}

// 从该 assignment 的 DELIVERY_* 事件折叠出投递状态 (02-STATE-MATRIX §2)。
// - 有 seq 时按 seq 升序, 否则保持传入顺序;
// - 首个终态生效, 之后的终态事件被忽略 (违约由事件层告警, 不覆盖事实);
// - recovered=true 表示进程重启后无法确认 send 结果: 折叠为 accepted 时降级 unknown。
export function foldDeliveryState(events = [], { recovered = false } = {}) {
  const list = Array.isArray(events) ? events : [];
  const allSeq = list.length > 1 && list.every((e) => Number.isFinite(Number(e?.seq)));
  const ordered = allSeq ? [...list].sort((a, b) => Number(a.seq) - Number(b.seq)) : list;
  let state = DELIVERY_STATE.NONE;
  let terminal = false;
  for (const event of ordered) {
    if (terminal) continue;
    const type = _typeOf(event);
    if (type === "delivery_accepted") {
      state = DELIVERY_STATE.ACCEPTED;
    } else if (type === "delivery_failed") {
      state = event?.willRetry === true ? DELIVERY_STATE.ACCEPTED : DELIVERY_STATE.FAILED;
    } else if (type === "delivery_delivered") {
      state = DELIVERY_STATE.DELIVERED;
      terminal = true;
    } else if (type === "delivery_dead_letter") {
      state = DELIVERY_STATE.DEAD_LETTER;
      terminal = true;
    }
  }
  if (recovered && state === DELIVERY_STATE.ACCEPTED) return DELIVERY_STATE.UNKNOWN;
  return state;
}
