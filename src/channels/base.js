// src/channels/base.js - 通道基类
// 统一通道接口: 每个通道实现 connect/send/disconnect
// 可选能力: test() 连通性探测 (配置是否可用), mount(server) 把 webhook 路由挂到 HTTP server
import { readBody, sendJson } from "../utils/http.js";
import { createTrigger } from "../flow/trigger.js";
import { planIngress, FLOW_ACTION } from "../flow/kernel.js";
import { enrichWithTaskBrief } from "../flow/extract.js";
import { shapeForChannel } from "./output.js";
import { createDeliveryReceipts, DEFAULT_SYNC_DEADLINE_MS } from "./receipts.js";
import { effectiveSyncDeadlineMs } from "../flow/delivery-contract.js";
import { DELIVERY_STATE } from "../workgraph/state.js";

export class Channel {
  constructor(name, agent) {
    this.name = name;
    this.agent = agent;
    this.connected = false;
  }

  async connect() { throw new Error(`${this.name}: connect() 未实现`); }
  // meta (2026-11-01 二期⑥): 回投元数据 { thread, replyTo } —— 通道可用它把回复
  // 送回原话题/原消息下 (飞书 reply 接口); 不支持 meta 的通道忽略第三参, 行为不变。
  async send(to, text, /* meta */ _meta = null) { throw new Error(`${this.name}: send() 未实现`); }
  async disconnect() { this.connected = false; }

