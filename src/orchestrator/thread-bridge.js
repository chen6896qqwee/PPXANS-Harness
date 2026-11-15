// src/orchestrator/thread-bridge.js - 长驻 worker 话题订阅编排 (2026-11-01 v4.2 持久化)
//
// 语义 (对齐设计稿 §3.2 订阅直通): 把一个话题 (thread/sessionKey) 交给一名**长驻**军团 worker
//   专职跟进 —— 后续同话题消息由通道层程序直通该 worker (legion.send), 不再进主 agent 的
//   Router LLM (实测同型优化在设计稿中省 ~37% Router token); worker 回复经 delivery 队列
//   回投原话题 (失败重试/WAL 续投)。
//
// 与 spawn_agent 的分工: spawn_agent 是"派活-收活-回收"的一次性委派; 本桥是"驻派" ——
//   worker 进程常驻 (agent._legion 复用同一军团), 直到 threadDetach/agent.shutdown。
//
// 直通路径: base.handleTrigger → agent.threadRoute(sk, thread) 命中 → bridge.forward(trigger)
//   → legion.send(worker, {type:"chat", message}) → deliver(payload, reply)。
//   消息同时落 EQ MESSAGE_RECEIVED (观测面; 转发走显式调用而非 EQ 订阅, 避免"直通+事件"双投)。
import path from "node:path";
import { noteCatch } from "../utils/catch-log.js";

const FORWARD_TIMEOUT_MS = 120000;

export class ThreadBridge {
  constructor({ legion, dataDir, globalDataDir = null, env = {}, deliver = null, onEvent = null, onReport = null, timeoutMs = FORWARD_TIMEOUT_MS } = {}) {
    if (!legion || typeof legion.spawnAgent !== "function") throw new Error("ThreadBridge: legion 必须注入");
    this.legion = legion;
    this.dataDir = String(dataDir || "");
    this.globalDataDir = globalDataDir;
    this.env = env || {};
    this.deliver = typeof deliver === "function" ? deliver : null; // (payload, reply) => void
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    // onReport: 每次长驻 worker 执行完的汇报 (与 spawn_agent 的 worker_report 同口径)
    this.onReport = typeof onReport === "function" ? onReport : null;
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : FORWARD_TIMEOUT_MS;
    this.entries = new Map(); // threadKey -> {name, sessionKey, thread, createdAt, forwards, lastForwardAt, busy}
    this._seq = 0;
  }

  _report(r) { if (this.onReport) { try { this.onReport(r); } catch { /* 埋点不阻断 */ } } }

  _ev(type, payload) { if (this.onEvent) { try { this.onEvent(type, payload); } catch { /* 埋点不阻断 */ } } }

  // 驻派: 为话题创建/复用长驻 worker, 发首个任务, 登记直通转发
  // 返回 {id, name, reply} (reply = 首任务回复, 与 spawn_agent 单任务同款)
  async attach(threadKey, { task, sessionKey = null, thread = null, readonly = false } = {}) {
    const key = String(threadKey || "");
    if (!key) throw new Error("thread-bridge: threadKey 必填");
    const existing = this.entries.get(key);
    if (existing) return { id: existing.name, name: existing.name, reply: null, reused: true };
    this._seq += 1;
    const name = `tw-${Date.now().toString(36)}-${this._seq.toString(36)}`;
    // 与 spawn_agent 同款隔离约定: 每worker独立 dataDir (多进程共享 dataDir 会互踩)
    this.legion.spawnAgent(name, {
      dataDir: this.dataDir ? path.join(this.dataDir, "legion", name) : undefined,
      globalDataDir: this.globalDataDir,
      env: readonly ? { ...this.env, PPX_AGENT_READONLY: "1" } : { ...this.env },
    });
    const entry = { name, sessionKey, thread, createdAt: Date.now(), forwards: 0, lastForwardAt: null, busy: false };
    this.entries.set(key, entry);
    this._ev("thread/attached", { threadKey: key, worker: name });
    let reply = null;
    if (task) {
      const startedAt = Date.now();
      reply = await this.legion.send(name, { type: "chat", message: String(task) }, { timeout: this.timeoutMs })
        .then((m) => {
          this._report({
            ok: true, envelope: m?.envelope || null, worker: name,
            durationMs: Date.now() - startedAt,
          });
          return m.reply || null;
        })
        .catch((e) => {
          this._ev("thread/task_error", { worker: name, error: String(e?.message || e).slice(0, 200) });
          this._report({ ok: false, worker: name, errorKind: "thread_task_error", durationMs: Date.now() - startedAt });
          return null;
        });
    }
    return { id: name, name, reply };
  }

