// src/session/turn.js - Session→Task→Turn 状态机 (对齐 codex taskTurn/turn 模型)
// Session 持有有序 tasks; Task 持有有序 turns + queuedUserInputs;
// turn 完成后若仍有排队输入则自动续开新 turn (对齐 codex appendTurn/completeTurn 语义)。
import { randomUUID } from "node:crypto";

// 新建一个 turn 对象 (status: open/closed/aborted)
function createTurn(task, seq) {
  return {
    id: `turn_${randomUUID()}`,
    seq,
    status: "open",
    startedAt: Date.now(),
    closedAt: null,
    items: [], // ResponseItem 数组
  };
}

// 新建一个 task 对象, 方法通过 this 绑定 (便于反序列化复用同一份方法)
function newTask(session, id) {
  return {
    id: id || `task_${randomUUID()}`,
    sessionId: session.id,
    turns: [],
    status: "running", // running | complete | aborted
    queuedUserInputs: [],
    currentTurn: null,

    // 追加一个用户输入:
    //  - 当前 turn 进行中 -> 先排队 (用户追打)
    //  - 无进行中 turn  -> 开新 turn 承接
    appendTurn(userInput) {
      if (this.currentTurn && this.currentTurn.status === "open") {
        this.queuedUserInputs.push(userInput);
        return this.currentTurn;
      }
      const turn = createTurn(this, this.turns.length + 1);
      this.turns.push(turn);
      this.currentTurn = turn;
      turn.items.push(userInput);
      session.turnCount += 1;
      return turn;
    },

    // 结束当前 turn:
    //  - 当前 turn 标 closed
    //  - 若仍有排队输入, 自动开新 turn 承接第一个 (其余留待下次 completeTurn)
    completeTurn() {
      if (this.currentTurn) {
        this.currentTurn.status = "closed";
        this.currentTurn.closedAt = Date.now();
      }
      if (this.queuedUserInputs.length > 0) {
        const next = this.queuedUserInputs.shift();
        this.appendTurn(next);
      }
      return this.currentTurn;
    },

    // 中止: 当前 turn 标 aborted, task 标 aborted
    abort() {
      if (this.currentTurn) {
        this.currentTurn.status = "aborted";
        this.currentTurn.closedAt = Date.now();
      }
      this.status = "aborted";
      session.status = "aborted";
      return this;
    },
  };
}

// 创建会话
export function createSession({ id } = {}) {
  const sessionId = id || `sess_${randomUUID()}`;
  const session = {
    id: sessionId,
    tasks: [],
    turnCount: 0,
    status: "active", // active | aborted
    createTask(input = {}) {
      const task = newTask(this, input.id);
      this.tasks.push(task);
      return task;
    },
    currentTask() {
      return this.tasks.length ? this.tasks[this.tasks.length - 1] : null;
    },
  };
  return session;
}

// 序列化会话为 JSON 字符串 (仅数据, 方法在反序列化时重建)
export function serializeSession(session) {
  return JSON.stringify({
    id: session.id,
    turnCount: session.turnCount,
    status: session.status,
    tasks: session.tasks.map((t) => ({
      id: t.id,
      sessionId: t.sessionId,
      status: t.status,
      queuedUserInputs: t.queuedUserInputs,
      turns: t.turns.map((tn) => ({
        id: tn.id,
        seq: tn.seq,
        status: tn.status,
        startedAt: tn.startedAt,
        closedAt: tn.closedAt,
        items: tn.items,
      })),
    })),
  });
}

// 从 JSON 反序列化 (重建方法 + 当前 turn 指针)
export function deserializeSession(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  const session = createSession({ id: data.id });
  session.turnCount = data.turnCount ?? 0;
  session.status = data.status ?? "active";
  session.tasks = (data.tasks || []).map((t) => {
    const task = newTask(session, t.id);
    task.status = t.status ?? "running";
    task.queuedUserInputs = t.queuedUserInputs || [];
    task.turns = (t.turns || []).map((tn) => ({
      id: tn.id,
      seq: tn.seq,
      status: tn.status,
      startedAt: tn.startedAt,
      closedAt: tn.closedAt ?? null,
      items: tn.items || [],
    }));
    task.currentTurn = task.turns.length ? task.turns[task.turns.length - 1] : null;
    return task;
  });
  return session;
}
