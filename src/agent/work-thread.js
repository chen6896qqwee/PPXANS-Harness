// src/agent/work-thread.js - 轮归属 + 长驻 worker 话题编排 (2026-11-08 自 work.js 拆出)
// work.js 863 行巨石的三路拆分之一: 这一半是 'Router 决定谁接这轮' 与 'ThreadBridge 常驻坐班'。
import { ThreadBridge } from '../orchestrator/thread-bridge.js';
import { Legion } from '../orchestrator/legion.js';
import { EventType } from '../protocol/index.js';
import { ROUTE_KIND, ROUTER_EVENT, emitRouterEvent, normalizeWorkerReport } from '../flow/router.js';

export const workThreadMethods = {
// ---- 轮归属 (2026-11-05): Router 最常见的决定是"不分派, 直接答" ----
// 每会话记录本轮归属 (inline/worker/thread), 轮收口时若仍为 inline 则补一条决策事件。
// 用 Map 按 sessionKey 隔离: 不同会话可并发跑, 单实例布尔会串轮。
_markTurnRoute(sessionKey, route) {
  if (this.role !== "router") return;
  if (!this._turnRoutes) this._turnRoutes = new Map();
  this._turnRoutes.set(String(sessionKey || "default"), String(route || "inline"));
},

_emitInlineDecision(sessionKey, status = "closed") {
  const sk = String(sessionKey || "default");
  const route = this._turnRoutes?.get(sk);
  if (route !== undefined) this._turnRoutes.delete(sk);
  if (this.role !== "router" || route !== "inline") return;
  emitRouterEvent(this, ROUTER_EVENT.DECISION, {
    kind: "inline",
    route: ROUTE_KIND.INLINE,
    reason: status === "aborted" ? "turn_aborted" : "answered_inline",
    sessionKey: sk,
    ok: status !== "aborted",
    routerRole: true,
  });
},

// 无通道入口 (MCP/CLI) 的受账对话: 建单 → begin → 执行 → complete/fail。
// 让同一次对话在 /work、看门狗与审计链里与 IM/Web 入站同源可查。
async chatTracked(text, {
  source = "api", from = "local", sessionKey = "default", cause = "ingress",
  worker = "router", run = null, origin = null, dedupeKey = null, externalId = null,
  skipIfDeduped = false,
} = {}) {
  const work = this.work;
  let ticket = null;
  let assignment = null;
  if (work && typeof work.submit === "function") {
    try {
      ticket = work.submit(
        { source, from, text: String(text ?? ""), sessionKey },
        { sessionKey, cause, origin, dedupeKey, externalId },
      );
    } catch { ticket = null; }
  }
  const live = !!ticket && !ticket.deduped;
  // ANS submit: 命中账本去重时不重复执行 (普通 chatTracked 仍保留"重放一次"的旧语义)。
  if (!live && skipIfDeduped && ticket?.deduped) {
    return {
      reply: null, ticketId: ticket.id || null,
      assignmentId: ticket.assignmentId || null, deduped: true,
    };
  }
  if (live && typeof work.begin === "function") {
    try { assignment = work.begin(ticket.id, { worker, sessionKey }); } catch { assignment = null; }
  }
  try {
    const reply = await (typeof run === "function" ? run() : this.chat(text, { sessionKey }));
    if (live) { try { work.complete(ticket.id, { result: reply }); } catch { /* 账本不阻断回复 */ } }
    return { reply, ticketId: ticket?.id || null, assignmentId: assignment?.id || null, deduped: !!ticket?.deduped };
  } catch (e) {
    if (live) { try { work.fail(ticket.id, e); } catch { /* 账本不阻断异常 */ } }
    // ANS 失败回投需要工单身份; 只附加属性, 不改异常类型/消息。
    if (e && typeof e === "object") {
      try {
        e.ticketId = ticket?.id || null;
        e.assignmentId = assignment?.id || null;
      } catch { /* frozen error: 保持原样 */ }
    }
    throw e;
  }
},

// ---- 长驻 worker 话题编排 (2026-11-01 三期第一批, 设计稿 §3.2 订阅直通) ----
_threadBridge() {
  if (this.__threadBridge) return this.__threadBridge;
  this.__threadBridge = new ThreadBridge({
    legion: this._legion || (this._legion = new Legion()),
    dataDir: this.dataDir,
    globalDataDir: this.globalDataDir,
    deliver: (payload, reply) => this._deliverThreadReply(payload, reply),
    onEvent: (type, payload) => { try { this.tracer?.event?.(type, payload); } catch { /* 不阻断 */ } },
    onReport: (r) => {
      try {
        emitRouterEvent(this, ROUTER_EVENT.REPORT, {
          ...normalizeWorkerReport(r),
          route: ROUTE_KIND.THREAD,
          origin: "delegate",
          role: "thread",
        });
      } catch { /* 观测不阻断 */ }
    },
  });
  return this.__threadBridge;
},

// worker 回复回投: 只回"消息来源通道"的原话题 (delivery 队列: 重试/WAL 续投)
_deliverThreadReply(payload, reply) {
  const mgr = this.channelManager;
  const meta = {
    thread: payload.thread || "",
    replyTo: payload.messageId || "",
    kind: "thread-worker",
    ticketId: payload.ticketId || null,
    assignmentId: payload.assignmentId || null,
    sessionKey: payload.sessionKey || null,
    origin: payload.origin || "ingress",
  };
  if (mgr?.delivery?.enqueue) {
    mgr.delivery.enqueue({ channel: payload.source || "log", to: payload.from || "*", text: reply, meta });
  } else {
    // 无 delivery (测试桩/未装配): 诚实落 tracer, 不假装已投递
    try { this.tracer?.event?.("thread/reply_undelivered", { source: payload.source, from: payload.from, chars: String(reply || "").length }); } catch {}
  }
},

// 驻派: 把一个话题/会话交给长驻 worker 专职跟进 (后续同话题消息直通, 不进 Router LLM)
async threadDelegate(sessionKey, task, opts = {}) {
  const bridge = this._threadBridge();
  this._markTurnRoute?.(sessionKey, "thread");
  const r = await bridge.attach(String(sessionKey || "default"), {
    task, sessionKey, thread: opts.thread || null, readonly: opts.readonly === true,
  });
  // 驻派也是 Router 的一次分派 (route=thread): 审计链与 spawn_agent 同口径留痕,
  //   后续同话题消息由 kernel 直通, 不再产生新的 Router 决策事件。
  emitRouterEvent(this, ROUTER_EVENT.DISPATCH, {
    kind: "thread",
    route: ROUTE_KIND.THREAD,
    worker: r?.name || "thread",
    sessionKey: String(sessionKey || "default"),
    origin: "delegate",
    role: "thread",
  });
  this.notify?.(`[驻派] 话题 ${sessionKey} → 长驻 worker ${r.name} (后续同话题消息直通)。`);
  return r;
},

// 直通判定 (handleTrigger 每条消息先问): 命中 = 该话题有驻派 worker
threadRoute(sessionKey, thread = "") {
  return this.__threadBridge?.route(sessionKey, thread) || null;
},

async threadForward(payload, opts = {}) {
  const bridge = this._threadBridge();
  const entry = bridge.route(payload.sessionKey, payload.thread);
  if (!entry) return { forwarded: false, reason: "no-entry" };
  return bridge.forward(entry, payload, opts);
},

async threadDetach(sessionKey) {
  if (!this.__threadBridge) return false;
  return this.__threadBridge.detach(sessionKey);
},

threadWorkers() {
  return this.__threadBridge?.list() || [];
},

// 入站消息进事件流 (三期① 收口: 此前 Trigger 不进 EQ, 观测盲区)
emitMessageReceived(trigger, sessionKey) {
  this._eqPushRef?.(EventType.MESSAGE_RECEIVED, {
    source: trigger.source || "unknown", from: trigger.from || "", group: trigger.group || "",
    thread: trigger.thread || "", messageId: trigger.messageId || "",
    textPreview: String(trigger.text ?? "").slice(0, 200), sessionKey,
  }, { sessionKey, thread: trigger.thread || "", ref: trigger.id });
},

// 需求提炼事件 (2026-11-07 双通道): 任务简报元数据进 EQ —— 只进形状字段
// (isTask/置信/来源/缺信息清单/时限原文), 正文与提炼出的 goal 不入事件
// (与 audit scrubArgs 的正文折叠同口径: 事件面回答"提炼发生了", 不搬运内容)。
emitTaskExtracted(trigger, brief, sessionKey) {
  this._eqPushRef?.(EventType.TASK_EXTRACTED, {
    isTask: brief?.isTask === true,
    confidence: Number(brief?.confidence) || 0,
    source: brief?.source || "fast",
    failOpen: brief?.failOpen || null,
    deadline: String(brief?.deadline || ""),
    missing: Array.isArray(brief?.missing) ? brief.missing.slice(0, 5) : [],
    messageId: trigger?.messageId || "",
    sessionKey,
  }, { sessionKey, thread: trigger?.thread || "", ref: trigger?.id || null });
},

// 执行进度采样 (Step 3): 轮次回调 → 当前会话在途 assignment 的 assignment_progress。
// 只做观测; 服务层按 500ms 窗口合并 (I14), 这里不自己做限流。
_workProgressTick(sessionKey, ev) {
  const sk = sessionKey || this._activeSessionKey;
  if (!this.work || !sk || !ev) return;
  const patch = {};
  const round = Number(ev.round);
  if (Number.isFinite(round)) patch.rounds = round + 1; // runToolLoop 从 0 起算
  const run = this.lastRun;
  if (run && Number.isFinite(run.steps)) patch.steps = run.steps;
  if (run && Array.isArray(run.toolNames) && run.toolNames.length) patch.tools = run.toolNames.slice(-32);
  const last = run && Array.isArray(run.toolNames) && run.toolNames.length ? run.toolNames[run.toolNames.length - 1] : null;
  if (last) patch.lastTool = last;
  if (!Object.keys(patch).length) return;
  try { this.work.progressBySession(String(sk), patch); } catch { /* 观测不阻断执行 */ }
},

// 同会话串行执行器: 前一轮未完成时排队 (Promise 链), 完成后自清理防 Map 膨胀
async _withSessionLock(sk, fn) {
  const locks = this._sessionLocks || (this._sessionLocks = new Map());
  const prev = locks.get(sk) || Promise.resolve();
  const run = prev.then(fn, fn); // 前一轮失败不阻塞下一轮
  const tail = run.catch(() => {});
  locks.set(sk, tail);
  void tail.then(() => { if (locks.get(sk) === tail) locks.delete(sk); });
  return run;
},

// 2026-10-24 (R5): 会话重定向解析 —— rewind/resume 把对话流切到 fork 分支
_redirectSession(sessionKey) {
  const sk = sessionKey || "default";
  return this._sessionRedirect?.get(sk) || sk;
},

// 会话回卷: 把当前会话回退最近 N 轮对话 (fork 到新分支, append-only 原会话保留)。
// 返回 { ok, droppedTurns?, newKey?, reason? }。长期记忆 (L1+) 不受回卷影响 ——
// 已提炼的记忆用 memory_forget 管理与会话回退解耦 (诚实语义, 不做假装的"全部撤销")。
rewindSession(sessionKey, turns = 1) {
  const sk = this._redirectSession(sessionKey);
  const userTurns = this.sessionStore.replay(sk).filter((e) => e.type === "user/message");
  if (!userTurns.length) return { ok: false, reason: "没有可回退的对话轮" };
  const n = Math.max(1, Math.min(Number(turns) || 1, userTurns.length));
  const boundary = userTurns[userTurns.length - n].seq - 1; // 回到该轮 user 消息之前
  // 2026-11-03: boundary = -1 是合法的 —— 第一轮就回卷 → fork 出空会话分支。
  //   旧实现把它当"已处于会话起点"拒绝, 于是"重新生成第一条回答"永远做不了
  //   (而第一条回答正是最常需要重答的那条)。fork(-1) 写空文件, append 后可正常续写。
  const toKey = `${sessionKey}-rw-${Date.now().toString(36)}`;
  this.sessionStore.fork(sk, boundary, toKey);
  // 重定向链收敛: 当前 key → 新分支; 所有指向当前 key 的旧映射一并改指新分支
  const map = this._sessionRedirect || (this._sessionRedirect = new Map());
  for (const [k, v] of map) if (v === sk) map.set(k, toKey);
  map.set(sessionKey, toKey);
  return { ok: true, droppedTurns: n, newKey: toKey };
},

// 写前重放安全事实 (Step 6): 有副作用且非幂等的工具在**执行前**把当前指派标脏。
//   只读或工具显式声明 idempotent 的调用不改变事实 —— 整轮重放不会让副作用翻倍。
//   返回 false 仅当"必须记录却记不上"(账本不可用): 调用方据此 fail-closed, 拒绝执行。
};
