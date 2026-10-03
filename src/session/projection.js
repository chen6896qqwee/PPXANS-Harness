// src/session/projection.js - Turn 投影层 (v3.1 首片集成, 2026-10-03)
//
// 定位: src/session/turn.js 的 Session→Task→Turn 状态机作为**投影层**接入主链路,
//       SessionStore (data/sessions/*.jsonl) 仍是会话内容的唯一事实源。
//       本层只记录「每轮对话的生命周期状态」(open/closed/aborted), 不参与消息路由,
//       对 chat/chatStream 是纯可观测增量 —— 后续 v3.1 排队输入 (queuedUserInputs)
//       承接、rollout 持久化都在这层之上演进, 不必再动主链路。
//
// 事件: agent.bus 发 chat/turn/begin、chat/turn/end (status: closed|aborted);
//       protocolBus.eq 有 SQ/EQ 总线时同步推 TASK_TURN_* 结构化事件。
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
  begin(sessionKey, userMsg) {
    if (!this.enabled) return null;
    try {
      const s = this._get(sessionKey);
      const task = s.currentTask() || s.createTask();
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
  abort(sessionKey) {
    if (!this.enabled) return null;
    try {
      const s = this.sessions.get(sessionKey);
      const task = s && s.currentTask();
      return task ? { turnId: task.currentTurn?.id, status: "aborted" } : null;
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
