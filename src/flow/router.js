// src/flow/router.js - Router 调度层事件与汇报协议 (2026-11-05)
//
// 一~三期把 Trigger/工单/Router 角色/看门狗铺上了, 但 Router 的"判断归属 → 分派 →
// 收到汇报"只在文本层留痕 (spawn_agent 回包 + 工单终态), 没有独立的调度事件。
// 本模块把调度协议收敛成纯函数 + 一个降级安全的写入器:
//   · normalizeWorkerReport: worker 信封 → 白名单汇报 (无正文, 可入审计链);
//   · emitRouterEvent: 推 EQ + 写 SHA-256 审计链 (白名单, 失败不阻断);
//   · buildDelegationBrief: 派发前检索全局记忆 + 角色共享板, 作为 [全局上下文] 前缀;
//   · ROUTER_EVENT / ROUTE_KIND: 事件与归属枚举 (与 protocol EventType 对齐)。
//
// 边界: 只描述"谁被分派、做到哪、结果如何", 不复制任务正文/工具结果 —— 正文在工单账本,
//   审计链只负责不可篡改的"发生过什么"。事件失败一律降级, 绝不阻断真实派发。
import { EventType } from "../protocol/index.js";
import { noteCatch } from "../utils/catch-log.js";
import { clip } from "../utils/text.js";

export const ROUTE_KIND = Object.freeze({
  INLINE: "inline",
  WORKER: "worker",
  THREAD: "thread",
});

export const ROUTER_EVENT = Object.freeze({
  DECISION: EventType.ROUTER_DECISION,
  DISPATCH: EventType.ROUTER_DISPATCH,
  REPORT: EventType.WORKER_REPORT,
});

// 审计链/事件流共用白名单。正文 (task/reply/thinking) 永远不在这里 ——
//   spawn_agent 的输入输出可能含密钥/用户隐私, 工单账本才是需要正文的地方。
const STRING_FIELDS = new Set([
  "ticketId", "assignmentId", "worker", "route", "kind", "status", "reason",
  "sessionKey", "origin", "role", "expert", "errorKind",
]);
const NUMBER_FIELDS = new Set([
  "tasks", "workers", "rounds", "steps", "toolCount", "durationMs", "memoryHits", "boardHits",
]);
const BOOL_FIELDS = new Set(["ok", "memoryInjected", "routerRole", "drifted"]);
const ARRAY_FIELDS = new Set(["tools"]);

export const ROUTER_EVENT_FIELDS = Object.freeze([
  ...STRING_FIELDS, ...NUMBER_FIELDS, ...BOOL_FIELDS, ...ARRAY_FIELDS,
]);

function int(v, max = 1e9) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, Math.trunc(n)));
}

/** 只保留白名单字段; 字符串截断、数字夹取、工具名限量。 */
export function sanitizeRouterFields(fields = {}) {
  const out = {};
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return out;
  for (const [k, v] of Object.entries(fields)) {
    if (STRING_FIELDS.has(k)) {
      if (v != null) out[k] = clip(v, 120);
    } else if (NUMBER_FIELDS.has(k)) {
      if (v != null) out[k] = int(v);
    } else if (BOOL_FIELDS.has(k)) {
      if (v != null) out[k] = v === true || v === 1 || v === "true";
    } else if (ARRAY_FIELDS.has(k)) {
      if (Array.isArray(v)) out[k] = v.slice(0, 8).map((x) => clip(x, 40));
    }
  }
  return out;
}

/**
 * 调度事件写入口: EQ (Web UI/watchdog 实时) + 审计链 (不可篡改时间线)。
 * 任何一侧失败都不阻断调度主路径; 审计关闭时只推 EQ。
 */
export function emitRouterEvent(agent, type, fields = {}) {
  const payload = sanitizeRouterFields(fields);
  const ref = {
    cause: "router",
    sessionKey: payload.sessionKey || null,
    ref: payload.ticketId || payload.assignmentId || null,
  };
  try {
    agent?._eqPushRef?.(type, payload, ref);
  } catch (e) { noteCatch(e); }
  try {
    if (agent?.audit && typeof agent.audit.appendEvent === "function"
      && agent.config?.audit?.lifecycle_events !== false) {
      agent.audit.appendEvent({ event: type, fields: payload });
    }
  } catch (e) { noteCatch(e); }
  return payload;
}

/**
 * worker 回包信封 → 稳定汇报对象。旧 worker 没有信封 (null) 也给出可入链的基本形状;
 * status 以调用方判定 (ok) 为准, 防止子进程自称 ok 掩盖超时/异常。
 */
