// src/workgraph/service.js - 工单生命周期 (准入 → 指派 → 投递)
//
// 职责单一: 把"一条入站输入"变成可追踪的工单, 把"一次执行"变成工单下的指派,
// 并在终态时产出结构化事件。不做 IO 之外的策略 (渠道怎么回、worker 怎么跑由调用方决定),
// 这样 channels / agent / http / 命令面共用同一份事实, 不会各记各的账。
//
// 事件名与 src/protocol EventType 对齐 (ticket_created / ticket_assigned / ...),
// agent 装配时直接映射成 EQ 事件, 订阅方 (Web UI / watchdog / 测试) 按 ticketId 归组。
//
// 设计溯源: docs/PROVENANCE.md#superagent (仅设计思想对照, 本文件源码自研)。
import { ASSIGNMENT_STATUS, TICKET_STATUS, isFinalStatus } from "./store.js";
import {
  ORIGIN, DELIVERY_STATE, normalizeOrigin, dedupeStrategyOf,
} from "./state.js";

export function createWorkService({
  store,
  onEvent = null,
  now = Date.now,
  log = null,
} = {}) {
  if (!store) throw new Error("workgraph service: 缺少 store");

  const activeBySession = new Map(); // sessionKey -> assignmentId (仅观测: assignment_progress 归组)
  const deliveryStarted = new Set(); // assignmentId 已有 delivery_accepted (取消/超时据此判是否可补 0 次死信)
  const progressState = new Map();   // assignmentId -> { lastEmitAt, pending, timer }
  const PROGRESS_WINDOW_MS = 500;
  const MAX_TIMER = 2 ** 30;

  function emit(type, ticket, extra = {}) {
    if (!ticket) return;
    const payload = {
      ticketId: ticket.id,
      status: ticket.status,
      source: ticket.source || null,
      sessionKey: ticket.sessionKey || null,
      worker: ticket.worker || null,
      origin: ticket.origin || null,
      externalId: ticket.externalId || null,
      dedupeKey: ticket.dedupeKey || null,
      dedupeStrategy: ticket.dedupeStrategy || null,
      ...extra,
    };
    const ref = {
      ticketId: ticket.id,
      sessionKey: ticket.sessionKey || null,
      thread: ticket.thread || null,
      assignmentId: extra.assignmentId || ticket.assignmentId || null,
      cause: ticket.origin || "ingress",
    };
    try { onEvent?.(type, payload, ref); } catch (e) { try { log?.warn?.(`[workgraph] 事件回调失败: ${e?.message || e}`); } catch { /* 不阻断 */ } }
  }

  function _assignmentEnded(ticket, assignment, extra = {}) {
    if (!ticket || !assignment?.id) return;
    emit("assignment_ended", ticket, {
      assignmentId: assignment.id,
      outcome: assignment.outcome || "completed",
      rounds: Number(assignment.rounds) || 0,
      steps: Number(assignment.steps) || 0,
      tools: Array.isArray(assignment.tools) ? assignment.tools : [],
      usage: assignment.usage || null,
      errorKind: assignment.errorKind || null,
      endedAt: assignment.endedAt || now(),
      ...extra,
    });
    if (activeBySession.get(assignment.sessionKey) === assignment.id) activeBySession.delete(assignment.sessionKey);
  }

  // assignment_progress 硬上限 (I14): 每 assignment 500ms ≤1 条; 窗口内只保留最新累计值,
  //   延迟合并那条带 coalesced=true。终态后不再发 (观测不得污染收口)。
  function _emitProgress(ticket, assignment) {
    if (!ticket || !assignment?.id || assignment.status !== "running") return;
    const at = now();
    const st = progressState.get(assignment.id) || { lastEmitAt: 0, pending: null, timer: null };
    const snapshot = () => {
      const cur = store.getAssignment(assignment.id);
      if (!cur || cur.status !== "running") return null;
      return {
        rounds: Number(cur.rounds) || 0,
        steps: Number(cur.steps) || 0,
        tools: Array.isArray(cur.tools) ? cur.tools.slice(0, 32) : [],
        lastTool: cur.lastTool || null,
      };
    };
    const fire = (coalesced) => {
      const snap = snapshot();
      if (!snap) return;
      const t = store.get(ticket.id);
      st.lastEmitAt = now();
      st.pending = null;
      emit("assignment_progress", t, { assignmentId: assignment.id, ...snap, coalesced, at: now() });
    };
    if (!st.timer && at - st.lastEmitAt >= PROGRESS_WINDOW_MS) {
      fire(false);
    } else {
      st.pending = true;
      if (!st.timer) {
        const delay = Math.max(0, Math.min(PROGRESS_WINDOW_MS - (at - st.lastEmitAt), MAX_TIMER));
        st.timer = setTimeout(() => {
          st.timer = null;
          if (!st.pending) return;
          fire(true);
        }, delay);
        if (typeof st.timer.unref === "function") st.timer.unref();
      }
    }
    progressState.set(assignment.id, st);
  }

  // 准入即建单。去重三段式 (I6): 显式 key > origin:externalId > source:from:messageId。
  //   · 显式 key 给了就只按 key 匹配, 不回落 messageId;
  //   · externalId 让 DSH/外部系统在"没有平台 messageId"的重投下仍能命中同一张工单;
  //   · 入站三元组覆盖 IM webhook 重试。
  function submit(trigger = {}, {
    sessionKey = null, cause = "ingress", priority = 0,
    origin = null, externalId = null, dedupeKey = null,
  } = {}) {
    const src = trigger.source || "";
    const from = trigger.from || "";
    const mid = trigger.messageId || "";
    const key = dedupeKey
      || trigger.meta?.dedupeKey
      || trigger.meta?.idempotency_key
      || trigger.meta?.idempotencyKey
      || null;
    const ext = externalId || trigger.meta?.externalId || trigger.meta?.external_id || null;
    const orig = normalizeOrigin(origin || trigger.origin || cause, ORIGIN.INGRESS);
    const strategy = dedupeStrategyOf({ explicitKey: key, externalId: ext, messageId: mid });
    const dup = strategy === "explicit"
      ? store.findDuplicate({ dedupeKey: key })
      : strategy === "external_id"
        ? store.findDuplicate({ externalId: ext, origin: orig })
        : store.findDuplicate({ source: src, messageId: mid, from });
    if (dup) return { ...dup, deduped: true };
    const ticket = store.create({
      source: src, from,
      group: trigger.group || "",
      thread: trigger.thread || "",
      messageId: mid,
      sessionKey: sessionKey || trigger.sessionKey || "default",
      text: trigger.text || "",
      priority, cause,
      origin: orig,
      externalId: ext,
      dedupeKey: key,
      dedupeStrategy: strategy,
      parentId: trigger.meta?.parentId || null,
    });
    emit("ticket_created", ticket, { deduped: false });
    return ticket;
  }

  function begin(ticketId, {
    worker = "router", sessionKey = null, bgTaskId = null,
    route = null, origin = null, delivery = null,
  } = {}) {
    const before = store.get(ticketId);
    if (!before) return null;
    if (isFinalStatus(before.status)) return null;
    const assignment = store.assign(ticketId, {
      worker, sessionKey, bgTaskId,
      route,
      origin: origin || before.cause,
      delivery,
    });
    const ticket = store.get(ticketId);
    const effectiveRoute = assignment?.route || "async"; // 旧调用点无 route: 结果经队列回投 = async
    if (assignment?.id) activeBySession.set(assignment.sessionKey, assignment.id);
    emit("ticket_assigned", ticket, {
      assignmentId: assignment?.id || null,
      worker: assignment?.worker || worker,
      route: assignment?.route || null,
    });
    emit("assignment_started", ticket, {
      assignmentId: assignment?.id || null,
      route: effectiveRoute,
      worker: assignment?.worker || worker,
      sessionKey: assignment?.sessionKey || null,
      origin: assignment?.origin || ticket?.origin || "ingress",
      startedAt: assignment?.startedAt || now(),
    });
    return assignment;
  }

  // 执行中进度 (轮次/工具/步骤): 只更新指派, 不动工单终态
  function progress(ticketId, patch = {}) {
    const t = store.get(ticketId);
    if (!t?.assignmentId) return null;
    const clean = {};
    for (const k of ["rounds", "steps", "tools", "bgTaskId", "lastTool"]) {
      if (patch[k] !== undefined) clean[k] = patch[k];
    }
    if (!Object.keys(clean).length) return store.getAssignment(t.assignmentId);
    const assignment = store.updateAssignment(t.assignmentId, clean);
    _emitProgress(t, assignment);
    return assignment;
  }

  // 按会话找在途 assignment 并记进度 (agent 轮次回调没有 ticketId, 只有 sessionKey)
  function progressBySession(sessionKey, patch = {}) {
    const aid = activeBySession.get(String(sessionKey || "")) || null;
    if (!aid) return null;
    const a = store.getAssignment(aid);
    if (!a || a.status !== "running") return null;
    return progress(a.ticketId, patch);
  }

  // 写前副作用事实 (Step 6): 有副作用的非幂等工具**执行前**调用, 把当前会话的在途指派
  //   标成不可安全重放。必须在调用前落账 —— 崩溃发生在工具执行中途时, 账本里已经有
  //   "这个指派碰过副作用" 的事实, 恢复才敢保守地说"不能自动重放"。
  //   返回是否命中在途指派 (无在途 = 不在工单执行中, 无需记录)。
  function _markOneUnsafe(aid, tool) {
    const a = store.getAssignment(aid);
    if (!a || a.status !== ASSIGNMENT_STATUS.RUNNING || a.replaySafe === false) return false;
    store.updateAssignment(aid, {
      replaySafe: false,
      replayUnsafeTool: tool ? String(tool) : null,
    });
    return true;
  }

  function markUnsafeBySession(sessionKey, tool = null) {
    // sessionKey 缺失 = 调用方确实不知道在哪个会话执行 (无 trace 的旁路路径/测试直调)。
    //   此时宁可多标: 标脏只会少自动恢复, 漏标却可能让有副作用的指派被当成"干净"重放。
    //   有明确会话键时只标那一个 —— 看门狗等独立会话不得污染在途工单。
    if (sessionKey == null || sessionKey === "") {
      let marked = false;
      for (const id of activeBySession.values()) marked = _markOneUnsafe(id, tool) || marked;
      return marked;
    }
    const aid = activeBySession.get(String(sessionKey));
    return aid ? _markOneUnsafe(aid, tool) : false;
  }

  // Step 7: 把一条只读/幂等工具的执行结果记到当前会话在途指派的检查点。
  //   无会话键/无在途指派 = 不归属任何工单执行, 直接跳过 (不做"猜一个工单"的写入)。
  function checkpointBySession(sessionKey, entry = {}) {
    if (sessionKey == null || sessionKey === "") return false;
    const aid = activeBySession.get(String(sessionKey));
    if (!aid) return false;
    return store.recordCheckpoint(aid, entry);
  }

  // delivery_accepted 到达时由通道层回填: 取消/执行超时收口据此决定是否补 attempt=0 死信。
  //   返回是否首次记录 (重复 accepted 不重复计数)。
  function markDeliveryStarted(assignmentId) {
    const id = String(assignmentId || "");
    if (!id || deliveryStarted.has(id)) return false;
    deliveryStarted.add(id);
    return true;
  }

  // 投递终态快照 (I4 修订): 只是 DELIVERY_* 事件的缓存, 权威事实仍在事件流。
  //   只收 delivered/dead_letter/unknown; 首个终态生效; 旧 assignment 的迟到终态忽略。
  //   目的: judge 不必为每条工单回放 EQ WAL (8MB × 24 段, 跨轮转事件可能已被压缩)。
  const SNAPSHOT_STATES = new Set([
    DELIVERY_STATE.DELIVERED, DELIVERY_STATE.DEAD_LETTER, DELIVERY_STATE.UNKNOWN,
  ]);

  function markDeliveryState({
    ticketId = null, assignmentId = null, state = null,
    attempt = null, receiptId = null, reason = null, at = null,
  } = {}) {
    const tid = String(ticketId || "");
    const aid = String(assignmentId || "");
    const st = String(state || "");
    if (!tid || !aid || !SNAPSHOT_STATES.has(st)) return null;
    const t = store.get(tid);
    if (!t) return null;
    if (String(t.assignmentId || "") !== aid) return null; // 迟到的旧 assignment 终态
    if (t.deliveryReceipt?.assignmentId === aid) return t;  // 首个终态优先
    return store.update(tid, {
      deliveryReceipt: {
        assignmentId: aid,
        state: st,
        attempt,
        receiptId,
        reason,
        at: Number.isFinite(Number(at)) ? Number(at) : now(),
      },
    });
  }

  function _closeAssignment(ticket, status, {
    result = null, error = null, envelope = null, outcome = null, errorKind = null,
  } = {}) {
    if (!ticket?.assignmentId) return null;
    const patch = {
      status,
      resultPreview: result == null ? null : String(result).slice(0, 300),
      error: error == null ? null : String(error).slice(0, 300),
      outcome: outcome || status,
    };
    if (envelope && typeof envelope === "object") {
      patch.rounds = Number(envelope.rounds) || 0;
      patch.steps = Number(envelope.steps) || 0;
      patch.tools = Array.isArray(envelope.tools) ? envelope.tools.slice(0, 32) : [];
      patch.usage = envelope.usage ?? null;
    }
    if (errorKind) patch.errorKind = String(errorKind);
    const assignment = store.updateAssignment(ticket.assignmentId, patch);
    const pst = progressState.get(ticket.assignmentId);
    if (pst?.timer) { try { clearTimeout(pst.timer); } catch { /* 已触发 */ } }
    progressState.delete(ticket.assignmentId);
    return assignment;
  }

  function complete(ticketId, { result = null, envelope = null, bgTaskId = null } = {}) {
    const ticket = store.get(ticketId);
    if (!ticket) return null;
    if (isFinalStatus(ticket.status)) return ticket; // 取消/失败后完成回调迟到, 不覆盖终态
    const patch = {
      status: TICKET_STATUS.DONE,
      result: result == null ? null : String(result).slice(0, 4000),
      resultPreview: result == null ? null : String(result).slice(0, 300),
      error: null,
      failureKind: null,
      worker: ticket.worker || "router",
    };
    if (envelope && typeof envelope === "object") {
      patch.rounds = Number(envelope.rounds) || 0;
      patch.steps = Number(envelope.steps) || 0;
      patch.tools = Array.isArray(envelope.tools) ? envelope.tools.slice(0, 32) : [];
      patch.usage = envelope.usage ?? null;
      // v5.0 信封 v2: 可验证交付物随工单落账 (UI 工单详情透出)
      if (Array.isArray(envelope.artifacts)) patch.artifacts = envelope.artifacts.slice(0, 16);
      if (Array.isArray(envelope.commands)) patch.commands = envelope.commands.slice(0, 16);
    }
    if (bgTaskId) patch.bgTaskId = String(bgTaskId);
    const next = store.update(ticketId, patch);
    const assignment = _closeAssignment(next, ASSIGNMENT_STATUS.DONE, { result, envelope, outcome: "completed" });
    _assignmentEnded(next, assignment, { outcome: "completed" });
    emit("ticket_completed", next, {
      ms: next?.startedAt ? Math.max(0, (next.endedAt || now()) - next.startedAt) : null,
      rounds: patch.rounds || 0,
    });
    return next;
  }

  function fail(ticketId, err, {
    failureKind = "error", errorKind = null, envelope = null, usage = null,
  } = {}) {
    const ticket = store.get(ticketId);
    if (!ticket) return null;
    if (isFinalStatus(ticket.status)) return ticket; // 终态不被一次迟到的失败覆盖
    const message = String(err?.message || err || "unknown error").slice(0, 300);
    const patch = {
      status: TICKET_STATUS.FAILED,
      error: message,
      failureKind,
    };
    if (envelope && typeof envelope === "object") {
      patch.rounds = Number(envelope.rounds) || 0;
      patch.steps = Number(envelope.steps) || 0;
      patch.tools = Array.isArray(envelope.tools) ? envelope.tools.slice(0, 32) : [];
      patch.usage = envelope.usage ?? null;
      // v5.0 信封 v2: 失败路径同样落交付物 (诊断"跑到哪一步"用)
      if (Array.isArray(envelope.artifacts)) patch.artifacts = envelope.artifacts.slice(0, 16);
      if (Array.isArray(envelope.commands)) patch.commands = envelope.commands.slice(0, 16);
    } else if (usage) {
      patch.usage = usage;
    }
    const next = store.update(ticketId, patch);
    const assignment = _closeAssignment(next, ASSIGNMENT_STATUS.FAILED, {
      error: message,
      envelope,
      outcome: "failed",
      errorKind: errorKind || failureKind,
    });
    _assignmentEnded(next, assignment, { outcome: errorKind === "execution_timeout" ? "timeout" : "failed" });
    emit("ticket_failed", next, { error: message, failureKind });
    // 执行阶段超时 (尚未开始投递): 补 attempt=0 死信, 让 DSH 区分"重投"与"重跑"。
    if (errorKind === "execution_timeout" && next?.assignmentId && !deliveryStarted.has(next.assignmentId)) {
      const deadAt = now();
      emit("delivery_dead_letter", next, {
        assignmentId: next.assignmentId,
        attempt: 0,
        reason: "execution_timeout",
        finalError: { kind: "execution_timeout", message },
        deadAt,
      });
      markDeliveryState({
        ticketId: next.id, assignmentId: next.assignmentId, state: DELIVERY_STATE.DEAD_LETTER,
        attempt: 0, reason: "execution_timeout", at: deadAt,
      });
    }
    return next;
  }

  // 长驻 worker 迁移: 工单仍活着, 只是执行者从 Router 换成驻派 worker (可观测态)
  function wait(ticketId, { worker = null, reason = null } = {}) {
    const ticket = store.get(ticketId);
    if (!ticket || isFinalStatus(ticket.status)) return ticket;
    const next = store.update(ticketId, {
      status: TICKET_STATUS.WAITING,
      worker: worker || ticket.worker || null,
      cause: reason || ticket.cause,
    });
    emit("ticket_waiting", next, { worker: next?.worker || null, reason });
    return next;
  }

  function cancel(ticketId, reason = "cancelled") {
    const ticket = store.get(ticketId);
    if (!ticket) return null;
    if (isFinalStatus(ticket.status)) return ticket;
    const next = store.update(ticketId, {
      status: TICKET_STATUS.CANCELLED,
      error: String(reason || "cancelled").slice(0, 300),
      failureKind: null,
    });
    const assignment = _closeAssignment(next, ASSIGNMENT_STATUS.CANCELLED, { error: reason, outcome: "cancelled" });
    _assignmentEnded(next, assignment, { outcome: "cancelled" });
    emit("ticket_cancelled", next, { reason });
    // 取消时结果从未交给通道 → attempt=0 死信 (矩阵 cancelled × none 的收口动作)。
    // 若投递已 accepted, 撤回不成立 (用户可能已收到), 不发死信 (矩阵 cancelled × accepted = 人工介入)。
    if (next?.assignmentId && !deliveryStarted.has(next.assignmentId)) {
      const deadAt = now();
      emit("delivery_dead_letter", next, {
        assignmentId: next.assignmentId,
        attempt: 0,
        reason: "cancelled",
        finalError: null,
        deadAt,
      });
      markDeliveryState({
        ticketId: next.id, assignmentId: next.assignmentId, state: DELIVERY_STATE.DEAD_LETTER,
        attempt: 0, reason: "cancelled", at: deadAt,
      });
    }
    return next;
  }

  function requeue(ticketId) {
    const before = store.get(ticketId);
    if (!before) return null;
    if (before.status !== TICKET_STATUS.FAILED && before.status !== TICKET_STATUS.CANCELLED) return null;
    const next = store.requeue(ticketId);
    if (next) emit("ticket_requeued", next, { attempts: next.attempts, requeueOf: next.requeueOf || null });
    return next;
  }

  // 启动恢复: 默认只标记, 不重跑。
  // resumeUnstarted=true 时保留 **admitted 且从未 begin** 的工单 (无执行事实 = 无副作用),
  //   返回给上层在通道就绪后显式重跑。
  // resumeStarted=true (Step 6) 时额外保留 **working 且指派 replaySafe=true** 的工单:
  //   本次指派开跑过的全部工具都是只读或显式幂等 —— 整轮重放不会让副作用翻倍。
  //   working 但 replaySafe=false/未知 (含旧账本无字段) 与全部 waiting 仍标 interrupted;
  //   长驻 worker 的工具执行发生在子进程, 父进程没有可靠事实, 不在本步范围内。
  // 两类候选都只收「其他实例」的工单: 本实例可能在途执行, 选进恢复队列等于双重执行。
  // 返回 { interrupted, notified, resumable, stale }; resumable 条目带 resumeKind。
  function recover({
    reason = "process_restart",
    resumeUnstarted = false,
    resumeStarted = false,
    resumeMaxAgeMs = 6 * 3600 * 1000,
    resumeLimit = 3,
  } = {}) {
    const before = store.list({ status: [TICKET_STATUS.ADMITTED, TICKET_STATUS.WORKING, TICKET_STATUS.WAITING], limit: 500 });
    // 与 markInterrupted 同一口径: 只处理其他实例留下的未终态工单。
    //   本实例的在途任务可能还在跑, 把它选进恢复队列会收口活指派并重跑一次 —— 那是双重执行。
    const mine = String(store.instance);
    const foreign = (t) => Boolean(t.instance) && String(t.instance) !== mine;
    const at = now();
    const maxAge = Number(resumeMaxAgeMs);
    const limit = Math.max(0, Math.floor(Number(resumeLimit) || 0));
    const resumable = [];
    let stale = 0;
    const overLimitOrOld = (t, since) => {
      const age = at - Number(since || t.createdAt || at);
      const tooOld = Number.isFinite(maxAge) && maxAge > 0 && age > maxAge;
      return tooOld || resumable.length >= limit;
    };
    if (resumeUnstarted) {
      for (const t of before) {
        if (t.status !== TICKET_STATUS.ADMITTED || !foreign(t)) continue;
        if (overLimitOrOld(t, t.admittedAt || t.createdAt)) { stale += 1; continue; }
        resumable.push({ ...t, resumeKind: "unstarted" });
      }
    }
    if (resumeStarted) {
      for (const t of before) {
        if (t.status !== TICKET_STATUS.WORKING || !t.assignmentId || !foreign(t)) continue;
        const a = store.getAssignment(t.assignmentId);
        // 只有明确的 replaySafe=true 才放行; 缺字段 (旧账本) 与 false 同属"无证据"。
        if (!a || a.status !== ASSIGNMENT_STATUS.RUNNING || a.replaySafe !== true) continue;
        if (overLimitOrOld(t, a.startedAt || t.startedAt)) { stale += 1; continue; }
        resumable.push({ ...t, resumeKind: "replay" });
      }
    }
    const keep = new Set(resumable.map((t) => t.id));
    // 重放候选的旧指派必须收口为 interrupted —— 工单留在 working 交给新指派接管,
    //   但"上一轮到这里就断了"是既有事实, 不能留一个永远 running 的幽灵指派。
    for (const t of resumable) {
      if (t.resumeKind !== "replay" || !t.assignmentId) continue;
      const a = store.getAssignment(t.assignmentId);
      if (a && a.status === ASSIGNMENT_STATUS.RUNNING) {
        store.updateAssignment(a.id, {
          status: ASSIGNMENT_STATUS.FAILED,
          error: reason,
          errorKind: "interrupted",
          outcome: "failed",
        });
      }
    }
    const interrupted = store.markInterrupted({ reason, skipIds: [...keep] });
    let notified = 0;
    for (const t of before) {
      if (keep.has(t.id)) continue;
      const after = store.get(t.id);
      if (after?.status === TICKET_STATUS.FAILED && after.failureKind === "interrupted") {
        emit("ticket_interrupted", after, { reason });
        notified += 1;
      }
    }
    return { interrupted, notified, resumable, stale };
  }

  function list(opts = {}) {
    const tickets = store.list(opts);
    const stats = store.stats();
    return { tickets, counts: stats.counts, stats };
  }

  function get(id) {
    const ticket = store.get(id);
    if (!ticket) return null;
    return { ticket, assignments: store.assignmentsOf(ticket.id) };
  }

  function stats() { return store.stats(); }

  return {
    submit, begin, progress, progressBySession, markUnsafeBySession, checkpointBySession, markDeliveryStarted, markDeliveryState,
    complete, fail, wait, cancel, requeue, recover,
    list, get, stats,
    _store: store,
  };
}
