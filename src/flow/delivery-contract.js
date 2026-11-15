// src/flow/delivery-contract.js - delivery.v1 契约解析 (DSH 吸收 Step 4, L2)
//
// 唯一职责: 把"这次入站该怎么执行/怎么投递"翻译成契约对象, 字段严格对齐
// docs/dsh-absorb/01-delivery.v1.schema.json —— 运行时代码只允许实现该文件, 不发明字段。
//
// 解析顺序 (schema x-resolution-order): 显式 > 通道默认 > flow 默认 > sync。
// 显式只能收紧 (sync → async), 不能把 async/thread 改成 sync。
// 显式的来源只认 trigger.delivery (进程内字段); meta 会被通道透传, 不参与投递语义,
// 避免 webhook 请求体伪造 sink/route (I19 的同一条边界)。
import { ORIGIN, normalizeOrigin, normalizeRoute } from "../workgraph/state.js";

const DELIVERY_CONTRACT_VERSION = "delivery.v1";
export const SYNC_DEADLINE_MS = 30000;
export const ASYNC_DEFAULTS = Object.freeze({
  max_attempts: 4,
  backoff_ms: 2000,
  backoff_cap_ms: 60000,
  jitter_ratio: 0.1,
  ttl_ms: 3600000,
  retry_on: Object.freeze(["timeout", "network", "rate_limit", "server_error"]),
});
const RETRY_ON = new Set(ASYNC_DEFAULTS.retry_on);

