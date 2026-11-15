// src/workgraph/judge.js - DSH 完成判定 (deliveryState × ticket.status 纯函数)
//
// 契约: docs/dsh-absorb/02-STATE-MATRIX.md §4。唯一收单条件是
// ticket.status=done 且 deliveryState=delivered; 其它组合只给动作, 不推进状态。
// 本模块不写账本、不发事件、不重试 —— 判定与执行严格分离。

import { TICKET_STATUS } from "./store.js";
import { DELIVERY_STATE, foldDeliveryState, isDeliveryState } from "./state.js";

export const VERDICT = Object.freeze({
  COMPLETED: "completed",
  IN_PROGRESS: "in_progress",
  DELIVERING: "delivering",
  DELIVERING_OR_STUCK: "delivering_or_stuck",
  FAILED: "failed",
  CANCELLED: "cancelled",
  REQUEUE_ALLOWED: "requeue_allowed",
  MANUAL_REVIEW: "manual_review",
  VIOLATION: "violation",
});

export const ACTION = Object.freeze({
  COLLECT: "collect",
  WAIT: "wait",
  RECORD: "record",
  NONE: "none",
  REQUEUE: "requeue",
  MANUAL: "manual",
  ALERT: "alert",
});

export const DEFAULT_GRACE_MS = 5 * 60 * 1000;

function _result(deliveryState, verdict, action, reason, extra = {}) {
  return {
    verdict,
    action,
    reason,
    deliveryState,
    requeueAllowed: false,
    autoEligible: false,
    ...extra,
  };
}

// 终态工单 + 非终态投递: 宽限期内等待收口, 超期视为卡死转人工 (矩阵 P* 规则)。
function _stuckOr(ticket, now, graceMs, deliveryState, verdict, reason) {
  const ended = Number(ticket.endedAt || ticket.updatedAt || ticket.createdAt || 0);
  if (ended > 0 && now - ended > graceMs) {
    return _result(deliveryState, VERDICT.MANUAL_REVIEW, ACTION.MANUAL, `${reason}; 超过收口宽限期`);
  }
  return _result(deliveryState, verdict, ACTION.WAIT, reason);
}

/**
 * @param {object} ticket workgraph 工单 (status/failureKind/assignmentId/endedAt)
 * @param {object} [options]
 * @param {string} [options.deliveryState] 已折叠的投递状态
 * @param {Array}  [options.events]        未折叠的 DELIVERY_* 事件 (调用方显式事实, 优先级最高)
 * @param {boolean}[options.useSnapshot]   false 时忽略 ticket.deliveryReceipt (默认读)
 * @param {boolean}[options.recovered]     重启后无法确认 send 结果 → accepted 降级 unknown
 * @param {boolean}[options.hasBegun]      是否已产生过 assignment (默认看 ticket.assignmentId)
 * @param {number} [options.now]           时间桩
 * @param {number} [options.graceMs]       收口宽限期 (默认 5 分钟)
 */
