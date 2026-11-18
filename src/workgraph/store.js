// src/workgraph/store.js - 工单账本持久层 (原生工单/指派账本)
//
// 为什么需要 (2026-11-02, 设计溯源 docs/PROVENANCE.md#superagent §2/§4):
//   早期版本的入站链路是"受理即执行": 同步回复走 chat(), 异步受理走 chatAsync() 的内存
//   注册表, 话题直通走 ThreadBridge。三条路径都没有**跨重启的工单事实** —— 进程在任务中途
//   退出, 用户只看到"没有回复", 也没有任何地方能回答"这条消息处理到哪了"。
//   工单/指派模型正是这层: 每条被准入的输入是一张工单, 每次执行是
//   工单下的一次指派 (worker / 会话 / 轮次 / 工具 / 终态), 全部可持久、可查询、可重跑。
//
// 设计约束 (与仓库既有语义对齐):
//   - 零运行时依赖, 只 import node: 内置模块;
//   - **日志即真相**: 账本是 append-only 事实日志 (默认 JSONL, 可选 SQLite), 内存态由日志
//     折叠得出, 任何时刻可重放; 压缩只是把等价的折叠结果写回, 不改变事实;
//   - 同步 fs (与 session store / spill 同口径), 写入短小, 单条 append 不做异步队列 ——
//     入站主路径不允许"先回复成功、账本稍后失败"的假成功;
//   - 落盘失败向调用方抛出, 由链路层决定降级 (渠道层 catch 后不影响用户回复);
//   - 恢复默认只做**标记**: 上一个进程遗留的 admitted/working 工单标为 failed/interrupted,
//     绝不静默重跑 (工具可能有副作用)。重跑是显式动作 (service.requeue → agent.workRequeue)。
//     唯一例外是**从未 begin 的 admitted 子集** (没有执行事实, 因而没有副作用): 上层可显式
//     开启 resume_unstarted 让它们在通道就绪后自动重跑; 存储层只按 skipIds 保留事实。
//
// 账本记录 (一行一 JSON):
//   {v:1, kind:"ticket_created", at, instance, ticket}
//   {v:1, kind:"ticket_patch",   at, instance, id, patch}
//   {v:1, kind:"assignment_created", at, instance, assignment}
//   {v:1, kind:"assignment_patch",   at, instance, id, patch}
//   {v:1, kind:"ticket_dropped", at, instance, id}
import fs from "node:fs";
import path from "node:path";
import { clip } from "../utils/text.js";
import { createJournal } from "./journal.js";
import { createCheckpointStore } from "./checkpoints.js";
import {
  ORIGIN,
  normalizeOrigin, normalizeRoute, buildDedupeKey, dedupeStrategyOf, isDedupeStrategy,
} from "./state.js";
import {
  plainObject, normalizeUsageSnapshot, deliveryReceiptSnapshot, copyTicket, copyAssignment,
} from "./snapshots.js";

