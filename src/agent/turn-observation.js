// src/agent/turn-observation.js - 单轮运行态与轮观测 (mixin, 从 bootstrap.js 拆出)
//
// 内容: 阶段 4 的单轮状态初始化 + Turn 投影/SQ/EQ 三件套的 begin/end + EQ 推送安全包装。
// 装配顺序不变: bootstrapMethods 在对象字面量里先展开本 mixin, 七段装配照旧按方法名调用。
import { TurnProjection } from "../session/projection.js";
import { OpType, EventType } from "../protocol/index.js";

export const turnObservationMethods = {
  // ---- 装配阶段 4: 单轮对话运行态 (通知/中断/工具事件) ----
  _initTurnState() {
    this._notifyCb = null;
    this._onToolEvent = null; // 工具事件回调
    this._toolCallSeq = 0; // 工具调用序号: 给 start/done 事件生成唯一 id, 供 UI 精确配对
    this._interrupted = false;
    // 2026-11-06 (评估 P1-4): 会话级中断位 —— 旧实现只有全局 _interrupted, 一个会话
    //   interrupt() 会把其它会话在途工具循环一并掐断。带 sessionKey 的中断只记这里。
    this._interruptedSessions = new Set();
    this._lastTurnUsedTools = false;
    // 本轮流式/工具运行态 (2026-10-04 Task#3 接线):
    //   _turnsUsedTools: 会话级"本轮是否用过工具"标记 (随本轮收口清除, 不留残留)
    //   _streamAborts:   会话级流式 AbortController 句柄 (interrupt 立即掐断上游请求, 用完即回收)
    this._turnsUsedTools = new Map();
    this._streamAborts = new Map();
    // 轮内中间草稿暂存桶 (sessionKey -> [{text, tools}]): 工具循环里每轮模型回包的内容先攒着,
    //   落库时交给 memory.recordTurn 写进 memory/turns 可重建上下文; 异常轮由 finally 收口清空。
    this._draftPending = new Map();
    // P2-2: 最近一次 provider 降级事实, 会话级存储 (并发会话各自的回退不串台)。
    //   chat/chatStream 收口时按本会话取用并清除; 访问器 `_lastFallback` 见 index.js。
    this._lastFallbackByKey = new Map();
    this._mcp = null; // MCP 连接句柄 (connectMcp 后赋值)
    this._proactiveTimer = null; // 主动任务生成定时器
    // 2026-10-24: SessionStart/SessionStop 钩子接线 —— 此前两个事件全仓无 emit 点。
    //   _seenSessions 记录已 emit 过 SessionStart 的会话 (每会话一次, 首次对话触发)。
    this._seenSessions = new Set();
    // 2026-10-24 (R5): 会话重定向 (rewind/resume 的落地机制) + 同会话互斥锁。
    //   _sessionRedirect: 原始 key -> 分支 key —— chat/chatStream 入口解析, 后续对话
    //   自动落到 fork 出的新分支 (append-only 日志不做物理截断, 原会话保留可审计)。
    //   _sessionLocks: 同一 sessionKey 的并发轮次串行化 (防历史交错), 跨会话仍并行。
    this._sessionRedirect = new Map();
    this._sessionLocks = new Map();
    this._turnInProgress = false; // chatStream 降级进 _chatCore 时保留回放缓存 (防双执行)
    // 2026-10-24 (R12): Turn 投影层装配 —— 每轮对话的 Session→Task→Turn 生命周期观测。
    //   config.agent.turn_projection === false 时整体旁路 (投影 + SQ op + EQ 事件一起停)。
    this.turnProjection = new TurnProjection();
    if (this.config?.agent?.turn_projection === false) this.turnProjection.enabled = false;
  },

  // ---- 2026-10-24 (R12): 轮观测 begin/end —— Turn 投影 + SQ op + EQ 事件三件套 ----
  // begin: (清扫死轮遗留 op) → 投影开 turn + SQ 提交 USER_TURN op + EQ 推 TURN_STARTED。
  // end:   消费本 op (队列不留残留) + 消费已生效的 INTERRUPT op + 投影收口 + EQ 推 TURN_CLOSED/TURN_ABORTED。
  // 全程 try 包裹, 投影层永不影响主链路 (projection.js 既有约定)。
  // 2026-10-25 (SQ 真实化): begin 前先 TTL 清扫 —— 崩溃/断连轮次遗留的 op 不再永久
  //   占住队列 (队列只增不减 = 装饰性的根因之一); end 把中断轮积累的 INTERRUPT op
  //   一并消费掉 (控制 op 生命周期 = 提交 → 中断生效 → 轮收口消费, 全程在队可观测)。
  _turnObsBegin(sessionKey, userMsg, channel) {
    if (!this.turnProjection?.enabled) return null;
    let turnId = null;
    let seq = null;
    let opId = null;
    try {
      const t = this.turnProjection.begin(sessionKey, userMsg);
      if (t) { turnId = t.turnId; seq = t.seq; }
    } catch { /* 投影异常不阻断 */ }
    try {
      const bus = this.protocolBus;
      if (bus?.sq) {
        // 死轮遗留清扫: 超过 10 分钟仍未消费的非中断 op = 崩溃轮残留, 记事件后移除
        const stale = (typeof bus.sq.sweep === "function" && bus.sq.sweep(10 * 60 * 1000)) || [];
        for (const op of stale) {
          try { this.tracer?.event?.("protocol/stale_op_swept", { id: op.id, type: op.type, ageMs: op.ageMs }); } catch {}
        }
        opId = bus.sq.submit({
          type: OpType.USER_TURN,
          payload: { sessionKey, text: String(userMsg ?? "").slice(0, 2000) },
        });
        // 2026-11-01 (二期①): 引用字段挂事件顶层 —— 订阅方可按 turnId/sessionKey 归组
        bus.eq?.push?.({ type: EventType.TURN_STARTED, payload: { sessionKey, turnId, opId, seq, channel }, turnId, sessionKey, opId });
      }
    } catch { /* 总线异常不阻断 */ }
    try { this.bus?.emit?.("chat/turn/begin", { sessionKey, turnId, opId, seq, channel }, { source: "agent.turn" }); } catch { /* 观测事件不阻断 */ }
    return { opId, turnId };
  },

  _turnObsEnd(sessionKey, obs, status = "closed") {
    if (!obs || !this.turnProjection?.enabled) return;
    try {
      const bus = this.protocolBus;
      if (obs.opId && bus?.sq) bus.sq.consume(obs.opId); // 收口: 只消费本轮自己的 op
      // 已生效的中断 op 一并收口: INTERRUPT 提交即生效 (interrupt() 内置位+掐流),
      // 轮结束后把队列里积压的中断 op 清走, 队列回到"只剩各在轮 USER_TURN op"的真态。
      // consumeType 只动 INTERRUPT —— 并发会话的 USER_TURN op 不受影响 (各轮自己收口)。
      if (bus?.sq && typeof bus.sq.consumeType === "function") {
        const consumed = bus.sq.consumeType(OpType.INTERRUPT);
        if (consumed.length) {
          try { this.tracer?.event?.("protocol/interrupt_ops_consumed", { count: consumed.length }); } catch {}
        }
      }
      if (status === "aborted") this.turnProjection.abort?.(sessionKey);
      else this.turnProjection.complete?.(sessionKey);
      bus?.eq?.push?.({
        type: status === "aborted" ? EventType.TURN_ABORTED : EventType.TURN_CLOSED,
        payload: { sessionKey, turnId: obs.turnId, status },
        turnId: obs.turnId,
        sessionKey,
        ...(status === "aborted" ? { cause: "abort" } : {}),
      });
    } catch { /* 观测收口异常不阻断 */ }
    try { this.bus?.emit?.("chat/turn/end", { sessionKey, turnId: obs.turnId, status }, { source: "agent.turn" }); } catch { /* 观测事件不阻断 */ }
  },

  // 协议总线可观测快照 (供 /health 与诊断): SQ 积压 op 数 + EQ 序号水位。
  protocolStats() {
    const bus = this.protocolBus;
    if (!bus) return { sqPending: 0, eqSeq: 0 };
    let sqPending = 0;
    let eqSeq = 0;
    try { sqPending = Number(bus.sq?.size?.()) || 0; } catch {}
    try {
      const hist = bus.eq?.history?.() || [];
      eqSeq = hist.length ? hist[hist.length - 1].seq : 0;
    } catch {}
    return { sqPending, eqSeq };
  },

  // EQ 推事件的安全包装 (2026-10-25): 事件流永不阻断主链路; WAL 落盘等异常静默。
  _eqPush(type, payload) {
    try { this.protocolBus?.eq?.push?.({ type, payload }); } catch { /* 事件流异常不阻断 */ }
  },

  // EQ 事件推送 + 顶层引用字段 (2026-11-01 二期①): turnId/sessionKey/cause 等
  // 挂到事件对象顶层 (而非埋进 payload), 订阅方按引用字段过滤/归组不必解 payload。
  _eqPushRef(type, payload, ref = {}) {
    try { this.protocolBus?.eq?.push?.({ type, payload, ...ref }); } catch { /* 事件流异常不阻断 */ }
  },

  // EQ payload 紧凑预览: 事件会进 WAL 长期落盘, 大参数/大结果必须截断 (默认 200 字符)。
  _eqPreview(v) {
    try {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return (s || "").slice(0, 200);
    } catch { return String(v).slice(0, 200); }
  },
};
