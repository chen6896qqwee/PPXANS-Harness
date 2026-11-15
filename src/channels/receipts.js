// src/channels/receipts.js - 投递回执事件 (DSH 吸收 Step 3)
//
// 唯一职责: 把"一次投递 attempt"翻译成 delivery_* 事件。同步直发 (Channel.send)
// 与异步队列 (delivery.js) 共用这一份实现 —— 两条路径不允许各自拼事件字段。
//
// 契约: docs/dsh-absorb/00-EVENTS.md §3.4-3.7 / 03-INVARIANTS.md I5、I13。
// 回执身份二选一 (deliveryId 优先):
//   - deliveryId: ANS notify (无工单, I16) 与多目标 submit (每个 sink 一个身份);
//   - ticketId + assignmentId: 工单执行结果 (I5, 与旧事件逐字一致, 从不带 deliveryId)。
// 两者都没有的投递 (broadcast / 旧 ANS) 不产回执: 伪造工单 ID 比没有事件更糟。
import { EventType } from "../protocol/index.js";

const SYNC_DEADLINE_MS = 30000;

// 稳定回执身份: <assignmentId|deliveryId>:<attempt>:<state>。seq 只排序, 不参与去重。
// deliveryId 只用于 ANS notify (无工单) 与多目标 submit —— 有 assignmentId 的旧路径逐字不变。
export function receiptId(identity, attempt, state) {
  return `${identity}:${attempt}:${state}`;
}

function _identity(ctx) {
  if (!ctx) return null;
  // deliveryId 优先: ANS submit 多目标时每个 sink 必须有独立回执身份;
  // 旧路径从不带 deliveryId, assignmentId 语义与 I5 完全不变。
  if (ctx.deliveryId) return String(ctx.deliveryId);
  if (ctx.assignmentId) return String(ctx.assignmentId);
  return null;
}

export function createDeliveryReceipts({ emit = null, now = Date.now } = {}) {
  const sinkOf = (fn) => (typeof fn === "function" ? fn : null);

  function _emit(type, ctx, state, payload) {
    const identity = _identity(ctx);
    if (!identity) return null;
    const attempt = Number.isFinite(Number(ctx.attempt)) ? Math.max(0, Math.trunc(Number(ctx.attempt))) : 0;
    // 字段顺序保持旧形状: ticketId/assignmentId 优先, 仅 ANS notify 才出现 deliveryId (I3 只增不改)。
    const body = ctx.assignmentId
      ? { ticketId: String(ctx.ticketId), assignmentId: String(ctx.assignmentId) }
      : { deliveryId: String(ctx.deliveryId) };
    if (ctx.deliveryId && ctx.assignmentId) body.deliveryId = String(ctx.deliveryId);
    body.attempt = attempt;
    body.receiptId = receiptId(identity, attempt, state);
    body.origin = ctx.origin || "ingress";
    Object.assign(body, payload);
    const fn = sinkOf(emit);
    if (fn) {
      try {
        fn(type, body, {
          ticketId: ctx.ticketId ? String(ctx.ticketId) : null,
          assignmentId: ctx.assignmentId ? String(ctx.assignmentId) : null,
          deliveryId: ctx.deliveryId ? String(ctx.deliveryId) : null,
          sessionKey: ctx.sessionKey || null,
        });
      } catch { /* I13: 观测失败不阻断投递 */ }
    }
    return body;
  }

  function accepted(ctx, extra = {}) {
    return _emit(EventType.DELIVERY_ACCEPTED, ctx, "accepted", {
      channel: ctx.channel || null,
      sink: ctx.sink || null,
      acceptedAt: ctx.at || now(),
      ...extra,
    });
  }

  function delivered(ctx, { providerMessageId = null, at = null } = {}) {
    return _emit(EventType.DELIVERY_DELIVERED, ctx, "delivered", {
      deliveredAt: at || now(),
      providerMessageId: providerMessageId == null ? null : String(providerMessageId),
    });
  }

  function failed(ctx, { error = null, willRetry = false, nextAttemptAt = null, at = null } = {}) {
    return _emit(EventType.DELIVERY_FAILED, ctx, "failed", {
      error: error && typeof error === "object"
        ? {
          kind: String(error.kind || "send_error"),
          message: String(error.message || "").slice(0, 300),
          retryable: error.retryable === true,
        }
        : { kind: "send_error", message: String(error || "").slice(0, 300), retryable: false },
      willRetry: willRetry === true,
      nextAttemptAt: nextAttemptAt == null ? null : Number(nextAttemptAt),
      failedAt: at || now(),
    });
  }

  function deadLetter(ctx, { reason = "delivery_exhausted", finalError = null, at = null } = {}) {
    return _emit(EventType.DELIVERY_DEAD_LETTER, ctx, "dead_letter", {
      reason: String(reason),
      finalError: finalError && typeof finalError === "object"
        ? {
          kind: String(finalError.kind || "send_error"),
          message: String(finalError.message || "").slice(0, 300),
        }
      : null,
      deadAt: at || now(),
    });
  }

  // 同步投递: accepted(1) → send() (硬超时) → delivered(1) 或 failed(false) + dead_letter。
  // 失败后照常向调用方抛出: 回执是观测事实, 不改变既有错误传播语义。
  async function sendSync({
    send,
    ticketId = null,
    assignmentId = null,
    deliveryId = null,
    origin = null,
    channel = null,
    to = null,
    text = "",
    meta = null,
    sessionKey = null,
    deadlineMs = SYNC_DEADLINE_MS,
    at = null,
  }) {
    if (typeof send !== "function") throw new Error("receipts.sendSync: send 必填");
    const ctx = { ticketId, assignmentId, deliveryId, origin, channel, sessionKey, attempt: 1 };
    const sink = { to, thread: meta?.thread || null, replyTo: meta?.replyTo || null };
    accepted({ ...ctx, sink, at: at || now() });
    const limit = Number(deadlineMs);
    let timer = null;
    try {
      const work = Promise.resolve().then(() => send(to, text, meta));
      const result = limit > 0
        ? await Promise.race([
          work,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const e = new Error(`投递超时 (${limit}ms)`);
              e.code = "DELIVERY_TIMEOUT";
              reject(e);
            }, limit);
            // 2026-11-13 修复: 这里**不能** unref —— 同步投递的语义是"调用方在等结果",
            //   定时器一旦 unref, 进程无事可做时直接退出, 超时永远不触发, sendSync 变成
            //   永不 resolve 的悬空 Promise (实测: 21 个投递/通道用例因此挂死)。
            //   30s 上限本身就是"最多挂这么久"的承诺, 不需要再靠 unref 提前放手。
          }),
        ])
        : await work;
      const providerMessageId = result && typeof result === "object"
        ? (result.messageId ?? result.message_id ?? result.providerMessageId ?? null)
        : null;
      delivered(ctx, { providerMessageId });
      return result;
    } catch (e) {
      const timeout = e?.code === "DELIVERY_TIMEOUT";
      const error = {
        kind: timeout ? "timeout" : "send_error",
        message: String(e?.message || e),
        retryable: false,
      };
      failed(ctx, { error, willRetry: false });
      // 契约 §4.1: sync 不重试, 失败固定落 dead_letter(delivery_timeout)。
      deadLetter(ctx, { reason: "delivery_timeout", finalError: error });
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { accepted, delivered, failed, deadLetter, sendSync };
}

export const DEFAULT_SYNC_DEADLINE_MS = SYNC_DEADLINE_MS;
