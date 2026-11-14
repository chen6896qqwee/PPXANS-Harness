// src/channels/delivery.js — 主动投递 Outbox (原生队列, L3 通道设施)
//
// 问题: ChannelManager.broadcast 若是 fire-and-forget, 飞书/企业微信 API 限流一次、网络抖
// 一下, 主动提醒就永远丢了 (连"丢了"都不可见)。这里用一条可恢复的 outbox 补齐投递语义。
//
// 语义:
//   · 失败重试: 指数退避 + 比例抖动 (默认 ±10%, 避免多通道同一时刻重撞);
//   · 过期丢弃: 提醒过时即噪音 (ttlMs), 容量上限丢最旧 (maxQueue);
//   · 重启续投: JSONL WAL 折叠, 已投出/已终态打 done 标记, 未完成且未过期的重新入队;
//   · 幂等键: 同一 key 在 pending 期间只保留一条 (webhook 重试/自动恢复不重复推送);
//   · 死信: 最终失败的消息保留完整现场 (可选落盘), 便于事后追查而不是只剩一行 warn。
//
// 排队模型: nextAttemptAt 定时调度 + 按通道分组执行 (组内串行保序 / 组间并行无队头阻塞)。
// 失败重试只推迟该条消息; 某通道 send 挂起不阻塞其它通道的重试周期。
// 入站回复不走队列 (base.handleTrigger 直发 —— 用户在等), 只有主动投递 (broadcast) 入队。
//
// WAL 折叠语义: 每次入队/重排追加一行完整 job, 终态 (sent/failed/dropped) 追加一行
// {kind:"done"} 标记; 启动 replay 时按 id 折叠取最新, 未完成且未过 TTL 的重新入队,
// 并把 WAL 重写为仅存活的 pending (启动时压缩, 防止无限增长)。
//
// 设计溯源: docs/PROVENANCE.md#superagent (仅设计思想对照, 本文件源码自研)。

import { warn as logWarn } from "../utils/logger.js";
import fs from "node:fs";
import path from "node:path";
import { noteCatch } from "../utils/catch-log.js";
import { createDeliveryReceipts, DEFAULT_SYNC_DEADLINE_MS } from "./receipts.js";

const DEFAULTS = {
  retryMax: 3,        // 首次尝试后的最大重试次数 (总尝试 = 1 + retryMax)
  backoffMs: 2000,    // 首次重试前等待; 之后指数 ×2 (2s → 4s → 8s, 上限 60s)
  backoffCapMs: 60000,
  jitterRatio: 0.1,   // 退避抖动比例 (±10%), 防止多通道/多实例同步重撞
  ttlMs: 60 * 60 * 1000, // 入队超 1h 未投出 → 丢弃 (提醒过期即噪音)
  maxQueue: 200,      // 积压上限, 超限丢最旧 (提醒类消息宁可丢旧不可挤爆)
  deadLetterMax: 50,  // 内存死信上限 (只保留最近 N 条完整现场)
};

// 纯函数退避计算 (可单测): base × 2^(n-1), 封顶后按比例抖动。
export function backoffDelay(attempts, {
  backoffMs = DEFAULTS.backoffMs,
  backoffCapMs = DEFAULTS.backoffCapMs,
  jitterRatio = DEFAULTS.jitterRatio,
  random = Math.random,
} = {}) {
  const base = Math.min(backoffMs * Math.pow(2, Math.max(0, attempts - 1)), backoffCapMs);
  const ratio = Math.max(0, Math.min(1, Number(jitterRatio) || 0));
  if (!ratio) return base;
  const delta = base * ratio;
  return Math.max(0, Math.round(base - delta + random() * delta * 2));
}

// delivery.v1 async policy → 队列可执行的 job 级快照 (Step 4)。非法/缺字段静默回落队列默认。
const RETRY_ON = new Set(["timeout", "network", "rate_limit", "server_error"]);

function normalizeJobPolicy(policy) {
  if (!policy || typeof policy !== "object" || policy.kind !== "async") return null;
  const out = {};
  const maxAttempts = Number(policy.max_attempts);
  if (Number.isFinite(maxAttempts)) out.max_attempts = Math.max(1, Math.min(10, Math.trunc(maxAttempts)));
  for (const k of ["backoff_ms", "backoff_cap_ms", "ttl_ms"]) {
    const n = Number(policy[k]);
    if (Number.isFinite(n) && n >= 0) out[k] = Math.trunc(n);
  }
  const jitter = Number(policy.jitter_ratio);
  if (Number.isFinite(jitter)) out.jitter_ratio = Math.max(0, Math.min(1, jitter));
  if (Array.isArray(policy.retry_on)) {
    out.retry_on = policy.retry_on.map(String).filter((k) => RETRY_ON.has(k));
  } else {
    out.retry_on = [...RETRY_ON]; // 契约 async 默认: 只重试投递阶段可恢复错误
  }
  return Object.keys(out).length ? out : null;
}

