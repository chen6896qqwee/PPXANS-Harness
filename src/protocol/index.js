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
  TURN_STARTED: "turn_started",
  TURN_CLOSED: "turn_closed",
  TURN_ABORTED: "turn_aborted",
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
// 2026-10-25 (SQ 真实化): 此前队列是"提交即消费"的装饰性结构 (评估报告 P1) ——
//   无时间戳、无队头语义、无腐烂清理。现在 op 带提交时刻, 并补三件真实能力:
//   atHead: FIFO 闸口语义 (谁先提交谁先被处理, 供调度/诊断判定)
//   pending: 快照 (不清空), 供 /health 可观测
//   sweep: TTL 清扫 —— 崩溃轮次遗留的 op 不再永久占队头 (防队列腐烂堵死后续判定)
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
    queue.push({ id, type: op.type, payload: op.payload, submittedAt: op.submittedAt || Date.now() });
    return id;
  }

  // 取出最早一个未处理 op 并出队 (无则 null) — 对齐 codex nextIdle 语义
  function nextIdle() {
    return queue.length ? queue.shift() : null;
  }

  // 按 id 取走一个 op (多会话并发下各轮只消费自己的 op, 不抢别人的队头)。
  // 返回被取走的 op 或 null (已被消费/不存在)。
  function consume(id) {
    const i = queue.findIndex((op) => op.id === id);
    return i >= 0 ? queue.splice(i, 1)[0] : null;
  }

  // 当前未消费 op 数 (诊断/收口断言用)
  function size() {
    return queue.length;
  }

  // 取走全部 op 并清空队列
  function drain() {
    const out = queue.splice(0, queue.length);
    return out;
  }

  // 该 id 的 op 是否在队头 (空队/false = 不在)。FIFO 闸口语义的判定原语。
  function atHead(id) {
    return queue.length > 0 && queue[0].id === id;
  }

  // 按类型取走全部 op (不动其他类型 —— 多会话并发时各轮的 USER_TURN op 互不干扰)。
  // 返回被取走的 op 数组 (无则空数组)。供控制 op (如 INTERRUPT) 的生命周期收口。
  function consumeType(type) {
    const out = queue.filter((op) => op.type === type);
    if (out.length) {
      const rest = queue.filter((op) => op.type !== type);
      queue.splice(0, queue.length, ...rest);
    }
    return out;
  }

  // 队列快照 (不消费): [{id, type, payload, submittedAt, ageMs}]
  function pending() {
    const now = Date.now();
    return queue.map((op) => ({ ...op, ageMs: now - (op.submittedAt || now) }));
  }

  // TTL 清扫: 提交超过 ttlMs 仍未被消费的 op 视为"死轮遗留"(崩溃/断连轮次的残留),
  // 移出队列并原样返回 (调用方负责留痕)。不扫 INTERRUPT (控制 op 生命周期跟随轮次,
  // 由轮收口统一消费); 不设默认 TTL —— 由调用方显式传 (语义上这是策略不是机制)。
  function sweep(ttlMs, { keepTypes = ["interrupt"] } = {}) {
    if (!(ttlMs > 0)) return [];
    const now = Date.now();
    const stale = [];
    const rest = [];
    for (const op of queue) {
      const age = now - (op.submittedAt || now);
      if (age > ttlMs && !keepTypes.includes(op.type)) stale.push(op);
      else rest.push(op);
    }
    if (stale.length) queue.splice(0, queue.length, ...rest);
    return stale;
  }

  return { submit, nextIdle, consume, size, drain, atHead, consumeType, pending, sweep };
}

// EventQueue: 结构化事件出队 + 订阅回调 + WAL 回放
export function createEventQueue({ walPath = null } = {}) {
  const events = [];   // 内存历史
  const subs = [];     // 订阅回调

  // WAL 目录不存在先建 (递归)
  if (walPath) {
    const dir = path.dirname(walPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // seq 从 WAL 续读: 进程重启后从尾部最后一个可解析行恢复计数, 避免新事件与
  // WAL 里的历史事件撞号 (否则按 seq 排序/去重的消费方会看到 1,2,1 这种重复序列)。
  let _seq = 0;
  if (walPath && fs.existsSync(walPath)) {
    const lines = fs.readFileSync(walPath, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const last = JSON.parse(line);
        if (Number.isFinite(last?.seq)) { _seq = last.seq; break; }
      } catch { /* 尾部坏行: 继续向前找最后一个可解析行 */ }
    }
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
