// src/flow/kernel.js - 原生入站流决策内核 (L2)
//
// 一条入站消息从"到达"到"开始执行"要经过五道判定: 准入 → 建单/去重 → 话题直通 →
// 异步/同步。这五道判定此前散落在 channels/base.handleTrigger 的 if 链里, 与传输/发送
// 逻辑混在一起 —— 想单独测试"这条消息会被怎么处理"必须伪造整条通道。
//
// 本模块把它们收敛成一个**纯决策函数** planIngress():
//   · 只读 agent 的配置与工单账本, 不发送、不执行、不持有连接;
//   · 返回一个可断言的 plan (action + ticket + 会话/回投元数据), 由通道层执行;
//   · 账本/观测失败一律降级 (ticket=null), 绝不阻断消息处理。
//
// 决策顺序 (行为与旧版逐字对齐):
//   drop      准入拒绝 / 空文本
//   replay    同一 messageId 命中已完成工单 → 重发缓存结果 (首次回复可能丢包)
//   duplicate 同一 messageId 命中在途/无结果工单 → 直接返回受理态, 不重复执行
//   thread    该会话/话题已驻派长驻 worker → 直通, 不进 Router LLM
//   async     显式异步或通道 async_reply → 先回执, 结果经 delivery 回投
//   sync      同步执行并回复
//
// 设计溯源: docs/PROVENANCE.md#superagent (仅设计思想对照, 本文件源码自研)。
import { admitThroughPolicy as defaultAdmit } from "./policy.js";
import { resolveDeliveryContract, tightenRoute } from "./delivery-contract.js";
import { TICKET_STATUS } from "../workgraph/index.js";

export const FLOW_ACTION = Object.freeze({
  DROP: "drop",
  REPLAY: "replay",
  DUPLICATE: "duplicate",
  THREAD: "thread",
  ASYNC: "async",
  SYNC: "sync",
});

function replyMeta(trigger) {
  return (trigger.thread || trigger.messageId)
    ? { thread: trigger.thread || "", replyTo: trigger.messageId || "" }
    : null;
}

/**
 * 计算一条 Trigger 的处理计划。
 *
 * @param {object}   opts
 * @param {object}   opts.agent        提供 config / work / threadRoute / emitMessageReceived
 * @param {string}   opts.channelName  当前通道名 (async_reply 按通道配置读取)
 * @param {object}   opts.trigger      归一后的 Trigger
 * @param {Function} opts.admit        准入函数 (测试可注入; 默认两级策略门)
 * @returns {Promise<object>} plan —— 至少包含 action; 放行时还带 sessionKey / replyTo / meta / ticket
 */
export async function planIngress({ agent = null, channelName = "", trigger = null, admit = defaultAdmit } = {}) {
  if (!trigger) return { action: FLOW_ACTION.DROP, reason: "empty_trigger" };

  const gate = await admit(trigger, agent);
  if (!gate?.ok) return { action: FLOW_ACTION.DROP, reason: "admission_denied", gate };
  if (!trigger.text) return { action: FLOW_ACTION.DROP, reason: "empty_text", gate };

  // rawSessionKey 保留 null (shared 映射) 供 chat 回退旧行为; sessionKey 是归组后的稳定键。
  const rawSessionKey = gate.sessionKey || null;
  const sessionKey = rawSessionKey || "default";
  const outCfg = agent?.config?.channels?.output || {};
  const replyTo = trigger.from || "*";
  const meta = replyMeta(trigger);
  const base = { gate, rawSessionKey, sessionKey, outCfg, replyTo, meta, trigger };

  // 入站事件进 EQ (观测失败不阻断)
  try { agent?.emitMessageReceived?.(trigger, sessionKey); } catch { /* 观测不阻断 */ }

  // 准入即建单; 账本失败只让 ticket 为空, 后续照常执行。
  let ticket = null;
  const work = agent?.work || null;
  if (work && typeof work.submit === "function") {
    try { ticket = work.submit(trigger, { sessionKey }); } catch { ticket = null; }
  }

  if (ticket?.deduped) {
    // 已完成: 重发缓存结果 (首次回复可能在网络上丢了, 直接丢弃会让用户永远收不到答案)。
    if (ticket.status === TICKET_STATUS.DONE && ticket.result) {
      return { ...base, action: FLOW_ACTION.REPLAY, ticket, cachedResult: ticket.result };
    }
    return { ...base, action: FLOW_ACTION.DUPLICATE, ticket };
  }

  // 长驻 worker 直通: 同会话/话题的后续事件不再进 Router LLM。
  const entry = agent?.threadRoute?.(sessionKey, trigger.thread || "");
  if (entry) {
    const delivery = resolveDeliveryContract({
      route: FLOW_ACTION.THREAD, origin: ticket?.origin, trigger, agent, channelName,
      ticket, replyTo, meta, entry,
    });
    return {
      ...base,
      action: FLOW_ACTION.THREAD,
      ticket,
      entry,
      delivery,
      threadPayload: {
        source: trigger.source || channelName,
        from: trigger.from || "*",
        group: trigger.group || "",
        thread: trigger.thread || "",
        messageId: trigger.messageId || "",
        text: trigger.text,
        sessionKey,
      },
    };
  }

  const asyncMode = trigger.meta?.async === true
    || agent?.config?.channels?.[channelName]?.async_reply === true;
  // 显式 delivery 只能收紧 (sync → async); 业务路由本身仍是 flow 的决定。
  const route = tightenRoute(asyncMode ? FLOW_ACTION.ASYNC : FLOW_ACTION.SYNC, trigger.delivery);
  const delivery = resolveDeliveryContract({
    route, origin: ticket?.origin, trigger, agent, channelName, ticket, replyTo, meta,
  });
  return { ...base, action: route === FLOW_ACTION.ASYNC ? FLOW_ACTION.ASYNC : FLOW_ACTION.SYNC, ticket, delivery };
}