// 重试分类只看投递阶段错误; 4xx 参数错误默认不重试 (契约 retry_on 不含 client_error)。
export function classifyRetryClass(e) {
  const code = String(e?.code || "");
  const msg = String(e?.message || e || "");
  const status = Number(e?.status ?? e?.statusCode ?? 0);
  const text = `${code} ${msg}`;
  if (/timeout|ETIMEDOUT/i.test(text)) return "timeout";
  if (/ECONN|ENET|EAI_AGAIN|socket hang up/i.test(text)) return "network";
  if (status === 429 || /rate.?limit/i.test(msg)) return "rate_limit";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "server_error";
}

export function createDeliveryQueue({
  send,                 // async (channelName, to, text, meta) => any —— 通道解析与发送由调用方注入
  retryMax = DEFAULTS.retryMax,
  backoffMs = DEFAULTS.backoffMs,
  backoffCapMs = DEFAULTS.backoffCapMs,
  jitterRatio = DEFAULTS.jitterRatio,
  ttlMs = DEFAULTS.ttlMs,
  maxQueue = DEFAULTS.maxQueue,
  deadLetterPath = null,
  deadLetterMax = DEFAULTS.deadLetterMax,
  walPath = null,
  now = () => Date.now(),
  random = Math.random,
  warn = (m) => logWarn(`[delivery] ${m}`),
  onEvent = null,       // (type, payload, ref) => void — delivery_* 回执 (Step 3, 无 ID 的 job 不产)
} = {}) {
  if (typeof send !== "function") throw new Error("delivery queue 需要 send(channelName, to, text[, meta])");
  const jobs = new Map(); // id -> job { id, key, channel, to, text, enqueuedAt, attempts, nextAttemptAt }
  const stats = { enqueued: 0, sent: 0, failed: 0, dropped: 0, retried: 0, replayed: 0, deduped: 0 };
  const lastErrors = [];  // 最近 10 条终态失败 (可观测: 丢了什么、为什么)
  const deadLetters = []; // 最近 N 条终态失败的完整现场 (含正文/元数据, 便于追查)
  const receipts = createDeliveryReceipts({ emit: onEvent, now });
  let seq = 0;
  let timer = null;
  let stopped = false;
  const draining = new Set(); // send 在途的通道 (组间并行, 组内串行)

  // 回执上下文: 带 ticketId + assignmentId 的 job 产工单回执; 仅带 deliveryId 的是 ANS notify。
  function _receiptCtx(job, attempt) {
    const m = job.meta && typeof job.meta === "object" ? job.meta : {};
    return {
      ticketId: m.ticketId || null,
      assignmentId: m.assignmentId || null,
      deliveryId: m.deliveryId || null,
      channel: job.channel,
      sessionKey: m.sessionKey || null,
      origin: m.origin || "ingress",
      attempt,
    };
  }
  function _receiptSink(job) {
    const m = job.meta && typeof job.meta === "object" ? job.meta : {};
    return { to: job.to, thread: m.thread || null, replyTo: m.replyTo || null };
  }
  function _emitDeadLetter(job, reason, finalError = null, attempt = null) {
    receipts.deadLetter(_receiptCtx(job, attempt == null ? job.attempts : attempt), {
      reason,
      finalError,
    });
  }

  // job 级策略: 契约给了就用契约, 否则沿用队列级常量 (旧 job/主动广播行为逐字不变)。
  function _limits(job) {
    const p = job.policy || null;
    return {
      maxAttempts: p?.max_attempts || (retryMax + 1),
      ttlMs: p && Number.isFinite(p.ttl_ms) && p.ttl_ms > 0 ? p.ttl_ms : ttlMs,
      backoffMs: p && Number.isFinite(p.backoff_ms) ? p.backoff_ms : backoffMs,
      backoffCapMs: p && Number.isFinite(p.backoff_cap_ms) ? p.backoff_cap_ms : backoffCapMs,
      jitterRatio: p && Number.isFinite(p.jitter_ratio) ? p.jitter_ratio : jitterRatio,
      retryOn: p && Array.isArray(p.retry_on) ? new Set(p.retry_on) : null,
    };
  }

  // ---- WAL (JSONL): job 行折叠取最新, done 行标记终态 ----
  const walAppend = (obj) => {
    if (!walPath) return;
    try {
      fs.mkdirSync(path.dirname(walPath), { recursive: true });
      fs.appendFileSync(walPath, JSON.stringify(obj) + "\n", "utf8");
    } catch (e) {
      warn(`WAL 写入失败 (投递继续, 仅丢续投能力): ${e.message}`);
    }
  };
  const walDone = (id, status) => walAppend({ kind: "done", id, status, at: now() });

  // 死信: 终态失败保留完整现场 (正文/元数据/尝试次数/原因)。内存环 + 可选 JSONL 落盘,
  //   解决"只看到一行 warn, 不知道丢的是哪条消息"的观测缺口。
  function deadLetter(job, reason) {
    const rec = {
      id: job.id,
      key: job.key || null,
      channel: job.channel,
      to: job.to,
      text: job.text,
      meta: job.meta ?? null,
      attempts: job.attempts,
      reason,
      at: now(),
    };
    deadLetters.push(rec);
    if (deadLetters.length > Math.max(1, Number(deadLetterMax) || DEFAULTS.deadLetterMax)) deadLetters.shift();
    if (!deadLetterPath) return;
    try {
      fs.mkdirSync(path.dirname(deadLetterPath), { recursive: true });
      fs.appendFileSync(deadLetterPath, JSON.stringify(rec) + "\n", "utf8");
    } catch (e) {
      warn(`死信落盘失败 (内存死信仍保留): ${e.message}`);
    }
  }

  // 启动 replay: 折叠出未完成的 job, 过 TTL 的丢弃, 其余重新入队; WAL 重写为仅存活 pending
  function replay() {
    if (!walPath || !fs.existsSync(walPath)) return 0;
    let lines = [];
    try {
      lines = fs.readFileSync(walPath, "utf8").split("\n").filter(Boolean);
    } catch {
      return 0;
    }
    const latest = new Map();  // id -> job
    const done = new Set();
    for (const line of lines) {
      let j = null;
      try { j = JSON.parse(line); } catch { continue; } // 坏行跳过 (崩溃尾部半行)
      if (!j || typeof j !== "object") continue;
      if (j.kind === "done" && j.id != null) done.add(String(j.id));
      else if (j.kind === "job" && j.job && j.job.id != null) latest.set(String(j.job.id), j.job);
    }
    const t = now();
    const live = [];
    for (const [id, job] of latest) {
      if (done.has(id)) continue;
      if (t - Number(job.enqueuedAt || 0) > _limits(job).ttlMs) { stats.dropped++; continue; } // 上辈子没送出去且已过期
      live.push({ ...job, id: String(id), nextAttemptAt: t });
      // accepted=false: 重启后续投的 attempt 需要在新进程里重新发 accepted 再发送。
      jobs.set(String(id), { ...job, id: String(id), nextAttemptAt: t, accepted: false });
      stats.replayed++;
    }
    // 压缩: WAL 重写为仅存活 pending (done/过期/坏行清掉), 防止跨重启无限增长
    try {
      fs.mkdirSync(path.dirname(walPath), { recursive: true });
      fs.writeFileSync(walPath, live.map((j) => JSON.stringify({ kind: "job", job: j })).join("\n") + (live.length ? "\n" : ""), "utf8");
    } catch (e) { noteCatch(e); /* 压缩失败不影响内存态, WAL 会继续变大 */ }
    return live.length;
  }

  function enqueue({ channel, to = "*", text, meta = null, key = null, policy = null }) {
    if (stopped) return { queued: false, reason: "队列已停止" };
    // 幂等键: 同一 key 在 pending 期间只保留一条 —— 自动恢复/webhook 重试不应重复推送。
    const k = key == null || key === "" ? null : String(key);
    if (k) {
      for (const j of jobs.values()) {
        if (j.key === k) {
          stats.deduped++;
          return { queued: false, reason: "duplicate", id: j.id };
        }
      }
    }
    const t = now();
    const id = `dv-${t.toString(36)}-${(++seq).toString(36)}`;
    const job = { id, key: k, channel: String(channel || ""), to: String(to ?? "*"), text: String(text ?? ""), enqueuedAt: t, attempts: 0, nextAttemptAt: t, meta, policy: normalizeJobPolicy(policy), accepted: false };
    // 容量上限: 丢最旧 (提醒宁可丢旧不可挤爆); 需 O(n) 找最旧 —— 队列小 (默认 200), 可接受
    if (jobs.size >= maxQueue) {
      let oldestId = null;
      let oldestAt = Infinity;
      for (const [jid, j] of jobs) {
        if (j.nextAttemptAt < oldestAt) { oldestAt = j.nextAttemptAt; oldestId = jid; }
      }
      if (oldestId != null) {
        const dropped = jobs.get(oldestId);
        jobs.delete(oldestId);
        stats.dropped++;
        walDone(oldestId, "dropped:overflow");
        _emitDeadLetter(dropped, "delivery_exhausted", null, dropped.attempts);
        warn(`队列满 (>${maxQueue}), 丢弃最旧: ${oldestId}`);
      }
    }
    // 契约 §3.4: accepted 先于真正入队/发送; 无 ticketId/assignmentId 的 job 静默跳过。
    receipts.accepted({ ..._receiptCtx(job, 1), sink: _receiptSink(job) });
    job.accepted = true;
    jobs.set(id, job);
    stats.enqueued++;
    walAppend({ kind: "job", job });
    schedule();
    return { queued: true, id };
  }

  function drain() {
    if (stopped) return;
    const t = now();
    // 到期的按入队顺序处理。**按通道分组: 组内串行 (同通道消息有序, 不并发重发), 组间并行**
    // —— 某通道 send 挂起/慢不阻塞其它通道: in-flight 状态按通道记 (draining), 重试周期照常推进
    // (队头阻塞只存在于同通道内部, 那是有序性的代价)。
    const ready = [...jobs.values()]
      .filter((j) => j.nextAttemptAt <= t && !draining.has(j.channel))
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.id.localeCompare(b.id));
    if (!ready.length) {
      // 2026-10-31 修复丢失唤醒: 此处此前直接 return, 有个窗口 —— 若"一条重试即将到期"
      //   与"另一通道 send 在途"并存, 本轮回调的 finally 已跑过 (timer 已清), 在途通道的
      //   finally 又要到 send 返回才会跑, 到期的那条将永远无人唤醒 (实测:
      //   channel-delivery 的 WAL 测试偶发 waitUntil 超时 —— 全量直跑 5 连绿, 门禁内偶发 1 红)。
      //   现按"未被在途通道占用的最早到期时间"补一个唤醒定时器; 已到期但被 draining
      //   挡住的条目由其 processGroup.finally 的 schedule() 兜底, 不在此空转。
      let earliest = Infinity;
      for (const j of jobs.values()) {
        if (draining.has(j.channel)) continue; // 在途通道醒来时自己会 schedule
        earliest = Math.min(earliest, j.nextAttemptAt);
      }
      if (earliest > t) schedule();
      return;
    }
    const groups = new Map();
    for (const j of ready) {
      if (!groups.has(j.channel)) groups.set(j.channel, []);
      groups.get(j.channel).push(j);
    }
    for (const [ch, group] of groups) {
      draining.add(ch);
      processGroup(group, t).finally(() => {
        draining.delete(ch);
        schedule(); // 该通道空出, 唤醒下一轮 (其 pending 重试或其它到期消息)
      });
    }
  }

  async function processGroup(group, t) {
    for (const job of group) {
      if (stopped) return;
      const limits = _limits(job);
      // TTL: 入队太久没送出去 → 丢弃 (重试期间也要检查 —— 长退避可能直接跨过 TTL)
      if (t - job.enqueuedAt > limits.ttlMs) {
        jobs.delete(job.id);
        stats.dropped++;
        walDone(job.id, "dropped:ttl");
        _emitDeadLetter(job, "delivery_timeout", { kind: "ttl_expired", message: `TTL ${limits.ttlMs}ms` }, job.attempts);
        warn(`投递超时未送出 (>${Math.round(limits.ttlMs / 1000)}s), 丢弃: ${job.id} → ${job.channel}`);
        continue;
      }
      // 契约 §3.4: 每次 attempt 发送前先有 accepted。首次入队时已发过, 重试/重启续投在这里补。
      if (!job.accepted) {
        receipts.accepted({ ..._receiptCtx(job, job.attempts + 1), sink: _receiptSink(job) });
        job.accepted = true;
      }
      try {
        const result = await send(job.channel, job.to, job.text, job.meta ?? null); // 2026-10-31 (一期): 回投元数据随 job 透传 (WAL 持久, 重启续投不丢)
        const providerMessageId = result && typeof result === "object"
          ? (result.messageId ?? result.message_id ?? result.providerMessageId ?? null)
          : null;
        jobs.delete(job.id);
        stats.sent++;
        walDone(job.id, "sent");
        receipts.delivered(_receiptCtx(job, job.attempts + 1), { providerMessageId });
      } catch (e) {
        const attempt = job.attempts + 1;
        const retryClass = classifyRetryClass(e);
        // 契约 retry_on 不含该类错误 → 立即死信, 不浪费剩余尝试。
        const retryableByPolicy = !limits.retryOn || limits.retryOn.has(retryClass);
        const error = {
          kind: retryClass === "timeout" ? "timeout" : "send_error",
          message: String(e && e.message ? e.message : e),
          retryable: retryableByPolicy && job.attempts + 1 < limits.maxAttempts,
        };
        job.attempts++;
        if (!retryableByPolicy || job.attempts >= limits.maxAttempts) {
          jobs.delete(job.id);
          stats.failed++;
          const reason = String(e && e.message ? e.message : e).slice(0, 200);
          lastErrors.push({ id: job.id, channel: job.channel, to: job.to, reason, at: now() });
          if (lastErrors.length > 10) lastErrors.shift();
          receipts.failed(_receiptCtx(job, attempt), { error, willRetry: false });
          deadLetter(job, reason);
          _emitDeadLetter(job, "delivery_exhausted", error, attempt);
          walDone(job.id, `failed:${reason}`);
          warn(`投递最终失败 (${job.attempts} 次尝试): ${job.channel} ← ${reason}`);
        } else {
          stats.retried++;
          job.nextAttemptAt = now() + backoffDelay(job.attempts, {
            backoffMs: limits.backoffMs,
            backoffCapMs: limits.backoffCapMs,
            jitterRatio: limits.jitterRatio,
            random,
          });
          job.accepted = false; // 下一次 attempt 发送前重新发 accepted
          receipts.failed(_receiptCtx(job, attempt), {
            error,
            willRetry: true,
            nextAttemptAt: job.nextAttemptAt,
          });
          walAppend({ kind: "job", job }); // 折叠语义: 重排后的 attempts/nextAttemptAt 持久化
        }
      }
    }
  }

  function schedule() {
    if (stopped || timer) return;
    let earliest = Infinity;
    for (const j of jobs.values()) earliest = Math.min(earliest, j.nextAttemptAt);
    if (earliest === Infinity) return; // 队列空, 等下一次 enqueue 唤醒
    const delay = Math.max(0, Math.min(earliest - now(), 2 ** 30));
    timer = setTimeout(() => {
      timer = null;
      drain();
    }, delay);
    // Node: 不让残留 timer 挂住进程退出
    if (typeof timer.unref === "function") timer.unref();
  }

  // 全部就绪 (无 pending 或都已投出/终态) 时 resolve —— 测试与优雅退出用
  function idle() {
    if (jobs.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (jobs.size === 0) return resolve();
        setTimeout(check, 10);
      };
      check();
    });
  }

  function shutdown() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    // pending 留在 WAL, 下次启动 replay 续投 (内存态直接丢弃)
    return { abandoned: jobs.size };
  }

  function statsSnapshot() {
    return {
      ...stats,
      pending: jobs.size,
      wal: walPath ? "on" : "off",
      lastErrors: lastErrors.slice(),
      deadLetters: deadLetters.slice(),
      deadLetterPath: deadLetterPath || null,
      nextAttemptInMs: (() => {
        let earliest = Infinity;
        for (const j of jobs.values()) earliest = Math.min(earliest, j.nextAttemptAt);
        return earliest === Infinity ? null : Math.max(0, earliest - now());
      })(),
    };
  }

  // 同步直发 (ANS route=sync): 复用同一份回执实现, 但不入队、不重试 (契约 §4.1)。
  async function sendSyncJob({ channel, to, text, meta = null, deadlineMs = null } = {}) {
    const m = meta && typeof meta === "object" ? meta : {};
    const limit = Number(deadlineMs) > 0 ? Number(deadlineMs) : DEFAULT_SYNC_DEADLINE_MS;
    return receipts.sendSync({
      send: (target, body, mm) => send(channel, target, body, mm),
      ticketId: m.ticketId || null,
      assignmentId: m.assignmentId || null,
      deliveryId: m.deliveryId || null,
      origin: m.origin || "ingress",
      channel,
      to,
      text,
      meta,
      sessionKey: m.sessionKey || null,
      deadlineMs: limit,
    });
  }

  const replayedCount = replay();
  if (replayedCount) warn(`replay: 从 WAL 恢复 ${replayedCount} 条未投递消息`);
  schedule();

  return { enqueue, sendSyncJob, idle, shutdown, stats: statsSnapshot, _jobs: jobs };
}
