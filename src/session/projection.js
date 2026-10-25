// src/session/projection.js - Turn 投影层 (v3.1 首片集成, 2026-10-03)
//
// 定位: src/session/turn.js 的 Session→Task→Turn 状态机作为**投影层**接入主链路,
//       SessionStore (data/sessions/*.jsonl) 仍是会话内容的唯一事实源。
//       本层只记录「每轮对话的生命周期状态」(open/closed/aborted), 不参与消息路由,
//       对 chat/chatStream 是纯可观测增量 —— 后续 v3.1 排队输入 (queuedUserInputs)
//       承接、rollout 持久化都在这层之上演进, 不必再动主链路。
//
// 事件: agent.bus 发 chat/turn/begin、chat/turn/end (status: closed|aborted);
//       protocolBus.eq 同步推 TURN_STARTED / TURN_CLOSED / TURN_ABORTED 结构化事件
//       (2026-10-24 R12 接线: 本类由 agent._initTurnState 装配, chat/chatStream 轮生命周期调用)。
import { createSession } from "./turn.js";

export class TurnProjection {
  constructor() {
    this.sessions = new Map(); // sessionKey -> session 状态机实例 (内存投影, 轻量)
    this.enabled = true;       // config.agent.turn_projection === false 时整体旁路
  }

  _get(sessionKey) {
    let s = this.sessions.get(sessionKey);
    if (!s) {
      s = createSession({ id: sessionKey });
      this.sessions.set(sessionKey, s);
    }
    return s;
  }

  // 开始一轮: 开新 turn 承接用户输入
  // aborted 的 task/session 不复活 —— 中止后再来新输入, 开新 task 承接
  // (对齐 codex 语义: aborted task 已终结, 新输入是新任务), 否则会出现
  // "task.status=aborted 却挂着 open turn"的矛盾状态。
  begin(sessionKey, userMsg) {
    if (!this.enabled) return null;
    try {
      let s = this.sessions.get(sessionKey);
      if (s && s.status !== "active") {
        this.sessions.delete(sessionKey);
        s = null;
      }
      if (!s) {
        s = createSession({ id: sessionKey });
        this.sessions.set(sessionKey, s);
      }
      let task = s.currentTask();
      if (!task || task.status !== "running") task = s.createTask();
      const turn = task.appendTurn(String(userMsg ?? ""));
      return { sessionId: s.id, turnId: turn.id, seq: turn.seq };
    } catch { return null; } // 投影层永不影响主链路
  }

  // 正常结束一轮 (排队输入存在时状态机自动开下一个 turn, 本层暂不消费)
  complete(sessionKey) {
    if (!this.enabled) return null;
    try {
      const s = this.sessions.get(sessionKey);
      const task = s && s.currentTask();
      const turn = task && task.completeTurn();
      return turn ? { turnId: turn.id, status: turn.status, queued: task.queuedUserInputs.length } : null;
    } catch { return null; }
  }

  // 中止一轮 (中断/异常)
  // 2026-10-24 (R12): 此前只是返回字面量 {status:"aborted"}, 从未调 task.abort() ——
  //   状态机实际纹丝不动 (探测实锤)。现在真正推进状态机并返回被中止的 turn id。
  abort(sessionKey) {
    if (!this.enabled) return null;
    try {
      const s = this.sessions.get(sessionKey);
      const task = s && s.currentTask();
      if (!task) return null;
      const turnId = task.currentTurn?.id ?? null;
      task.abort();
      return { turnId, status: "aborted" };
    } catch { return null; }
  }

  // 诊断视图: 指定会话的 turn 概要
  status(sessionKey) {
    const s = this.sessions.get(sessionKey);
    if (!s) return null;
    const task = s.currentTask();
    return {
      sessionId: s.id,
      turnCount: s.turnCount,
      taskStatus: task ? task.status : null,
      queuedInputs: task ? task.queuedUserInputs.length : 0,
      turns: (task ? task.turns : []).slice(-10).map((t) => ({ id: t.id, seq: t.seq, status: t.status })),
    };
  }
}