export function normalizeWorkerReport({
  ok = true, envelope = null, worker = "", ticketId = null, assignmentId = null,
  durationMs = 0, errorKind = null,
} = {}) {
  const e = envelope && typeof envelope === "object" && !Array.isArray(envelope) ? envelope : {};
  const tools = Array.isArray(e.tools) ? e.tools.map((t) => clip(t, 40)).slice(0, 8) : [];
  const passed = ok !== false;
  return {
    worker: clip(worker || e.worker || "", 64) || null,
    ticketId: clip(ticketId || e.ticketId || "", 120) || null,
    assignmentId: clip(assignmentId || e.assignmentId || "", 120) || null,
    ok: passed,
    status: passed ? (clip(e.status || "ok", 24) || "ok") : "error",
    errorKind: clip(errorKind || "", 40) || null,
    rounds: int(e.rounds, 10000),
    steps: int(e.steps, 100000),
    tools,
    toolCount: Array.isArray(e.tools) ? e.tools.length : 0,
    durationMs: int(durationMs),
  };
}

/**
 * 高级编排 (team/review/supervisor/team-room) 的逐 Worker 生命周期:
 * 建单 → dispatch 事件 → 执行 → complete/fail + report 事件。
 * 与 spawn_agent 直派路径同口径; 账本/审计未装配时全部降级为 no-op。
 * @returns {{ticketId:string|null, assignmentId:string|null, finish:Function}}
 */
export function beginWorkerRun(agent, {
  task = "", worker = "", role = null, expert = null, sessionKey = "default", origin = "delegate",
} = {}) {
  const work = agent?.work || null;
  const sk = String(sessionKey || "default");
  let ticket = null;
  if (work && typeof work.submit === "function") {
    try {
      ticket = work.submit({ source: "spawn_agent", from: sk, text: String(task ?? "") }, { sessionKey: sk, cause: origin });
    } catch { ticket = null; }
  }
  const live = !!ticket && !ticket.deduped;
  let assignment = null;
  if (live && typeof work.begin === "function") {
    try { assignment = work.begin(ticket.id, { worker, sessionKey: sk }); } catch { assignment = null; }
  }
  const assignmentId = assignment?.id || null;
  emitRouterEvent(agent, ROUTER_EVENT.DISPATCH, {
    ticketId: live ? ticket.id : null,
    assignmentId,
    worker,
    sessionKey: sk,
    origin,
    route: ROUTE_KIND.WORKER,
    role,
    expert,
  });
  let done = false;
  return {
    ticketId: live ? ticket.id : null,
    assignmentId,
    finish({ ok = true, envelope = null, reply = "", errorKind = null, durationMs = 0, extra = {} } = {}) {
      if (done) return;
      done = true;
      if (live && work) {
        try {
          if (ok) work.complete(ticket.id, { result: reply, envelope });
          else work.fail(ticket.id, new Error(errorKind || "worker_failed"), { failureKind: errorKind || "worker_failed" });
        } catch { /* 账本不阻断编排 */ }
      }
      emitRouterEvent(agent, ROUTER_EVENT.REPORT, {
        ...normalizeWorkerReport({
          ok, envelope, worker, ticketId: live ? ticket.id : null, assignmentId,
          durationMs, errorKind: ok ? null : (errorKind || "worker_error"),
        }),
        route: ROUTE_KIND.WORKER,
        origin,
        role,
        ...extra,
      });
    },
  };
}

/**
 * 派发前全局上下文: 语义记忆 topN + 同角色共享板近 2 条 (跨 Worker 实时事实)。
 * 未开启 / 无命中 → 空串 (行为与旧路径一致, 不白占 token)。
 */
export async function buildDelegationBrief(agent, task, {
  board = null, role = "", limit = 3, maxChars = 800,
} = {}) {
  const sections = [];
  let memoryHits = 0;
  let boardHits = 0;

  try {
    const facts = agent?.facts;
    if (facts && typeof facts.querySemantic === "function") {
      const n = Math.max(1, Math.min(8, Number(limit) || 3));
      const rows = await facts.querySemantic(String(task || ""), { limit: n });
      const lines = (Array.isArray(rows) ? rows : [])
        .map((h) => String(h?.content || h?.text || "").replace(/\s+/g, " ").trim().slice(0, 180))
        .filter(Boolean)
        .slice(0, n);
      if (lines.length) {
        sections.push("记忆:\n" + lines.map((l) => `- ${l}`).join("\n"));
        memoryHits = lines.length;
      }
    }
  } catch (e) { noteCatch(e); /* 记忆检索失败不影响派发 */ }

  try {
    if (board && typeof board.query === "function") {
      const rows = board.query({ topic: role || undefined, limit: 2 });
      const lines = (Array.isArray(rows) ? rows : [])
        .map((r) => `[${clip(r?.from || "worker", 24)}] ${String(r?.content || "").replace(/\s+/g, " ").trim().slice(0, 160)}`)
        .filter((l) => l.length > 8)
        .slice(0, 2);
      if (lines.length) {
        sections.push("共享板:\n" + lines.map((l) => `- ${l}`).join("\n"));
        boardHits = lines.length;
      }
    }
  } catch (e) { noteCatch(e); /* 共享板读取失败不影响派发 */ }

  if (!sections.length) return { text: "", memoryHits: 0, boardHits: 0 };
  let text = `[全局上下文]\n${sections.join("\n")}\n\n`;
  if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 4))}\n…\n\n`;
  return { text, memoryHits, boardHits };
}
