// src/agent/stream.js — 流式对话主链 (2026-11-03 从 index.js 下沉)
// 行为与拆分前完全一致; 以 prototype descriptor 方式挂回 PPXAgent, 调用方无感知.
import { noteCatch } from "../utils/catch-log.js";
import { warn } from "../utils/logger.js";
import { selfCheckReply, sanitizeReply } from "../core/selfcheck.js";
import { runWithTrace, patchTrace, currentTrace } from "../core/trace.js";

class StreamMixin {
  // 流式对话: 返回 { text, history } 或回调 onDelta 推送增量
  // 支持工具循环: 若消息触发工具调用, 走 _llmWithTools (触发 onTool 事件推送工具活动),
  // 最终结果作为一次 delta 推送; 否则走 streamChat 逐字流式 [P1#7]
  // 2026-10-24 (R5): 同会话互斥锁 + rewind/resume 重定向, 与 chat 同一套机制。
  async chatStream(userMsg, opts = {}) {
    const sk = opts.sessionKey || "default";
    return this._withSessionLock(sk, () => this._chatStreamCore(userMsg, opts));
  }

  async _chatStreamCore(userMsg, {
    sessionKey = "default", onDelta, onTool, onStep, onReasoning, fileRefs = "",
    taskId = null, traceId = null, strata = null, evalSampleRate = null, taskOk = null,
  } = {}) {
    // (R9 审计) 与 _chatCore 同款: 重定向在 runWithTrace 之前解析, trace 携带真实会话
    sessionKey = this._redirectSession(sessionKey);
    // 轮归属: 与 _chatCore 同口径 (Router 未委派则收口时补 inline 决策事件)。
    this._markTurnRoute?.(sessionKey, "inline");
    // 2026-10-24 (R12): 轮观测 begin —— 与 chat 同款三件套, begin 在所有早退之前
    //   (命令/预算/无 llm 委托都算用户轮); 异常与用户中断由收口标 aborted。
    const obs = this._turnObsBegin(sessionKey, userMsg, "chatStream");
    if (typeof taskOk === "boolean") obs.taskOk = taskOk;
    let _turnStatus = "closed";
    try {
    // 重构第三刀: 入口生成 traceId (无 LLM 降级 chat 时嵌套新 trace, 独立可追踪)
    return await runWithTrace(async () => {
    // 架构优化 ②: 流式轮同样落 run 契约 (kind=turn, channel=stream)
    patchTrace({ sessionKey, runKind: "turn", channel: "stream" });
    this._captureEvalTurn(obs);
    // 2026-10-24 (R8) 修复: 斜杠命令接入流式通道 —— R3 只接了 chat, Web UI 走
    //   chatStream 发 /status /skills /rewind 会被当普通文本喂给 LLM (实测实锤)。
    //   语义与 _chatCore 完全一致: 命令命中 → 直接回文案 (经 onDelta 推给前端),
    //   不调 LLM、不落库。/plan /do 翻转计划态后同样直接返回。
    {
      const planIntent = this._consumePlanCommand(userMsg, sessionKey);
      if (planIntent) {
        if (planIntent.action === "enter_plan_mode") {
          this.setPlanMode(sessionKey, true);
          const msg = "已进入计划模式: 后续工具调用仅允许只读操作, 请先产出计划交用户审阅; 输入 /do 退出计划模式开始执行。";
          if (onDelta) onDelta(msg);
          return this._maskReplyPII(msg);
        }
        if (this.isPlanMode(sessionKey)) {
          this.setPlanMode(sessionKey, false);
          const msg = "已退出计划模式, 恢复执行。";
          if (onDelta) onDelta(msg);
          return this._maskReplyPII(msg);
        }
        const msg = "当前会话不在计划模式, 无需退出。";
        if (onDelta) onDelta(msg);
        return this._maskReplyPII(msg);
      }
      const cmdOut = await this._executeCommand(userMsg, sessionKey);
      if (cmdOut !== null) {
        if (onDelta) { try { onDelta(String(cmdOut)); } catch (e) { noteCatch(e); /* 消费方异常不阻断 */ } }
        return this._maskReplyPII(String(cmdOut));
      }
    }
    if (!this.llm) {
      const trace = currentTrace();
      return this.chat(userMsg, {
        sessionKey, turnObs: obs, taskId: trace?.taskId, traceId: trace?.traceId,
        strata: trace?.strata, evalSampleRate: trace?.evalSampleRate,
      });
    }
    // 2026-10-24 (R2): 流式轮同样重置回退重放缓存
    // 2026-11-06 (评估 P1-4): 缓存按会话分桶 (_turnExecCacheFor), 本轮重置本会话桶
    this._turnAttempt = 0;
    this._turnExecCache = null; // 旧单例字段清空 (防旧引用复活)
    this._turnExecCaches?.delete(sessionKey || "default");
    // 2026-11-01 (三期投机复现): 本轮工具失败清单 (2026-11-12 起按会话分桶)
    this._clearTurnFailures(sessionKey);
    // 2026-10-10 修复 (P0-1 孪生): 流式入口同样消费预算闸门 —— 超限时不得再发上游请求,
    //   并把提示同时推给 onDelta (否则前端只会看到空白流)。
    const blocked = this._budgetBlocked();
    if (blocked) { obs.taskOk = false; onDelta && onDelta(blocked); return blocked; }
    // 2026-10-24 (R4): SessionStart 追踪与 chat 对齐 —— 此前流式路径的会话不触发
    //   SessionStart 钩子 (钩子只对 chat 路径的会话可见)。
    {
      const sk = sessionKey || "default";
      if (!this._seenSessions.has(sk)) {
        this._seenSessions.add(sk);
        try { this.hooks?.emit?.("SessionStart", { sessionKey: sk, source: "chatStream" })?.catch?.(() => {}); } catch (e) { noteCatch(e); /* 不阻断 */ }
      }
    }
    this.clearInterrupt(sessionKey); // 新一轮对话开始, 复位本会话中断位 (P1-4: 不殃及其它会话)
    // v4.2 分层漏斗: L1 规则直答 → L2 提示块注入 (user 尾部, 幂等; 随 _turnHistoryTexts 落库) → L3 流式主链
    const funnelOn = this.config.agent?.intent_funnel !== false;
    const sk = sessionKey || "default";
    this._turnHistoryTexts.delete(sk); // 每轮重置 (漏斗关闭/规则直答时防串轮残留)
    // 2026-11-03: @ 引用文件资料块 — 赶在 _armIntentHint 之前落 Map, 其 historyText 会带上引用
    if (fileRefs) this._turnFileRefs.set(sk, String(fileRefs));
    const local = (this.config.agent?.localIntent !== false) ? await this._localIntent(userMsg, sessionKey) : null;
    if (local) {
      this._intentRecord(sessionKey, userMsg, "rule", "local");
      onDelta && onDelta(local); return local;
    }
    if (funnelOn) this._armIntentHint(userMsg, sessionKey);
    // 引用了文件但 L2 未命中: 仍需把带引用的 wire 记为 historyText (与落库一致)
    if (this._turnFileRefs?.has(sk) && !this._turnHistoryTexts.has(sk)) {
      this._turnHistoryTexts.set(sk, this._userWireText(userMsg, sk));
    }
    const system = this._context(userMsg);
    const history = await this._loadHistory(sessionKey);
    const messages = [{ role: "system", content: system }, ...history, { role: "user", content: this._userContent(userMsg, sessionKey) }];

    // 多模态路由: 消息含图片时优先 vision provider (否则图片发到文本后端无意义)
    const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c && c.type === "image_url"));
    const activeLLM = hasImage ? (this._visionLLM() || this.llm) : this.llm;

    // 挂工具事件透传 (供 onTool 推送)
    const prevCb = this._onToolEvent;
    if (onTool) this._onToolEvent = (ev) => { try { onTool(ev); } catch (e) { noteCatch(e); } };
    // 挂 step 事件透传 (供 onStep 推送推理轮次)
    const prevStepCb = this._onStepEvent;
    if (onStep) this._onStepEvent = (ev) => { try { onStep(ev); } catch (e) { noteCatch(e); } };

    // 流式中断句柄 (2026-10-04 Task#3): interrupt(sessionKey) 立即掐断上游请求 ——
    //   已吐出的增量保留, 绝不降级重发 (那是二次计费 + 重复输出)。
    const ac = new AbortController();
    this._streamAborts.set(sessionKey, ac);
    let partial = "";
    let reply;
    this._turnInProgress = true; // (R5): 降级进 _chatCore 时保留回放缓存 (finally 收口)
    let emittedAny = false; // (R10): 本轮是否已流式吐过增量 (决定 done 后是否补发全文)
    try {
      // 2026-10-24 (R4): 流式全量接管 —— provider 支持流式时, 无工具走逐字流,
      //   有工具也走流式工具循环 (apiChatStream: 文本增量实时可见, 增量 tool_call 累积)。
      //   "带工具就整体退化为非流式"自此移除; 失败回退语义在 policy 内处理。
      // 2026-10-24 (R10): 接入 provider 回退链 —— 此前直连 _llmWithTools, 主模型宕机时
      //   流式用户要承受"整轮重来 + 退化为非流式"; 现在健康探测过滤 + 逐 provider
      //   流式尝试 (单 provider 内的流式失败仍由 policy 的 stream→非流式兜底)。
      // 2026-11-01 (二期②): 思考链增量透传 (推理模型 reasoning_content, 默认积累进 _lastReasoning)
      // 2026-11-03: 提到分支外 —— 非流式回退分支此前不传 onReasoning, 思考块永远不出现。
      const reasoningEmit = onReasoning || ((t) => { if (t) this._lastReasoning = (this._lastReasoning || "") + t; });
      this._lastReasoning = "";
      if (activeLLM.supportsStream) {
        const emit = onDelta
          ? (d, meta) => { if (d) { partial += d; emittedAny = true; } try { onDelta(d, meta); } catch (e) { noteCatch(e); /* 消费方异常不阻断 */ } }
          : null;
        if (this.toolsEnabled) {
          reply = await this._llmWithFallback(messages, emit, ac.signal, reasoningEmit);
        } else {
          // 纯文本流也要透传思考链 (此前该分支丢掉 onReasoning, 关工具时前端永远没有思考块)
          reply = await activeLLM.streamChat(messages, { onDelta: emit, onReasoning: reasoningEmit, signal: ac.signal });
        }
      } else {
        reply = await this._llmWithFallback(messages, null, ac.signal, reasoningEmit);
      }
      // (R10) 回退链走的是非流式 provider (或全部流式失败后 policy 兜底) 时, 增量为空:
      //   补发一次全文, 防前端只见 done 事件不见正文。
      if (onDelta && !emittedAny && reply) { try { onDelta(reply); } catch (e) { noteCatch(e); } }
    } catch (e) {
      // 判定"用户叫停"而非"上游真故障": AbortError / 已置中断位 / 句柄已 abort
      // 2026-11-06 (评估 P1-4): 中断判定走会话隔离入口, 只认本会话 (或全局) 中断
      const isAbort = e?.name === "AbortError" || this._isInterrupted(sessionKey) || ac.signal.aborted;
      if (isAbort) {
        warn("chatStream 被中断, 保留已生成部分 (不降级重发):", String(e?.message || e));
        _turnStatus = "aborted"; // (R12) 用户叫停 = 本轮中止, 收口如实记录
        obs.taskOk = false;
        reply = partial;
      } else {
        warn("chatStream 失败, 降级非流式 chat:", e.message);
        // persist:false —— 落库统一交给本函数末尾的 _persistTurn 完成,
        //   否则降级路径既在 chat 内落一次、又在末尾落一次 = 会话凭空多一轮 (P1#7 双写)。
        //   (R5): 走 _chatCore 直调 (本函数已持同会话锁, 再入 chat 会死锁); 已流式吐出
        //   过部分文本时插分隔标记, 防用户看到"半截 + 全文"拼接的重复内容;
        //   _turnInProgress 仍为真 → _chatCore 保留回放缓存, 非幂等工具不双执行。
        //   (R12): 传入本函数已开的 obs —— 降级不重复开 turn, 收口仍归本函数。
        if (partial && onDelta) { try { onDelta("\n\n[流式中断 → 已重新生成]\n\n"); } catch (e) { noteCatch(e); } }
        const trace = currentTrace();
        reply = await this._chatCore(userMsg, {
          sessionKey, persist: false, turnObs: obs, funnelResumed: true,
          taskId: trace?.taskId, traceId: trace?.traceId,
          strata: trace?.strata, evalSampleRate: trace?.evalSampleRate,
        });
        if (onDelta) onDelta(reply);
      }
    } finally {
      this._onToolEvent = prevCb;
      this._onStepEvent = prevStepCb;
      this._streamAborts.delete(sessionKey); // abort 句柄必须回收, 不留残留
      this._turnInProgress = false; // (R5) 轮收口: 后续轮次照常重置回放缓存
      this._turnIntentHints.delete(sk); // v4.2: 提示块轮末回收 (幂等注入; _turnHistoryTexts 留给下方落库)
      this._turnFileRefs?.delete(sk);   // @ 引用块同生命周期: wire 已烘进 historyText, 轮末回收
    }
    if (this._isInterrupted(sessionKey)) {
      obs.taskOk = false;
      _turnStatus = "aborted";
    }
    // 落库用模型原文 (剥掉本轮降级提示), 与 chat 共用同一路径; afterTurn 与 chat 对齐 ——
    //   流式轮次同样触发 L2 归档 / 经验学习 / L3 画像刷新 (2026-10-04 Task#3)。
    // 2026-10-24 (R2): 落库前补 selfCheck 闸门 —— 此前只有 chat 有, 流式路径裸奔。
    //   注意 onDelta 已实时吐出增量, 这里的净化只修正"落库/回放/下轮上下文"里的版本
    //   (历史脏文本会持续污染后续轮次, 比单次展示问题更重)。
    // 2026-10-24 (R9 审计): usedTools 轮内捕获 —— 此处 chatStream 从不复位该标记,
    //   selfCheck 读到的是上一轮 (可能来自 chat 通道) 的陈旧值。与 chat 同款: 本轮读后即清。
    const usedTools = this._lastTurnUsedTools;
    this._lastTurnUsedTools = false;
    if (this.config?.agent?.self_check !== false) {
      try {
        const report = selfCheckReply(reply, { usedTools });
        if (!report.ok) {
          warn("chatStream 回答自检未通过:", report.issues.map((i) => i.code).join(","));
          this.bus?.emit("agent/selfcheck", { codes: report.issues.map((i) => i.code), issues: report.issues, sessionKey, channel: "chatStream" }, { source: "agent.chatStream" });
          this._observeEvalSelfCheck(obs, reply, report);
          reply = sanitizeReply(reply, report);
        }
      } catch (e) { /* 自检异常不阻断主链 */
        warn("[selfcheck] chatStream 自检异常:", e?.message || e);
      }
    }
    await this._persistTurn(sessionKey, userMsg, this._stripFallbackNotice(reply), { afterTurn: true, historyText: this._turnHistoryTexts.get(sk) || null });
    this._turnHistoryTexts.delete(sk); // v4.2: wire 历史已落库, 回收 (防串轮)
    // 2026-10-24 (R10 审计#5): 流式用户此前永远看不到降级提示 —— chat 会把
    //   _fallbackNotice 拼到回复尾部, chatStream 只清空不告知。现对齐: 回复尾部
    //   拼提示 (落库的仍是模型原文, 上面 _stripFallbackNotice 已剥) + notify 推送。
    if (this._lastFallback) {
      const fb = this._lastFallback;
      reply = String(reply ?? "") + this._fallbackNotice(fb);
      this.notify(`[降级] ${fb.from} → ${fb.to}`);
    }
    this._lastFallback = null; // 降级提示不影响后续轮次
    this._turnsUsedTools.delete(sessionKey); // 本轮收口: 清除工具使用标记
    // 2026-11-01 (三期投机复现): 流式轮收口边界 —— 同 chat
    this._scheduleSpeculative(sessionKey);
    return this._maskReplyPII(reply);
      }, { sessionKey, channel: "chatStream", taskId, traceId, strata, evalSampleRate });
    } catch (e) {
      _turnStatus = "aborted";
      obs.taskOk = false;
      this._clearTurnFailures(sessionKey); // 中止轮不投机复现 (用户已叫停, 尊重语义)
      throw e;
    } finally {
      this._emitInlineDecision?.(sessionKey, _turnStatus);
      this._turnObsEnd(sessionKey, obs, _turnStatus);
    }
  }
}

const d = Object.getOwnPropertyDescriptors(StreamMixin.prototype);
delete d.constructor;
export const streamMethods = d;
