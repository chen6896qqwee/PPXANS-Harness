// src/agent/lane-merger.js - 同会话并发面 (2026-11-14 自 index.js 拆出, 战役遗留项 #6)
//
// 关注点: "同一会话的多个输入怎么收敛成轮" ——
//   · chat 路由入口: 合并车道 vs (斜杠命令/resumeCtx/批处理关闭) 直进会话锁;
//   · Router 批处理车道: _enqueueMergeableTurn / _runMergedLane (dsh inbox claim 语义);
//   · 中断位与流式掐断: interrupt / _isInterrupted / clearInterrupt;
//   · 降级重放缓存按会话分桶: _turnExecCacheFor。
// 命名注意: 与 src/channels/ans-lane.js (ANS 出站车道) 无关, 那是另一条车道。
//
// 状态归属 (初始化仍按惯例留在 turn-observation.js _initTurnState; 懒建字段就地自建):
//   · _mergeLanes / _turnExecCaches —— 本文件懒建;
//   · _sessionLocks (_withSessionLock 消费, 见 work-thread.js) / _sessionRedirect /
//     _interrupted / _interruptedSessions / _streamAborts —— _initTurnState 建。
//
// 方法名与 this._chatCore / this.chat 调用点保持原样 —— 既有测试对 agent._chatCore /
//   agent.chat 做实例猴补丁, this. 动态派发使拆分对调用方与测试透明。
import { noteCatch } from "../utils/catch-log.js";
import { currentTrace } from "../core/trace.js";
import { OpType, EventType } from "../protocol/index.js";