export function judgeTicket(ticket, options = {}) {
  if (!ticket || typeof ticket !== "object") {
    return _result(DELIVERY_STATE.NONE, VERDICT.VIOLATION, ACTION.ALERT, "缺少工单");
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : DEFAULT_GRACE_MS;
  // 优先级: 调用方显式事实 (events / deliveryState) > 终态快照 > 无。
  // 快照让判定不必回放 EQ WAL; 只在该 assignment 的终态写入 (I4 修订), 因此不会掩盖在途事实。
  const snap = options.useSnapshot === false ? null : ticket.deliveryReceipt;
  const usableSnap = snap && String(snap.assignmentId || "") === String(ticket.assignmentId || "")
    && isDeliveryState(snap.state) ? String(snap.state) : null;
  const deliveryState = options.events
    ? foldDeliveryState(options.events, { recovered: options.recovered === true })
    : options.deliveryState !== undefined && options.deliveryState !== null
      ? String(options.deliveryState || DELIVERY_STATE.NONE)
      : (usableSnap || DELIVERY_STATE.NONE);
  if (!isDeliveryState(deliveryState)) {
    return _result(deliveryState, VERDICT.VIOLATION, ACTION.ALERT, `未知投递状态 ${deliveryState}`);
  }
  const hasBegun = options.hasBegun === undefined
    ? Boolean(ticket.assignmentId)
    : Boolean(options.hasBegun);
  const status = ticket.status;

  if (status === TICKET_STATUS.ADMITTED || status === TICKET_STATUS.WORKING) {
    if (deliveryState !== DELIVERY_STATE.NONE) {
      return _result(deliveryState, VERDICT.VIOLATION, ACTION.ALERT,
        `执行未结束却出现投递事实 (${deliveryState})`);
    }
    return _result(deliveryState, VERDICT.IN_PROGRESS, ACTION.WAIT, "等待执行完成");
  }

  if (status === TICKET_STATUS.WAITING) {
    if (deliveryState === DELIVERY_STATE.UNKNOWN) {
      return _result(deliveryState, VERDICT.MANUAL_REVIEW, ACTION.MANUAL, "长驻 worker 等待中投递结果未知");
    }
    return _result(deliveryState, VERDICT.IN_PROGRESS, ACTION.WAIT, "等待 worker 回投");
  }

  if (status === TICKET_STATUS.DONE) {
    if (deliveryState === DELIVERY_STATE.DELIVERED) {
      return _result(deliveryState, VERDICT.COMPLETED, ACTION.COLLECT, "执行成功且结果已送达");
    }
    if (deliveryState === DELIVERY_STATE.ACCEPTED || deliveryState === DELIVERY_STATE.FAILED) {
      return _stuckOr(ticket, now, graceMs, deliveryState, VERDICT.DELIVERING,
        "执行成功, 投递尚未收口");
    }
    if (deliveryState === DELIVERY_STATE.DEAD_LETTER) {
      return _result(deliveryState, VERDICT.MANUAL_REVIEW, ACTION.MANUAL,
        "执行成功但结果未送达; 不重跑执行, 人工决定是否重发");
    }
    if (deliveryState === DELIVERY_STATE.NONE) {
      return _result(deliveryState, VERDICT.MANUAL_REVIEW, ACTION.MANUAL,
        "执行成功却从未投递 (缺少 accepted)");
    }
    return _result(deliveryState, VERDICT.MANUAL_REVIEW, ACTION.MANUAL, "投递结果未知");
  }

  if (status === TICKET_STATUS.FAILED) {
    if (ticket.failureKind === "interrupted") {
      if (deliveryState === DELIVERY_STATE.DEAD_LETTER) {
        return _result(deliveryState, VERDICT.REQUEUE_ALLOWED, ACTION.REQUEUE,
          "中断且已有死信; 仅允许显式 requeue", { requeueAllowed: true });
      }
      if (deliveryState === DELIVERY_STATE.NONE) {
        return _result(deliveryState, VERDICT.REQUEUE_ALLOWED, ACTION.REQUEUE,
          "中断且从未 begin; 无执行事实即无副作用", {
            requeueAllowed: true,
            autoEligible: !hasBegun,
          });
      }
      return _result(deliveryState, VERDICT.MANUAL_REVIEW, ACTION.MANUAL,
        "中断但存在投递事实; 先核对是否已送达/已执行, 防重复副作用");
    }
    if (deliveryState === DELIVERY_STATE.DEAD_LETTER || deliveryState === DELIVERY_STATE.DELIVERED) {
      return _result(deliveryState, VERDICT.FAILED, ACTION.RECORD,
        "执行失败终态; 允许显式 requeue, 禁止自动重跑", { requeueAllowed: true });
    }
    if (deliveryState === DELIVERY_STATE.UNKNOWN) {
      return _result(deliveryState, VERDICT.MANUAL_REVIEW, ACTION.MANUAL,
        "执行失败且投递结果未知; 先核对再决定是否重跑");
    }
    return _stuckOr(ticket, now, graceMs, deliveryState, VERDICT.DELIVERING_OR_STUCK,
      "执行已失败, 失败通知投递尚未收口");
  }

  if (status === TICKET_STATUS.CANCELLED) {
    if (deliveryState === DELIVERY_STATE.DEAD_LETTER || deliveryState === DELIVERY_STATE.DELIVERED) {
      return _result(deliveryState, VERDICT.CANCELLED, ACTION.NONE, "已取消, 无后续动作");
    }
    if (deliveryState === DELIVERY_STATE.ACCEPTED || deliveryState === DELIVERY_STATE.FAILED) {
      return _result(deliveryState, VERDICT.MANUAL_REVIEW, ACTION.MANUAL,
        "取消到达时投递已受理; 撤回不成立");
    }
    if (deliveryState === DELIVERY_STATE.NONE) {
      return _stuckOr(ticket, now, graceMs, deliveryState, VERDICT.DELIVERING_OR_STUCK,
        "取消后等待取消通知的死信收口");
    }
    return _result(deliveryState, VERDICT.MANUAL_REVIEW, ACTION.MANUAL, "取消后投递结果未知");
  }

  return _result(deliveryState, VERDICT.VIOLATION, ACTION.ALERT, `未知工单状态 ${status}`);
}

export function isTicketCompleted(ticket, options = {}) {
  return judgeTicket(ticket, options).verdict === VERDICT.COMPLETED;
}
