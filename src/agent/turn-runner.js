// src/agent/turn-runner.js - 单轮执行面 (2026-11-14 自 index.js 拆出, 战役遗留项 #6)
//
// 关注点: "一轮怎么跑完" ——
//   · _chatCore 主链: 重定向 → 续跑上下文 → 轮归属 → 轮观测 → trace → 中断复位 →
//     回放缓存重置 → 预算闸门 → 钩子 → plan/斜杠命令 → 分层漏斗 → 模式分发 →
//     自检 → 落库 → 生命周期/投机复现 → 降级提示 → PII 掩码;
//   · chatAsync: 后台任务入口 (_bgTasks 注册 + TASK_* EQ 事件 + onDone/onError)。
//
// 状态归属: _turnInProgress / _seenSessions / _turnsUsedTools / _lastTurnUsedTools /
//   _draftPending (_initTurnState 建, 见 turn-observation.js); _bgTasks / _bgSeq 懒建;
//   _turnExecCaches 分桶与轮内重置消费 lane-merger.js 的 _turnExecCacheFor 口径。
// 方法名与调用点保持原样 —— 既有测试对 agent._chatCore 做实例猴补丁, this. 动态派发透明。
import { noteCatch } from "../utils/catch-log.js";
import { warn, error } from "../utils/logger.js";
import { EventType } from "../protocol/index.js";
import { runWithTrace, patchTrace } from "../core/trace.js";
import { LLM_FAILED_HINT } from "./loop/policy.js";
import { selfCheckReply, sanitizeReply } from "../core/selfcheck.js";