export const TICKET_STATUS = Object.freeze({
  ADMITTED: "admitted", // 已准入, 等待执行 (异步受理 / 重跑排队)
  WORKING: "working",   // 正在执行
  WAITING: "waiting",   // 迁移到长驻 worker, 等待其回投 (ThreadBridge 路径的观测态)
  DONE: "done",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const ASSIGNMENT_STATUS = Object.freeze({
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

const TICKET_FINAL = new Set([TICKET_STATUS.DONE, TICKET_STATUS.FAILED, TICKET_STATUS.CANCELLED]);
const TICKET_ALL = new Set(Object.values(TICKET_STATUS));
const ASSIGNMENT_ALL = new Set(Object.values(ASSIGNMENT_STATUS));

export function isFinalStatus(status) { return TICKET_FINAL.has(status); }

// 截断工具: 账本不复制整段大文本, 只保留可观测/可重跑的头部
// (实现收敛在 utils/text.js, 与 flow/router、checkpoints 共用同一份硬截断语义)

// 快照字段规整与只读拷贝见 ./snapshots.js (usage/receipt/纯对象校验 + copy*)。

// 工具级检查点 (Step 7, 断点续执行): 账本细节在 ./checkpoints.js —— 它只是执行事实缓存,
//   不进本文件的事实日志, 也不参与折叠/压缩。

export function createWorkStore({
  dir,
  now = Date.now,
  instanceId = null,
  maxTickets = 2000,
  retentionDays = 14,
  compactAt = 5000,
  dedupeMs = 30000,
  checkpoints = false,
  stateBackend = "jsonl",
} = {}) {
  if (!dir) throw new Error("workgraph store: 缺少 dir");
  fs.mkdirSync(dir, { recursive: true });
  // Step 9: 事实存储可替换 (jsonl 默认 / sqlite)。只换落盘后端, 折叠与语义不变。
  const journal = createJournal({ dir, kind: stateBackend, now });
  const journalPath = journal.path;
  const checkpointsEnabled = checkpoints === true;
  const instance = String(instanceId || `${process.pid}-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

  const tickets = new Map();
  const assignments = new Map();
  let lines = 0;
  let seq = 0;

  const checkpointStore = createCheckpointStore({
    dir: path.join(dir, "checkpoints"),
    enabled: checkpointsEnabled,
    now,
    isKnownAssignment: (id) => assignments.has(String(id)),
  });

  function _newId(prefix) {
    for (;;) {
      seq += 1;
      const id = `${prefix}_${now().toString(36)}_${seq.toString(36)}`;
      if (!tickets.has(id) && !assignments.has(id)) return id;
    }
  }

  function _apply(rec) {
    if (!rec || typeof rec !== "object") return;
    switch (rec.kind) {
      case "ticket_created": {
        if (rec.ticket?.id) tickets.set(rec.ticket.id, { ...rec.ticket, instance: rec.ticket.instance || rec.instance || null });
        break;
      }
      case "ticket_patch": {
        const t = tickets.get(rec.id);
        if (t && rec.patch) {
          Object.assign(t, rec.patch);
          if (rec.patch.updatedAt === undefined) t.updatedAt = rec.at || t.updatedAt;
        }
        break;
      }
      case "assignment_created": {
        const a = rec.assignment;
        if (a?.id) assignments.set(a.id, { ...a });
        break;
      }
      case "assignment_patch": {
        const a = assignments.get(rec.id);
        if (a && rec.patch) {
          Object.assign(a, rec.patch);
          if (rec.patch.updatedAt === undefined) a.updatedAt = rec.at || a.updatedAt;
        }
        break;
      }
      case "ticket_dropped": {
        tickets.delete(rec.id);
        for (const [aid, a] of assignments) {
          if (a.ticketId === rec.id) assignments.delete(aid);
        }
        break;
      }
      default: break;
    }
  }

  // 启动折叠: 日志即真相。坏行跳过 (与 session store 同口径), 最后一条可解析记录决定状态。
  {
    const loaded = journal.read();
    lines = loaded.lines;
    for (const rec of loaded.records) _apply(rec);
  }

  function _append(rec) {
    const full = { v: 1, ...rec, at: rec.at || now(), instance };
    journal.append(full);
    lines += 1;
    _apply(full);
    if (lines > compactAt) compact();
  }

  function create(input = {}) {
    const at = now();
    const origin = normalizeOrigin(input.origin || input.cause, ORIGIN.INGRESS);
    const externalId = input.externalId ? String(input.externalId) : null;
    const explicitKey = input.dedupeKey ? String(input.dedupeKey) : null;
    // 键在准入时算定并落账 (I6): 之后的重投/DSH 反向查找都以它为准, 不再看本次请求带了什么。
    const dedupeStrategy = isDedupeStrategy(input.dedupeStrategy)
      ? input.dedupeStrategy
      : dedupeStrategyOf({ explicitKey, externalId, messageId: input.messageId });
    const dedupeKey = explicitKey || buildDedupeKey({
      explicitKey, origin, externalId,
      source: input.source, from: input.from, messageId: input.messageId,
    });
    const ticket = {
      id: _newId("wk"),
      status: TICKET_STATUS.ADMITTED,
      source: String(input.source || ""),
      from: String(input.from || ""),
      group: String(input.group || ""),
      thread: String(input.thread || ""),
      messageId: String(input.messageId || ""),
      sessionKey: String(input.sessionKey || "default"),
      text: clip(input.text, 2000),
      textPreview: clip(input.text, 200),
      priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0,
      parentId: input.parentId ? String(input.parentId) : null,
      cause: String(input.cause || "ingress"),
      origin,
      externalId,
      dedupeKey,
      dedupeStrategy,
      // 架构优化 ②(2026-11-16): runId 贯通工单账本 —— 与 trace/审计/工具轨迹同一血缘。
      //   旧账本没有该字段 → undefined (读取方按"未记录"处理, 不做推测)。
      runId: input.runId ? String(input.runId) : null,
      requeueOf: input.requeueOf ? String(input.requeueOf) : null,
      deliveryReceipt: null,
      attempts: 0,
      worker: null,
      assignmentId: null,
      bgTaskId: input.bgTaskId ? String(input.bgTaskId) : null,
      createdAt: at,
      admittedAt: at,
      startedAt: null,
      endedAt: null,
      updatedAt: at,
      resultPreview: null,
      result: null,
      error: null,
      failureKind: null,
    };
    _append({ kind: "ticket_created", ticket });
    _maybePrune();
    return copyTicket(tickets.get(ticket.id));
  }

  function update(id, patch = {}) {
    const t = tickets.get(id);
    if (!t) return null;
    if (patch.status !== undefined && !TICKET_ALL.has(patch.status)) {
      throw new Error(`workgraph: 非法工单状态 ${patch.status}`);
    }
    const at = now();
    const clean = { ...patch, updatedAt: at };
    // 账本字段上限: 入站文本/结果/错误都可能很大, 持久层统一截断 (调用方不必各截各的)
    for (const k of ["text", "result", "resultPreview", "error"]) {
      if (clean[k] !== undefined && clean[k] !== null) {
        clean[k] = clip(clean[k], k === "result" ? 4000 : (k === "text" ? 2000 : 300));
      }
    }
    if (clean.usage !== undefined) clean.usage = normalizeUsageSnapshot(clean.usage);
    if (clean.origin !== undefined) clean.origin = normalizeOrigin(clean.origin, t.origin || ORIGIN.INGRESS);
    if (clean.externalId !== undefined) clean.externalId = clean.externalId == null ? null : clip(clean.externalId, 200);
    if (clean.dedupeKey !== undefined) clean.dedupeKey = clean.dedupeKey == null ? null : clip(clean.dedupeKey, 500);
    if (clean.dedupeStrategy !== undefined) {
      if (!isDedupeStrategy(clean.dedupeStrategy)) {
        throw new Error(`workgraph: 非法去重策略 ${clean.dedupeStrategy}`);
      }
      clean.dedupeStrategy = String(clean.dedupeStrategy);
    }
    if (clean.deliveryReceipt !== undefined) clean.deliveryReceipt = deliveryReceiptSnapshot(clean.deliveryReceipt);
    if (clean.requeueOf !== undefined) clean.requeueOf = clean.requeueOf == null ? null : String(clean.requeueOf);
    // 状态迁移的派生字段: 一处写对, 查询方不用自己算
    const next = patch.status || t.status;
    if (patch.status && patch.startedAt === undefined && next === TICKET_STATUS.WORKING && !t.startedAt) {
      clean.startedAt = at;
    }
    if (patch.status && patch.endedAt === undefined && TICKET_FINAL.has(next) && !t.endedAt) {
      clean.endedAt = at;
    }
    if (patch.status && next !== TICKET_STATUS.FAILED && patch.failureKind === undefined) {
      clean.failureKind = null;
    }
    _append({ kind: "ticket_patch", id, patch: clean });
    // 终态工单不再需要续跑检查点 (显式 requeue 也从任务开头重跑)。
    if (patch.status && TICKET_FINAL.has(next)) {
      for (const [aid, a] of assignments) if (a.ticketId === id) dropCheckpoints(aid);
    }
    return copyTicket(tickets.get(id));
  }

  function assign(ticketId, {
    worker = "router", sessionKey = null, bgTaskId = null,
    route = null, origin = null, delivery = null,
    metacognition = null, runId = null,
  } = {}) {
    const t = tickets.get(ticketId);
    if (!t) return null;
    const at = now();
    const assignmentId = _newId("as");
    const deliverySnap = plainObject(delivery);
    // delivery.v1 的 assignmentId 由账本在落盘时绑定 —— 调用方创建契约时还拿不到 assignment.id。
    // 恒用新 ID (I7), 不接受调用方预置的 assignmentId (requeue 也不得复用旧 ID)。
    if (deliverySnap && typeof deliverySnap === "object") deliverySnap.assignmentId = assignmentId;
    const assignment = {
      id: assignmentId,
      ticketId,
      worker: String(worker || "router"),
      sessionKey: String(sessionKey || t.sessionKey || "default"),
      origin: normalizeOrigin(origin || t.cause, ORIGIN.INGRESS),
      route: normalizeRoute(route),
      // 执行血缘: 指派继承工单 runId; 重跑/换轮次可由调用方显式覆盖
      runId: runId ? String(runId) : (t.runId || null),
      delivery: deliverySnap,
      // 元认知观测字段 (2026-11-15, flow/gate.js): 随指派落账, 只存不判。
      //   null/非对象一律归一为 null (旧调用点零变化)。
      metacognition: (metacognition && typeof metacognition === "object")
        ? { ...metacognition } : null,
      status: ASSIGNMENT_STATUS.RUNNING,
      rounds: 0,
      steps: 0,
      tools: [],
      // 重放安全事实 (Step 6): true = 本次指派至今没有开跑过有副作用的非幂等工具。
      //   执行收口在**调用前**把非安全工具翻成 false (写前事实); 一旦 false 永不回 true。
      //   旧账本没有该字段 → 视为"无证据", 恢复时一律不放行自动重放。
      replaySafe: true,
      replayUnsafeTool: null,
      bgTaskId: bgTaskId ? String(bgTaskId) : (t.bgTaskId || null),
      resultPreview: null,
      error: null,
      startedAt: at,
      endedAt: null,
      updatedAt: at,
    };
    _append({ kind: "assignment_created", assignment });
    update(ticketId, {
      status: TICKET_STATUS.WORKING,
      worker: assignment.worker,
      assignmentId: assignment.id,
      bgTaskId: assignment.bgTaskId,
      startedAt: t.startedAt || at,
      deliveryReceipt: null, // 新 assignment: 旧投递终态缓存不适用
    });
    return copyAssignment(assignments.get(assignment.id));
  }

  function updateAssignment(id, patch = {}) {
    const a = assignments.get(id);
    if (!a) return null;
    if (patch.status !== undefined && !ASSIGNMENT_ALL.has(patch.status)) {
      throw new Error(`workgraph: 非法指派状态 ${patch.status}`);
    }
    const at = now();
    const clean = { ...patch, updatedAt: at };
    for (const k of ["error", "resultPreview"]) {
      if (clean[k] !== undefined && clean[k] !== null) clean[k] = clip(clean[k], 300);
    }
    if (clean.tools !== undefined) {
      clean.tools = Array.isArray(clean.tools) ? clean.tools.slice(0, 32).map(String) : [];
    }
    // 重放安全是单向锁: 一旦记录过副作用, 任何补丁都不能把它改回 true。
    if (patch.replaySafe !== undefined) {
      clean.replaySafe = a.replaySafe === false ? false : patch.replaySafe === true;
    }
    if (patch.replayUnsafeTool !== undefined) {
      clean.replayUnsafeTool = patch.replayUnsafeTool == null ? null : clip(patch.replayUnsafeTool, 100);
    }
    if (clean.usage !== undefined) clean.usage = normalizeUsageSnapshot(clean.usage);
    if (clean.delivery !== undefined) clean.delivery = plainObject(clean.delivery);
    for (const [k, n] of [["errorKind", 100], ["outcome", 40], ["lastTool", 100], ["taskType", 120]]) {
      if (clean[k] !== undefined && clean[k] !== null) clean[k] = clip(clean[k], n);
    }
    if (patch.status && patch.endedAt === undefined
      && [ASSIGNMENT_STATUS.DONE, ASSIGNMENT_STATUS.FAILED, ASSIGNMENT_STATUS.CANCELLED].includes(patch.status)
      && !a.endedAt) {
      clean.endedAt = at;
    }
    _append({ kind: "assignment_patch", id, patch: clean });
    return copyAssignment(assignments.get(id));
  }

  function get(id) { return copyTicket(tickets.get(String(id || ""))); }

  function getAssignment(id) { return copyAssignment(assignments.get(String(id || ""))); }

  function assignmentsOf(ticketId) {
    return [...assignments.values()]
      .filter((a) => a.ticketId === ticketId)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(copyAssignment);
  }

  // 最近 assignments (2026-11-15, effect cohort 联表用): 按 startedAt 降序取 N 条。
  //   effect.measure 用 [startedAt, endedAt] 时间窗把 traces 联到确定性 taskType 上。
  function listAssignments(limit = 100) {
    return [...assignments.values()]
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
      .slice(0, Math.max(1, Number(limit) || 100))
      .map(copyAssignment);
  }

  // ---- 工具级检查点 (Step 7) ----
  // 只记录调用方显式给出的安全步骤 (只读/幂等); 上限/截断/落盘格式在 ./checkpoints.js。
  const recordCheckpoint = (assignmentId, entry = {}) => checkpointStore.record(assignmentId, entry);
  const checkpointsOf = (assignmentId) => checkpointStore.list(assignmentId);
  const dropCheckpoints = (assignmentId) => checkpointStore.drop(assignmentId);

  function list({ status = null, limit = 50, since = null, source = null } = {}) {
    const wanted = status == null ? null
      : (Array.isArray(status) ? new Set(status.map(String)) : new Set([String(status)]));
    const min = Number.isFinite(Number(since)) ? Number(since) : null;
    return [...tickets.values()]
      .filter((t) => !wanted || wanted.has(t.status))
      .filter((t) => !source || t.source === String(source))
      .filter((t) => min == null || t.createdAt >= min)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .slice(0, Math.max(0, Number(limit) || 50))
      .map(copyTicket);
  }

  // 去重 (I6 三段式): 显式 dedupeKey > origin:externalId > (source, from, messageId)。
  //   · 显式 key 优先且只按 key 匹配, 不回落 messageId (保持既有语义);
  //   · externalId 是 DSH/外部系统的幂等键, 重投时通常没有 messageId —— 必须能反查;
  //   · 无以上两者时按入站三元组匹配 (IM webhook 重试是真实存在的重复执行源)。
  // 在途工单不看时间窗口; 终态工单只在窗口内去重 (超窗说明用户/平台真的又发了一次)。
  function findDuplicate({ source, messageId, from, dedupeKey, externalId, origin } = {}) {
    const explicit = dedupeKey ? String(dedupeKey) : null;
    const ext = externalId ? String(externalId) : null;
    if (!explicit && !ext && !messageId) return null;
    const min = now() - Math.max(0, Number(dedupeMs) || 0);
    let hit = null;
    for (const t of tickets.values()) {
      if (explicit) {
        if (t.dedupeKey !== explicit) continue;
      } else if (ext) {
        if (t.externalId !== ext) continue;
        if (origin && t.origin !== String(origin)) continue;
      } else {
        if (t.messageId !== String(messageId)) continue;
        if (source && t.source !== String(source)) continue;
        if (from && t.from !== String(from)) continue;
      }
      const active = !TICKET_FINAL.has(t.status);
      if (!active && t.createdAt < min) continue;
      if (!hit || t.createdAt > hit.createdAt) hit = t;
    }
    return hit ? copyTicket(hit) : null;
  }

  // 重启恢复: 只标记, 不重跑。返回被标记数量。
  // 只处理**其他实例**留下的未终态工单 —— 同进程内新建的 store 不会误伤自己的在途任务。
  // skipIds: 由调用方筛出的"可安全恢复"工单 (admitted 且从未 begin), 保留原状态不标记;
  //   是否真的重跑由上层显式决定, 存储层只保证"不把事实改写错"。
  function markInterrupted({ reason = "process_restart", instanceId = null, skipIds = [] } = {}) {
    const mine = String(instanceId || instance);
    const skip = new Set((skipIds || []).map(String));
    const at = now();
    let n = 0;
    for (const t of [...tickets.values()]) {
      if (TICKET_FINAL.has(t.status)) continue;
      if (skip.has(t.id)) continue;
      if (!t.instance || t.instance === mine) continue;
      const patch = {
        status: TICKET_STATUS.FAILED,
        error: clip(reason, 300),
        failureKind: "interrupted",
        endedAt: at,
      };
      _append({ kind: "ticket_patch", id: t.id, patch: { ...patch, updatedAt: at } });
      for (const a of assignments.values()) {
        if (a.ticketId === t.id) dropCheckpoints(a.id);
        if (a.ticketId === t.id && a.status === ASSIGNMENT_STATUS.RUNNING) {
          _append({
            kind: "assignment_patch", id: a.id,
            patch: {
              status: ASSIGNMENT_STATUS.FAILED, error: clip(reason, 300),
              errorKind: "interrupted", outcome: "failed",
              endedAt: at, updatedAt: at,
            },
          });
        }
      }
      n += 1;
    }
    return n;
  }

  // 显式重跑: 仅允许终态工单回到 admitted (attempts+1, 清空上一轮结果/错误)。
  function requeue(id) {
    const t = tickets.get(String(id || ""));
    if (!t) return null;
    if (!TICKET_FINAL.has(t.status)) return null;
    if (t.status === TICKET_STATUS.DONE) return null; // 已成功的不重跑 (避免重复副作用)
    const at = now();
    return update(t.id, {
      status: TICKET_STATUS.ADMITTED,
      attempts: (t.attempts || 0) + 1,
      requeueOf: t.assignmentId ? String(t.assignmentId) : null,
      worker: null,
      assignmentId: null,
      bgTaskId: null,
      startedAt: null,
      endedAt: null,
      result: null,
      resultPreview: null,
      error: null,
      failureKind: null,
      deliveryReceipt: null,
      cause: "requeue",
      updatedAt: at,
    });
  }

  function stats() {
    const counts = { admitted: 0, working: 0, waiting: 0, done: 0, failed: 0, cancelled: 0 };
    let interrupted = 0;
    let oldestActiveAt = null;
    for (const t of tickets.values()) {
      if (counts[t.status] !== undefined) counts[t.status] += 1;
      if (t.status === TICKET_STATUS.FAILED && t.failureKind === "interrupted") interrupted += 1;
      if (!TICKET_FINAL.has(t.status)) {
        if (oldestActiveAt == null || t.createdAt < oldestActiveAt) oldestActiveAt = t.createdAt;
      }
    }
    return {
      total: tickets.size,
      assignments: assignments.size,
      counts,
      active: counts.admitted + counts.working + counts.waiting,
      interrupted,
      oldestActiveAt,
      journalLines: lines,
      journalPath,
      journalKind: journal.kind,
      instance,
      checkpoints: checkpointsEnabled,
    };
  }

  // 容量/保留期治理: 只淘汰终态工单, 活跃工单永不因容量被删。
  function prune() {
    const at = now();
    const keepMs = Math.max(0, Number(retentionDays) || 0) * 86400000;
    const dropped = [];
    const terminal = () => [...tickets.values()]
      .filter((t) => TICKET_FINAL.has(t.status))
      .sort((a, b) => (a.endedAt || a.updatedAt) - (b.endedAt || b.updatedAt));

    for (const t of terminal()) {
      if (keepMs <= 0) break;
      const ended = t.endedAt || t.updatedAt || t.createdAt;
      if (at - ended > keepMs) dropped.push(t.id);
    }
    const cap = Math.max(0, Number(maxTickets) || 0);
    if (cap > 0) {
      let size = tickets.size - dropped.length;
      for (const t of terminal()) {
        if (size <= cap) break;
        if (!dropped.includes(t.id)) { dropped.push(t.id); size -= 1; }
      }
    }
    for (const id of dropped) {
      for (const [aid, a] of assignments) if (a.ticketId === id) dropCheckpoints(aid);
      _append({ kind: "ticket_dropped", id });
    }
    return dropped.length;
  }

  function _maybePrune() {
    if (tickets.size > Math.max(0, Number(maxTickets) || 0) * 1.2) prune();
  }

  // 压缩: 把折叠出的当前事实写成快照, 由后端原子替换 (jsonl: tmp+rename / sqlite: 事务)。
  function compact() {
    const out = [];
    for (const t of tickets.values()) out.push({ v: 1, kind: "ticket_created", at: t.createdAt, instance: t.instance || instance, ticket: t });
    for (const a of assignments.values()) out.push({ v: 1, kind: "assignment_created", at: a.startedAt, instance: instance, assignment: a });
    journal.rewrite(out);
    lines = out.length;
    return { lines, tickets: tickets.size, assignments: assignments.size };
  }

  function close() { journal.close(); }

  return {
    instance, journalPath,
    create, update, assign, updateAssignment,
    get, getAssignment, assignmentsOf, listAssignments, list, findDuplicate,
    recordCheckpoint, checkpointsOf, dropCheckpoints,
    markInterrupted, requeue, stats, prune, compact, close,
    _raw: () => ({ tickets: [...tickets.values()], assignments: [...assignments.values()] }),
  };
}