  // 连通性测试: 默认尝试 connect (验证配置能建立连接), 返回 { ok, detail }
  // 需要网络探测的通道可覆盖为更细的校验 (如验证 token)
  async test() {
    try {
      await this.connect();
      return { ok: true, detail: `${this.name} 配置有效` };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  }

  // 把 webhook 路由挂到 HTTP server (若通道是 webhook 型); 默认不挂载
  mount(/* httpServer */) { return null; }

  // ---- webhook 型通道的公共辅助 (2026-09-18 重构: feishu/wechat 原各抄一份) ----

  // 路由注册器: 优先注册到主 HTTP 通道的统一路由表 (单一 request handler 分发, 无多 listener 竞态);
  // 未提供主通道时退化为挂到 server 的 request 事件 (仅路径匹配, 调用方自行防双响应)
  _registrar(server, httpChannel) {
    if (httpChannel && typeof httpChannel.registerWebhook === "function") {
      return (path, fn) => httpChannel.registerWebhook(path, fn);
    }
    return (path, fn) => { if (server && typeof server.on === "function") server.on("request", fn); };
  }

  // 读满请求体 (webhook 回调用, 无大小限制 —— 各通道自行校验内容)
  _readBody(req) {
    return readBody(req);
  }

  // 统一的 JSON 响应
  _sendJson(res, code, obj) {
    sendJson(res, code, obj);
  }

  // 回执产出器 (Step 3): 与 delivery 队列共用同一份 delivery_* 字段实现。
  // 未装配 EQ (测试桩) 时 emit 为空操作, 投递照常。
  _receipts() {
    if (!this.__receipts) {
      this.__receipts = createDeliveryReceipts({
        emit: (type, payload, ref) => {
          try { this.agent?._eqPushRef?.(type, payload, { cause: payload.origin || "ingress", ...ref }); } catch { /* 观测不阻断 */ }
          if (type === "delivery_accepted") {
            try { this.agent?.work?.markDeliveryStarted?.(payload.assignmentId); } catch { /* 观测不阻断 */ }
          } else if (type === "delivery_delivered" || type === "delivery_dead_letter") {
            // 终态快照: judge 优先读它, 免去回放 EQ WAL (I4 修订)。
            try {
              this.agent?.work?.markDeliveryState?.({
                ticketId: payload.ticketId,
                assignmentId: payload.assignmentId,
                state: type === "delivery_delivered" ? DELIVERY_STATE.DELIVERED : DELIVERY_STATE.DEAD_LETTER,
                attempt: payload.attempt,
                receiptId: payload.receiptId,
                reason: payload.reason || null,
                at: payload.deliveredAt || payload.deadAt || null,
              });
            } catch { /* 观测不阻断 */ }
          }
        },
      });
    }
    return this.__receipts;
  }

  _syncDeadlineMs(contract = null) {
    // Step 4: 契约优先 —— sync 截止 = min(policy.deadline_ms, 剩余 execution 预算)。
    // 无契约 (旧调用/测试桩) 时回退通道配置, 行为与 Step 3 逐字一致。
    const fromContract = effectiveSyncDeadlineMs(contract);
    if (fromContract != null) return fromContract;
    const v = Number(this.agent?.channelManager?.deliveryConfig?.syncDeadlineMs);
    return v > 0 ? v : DEFAULT_SYNC_DEADLINE_MS;
  }

  // 收到 Trigger → 原生入站流内核给计划 → 通道只负责执行与发送。
  //   planIngress 统一处理两级过滤/会话键/建单去重/话题直通/异步/同步六种决策;
  //   本方法不再用 if 链重述这些语义, 也不再直接读取 policy/ticket 内部字段。
  //   回复携带 trigger 元数据 (thread/messageId), 飞书可走 reply 接口回到原话题。
  async handleTrigger(trigger) {
    const plan = await planIngress({ agent: this.agent, channelName: this.name, trigger });
    if (plan.action === FLOW_ACTION.DROP) return null;

    const { ticket, sessionKey, rawSessionKey, replyTo, meta, outCfg } = plan;
    const work = this.agent?.work || null;
    const workBegin = (worker, extra = {}) => {
      try { return ticket && work ? work.begin(ticket.id, { worker, sessionKey, ...extra }) : null; } catch { return null; }
    };
    const workDone = (payload) => { try { if (ticket) work.complete(ticket.id, payload); } catch { /* 账本不阻断回复 */ } };
    const workFail = (e) => { try { if (ticket) work.fail(ticket.id, e); } catch { /* 账本不阻断回复 */ } };
    const msgMeta = (extra = {}) => ({
      ...meta,
      ticketId: ticket?.id || null,
      sessionKey: rawSessionKey || null,
      origin: ticket?.origin || "ingress",
      ...extra,
    });

    // webhook 重试命中已完成工单 → 重发缓存结果 (首次回复可能丢包)
    // 不产 delivery_*: 这是对同一 assignment 的补偿重发, 新终态会破坏"每 assignment 恰好一个终态"。
    if (plan.action === FLOW_ACTION.REPLAY) {
      await this.send(replyTo, shapeForChannel(this.name, plan.cachedResult, outCfg), meta);
      return plan.cachedResult;
    }
    if (plan.action === FLOW_ACTION.DUPLICATE) {
      return { deduped: true, ticketId: ticket.id, status: ticket.status };
    }

    // 需求提炼 (2026-11-07, Super-agent §3.1): 准入回答"要不要处理", 提炼回答"要处理
    //   的是什么" —— 程序层零成本启发 + 可选 LLM 语义层 (fail-open), 命中任务以
    //   [需求提炼] 前缀注入 ASYNC/SYNC 路径的消息。默认关闭 = 字节不变。
    //   THREAD 直通不带前缀 (worker 已驻派, 直通契约不变); 提炼失败绝不阻断消息。
    let taskText = trigger.text;
    try {
      const ex = await enrichWithTaskBrief(trigger, this.agent, plan.sessionKey);
      if (ex?.prefix) taskText = `${ex.prefix}\n\n${trigger.text}`;
    } catch { /* 提炼是增强, 不是闸门 */ }

    // 长驻 worker 直通: 同话题后续事件不进 Router LLM
    if (plan.action === FLOW_ACTION.THREAD) {
      const assignment = workBegin(`thread:${plan.entry.name}`, {
        route: "thread",
        delivery: plan.delivery || null,
      });
      // worker 信封必须带回 ticketId/assignmentId (父进程据此产 assignment/delivery 事件);
      // worker 本身不产投递事件 (I11)。
      const payload = {
        ...plan.threadPayload,
        ticketId: ticket?.id || null,
        assignmentId: assignment?.id || null,
        origin: ticket?.origin || "ingress",
      };
      let ended = false;
      try {
        const r = await this.agent.threadForward(payload, {
          // 契约显式给 0 = 沿用桥默认 (兼容旧行为); >0 才覆盖。
          timeoutMs: Number(plan.delivery?.policy?.forward_timeout_ms) > 0
            ? Number(plan.delivery.policy.forward_timeout_ms) : undefined,
          onProgress: (ev) => {
            try { this.agent._workProgressTick?.(rawSessionKey, ev); } catch { /* 观测不阻断 */ }
          },
          // 先收口执行, 再回投结果 —— 保证事件顺序 assignment_ended → delivery_accepted (§4.1)。
          onExecuted: (reply, envelope) => {
            ended = true;
            workDone({ result: reply || "", envelope });
          },
        });
        if (r.forwarded) {
          if (!ended) workDone({ result: r.reply || "", envelope: r.envelope || null });
        } else {
          workFail(new Error(r.reason || "forward_failed"));
        }
        return { delegated: r.forwarded, worker: plan.entry.name, reason: r.reason || null };
      } catch (e) {
        workFail(e);
        throw e;
      }
    }

    // 异步受理: 不阻塞 webhook, 结果经 delivery 回投原话题
    if (plan.action === FLOW_ACTION.ASYNC) {
      const assignment = workBegin("router:async", {
        route: "async",
        delivery: plan.delivery || null,
      });
      // Step 4: 队列按契约 policy 重试/TTL, 不再全部套用通道级常量。
      const policy = plan.delivery?.policy?.kind === "async" ? plan.delivery.policy : null;
      let started = null;
      try {
        started = this.agent.chatAsync(taskText, {
          sessionKey: rawSessionKey || undefined,
          onDone: (reply) => {
            workDone({ result: reply, bgTaskId: started?.id });
            this._deliverAsync(replyTo, shapeForChannel(this.name, reply, outCfg), msgMeta({
              bgTaskId: started?.id, assignmentId: assignment?.id || null, kind: "done",
            }), policy);
          },
          onError: (e) => {
            workFail(e);
            this._deliverAsync(replyTo, `[后台任务失败] ${e?.message || e}`, msgMeta({
              bgTaskId: started?.id, assignmentId: assignment?.id || null, kind: "error",
            }), policy);
          },
        });
      } catch (e) {
        workFail(e);
        throw e;
      }
      const ack = `[已受理] 后台任务 ${started.id} 处理中, 完成后回投${meta?.thread ? "本话题" : "本会话"}。`;
      // [已受理] 是受理回执, 不是投递结果 —— 不写 delivery_delivered (§5.2)。
      await this.send(replyTo, ack, meta);
      return { accepted: true, taskId: started.id, ticketId: ticket?.id || null };
    }

    // 同步主路径
    const assignment = workBegin("router", {
      route: "sync",
      delivery: plan.delivery || null,
    });
    try {
      const reply = await this.agent.chat(taskText, rawSessionKey ? { sessionKey: rawSessionKey } : undefined);
      workDone({ result: reply });
      const shaped = shapeForChannel(this.name, reply, outCfg);
      await this._receipts().sendSync({
        send: (to, text, m) => this.send(to, text, m),
        ticketId: ticket?.id || null,
        assignmentId: assignment?.id || null,
        channel: this.name,
        to: replyTo,
        text: shaped,
        meta,
        sessionKey: rawSessionKey || null,
        deadlineMs: this._syncDeadlineMs(plan.delivery),
      });
      return reply;
    } catch (e) {
      workFail(e);
      throw e;
    }
  }

  // 异步结果回投 (二期④): 优先走本通道的 delivery 队列 (失败重试 + WAL 续投, 重启不丢);
  // 队列未装配 (测试桩/delivery 关闭) 时直发。只回投到"受理消息的来源通道", 不全通道广播。
  async _deliverAsync(to, text, meta, policy = null) {
    const mgr = this.agent?.channelManager;
    if (mgr?.delivery && typeof mgr.delivery.enqueue === "function") {
      // Step 4: 契约 policy 随 job 落 WAL —— 重启续投仍按同一重试/TTL 预算。
      mgr.delivery.enqueue({ channel: this.name, to, text, meta, policy });
      return { queued: true };
    }
    // 直发兜底仍按同一份回执语义 (有 ticketId/assignmentId 时), 不让"没队列"变成观测黑洞。
    if (meta?.ticketId && meta?.assignmentId) {
      return this._receipts().sendSync({
        send: (t, x, m) => this.send(t, x, m),
        ticketId: meta.ticketId,
        assignmentId: meta.assignmentId,
        channel: this.name,
        to,
        text,
        meta,
        sessionKey: meta.sessionKey || null,
        deadlineMs: this._syncDeadlineMs(),
      });
    }
    return this.send(to, text, meta);
  }

  // 兼容壳: 老签名 (from, text) 包成最小 Trigger 走 Trigger 主路径
  async handleMessage(from, text) {
    return this.handleTrigger(createTrigger({ source: this.name, from, text }));
  }
}