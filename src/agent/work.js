// src/agent/work.js - 工单/后台任务控制面 (2026-11-08 自 863 行巨石三路拆分)
// 本文件保留 '控制面': 后台任务注册表 / 工单账本查询与重跑 / 投机复现 / 检查点与重放安全。
// 轮归属与常驻编排见 work-thread.js, 轮内意图与学习/统计见 work-turn.js;
// workMethods 仍是三者合并后的对外契约 (index.js 原型展开与既有测试不受影响)。
import { createHash } from 'node:crypto';
import { noteCatch } from '../utils/catch-log.js';
import { EventType } from '../protocol/index.js';
import { createTaskBoard } from '../mcp/tasks.js';
import { createSpeculativeRepair, normalizeMode } from '../evolve/speculative.js';
import { TICKET_STATUS } from '../workgraph/index.js';
import { warn } from '../utils/logger.js';
import { workThreadMethods } from './work-thread.js';
import { workTurnMethods } from './work-turn.js';

export const workMethods = {
  // 三个子 mixin 合并成对外契约 (index.js 原型展开 / 既有测试只认 workMethods)
  ...workThreadMethods,
  ...workTurnMethods,
// (R17) 共享任务面板实例: /task 命令、HTTP /api/tasks、MCP ppx.task.* 三方同源。
getTaskBoard() {
  if (!this._taskBoardInst) this._taskBoardInst = createTaskBoard(this.root);
  return this._taskBoardInst;
},

// 注册表容量守卫: 保留最近 50 条; 淘汰时先清已终态 (done/error/cancelled/timeout) 的最旧者
_bgTrim() {
  const tasks = this._bgTasks;
  if (!tasks || tasks.size <= 50) return;
  for (const [k, v] of tasks) {
    if (tasks.size <= 50) break;
    if (v.status !== "running") tasks.delete(k);
  }
  while (tasks.size > 50) {
    const oldest = tasks.keys().next().value;
    tasks.delete(oldest);
  }
},

// 后台任务清单 (供 /bg 命令与诊断): 新任务在前
bgTasks() {
  if (!this._bgTasks) return [];
  return [...this._bgTasks.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(({ promise, ...rest }) => rest);
},

// 取消后台任务: 置终态 + interrupt(sessionKey) + EQ 事件。返回是否命中。
bgCancel(id) {
  const entry = this._bgTasks?.get(id);
  if (!entry || entry.status !== "running") return false;
  entry.status = "cancelled";
  entry.endedAt = Date.now();
  this._eqPushRef?.(EventType.TASK_ABORTED, { taskId: id, sessionKey: entry.sessionKey, status: "cancelled" }, { sessionKey: entry.sessionKey, ref: id });
  try { this.interrupt(entry.sessionKey); } catch { /* 中断异常不影响标记 */ }
  // 工单联动 (2026-11-02): 取消后台任务时把对应工单收口为 cancelled —— 否则它会停在
  // working 直到下次启动恢复被标记 interrupted, 期间 /work 显示"在跑"是假象。
  try {
    const t = this.workList({ limit: 200 }).tickets.find((x) => x.bgTaskId === id
      && ![TICKET_STATUS.DONE, TICKET_STATUS.FAILED, TICKET_STATUS.CANCELLED].includes(x.status));
    if (t) this.work?.cancel(t.id, "bg_cancel");
  } catch { /* 账本异常不影响取消 */ }
  return true;
},

// ---- 工单账本 (2026-11-02 三期第二批): 查询/取消/显式重跑 ----
// 入站受理时由 Channel.handleTrigger 建单; 这里是对外控制面 (命令/HTTP/测试)。
workList(opts = {}) {
  if (!this.work) return { tickets: [], counts: {}, stats: null, enabled: false };
  const out = this.work.list(opts);
  return { ...out, enabled: true };
},

workGet(id) {
  if (!this.work) return null;
  return this.work.get(id);
},

workCancel(id, reason = "user_cancel") {
  if (!this.work) return { ok: false, reason: "workgraph_disabled" };
  const t = this.work.get(id)?.ticket;
  if (!t) return { ok: false, reason: "not_found" };
  if ([TICKET_STATUS.DONE, TICKET_STATUS.FAILED, TICKET_STATUS.CANCELLED].includes(t.status)) {
    return { ok: false, reason: "already_final", ticket: t };
  }
  if (t.bgTaskId) { try { this.bgCancel(t.bgTaskId); } catch { /* 后台任务可能已回收 */ } }
  const next = this.work.cancel(id, reason);
  return { ok: !!next, ticket: next };
},

// 显式重跑: 只接受 failed/cancelled 工单。重跑走 chatAsync (不阻塞命令面),
// 结果经来源通道 delivery 队列回投原话题; 工具副作用由用户显式触发并承担 (不做静默重放)。
workRequeue(id) {
  if (!this.work) return { ok: false, reason: "workgraph_disabled" };
  const t = this.work.get(id)?.ticket;
  if (!t) return { ok: false, reason: "not_found" };
  if (!t.text) return { ok: false, reason: "no_text", ticket: t };
  const re = this.work.requeue(id);
  if (!re) return { ok: false, reason: "not_requeueable", ticket: t };
  const sk = re.sessionKey || "default";
  this.work.begin(id, { worker: "router:requeue", sessionKey: sk });
  const { id: bgId } = this.chatAsync(re.text, {
    sessionKey: sk,
    onDone: (reply) => {
      this.work.complete(id, { result: reply, bgTaskId: bgId });
      this._deliverWorkReply(re, reply);
    },
    onError: (e) => {
      this.work.fail(id, e);
      this._deliverWorkReply(re, `[工单重跑失败] ${e?.message || e}`);
    },
  });
  return { ok: true, ticket: this.work.get(id)?.ticket, bgTaskId: bgId };
},

// 启动安全自动恢复 (2026-11-02): 重跑 recover 筛出的工单。两类 (Step 6 扩展):
//   - unstarted: admitted 且从未 begin —— 没有执行事实, 不存在副作用;
//   - replay: working 且上一指派 replaySafe=true —— 开跑过的工具全为只读/显式幂等,
//     整轮重放不会让副作用翻倍; 旧指派已由 recover 收口为 interrupted。
// 必须在通道启动后调用 (结果要回投原话题); 队列一次性消费, 重复调用不会重复执行。
// 消费时重新校验状态: 期间被取消/人工处理/产生新副作用证据 → 跳过, 不抢跑。
// 失败/空文本按普通工单失败收口并回投, 不抛给启动流程 (自动恢复不能拖垮服务)。
resumeUnstartedTickets({ limit = null } = {}) {
  if (!this.work) return { resumed: 0, tickets: [], reason: "workgraph_disabled" };
  const queue = Array.isArray(this._workResumeQueue) ? this._workResumeQueue : [];
  const max = limit == null ? queue.length : Math.max(0, Math.floor(Number(limit) || 0));
  const started = [];
  for (const t of queue) {
    if (started.length >= max) break;
    const kind = t.resumeKind === "replay" ? "replay" : "unstarted";
    const cur = this.work.get(t.id)?.ticket;
    if (!cur) continue;
    if (kind === "unstarted" && cur.status !== TICKET_STATUS.ADMITTED) continue; // 已被取消/人工重跑
    let prev = null;
    if (kind === "replay") {
      if (cur.status !== TICKET_STATUS.WORKING) continue;
      // 旧指派已收口; replaySafe 单向锁仍在, 这里复核一次防"恢复后又被标脏"。
      prev = this.workStore?.getAssignment?.(cur.assignmentId) || null;
      if (!prev || prev.replaySafe !== true) continue;
    }
    if (!cur.text) {
      this.work.fail(cur.id, "工单无文本, 无法自动恢复", { failureKind: "resume_no_text" });
      continue;
    }
    const sk = cur.sessionKey || "default";
    const worker = kind === "replay" ? "router:replay" : "router:resume";
    // Step 7: 只对重放路径恢复检查点 (unstarted 没有执行事实, 不存在检查点)。
    const resumeCtx = kind === "replay" ? this._buildResumeCtx(prev) : null;
    this.work.begin(cur.id, { worker, sessionKey: sk });
    try {
      const { id: bgId } = this.chatAsync(cur.text, {
        sessionKey: sk,
        ...(resumeCtx ? { resumeCtx } : {}),
        onDone: (reply) => {
          this.work.complete(cur.id, { result: reply, bgTaskId: bgId });
          this._deliverWorkReply(cur, reply);
        },
        onError: (e) => {
          this.work.fail(cur.id, e, { failureKind: kind === "replay" ? "replay_error" : "resume_error" });
          this._deliverWorkReply(cur, `[工单自动恢复失败] ${e?.message || e}`);
        },
      });
      started.push({ id: cur.id, bgTaskId: bgId, sessionKey: sk, kind, resumeSteps: resumeCtx?.steps || 0 });
    } catch (e) {
      this.work.fail(cur.id, e, { failureKind: kind === "replay" ? "replay_error" : "resume_error" }); /* swallowed-ok(2026-11-03): 失败已写入工单状态 */
    }
  }
  this._workResumeQueue = [];
  return { resumed: started.length, tickets: started };
},

// 工单结果回投: 优先走来源通道的 delivery 队列 (失败重试/WAL 续投), 无通道时退回通知回调。
_deliverWorkReply(ticket, text) {
  const meta = {
    ...(ticket.thread || ticket.messageId ? { thread: ticket.thread || "", replyTo: ticket.messageId || "" } : {}),
    ticketId: ticket.id,
    assignmentId: ticket.assignmentId || null,
    sessionKey: ticket.sessionKey || null,
    origin: ticket.origin || "ingress",
  };
  const ch = this.channelManager?.get?.(ticket.source);
  if (ch && typeof ch._deliverAsync === "function") {
    try { void ch._deliverAsync(ticket.from || "*", text, meta); return true; } catch (e) { noteCatch(e); /* 退回队列 */ }
  }
  const delivery = this.channelManager?.delivery;
  if (delivery && typeof delivery.enqueue === "function") {
    try { delivery.enqueue({ channel: ticket.source, to: ticket.from || "*", text, meta }); return true; } catch (e) { noteCatch(e); /* 退回通知 */ }
  }
  this.notify?.(text);
  return false;
},

// ---- 投机复现修复 (2026-11-01 三期第一批, 设计稿 §4.1 静默复现) ----
// 轮收口边界上静默复现本轮工具失败: 故障病历 (FailureEpisodeStore) 的首个真实消费方。
_speculativeEngine() {
  if (this.__speculative !== undefined) return this.__speculative;
  try {
    this.__speculative = createSpeculativeRepair({
      failures: this.ctx?.consume?.("failures") || null,
      experience: this.experience || null,
      runTool: (name, args) => this._runTool(name, args), // 权限/审计/钩子照常生效
      isIdempotent: (name) => this._toolIdempotent(name),
      diagnose: this.config?.agent?.speculative_repair === "full"
        ? (text) => new Promise((resolve) => {
          this.chatAsync(text, { sessionKey: "ppx:speculative", onDone: () => resolve(null), onError: () => resolve(null) });
        })
        : null,
      onEvent: (type, payload) => { try { this.tracer?.event?.(type, payload); } catch { /* 不阻断 */ } },
    });
  } catch { this.__speculative = null; }
  return this.__speculative;
},

// 轮工具失败清单按会话分桶 (2026-11-12): 实例单值在并发会话下会互相清空/串轮 ——
//   A 轮收口时会把 B 轮的失败当成自己的在 A 上下文里投机重放 (互斥锁只按会话串行化)。
//   键 = sessionKey; 兜底 128 桶上限, 防长跑进程累积空数组。
_turnFailuresOf(sessionKey) {
  const key = String(sessionKey || this._activeSessionKey || "default");
  if (!this._turnFailuresByKey) this._turnFailuresByKey = new Map();
  let arr = this._turnFailuresByKey.get(key);
  if (!arr) {
    if (this._turnFailuresByKey.size >= 128) {
      const oldest = this._turnFailuresByKey.keys().next().value;
      if (oldest != null) this._turnFailuresByKey.delete(oldest);
    }
    arr = [];
    this._turnFailuresByKey.set(key, arr);
  }
  return arr;
},

_clearTurnFailures(sessionKey) {
  const key = String(sessionKey || this._activeSessionKey || "default");
  this._turnFailuresByKey?.delete(key);
},

// 轮收口调度 (chat/chatStream 成功收口后调用): 失败清单非空 && 模式开启 → 后台静默复现
_scheduleSpeculative(sessionKey) {
  const key = String(sessionKey || this._activeSessionKey || "default");
  const failed = this._turnFailuresByKey?.get(key) || [];
  this._turnFailuresByKey?.delete(key);
  const mode = normalizeMode(this.config?.agent?.speculative_repair);
  if (mode === "off" || !failed.length) return;
  const eng = this._speculativeEngine();
  if (!eng) return;
  const count = eng.schedule(failed);
  if (count > 0) this.notify?.(`[投机复现] 本轮 ${count} 个工具失败已进后台静默复现 (病历/经验沉淀)。`);
},

_markWorkReplayUnsafe(name, sessionKey = null) {
  if (!this.work || typeof this.work.markUnsafeBySession !== "function") return true;
  if (this._toolReplaySafe(name)) return true;
  try {
    // 会话键未知时传 null: 服务层会保守地把所有在途指派标脏 (只影响自动重放, 不影响执行)。
    const sk = sessionKey || this._activeSessionKey || null;
    this.work.markUnsafeBySession(sk == null ? null : String(sk), name);
    return true;
  } catch (e) {
    warn(`[workgraph] 副作用写前事实落账失败 (${name}): ${e?.message || e}`);
    return false;
  }
},

// 重放安全判定 (Step 6/7 共用): 只读能力 或 显式声明幂等。
//   查不到元数据时返回 false —— 对检查点/复用而言"不确定"等同"不可复用" (保守)。
_toolReplaySafe(name) {
  try {
    const cap = this.tools?.getCapability?.(name) || null;
    if (cap && cap.readOnly === true) return true;
    const meta = this.tools?.metaOf?.(name) || null;
    return !!(meta && meta.idempotent === true);
  } catch (e) {
    noteCatch("src/agent/work.js#_toolReplaySafe", e);
    return false;
  }
},

// ---- Step 7: 断点续执行 (检查点 / 已完成调用复用) ----
// 检查点键 = 工具名 + 规范化参数 (键排序, 与对象字面量顺序无关)。
//   同键 = 同一可复用步骤; 参数不同绝不复用。
_checkpointKey(name, args) {
  return createHash("sha256").update(`${name}|${_canonicalJson(args ?? null)}`).digest("hex").slice(0, 32);
},

// 把一次重放安全工具的执行结果记入当前会话在途指派的检查点。
//   只在 resume_checkpoint=true 时写; 有副作用的调用从不进检查点 (也不参与复用)。
_recordWorkCheckpoint(name, args, result, ok, callId = null, sessionKey = null) {
  const wg = this.config?.agent?.work_graph || {};
  if (wg.resume_checkpoint !== true || wg.resume_started !== true) return false;
  if (!this._toolReplaySafe(name)) return false;
  if (!this.work || typeof this.work.checkpointBySession !== "function") return false;
  try {
    const sk = sessionKey || this._activeSessionKey || null;
    return this.work.checkpointBySession(sk == null ? null : String(sk), {
      tool: name,
      key: this._checkpointKey(name, args),
      ok: ok !== false,
      result: result == null ? "" : String(result),
      callId: callId == null ? null : String(callId),
    });
  } catch (e) {
    warn(`[workgraph] 检查点写入失败 (${name}): ${e?.message || e}`);
    return false;
  }
},

// 续跑上下文挂到本轮: 提示块 + 复用表 (按会话键隔离, 轮末清除)。
_armResumeCtx(sessionKey, ctx) {
  const sk = String(sessionKey || "default");
  if (!ctx || !Array.isArray(ctx.entries) || !ctx.entries.length) return false;
  const memo = new Map();
  for (const e of ctx.entries) {
    if (e && e.ok === true && e.key && e.tool) memo.set(e.key, { tool: e.tool, result: e.result ?? "" });
  }
  if (!this._turnResumeHints) this._turnResumeHints = new Map();
  if (!this._turnResumeMemos) this._turnResumeMemos = new Map();
  this._turnResumeHints.set(sk, { ...ctx, steps: ctx.entries.length, reusable: memo.size });
  this._turnResumeMemos.set(sk, memo);
  return true;
},

_clearResumeCtx(sessionKey) {
  const sk = String(sessionKey || "default");
  this._turnResumeHints?.delete(sk);
  this._turnResumeMemos?.delete(sk);
},

// 续跑提示文本: 只说明事实 (中断位置/可复用步数), 由模型自行决定继续方式。
_resumeHintText(ctx) {
  if (!ctx) return "";
  const reusable = Number(ctx.reusable) || 0;
  return [
    `[断点续执行] 上一轮执行到第 ${ctx.steps} 个只读步骤后中断 (指派 ${ctx.fromAssignment || "?"})。`,
    reusable > 0
      ? `其中 ${reusable} 个已完成调用的结果已恢复: 完全相同 (工具 + 参数) 的调用直接复用上次结果, 不重复执行; 其余步骤按需重跑。`
      : "没有可直接复用的已完成调用, 请从中断处继续, 不要从头重复已完成的工作。",
  ].join("\n");
},

// 从上一指派的检查点构建续跑上下文 (只读文件, 不改变账本)。
_buildResumeCtx(assignment) {
  if (!assignment || !this.workStore?.checkpointsOf) return null;
  let entries = [];
  try { entries = this.workStore.checkpointsOf(assignment.id) || []; }
  catch (e) { noteCatch("src/agent/work.js#_buildResumeCtx", e); return null; }
  if (!entries.length) return null;
  return {
    fromAssignment: assignment.id,
    entries,
    steps: entries.length,
    tools: [...new Set(entries.map((e) => e.tool))].slice(0, 12),
  };
},
};


// 规范化 JSON: 键排序 + 深度上限 (防环)。检查点键必须与对象字面量顺序无关。
function _canonicalJson(v, depth = 0) {
  if (depth > 12) return '"[deep]"';
  if (v === null || typeof v === "undefined") return "null";
  if (typeof v === "bigint") return JSON.stringify(String(v));
  if (typeof v !== "object") {
    const s = JSON.stringify(v);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(v)) return `[${v.map((x) => _canonicalJson(x, depth + 1)).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${_canonicalJson(v[k], depth + 1)}`).join(",")}}`;
}
