// src/protocol/index.js - SQ/EQ 双队列事件流 (对齐 OpenAI Codex SubmissionQueue/EventQueue)
// 通道层与内核解耦的唯一总线:
//   SubmissionQueue: 用户操作入队 (op = {id, type, payload}), 先提交先处理
//   EventQueue:       结构化事件出队 + 订阅回调 + WAL 回放 (JSONL)
import fs from "node:fs";
import path from "node:path";

// 操作类型 (用户侧动作, 进 SQ)
export const OpType = {
  USER_TURN: "user_turn",
  INTERRUPT: "interrupt",
  RESUME: "resume",
  APPROVE: "approve",
  DENY: "deny",
};

// 事件类型 (内核产出, 供 Web UI 时间线渲染, 进 EQ)
export const EventType = {
  TASK_STARTED: "task_started",
  AGENT_MESSAGE: "agent_message",
  TOOL_CALLED: "tool_called",
  TOOL_OUTPUT: "tool_output",
  APPROVAL_REQUESTED: "approval_requested",
  APPROVAL_RESOLVED: "approval_resolved",
  TASK_COMPLETE: "task_complete",
  TASK_ABORTED: "task_aborted",
  TURN_DIFF: "turn_diff",
  ERROR: "error",
  TOKEN_COUNT: "token_count",
  PLAN_UPDATED: "plan_updated",
  COMPACTED: "compacted",
};

// SubmissionQueue: 用户操作入队, 内部数组队列, 先提交先处理
export function createSubmissionQueue() {
  let _seq = 0;
  const queue = [];

  // 默认 id: t_<时间戳>_<自增序号> (对齐 codex Id::UnixMs 唯一性)
  function _newId() {
    _seq += 1;
    return `t_${Date.now()}_${_seq}`;
  }

  // 提交一个操作, 返回分配/给定的 id
  function submit(op = {}) {
    const id = op.id || _newId();
    queue.push({ id, type: op.type, payload: op.payload });
    return id;
  }

  // 取出最早一个未处理 op 并出队 (无则 null) — 对齐 codex nextIdle 语义
  function nextIdle() {
    return queue.length ? queue.shift() : null;
  }

  // 取走全部 op 并清空队列
  function drain() {
    const out = queue.splice(0, queue.length);
    return out;
  }

  return { submit, nextIdle, drain };
}

// EventQueue: 结构化事件出队 + 订阅回调 + WAL 回放
export function createEventQueue({ walPath = null } = {}) {
  let _seq = 0;
  const events = [];   // 内存历史
  const subs = [];     // 订阅回调

  // WAL 目录不存在先建 (递归)
  if (walPath) {
    const dir = path.dirname(walPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // 推送一个事件: ev = {id?, ts?, type, payload}; seq 自增
  function push(ev) {
    _seq += 1;
    const full = {
      id: ev.id || `e_${Date.now()}_${_seq}`,
      ts: ev.ts || Date.now(),
      seq: _seq,
      type: ev.type,
      payload: ev.payload,
    };
    events.push(full);
    // 同步落 WAL (JSONL, 一行一 JSON)
    if (walPath) {
      fs.appendFileSync(walPath, JSON.stringify(full) + "\n", "utf8");
    }
    // 同步通知订阅回调 (单个回调异常不影响事件流)
    for (const fn of subs) {
      try { fn(full); } catch { /* 订阅回调不应中断事件流 */ }
    }
    return full;
  }

  // 订阅: 返回取消订阅函数
  function subscribe(fn) {
    subs.push(fn);
    return () => {
      const i = subs.indexOf(fn);
      if (i >= 0) subs.splice(i, 1);
    };
  }

  // 回放 WAL: 读文件返回全部事件
  function replay() {
    if (!walPath || !fs.existsSync(walPath)) return [];
    const out = [];
    for (const line of fs.readFileSync(walPath, "utf8").split("\n").filter(Boolean)) {
      try { out.push(JSON.parse(line)); } catch { /* 跳过损坏行 */ }
    }
    return out;
  }

  // 内存历史快照
  function history() {
    return [...events];
  }

  return { push, subscribe, replay, history };
}

// createProtocolBus: 便捷工厂 — 把 SQ/EQ 与常用提交动作打包
export function createProtocolBus({ walPath } = {}) {
  const sq = createSubmissionQueue();
  const eq = createEventQueue({ walPath });

  // 提交一个用户回合 (USER_TURN op)
  function submitUserTurn(text) {
    return sq.submit({ type: OpType.USER_TURN, payload: { text } });
  }

  // 中断当前回合 (INTERRUPT op)
  function interrupt() {
    return sq.submit({ type: OpType.INTERRUPT, payload: {} });
  }

  // 关闭总线 (无持久连接, 留作未来扩展点)
  function close() {
    /* noop */
  }

  return { sq, eq, submitUserTurn, interrupt, close };
}