export const turnRunnerMethods = {
  // ---- 异步 ReAct (2026-11-01 二期④): 后台任务 start/stop + 结果回投 ----
  // chatAsync: 立即返回 {id, sessionKey} 不阻塞调用方 (IM 受理后先回执, Web 异步长任务);
  //   chat 在后台照常走同会话互斥/合并车道/工具循环, 完成/失败/取消经 EQ TASK_* 事件
  //   (此前 TASK_STARTED/COMPLETE/ABORTED 三种事件类型全仓零生产者) + onDone/onError 回调
  //   通知消费方 (channels 异步受理分支据此经 delivery 队列回投原话题)。
  // 取消: bgCancel(id) → interrupt(sessionKey) (流式通道按会话精确掐断; 非流式 chat 的
  //   _interrupted 是全局位 —— 取消会中断"当前正在跑的那一轮", 若后台任务正排队等锁,
  //   其后开跑的首轮会被误中断, 这是 v1 已知边界, 诚实记录不掩盖)。
  chatAsync(userMsg, opts = {}) {
    const sk = opts.sessionKey || "default";
    this._bgTasks = this._bgTasks || new Map();
    this._bgSeq = (this._bgSeq || 0) + 1;
    const id = `bg_${Date.now().toString(36)}_${this._bgSeq.toString(36)}`;
    const entry = {
      id, sessionKey: sk, status: "running",
      text: String(userMsg ?? "").slice(0, 500),
      startedAt: Date.now(), endedAt: null, replyPreview: null, error: null,
    };
    this._bgTasks.set(id, entry);
    this._bgTrim();
    this._eqPushRef?.(EventType.TASK_STARTED, { taskId: id, sessionKey: sk, textPreview: entry.text.slice(0, 200) }, { sessionKey: sk, ref: id });
    // 后台执行: 走 chat() —— 同会话追打自动合并 (Router 批处理语义对后台任务同样生效)
    // EQ/回调与评测账本共享同一个后台 taskId, 不再各建一套任务身份。
    const p = this.chat(userMsg, { ...opts, sessionKey: sk, taskId: opts.taskId || id });
    entry.promise = p.then(
      (reply) => {
        if (entry.status !== "running") return reply; // 已被 bgCancel 标记, 不覆盖终态
        entry.status = "done";
        entry.endedAt = Date.now();
        entry.replyPreview = String(reply || "").slice(0, 300);
        this._eqPushRef?.(EventType.TASK_COMPLETE, { taskId: id, sessionKey: sk, status: "done", ms: entry.endedAt - entry.startedAt }, { sessionKey: sk, ref: id });
        try { if (typeof opts.onDone === "function") opts.onDone(reply, entry); } catch (e) { noteCatch(e); /* 回调异常不阻断 */ }
        return reply;
      },
      (e) => {
        if (entry.status !== "running") return null;
        entry.status = "error";
        entry.endedAt = Date.now();
        entry.error = String(e?.message || e).slice(0, 300);
        this._eqPushRef?.(EventType.TASK_ABORTED, { taskId: id, sessionKey: sk, status: "error", error: entry.error }, { sessionKey: sk, ref: id });
        try { if (typeof opts.onError === "function") opts.onError(e, entry); } catch (e) { noteCatch(e); /* 回调异常不阻断 */ }
        return null; // 吞掉拒绝: 后台任务的失败已落账 + 回调, 不做浮动 rejection
      }
    );
    return { id, sessionKey: sk };
  },

  async _chatCore(userMsg, {
    persist = true, sessionKey = "default", mode = null, turnObs = null, funnelResumed = false,
    fileRefs = "", resumeCtx = null, taskId = null, traceId = null, strata = null,
    evalSampleRate = null, taskOk = null,
  } = {}) {
    // 2026-10-24 (R9 审计): 重定向必须在 runWithTrace **之前**解析 —— trace 上下文的
    //   options 在调用时求值, 此前回调里的重赋值不会传进去, 导致 _admitToolCall 的
    //   计划态检查 / _turnsUsedTools / _recordDraft 全部读重定向前的旧会话 key
    //   (回卷/恢复后 /plan 形同虚设)。解析后传入, trace 携带真实会话。
    sessionKey = this._redirectSession(sessionKey);
    // Step 7: 续跑上下文挂在重定向后的会话键上 (wire 拼装按它读)。
    if (resumeCtx) this._armResumeCtx?.(sessionKey, resumeCtx);
    // 轮归属: Router 角色下先记为 inline, 委派工具命中后改写为 worker/thread。
    this._markTurnRoute?.(sessionKey, "inline");
    // 2026-10-24 (R12): 轮观测 begin —— Turn 投影开 turn + SQ 提交 USER_TURN op +
    //   EQ 推 TURN_STARTED。chatStream 降级进本函数时传入已有 obs (不重复开, 收口归它)。
    //   begin 放在所有早退 (预算/命令/计划) 之前: 控制面操作同样是用户轮, 不留悬空 turn。
    const ownObs = !turnObs;
    const obs = turnObs || this._turnObsBegin(sessionKey, userMsg, "chat");
    if (typeof taskOk === "boolean") obs.taskOk = taskOk;
    let _turnStatus = "closed";
    try {
    // 重构第三刀: 入口生成 traceId, 记忆/工具/学习子调用自动继承 (AsyncLocalStorage)
    return await runWithTrace(async () => {
    // 架构优化 ②(2026-11-13): 把会话/通道/run 类型补进 trace 上下文 —— 审计、工单、
    //   委派 worker 全部按这一条 runId 归组, 不再靠时间戳猜关联。
    patchTrace({ sessionKey, runKind: "turn", channel: "chat" });
    this._captureEvalTurn(obs);
    this.clearInterrupt(sessionKey); // 新一轮对话开始, 复位本会话中断位 (P1-4: 不殃及其它会话)
    // 2026-10-24 (R2): 回退重放缓存按轮重置 (防双执行, 见 _runTool)。
    //   (R5) 流式降级进本函数时 _turnInProgress 为真 —— 缓存保留, 非幂等工具不双执行。
    if (!this._turnInProgress) {
      this._turnAttempt = 0;
      // 2026-11-06 (评估 P1-4): 回放缓存按会话分桶 (_turnExecCacheFor), 本轮重置本会话桶
      this._turnExecCache = null; // 旧单例字段清空 (防旧引用复活)
      this._turnExecCaches?.delete(sessionKey || "default");
      // 2026-11-01 (三期投机复现): 本轮工具失败清单 (轮收口静默复现用)
      // 2026-11-12: 按会话清 —— 实例单值会被并发会话互相清空/串轮。
      this._clearTurnFailures(sessionKey);
    }
    // 2026-10-10 修复 (P0-1 孪生): _budgetBlocked() 此前定义了却无任何调用方 —— 预算闸门
    //   即使置位也拦不住下一次 chat。闸门必须在"入口"处消费, 在花任何 token 之前。
    const blocked = this._budgetBlocked();
    if (blocked) { obs.taskOk = false; return blocked; }
    this.bus?.emit("chat/user", { userMsg, sessionKey }, { source: "agent.chat" });
    // 2026-10-24: SessionStart 钩子 (每会话一次): 会话恢复/新会话首次对话时触发,
    //   供外部钩子做会话级预热 (加载项目上下文/欢迎注入)。emit 异常不阻断主链。
    {
      const sk = sessionKey || "default";
      if (!this._seenSessions.has(sk)) {
        this._seenSessions.add(sk);
        try { this.hooks?.emit?.("SessionStart", { sessionKey: sk, source: "chat" })?.catch?.(() => {}); } catch (e) { noteCatch(e); /* 不阻断 */ }
      }
    }
    this._lastFallback = null; // P2-2: 只关心"本轮"是否降级, 先清上次残留
    // plan 模式命令入口: /plan /do 命中即翻转会话计划态并直接回文案, 不调 LLM
    const planIntent = this._consumePlanCommand(userMsg, sessionKey);
    if (planIntent) {
      if (planIntent.action === "enter_plan_mode") {
        this.setPlanMode(sessionKey, true);
        return "已进入计划模式: 后续工具调用仅允许只读操作, 请先产出计划交用户审阅; 输入 /do 退出计划模式开始执行。";
      }
      // exit_plan_mode
      if (this.isPlanMode(sessionKey)) {
        this.setPlanMode(sessionKey, false);
        return "已退出计划模式, 恢复执行。";
      }
      return "当前会话不在计划模式, 无需退出。";
    }
    // 2026-10-24 (R3): 斜杠命令全量接线 —— 命令结果直接作回复 (不进 LLM、不落库:
    //   控制面操作不污染对话历史)。返回 null = 非命令, 走 LLM 主链。
    if (!planIntent) {
      const cmdOut = await this._executeCommand(userMsg, sessionKey);
      if (cmdOut !== null) return this._maskReplyPII(String(cmdOut));
    }
    let reply;
    // v4.2 分层漏斗: L1 规则直答 → L2 上下文提示块 (注入 user 尾部, 提示不接管决策) → L3 mode 分发兜底
    const funnelOn = this.config.agent?.intent_funnel !== false;
    const sk = sessionKey || "default";
    if (funnelResumed) {
      // 流式降级复跑 (chatStream 传入): 提示块与层统计已由 chatStream 的 arm 完成,
      //   不重置不重算不重计 —— _turnIntentHints 里现成的 hint 会经 buildMessages 烘进本轮 wire。
    } else {
      this._turnHistoryTexts.delete(sk); // 每轮重置 (漏斗关闭/规则直答时防串轮残留)
      // 2026-11-03: @ 引用文件资料块 —— 必须赶在 _armIntentHint 之前落进 Map,
      //   这样它算出的 historyText (= wire 形态) 会一并带上引用内容, 落库与模型所见一致。
      if (fileRefs) this._turnFileRefs.set(sk, String(fileRefs));
    }
    const local = (this.config.agent?.localIntent !== false) ? await this._localIntent(userMsg, sessionKey) : null;
    if (local) {
      reply = local;
      this._intentRecord(sessionKey, userMsg, "rule", "local");
    } else {
      // L2: 命中信号才注入提示块 (无信号不注入, 防提示疲劳); 层统计随 _armIntentHint 落盘
      if (funnelOn && !funnelResumed) this._armIntentHint(userMsg, sessionKey);
      // 引用块已在 wire 里: 即使 L2 没命中 (不会写 historyText), 也要把带引用的 wire 落库,
      // 否则下一轮重建的历史与上一轮模型所见不一致 (append-only 缓存契约会破)。
      if (this._turnFileRefs?.has(sk) && !this._turnHistoryTexts.has(sk)) {
        this._turnHistoryTexts.set(sk, this._userWireText(userMsg, sk));
      }
      // 模式分发 (L3 兜底层): 编排策略可插拔 (react/single, 未来 plan-exec/multi-agent/graph 等)
      const modeName = mode || this.config.agent?.mode || "react";
      try {
        reply = await this.ctx.consume("modes").run(modeName, this, userMsg, { sessionKey });
      } catch (e) {
        error("LLM 调用失败:", e.message);
        obs.taskOk = false;
        reply = LLM_FAILED_HINT(e.message);
      } finally {
        this._turnIntentHints.delete(sk); // 提示块已烘进本轮 wire 与 _turnHistoryTexts, 轮末回收 (幂等注入, 不再消费即清)
      }
      if (!funnelOn) this._intentRecord(sessionKey, userMsg, "llm", null);
    }
    // 工具循环可用普通返回值结束中断, 不一定抛 AbortError; 中断位才是事实来源。
    if (this._isInterrupted(sessionKey)) {
      obs.taskOk = false;
      _turnStatus = "aborted";
    }

    const usedTools = this._lastTurnUsedTools;
    this._lastTurnUsedTools = false;
    if (this._notifyCb && usedTools) this.notify("[done] 任务完成 (工具执行)。");
    // 2026-10-24 (R9 审计): chat 通道同样要做会话工具标记收口 —— 此前只有 chatStream
    //   收口, chat 通道的条目永久残留 (长跑多会话下 Map 无界增长 + 语义陈旧)。
    this._turnsUsedTools?.delete(sessionKey);

    // 最终回答自检 (2026-10-09): 这是整条链路上唯一面向"用户可见文本"的闸门。
    // 确定性判定 (零 LLM 成本): 空回复 / 内部错误外泄 / 未渲染工具信封 / 裸 JSON。
    // 其中"内部错误外泄"会就地净化 (内部细节对用户无价值且有害), 其余只记录与告警, 不擅自改写。
    if (this.config?.agent?.self_check !== false) {
      try {
        const report = selfCheckReply(reply, { usedTools });
        if (!report.ok) {
          const codes = report.issues.map((i) => i.code).join(",");
          warn("回答自检未通过:", codes);
          this.bus?.emit("agent/selfcheck", { codes, issues: report.issues, sessionKey }, { source: "agent.selfcheck" });
          this._observeEvalSelfCheck(obs, reply, report);
          reply = sanitizeReply(reply, report);
        }
      } catch (e) { noteCatch(e); /* 自检本身异常不得阻断主链路 */
        // 但静默吞掉等于"最终闸门坏了没人知道" —— 留一条 warn, 排查时可发现自检停摆
        warn("[selfcheck] chat 自检异常:", e?.message || e);
      }
    }

    if (persist) {
      // 会话落盘 + L0/L1 记忆写入 + 记忆升降级协调 (afterTurn: L2 场景归档/经验学习/L3 画像刷新)
      await this._persistTurn(sessionKey, userMsg, reply, { afterTurn: true, historyText: this._turnHistoryTexts.get(sk) || null });
      this._turnHistoryTexts.delete(sk);
    }
    // persist=false (流式降级直调): historyText 条目必须保留 —— 本函数末尾的 _persistTurn 还要读它。
    // 生命周期推进: 每次对话计数, 阶段转换 born→growing→mature
    this.bus?.emit("chat/reply", { reply }, { source: "agent.chat" });
    this._lifecycleTick();
    this.evolve && this.evolve.tick();
    // 2026-11-01 (三期投机复现): 轮收口边界 —— 本轮有工具失败则后台静默复现 (不阻塞回复)
    this._scheduleSpeculative(sessionKey);
    // P2-2: 本轮若发生过 provider 降级, 在回复末尾附可见提示
    //   (放在 persist 之后 —— 写入会话历史/记忆的始终是模型原文, 提示只对当轮用户可见)
    if (this._lastFallback) {
      const fb = this._lastFallback;
      this._lastFallback = null;
      reply = String(reply ?? "") + this._fallbackNotice(fb);
      this.notify(`[降级] ${fb.from} → ${fb.to}`);
    }
    return this._maskReplyPII(reply);
      }, { sessionKey, channel: "chat", userMsg: String(userMsg).slice(0, 200), taskId, traceId, strata, evalSampleRate });
    } catch (e) {
      _turnStatus = "aborted"; // 异常逃逸 = 本轮中止 (finally 收口, 不留悬空 open turn)
      obs.taskOk = false;
      this._clearTurnFailures(sessionKey); // 中止轮不投机复现 (尊重中止语义)
      throw e;
    } finally {
      this._emitInlineDecision?.(sessionKey, _turnStatus);
      this._turnFileRefs?.delete(sessionKey); // 引用块只服务本轮, 不留残到下一轮
      this._clearResumeCtx?.(sessionKey); // 续跑上下文同理: 一次性, 不串到下一轮
      if (ownObs) this._turnObsEnd(sessionKey, obs, _turnStatus);
    }
  },
};