  // 直通判定: 该会话/话题是否有驻派 worker (handleTrigger 每条消息先问这里)
  route(sessionKey, thread = "") {
    if (thread && this.entries.has(String(thread))) return this.entries.get(String(thread));
    if (sessionKey && this.entries.has(String(sessionKey))) return this.entries.get(String(sessionKey));
    return null;
  }

  // 同话题消息直通 worker (不经 Router LLM): 串行化 (worker promise 链, 对齐 agent-worker v1.0.8 口径)
  // Step 3: 请求透传 ticketId/assignmentId, worker 在信封里回传; 父进程用 onExecuted 先收口执行,
  //   再 deliver 结果 —— worker 不产 delivery_* (I11)。
  async forward(entry, payload, { onProgress = null, onExecuted = null, timeoutMs = null } = {}) {
    if (!entry || entry.busy) return { forwarded: false, reason: entry ? "busy" : "no-entry" };
    entry.busy = true;
    entry.forwards += 1;
    entry.lastForwardAt = Date.now();
    // Step 4: 契约显式 forward_timeout_ms > 0 才覆盖桥默认; 未给/0 保持 120s 旧行为。
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs;
    const startedAt = Date.now();
    try {
      const message = { type: "chat", message: String(payload.text || "") };
      if (payload.ticketId) message.ticketId = String(payload.ticketId);
      if (payload.assignmentId) message.assignmentId = String(payload.assignmentId);
      const m = await this.legion.send(entry.name, message, {
        timeout: limit,
        ...(typeof onProgress === "function" ? { onProgress } : {}),
      });
      const reply = m.reply || null;
      const envelope = m.envelope && typeof m.envelope === "object" ? m.envelope : null;
      this._report({
        ok: true, envelope, worker: entry.name,
        ticketId: payload.ticketId || null, assignmentId: payload.assignmentId || null,
        durationMs: Date.now() - startedAt,
      });
      if (typeof onExecuted === "function") {
        try { onExecuted(reply, envelope); } catch { /* 收口失败不阻断结果回投 */ }
      }
      if (reply && this.deliver) {
        try { this.deliver(payload, reply); } catch (e) { this._ev("thread/deliver_error", { worker: entry.name, error: String(e?.message || e).slice(0, 200) }); /* swallowed-ok(2026-11-03): 已发 deliver_error 事件 */ }
      }
      this._ev("thread/forwarded", { worker: entry.name, ms: Date.now() - entry.lastForwardAt });
      return { forwarded: true, reply, envelope };
    } catch (e) {
      this._ev("thread/forward_error", { worker: entry.name, error: String(e?.message || e).slice(0, 200) });
      this._report({
        ok: false, worker: entry.name, errorKind: "forward_error",
        ticketId: payload.ticketId || null, assignmentId: payload.assignmentId || null,
        durationMs: Date.now() - startedAt,
      });
      // 诚实回投失败 (不静默吞): 走 deliver 报错, 让原话题知道直通失败
      if (this.deliver) {
        try { this.deliver(payload, `[直通失败] 话题 worker ${entry.name} 未响应: ${String(e?.message || e).slice(0, 120)} (消息未处理, 可重发或 /bg detach)}`); } catch (e) { noteCatch(e); /* 尽力而为 */ }
      }
      return { forwarded: false, reason: "error" };
    } finally {
      entry.busy = false;
    }
  }

  // 撤驻: 解除登记 + 回收 worker 进程。返回是否命中。
  async detach(threadKey) {
    const entry = this.entries.get(String(threadKey || ""));
    if (!entry) return false;
    this.entries.delete(String(threadKey));
    try { await this.legion.killAgent(entry.name); } catch { /* 回收失败不阻断登记清除 */ }
    this._ev("thread/detached", { threadKey: String(threadKey), worker: entry.name });
    return true;
  }

  list() {
    return [...this.entries.entries()].map(([key, e]) => ({
      threadKey: key, worker: e.name, sessionKey: e.sessionKey, thread: e.thread,
      forwards: e.forwards, lastForwardAt: e.lastForwardAt, createdAt: e.createdAt,
    }));
  }

  async detachAll() {
    const keys = [...this.entries.keys()];
    for (const k of keys) await this.detach(k);
    return keys.length;
  }
}