// v5.0 合并批逐条回信 (P2.1c): 按 [[回复 #n]] 标记把整批回复拆成逐条分段。
//   纯函数 (直测友好); 缺标记返回 null (调用方回退"整批共享同一回复"旧语义),
//   缺某段编号该位置为 null (该条同样回退整批)。
// 2026-11-14: 实现自 index.js 迁入 (合并车道同属本文件), index.js re-export 保持导入点不变。
export function splitSegmentedReply(reply, count) {
  const text = String(reply == null ? "" : reply);
  const n = Math.max(1, Number(count) || 1);
  if (!text || n <= 1) return null;
  const marks = [...text.matchAll(/\[\[回复\s*#\s*(\d+)\]\]/g)];
  if (!marks.length) return null;
  const segs = new Array(n).fill(null);
  for (let i = 0; i < marks.length; i++) {
    const idx = parseInt(marks[i][1], 10) - 1;
    if (!(idx >= 0 && idx < n)) continue;
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const seg = text.slice(start, end).trim();
    if (seg) segs[idx] = seg;
  }
  return segs;
}

export const laneMergerMethods = {
  // 对话主入口 (含工具调用循环)
  // 2026-10-24 (R5): 同会话互斥 —— 同一 sessionKey 的并发轮次串行化 (防历史交错/记忆双写),
  //   不同会话仍完全并行。锁不跨进程 (多进程共享 dataDir 的隔离靠独立 dataDir, 军团语义)。
  async chat(userMsg, opts = {}) {
    const sk = opts.sessionKey || "default";
    // 2026-11-01 (v4.1 平台化 Router 批处理): 同会话忙时新到的普通文本输入
    //   不再各开一轮串行推理, 而是收口时整批 claim 合并成一轮 (dsh inbox claim 语义)。
    //   斜杠命令要求逐条原样执行, 不参与合并; agent.router_batching=false 旁路 (默认开)。
    if (this.config?.agent?.router_batching !== false
        && !opts.resumeCtx
        && !String(userMsg ?? "").trimStart().startsWith("/")) {
      return this._enqueueMergeableTurn(sk, userMsg, opts);
    }
    return this._withSessionLock(sk, () => this._chatCore(userMsg, opts));
  },

  // ---- Router 批处理 (2026-11-01 二期②): 同会话积压输入合并轮 ----  // 机制 (对齐设计溯源 docs/PROVENANCE.md#dsh agent-loop inbox.ts): 每会话一条"合并车道"(merge lane);
  //   车道拿到会话锁开始执行的那一刻 claim 当前批次全部文本 (≤ router_batch_max,
  //   默认 8, 超出的留给下一批), 合并成一条注入 _chatCore, 一次推理回答全部;
  //   执行期间新到的输入进下一批 (车道内循环 claim, 语义 = dsh 收口时 inbox 非空则续跑)。
  //   被合并的调用与队头共享同一回复 (merge 语义: 一批一条回答, 不逐条伪造回复)。
  //   效果 (SUPERAGENT-GAP §2.1): 拥堵时 N 条追打从 N 轮串行推理 → 1 轮合并推理。
  _enqueueMergeableTurn(sk, userMsg, opts) {
    this._mergeLanes = this._mergeLanes || new Map();
    let lane = this._mergeLanes.get(sk);
    if (!lane || lane.started) {
      lane = { texts: [], opts: null, started: false };
      this._mergeLanes.set(sk, lane);
      lane.promise = this._withSessionLock(sk, () => this._runMergedLane(sk, lane))
        .catch(() => {}) // 车道自身失败不进锁链 (批次 reject 已传给各调用方)
        .finally(() => { if (this._mergeLanes.get(sk) === lane) this._mergeLanes.delete(sk); });
    }
    if (!lane.opts) lane.opts = opts || {}; // 队头 opts 为准 (sessionKey 同为 sk, 其余差异按队头)
    return new Promise((resolve, reject) => {
      lane.texts.push({ text: String(userMsg ?? ""), resolve, reject });
    });
  },

  async _runMergedLane(sk, lane) {
    lane.started = true;
    const cap = Math.max(1, Number(this.config?.agent?.router_batch_max) || 8);
    for (;;) {
      // claim: 取走当前批 (≤cap); 执行期间新到的留在 lane.texts, 本轮完成后继续下一批
      const items = lane.texts.splice(0, cap);
      if (!items.length) break;
      // v5.0 逐条回信 (P2.1c): 合并批不再共享同一回复 —— 注入语要求模型按
      //   [[回复 #n]] 标记分段作答, 收口按标记拆分后各回各的 (IM 各回各的发送者)。
      //   模型没按协议分段 (缺标记/缺段) 时, 该条回退整批回复 —— 行为兜底等于旧语义。
      const multi = items.length > 1;
      const merged = !multi
        ? items[0].text
        : `[用户在本轮执行期间陆续发送了 ${items.length} 条消息, 已合并为一批处理, 逐条如下]\n`
          + items.map((it, i) => `[${i + 1}] ${it.text}`).join("\n")
          + `\n\n[回答要求] 逐条单独回应上面的每条消息: 按顺序用 [[回复 #编号]] (编号替换为对应消息的序号, 如 1、2、3) 标记分段, 每段只回应同编号的那条消息; 不要写成一篇合并的回复。`;
      try {
        this.tracer?.event?.("router/batch_merge", { sessionKey: sk, count: items.length, segmented: multi });
        const reply = await this._chatCore(merged, { ...(lane.opts || {}), sessionKey: sk });
        const segs = multi ? splitSegmentedReply(reply, items.length) : null;
        for (let i = 0; i < items.length; i++) {
          const own = segs && typeof segs[i] === "string" && segs[i].length ? segs[i] : reply;
          items[i].resolve(own);
        }
      } catch (e) {
        for (const it of items) it.reject(e);
      }
    }
  },

  // 中断: 置位中断标记 + 立即掐断在途流式请求 (否则上游继续吐字, 用户白等/白计费)。
  //   无参 = 掐断全部会话在途流; 带 sessionKey = 只掐断该会话 (多路复用 Web 端用)。
  // 2026-10-25 (SQ 真实化): 中断作为控制 op 走 SQ 队列 —— 此前 SQ 只有 USER_TURN
  //   提交-同轮消费一种形状 (装饰性队列)。现在 INTERRUPT op 入队 + EQ 推事件,
  //   由轮收口 (_turnObsEnd) 统一消费, 控制指令与用户回合共用同一条 FIFO 总线。
  interrupt(sessionKey) {
    // 2026-11-06 (评估 P1-4): 中断位按会话隔离 —— 带 sessionKey 只置该会话位,
    //   不再置全局位 (旧实现一个会话中断会掐断其它会话在途的工具循环)。
    //   无参 = 全局中断, 语义不变 (掐断全部)。
    if (sessionKey) this._interruptedSessions?.add(String(sessionKey));
    else this._interrupted = true;
    try {
      const bus = this.protocolBus;
      if (bus?.sq) {
        bus.sq.submit({ type: OpType.INTERRUPT, payload: { sessionKey: sessionKey || null } });
        bus.eq?.push?.({ type: EventType.TURN_ABORTED, payload: { sessionKey: sessionKey || null, cause: "interrupt" } });
      }
    } catch (e) { noteCatch(e); /* 队列不可用不影响既有中断语义 */ }
    // 等待回答的提问先收口: 否则工具 Promise 要挂到超时, 回合停不下来 (BOT: 提问随回合结束)。
    this.cancelQuestions(sessionKey, "interrupted");
    if (!this._streamAborts) return;
    if (sessionKey) {
      const ac = this._streamAborts.get(sessionKey);
      if (ac) { try { ac.abort(); } catch (e) { noteCatch(e); } }
      return;
    }
    for (const ac of this._streamAborts.values()) { try { ac.abort(); } catch (e) { noteCatch(e); } }
  },

  // 2026-11-06 (评估 P1-4): 中断查询统一入口 (工具循环 isInterrupted / abort 判定都走这里):
  //   全局位 OR 本会话位。sessionKey 缺省时从当前 trace 上下文取。
  _isInterrupted(sessionKey) {
    if (this._interrupted) return true;
    const sk = String(sessionKey || currentTrace()?.sessionKey || this._activeSessionKey || "");
    return !!(sk && this._interruptedSessions?.has(sk));
  },

  clearInterrupt(sessionKey) {
    // 2026-11-06 (评估 P1-4): 轮入口按会话复位本会话位; 全局位保留旧语义
    //   (新一轮开始 = 上一轮的全局中断作废), 与旧行为逐字节兼容。
    if (sessionKey) this._interruptedSessions?.delete(String(sessionKey));
    this._interrupted = false;
  },

  // 2026-11-06 (评估 P1-4): 降级重放缓存按会话隔离 —— 旧实现单 Map 挂 this, 两个会话
  //   并发开轮时互相覆盖, B 会话可能复用 A 会话的非幂等工具结果 (跨会话误复用)。
  //   现按 sessionKey 分桶; 轮入口删桶 (见 _chatCore), 上限 128 防未收口会话堆积。
  _turnExecCacheFor(sessionKey) {
    const key = String(sessionKey || currentTrace()?.sessionKey || this._activeSessionKey || "default");
    if (!this._turnExecCaches) this._turnExecCaches = new Map();
    let m = this._turnExecCaches.get(key);
    if (!m) {
      if (this._turnExecCaches.size >= 128) {
        const oldest = this._turnExecCaches.keys().next().value;
        if (oldest != null) this._turnExecCaches.delete(oldest);
      }
      m = new Map();
      this._turnExecCaches.set(key, m);
    }
    return m;
  },
};
