// src/workgraph/judge.js - DSH 完成判定 (deliveryState × ticket.status 纯函数)
//
// 契约: docs/dsh-absorb/02-STATE-MATRIX.md §4。唯一收单条件是
// ticket.status=done 且 deliveryState=delivered; 其它组合只给动作, 不推进状态。
// 本模块不写账本、不发事件、不重试 —— 判定与执行严格分离。
//
// 2026-11-15 证据链维度 (verified-by-evidence): delivered 是调度语义的诚实, correct 是
// 认知语义的诚实 —— 两者之间补一层"完成是否被验证证据背书"。默认只观测 (结果附
// verifiedBy 字段, 判定行为逐字节不变); requireEvidence=true (配置显式开启) 时完成判定
// 升级为 done ∧ delivered ∧ verified, 缺证据降级 MANUAL_REVIEW 交人工, 绝不静默放行。

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
 * @param {object} [options.verified]      验证证据快照 {ref, kind, ts} (2026-11-15; 缺省读不到即 null)
 * @param {boolean}[options.requireEvidence] true 时完成判定升级为 done ∧ delivered ∧ verified (默认 false)
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
      // 改道未执行 (2026-11-16, gate.js 规则三): done ∧ delivered 成立, 但工单标记了
      //   rerouted —— 实际没有执行任务, 只向来源方提了澄清问题。判 COMPLETED 会让
      //   "没干活"混进完成率, 与"改道"语义直接冲突, 所以在这里先分流。降级 MANUAL_REVIEW
      //   而不是 FAILED: 任务本身没失败, 它还在等来源方补信息。可逆 (补信息后重新派单)。
      if (ticket.rerouted) {
        return _result(deliveryState, VERDICT.MANUAL_REVIEW, ACTION.MANUAL,
          `低置信改道为 ${ticket.rerouted}, 任务未执行 (需来源方补充信息后重新派单)`,
          { rerouted: String(ticket.rerouted), ...(ticket.lowConfidence ? { lowConfidence: true } : {}) });
      }
      // 证据链维度 (2026-11-15): verified = {ref, kind, ts} | null, 由调用方从工单
      // verification 快照或证据库传入。默认 (requireEvidence 缺省) 纯观测:
      // 判定结果不变, 只多一个 verifiedBy 字段 —— 审计面从此能区分"送达且验证过"与"仅送达"。
      const verifiedBy = options.verified?.ref ? String(options.verified.ref) : null;
      if (options.requireEvidence === true && !verifiedBy) {
        return _result(deliveryState, VERDICT.MANUAL_REVIEW, ACTION.MANUAL,
          "done ∧ delivered 但缺验证证据 (require_evidence 开启, 不静默放行)");
      }
      // 低置信消费规则 (2026-11-15, gate.js 的下游): 元认知门控在执行前打了低置信,
      //   完成判定把它透传为复核信号 —— 只附字段不改判定 (是否人工复核由消费方决定),
      //   信号来源优先级: 显式 options > 工单快照 (complete 时随 payload 落账)。
      const lowConfidence = (options.lowConfidence === true || ticket.lowConfidence === true)
        ? true : undefined;
      return _result(deliveryState, VERDICT.COMPLETED, ACTION.COLLECT,
        verifiedBy ? "执行成功且结果已送达 (含验证证据)" : "执行成功且结果已送达",
        {
          verifiedBy,
          ...(lowConfidence ? { lowConfidence } : {}),
        });
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