function int(v, { def = 0, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function ratio(v, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(0, Math.min(1, n));
}

// 通道默认: 全局 channels.delivery 与通道级 channels.<name>.delivery 叠加 (通道级更具体)。
function channelDefaults(agent, channelName) {
  const channels = agent?.config?.channels || {};
  const perChannel = channels?.[channelName]?.delivery;
  return {
    ...(channels.delivery && typeof channels.delivery === "object" ? channels.delivery : {}),
    ...(perChannel && typeof perChannel === "object" ? perChannel : {}),
  };
}

// 显式路由只能把 sync 收紧为 async; thread 必须已有驻派入口, 不能凭空指定。
export function tightenRoute(computed, explicitDelivery = null) {
  const route = normalizeRoute(computed) || "sync";
  if (route !== "sync") return route;
  const requested = normalizeRoute(explicitDelivery?.route);
  return requested === "async" ? "async" : route;
}

function buildSink({ explicit, trigger, channelName, replyTo, meta }) {
  const es = explicit?.sink && typeof explicit.sink === "object" ? explicit.sink : {};
  const channel = String(es.channel || channelName || "unknown");
  const to = String(es.to || replyTo || "*");
  const thread = es.thread !== undefined ? (es.thread == null ? null : String(es.thread))
    : (trigger?.thread ? String(trigger.thread) : null);
  const replyToId = es.replyTo !== undefined ? (es.replyTo == null ? null : String(es.replyTo))
    : (trigger?.messageId ? String(trigger.messageId) : null);
  return {
    channel,
    to,
    thread,
    replyTo: replyToId,
    meta: meta && typeof meta === "object" ? { ...meta } : null,
  };
}

function buildExecution(explicit) {
  const e = explicit && typeof explicit === "object" ? explicit : {};
  return {
    timeout_ms: int(e.timeout_ms, { def: 0, min: 0 }),
    deadline_at: e.deadline_at == null ? null : int(e.deadline_at, { def: 0, min: 0 }),
  };
}

function buildPolicy(route, { explicit, agent, channelName, entry }) {
  const dcfg = channelDefaults(agent, channelName);
  const ep = explicit?.policy && typeof explicit.policy === "object" ? explicit.policy : {};

  if (route === "sync") {
    const p = ep.kind === "sync" ? ep : {};
    const channelMs = int(dcfg.sync_deadline_ms ?? dcfg.deadline_ms, { def: 0, min: 0 });
    const deadline = int(p.deadline_ms, { def: 0, min: 0 }) || channelMs || SYNC_DEADLINE_MS;
    return { kind: "sync", deadline_ms: Math.max(1, deadline), on_timeout: "dead_letter" };
  }

  if (route === "async") {
    const p = ep.kind === "async" ? ep : {};
    const retryMax = int(dcfg.retry_max, { def: 3, min: -1 });
    const channelMaxAttempts = retryMax >= 0 ? retryMax + 1 : ASYNC_DEFAULTS.max_attempts;
    const retryOn = Array.isArray(p.retry_on)
      ? p.retry_on.map(String).filter((k) => RETRY_ON.has(k))
      : [...ASYNC_DEFAULTS.retry_on];
    return {
      kind: "async",
      max_attempts: int(p.max_attempts, { def: channelMaxAttempts, min: 1, max: 10 }),
      backoff_ms: int(p.backoff_ms, { def: int(dcfg.backoff_ms, { def: ASYNC_DEFAULTS.backoff_ms, min: 0 }), min: 0 }),
      backoff_cap_ms: int(p.backoff_cap_ms, {
        def: int(dcfg.backoff_cap_ms, { def: ASYNC_DEFAULTS.backoff_cap_ms, min: 0 }), min: 0,
      }),
      jitter_ratio: ratio(p.jitter_ratio, ratio(dcfg.jitter_ratio, ASYNC_DEFAULTS.jitter_ratio)),
      ttl_ms: int(p.ttl_ms, { def: int(dcfg.ttl_ms, { def: ASYNC_DEFAULTS.ttl_ms, min: 0 }), min: 0 }),
      retry_on: retryOn,
    };
  }

  // thread: worker/busy_policy 由驻派事实决定 (显式不得冒充别的 worker);
  // forward_timeout_ms=0 表示沿用桥默认 (兼容旧行为)。
  return {
    kind: "thread",
    worker: String(entry?.name || (ep.kind === "thread" && ep.worker) || "unknown"),
    busy_policy: "reject",
    forward_timeout_ms: int(ep.kind === "thread" ? ep.forward_timeout_ms : 0, { def: 0, min: 0 }),
  };
}

// I6 三段式: 键在 workgraph 准入时已算定 (ticket.dedupeKey / dedupeStrategy) —— 契约只如实上报,
// 不在这里重新推导, 否则 DSH 看到的重投键会和账本里的工单键对不上。
function buildDedupe(ticket, trigger, agent) {
  const key = ticket?.dedupeKey ? String(ticket.dedupeKey) : null;
  const strategy = ticket?.dedupeStrategy
    || (key ? "explicit" : (trigger?.externalId ? "external_id" : (trigger?.messageId ? "source_message" : "none")));
  const cfgMs = Number(agent?.config?.agent?.work_graph?.dedupe_ms);
  const out = {
    key,
    strategy,
    window_ms: Number.isFinite(cfgMs) && cfgMs >= 0 ? cfgMs : 30000,
  };
  // 可选字段 (I3): 无 externalId 时不出现, 旧形状逐字节不变。
  const ext = ticket?.externalId ? String(ticket.externalId) : (trigger?.externalId || null);
  if (ext) out.external_id = ext;
  return out;
}

/**
 * 解析一次执行的 delivery.v1 契约。assignmentId 在 workgraph.assign 落账时绑定
 * (store 侧写入, 避免调用方各自拼 ID)。
 */
export function resolveDeliveryContract({
  route,
  origin = null,
  trigger = null,
  agent = null,
  channelName = "",
  ticket = null,
  replyTo = null,
  meta = null,
  entry = null,
  now = Date.now,
} = {}) {
  const explicit = trigger?.delivery && typeof trigger.delivery === "object" ? trigger.delivery : null;
  const r = normalizeRoute(route) || "sync";
  return {
    version: DELIVERY_CONTRACT_VERSION,
    ticketId: ticket?.id ? String(ticket.id) : null,
    assignmentId: null,
    route: r,
    origin: normalizeOrigin(origin || ticket?.origin, ORIGIN.INGRESS),
    sink: buildSink({ explicit, trigger, channelName, replyTo, meta }),
    execution: buildExecution(explicit?.execution),
    policy: buildPolicy(r, { explicit, agent, channelName, entry }),
    dedupe: buildDedupe(ticket, trigger, agent),
    createdAt: now(),
  };
}

export function bindDeliveryContract(contract, { ticketId = null, assignmentId = null } = {}) {
  if (!contract || typeof contract !== "object") return null;
  return {
    ...contract,
    ticketId: ticketId ? String(ticketId) : contract.ticketId,
    assignmentId: assignmentId ? String(assignmentId) : contract.assignmentId,
  };
}

// 剩余执行预算: timeout_ms 从契约创建时刻起算; deadline_at 是绝对时间。两者取更早, 无上限返回 null。
export function remainingExecutionMs(execution, now = Date.now()) {
  if (!execution || typeof execution !== "object") return null;
  const createdAt = Number(execution.createdAt);
  const limits = [];
  const timeout = Number(execution.timeout_ms);
  if (timeout > 0) limits.push((Number.isFinite(createdAt) ? createdAt : now) + timeout - now);
  const deadline = Number(execution.deadline_at);
  if (Number.isFinite(deadline) && execution.deadline_at != null) limits.push(deadline - now);
  if (!limits.length) return null;
  return Math.max(0, Math.min(...limits));
}

// sync 发送硬超时 = min(policy.deadline_ms, 剩余 execution 预算)。非 sync 契约返回 null。
// 预算已耗尽时返回 1ms (立即超时), 而不是 0 (0 在 sendSync 里表示"不设上限")。
export function effectiveSyncDeadlineMs(contract, now = Date.now()) {
  const policy = contract?.policy;
  if (!policy || policy.kind !== "sync") return null;
  const base = Number(policy.deadline_ms) > 0 ? Number(policy.deadline_ms) : SYNC_DEADLINE_MS;
  const execution = contract?.execution
    ? { ...contract.execution, createdAt: contract.createdAt }
    : null;
  const remaining = remainingExecutionMs(execution, now);
  return remaining == null ? base : Math.max(1, Math.min(base, remaining));
}
