// test/session-turn.test.js - Session→Task→Turn 状态机测试
import { test } from "node:test";
import assert from "node:assert";
import { createSession, serializeSession, deserializeSession } from "../src/session/turn.js";

test("createTask→appendTurn→completeTurn 基础流程", () => {
  const s = createSession({ id: "s1" });
  const task = s.createTask();
  assert.equal(s.tasks.length, 1);
  const turn = task.appendTurn({ role: "user", content: "hi" });
  assert.equal(task.turns.length, 1);
  assert.equal(task.currentTurn.id, turn.id);
  turn.items.push({ role: "assistant", content: "ok" }); // 模拟 agent 回复
  task.completeTurn();
  assert.equal(turn.status, "closed");
  assert.equal(task.turns.length, 1);
  assert.equal(task.queuedUserInputs.length, 0);
});

test("completeTurn 后 queued 自动续 turn", () => {
  const s = createSession({ id: "s2" });
  const task = s.createTask();
  task.appendTurn({ role: "user", content: "a" });
  // turn 进行中用户追打 -> 排队
  task.appendTurn({ role: "user", content: "b" });
  assert.equal(task.queuedUserInputs.length, 1);
  task.completeTurn();
  // 自动开新 turn 承接排队输入
  assert.equal(task.turns.length, 2);
  assert.equal(task.turns[1].status, "open");
  assert.equal(task.turns[1].items.length, 1);
  assert.equal(task.turns[1].items[0].content, "b");
  assert.equal(task.queuedUserInputs.length, 0);
});

test("多次排队: 每轮 completeTurn 续一个 turn", () => {
  const s = createSession({ id: "s3" });
  const task = s.createTask();
  task.appendTurn({ role: "user", content: "a" });
  task.appendTurn({ role: "user", content: "b" });
  task.appendTurn({ role: "user", content: "c" });
  assert.equal(task.queuedUserInputs.length, 2);
  task.completeTurn();
  assert.equal(task.turns.length, 2);
  assert.equal(task.queuedUserInputs.length, 1); // 还剩 c
  task.completeTurn();
  assert.equal(task.turns.length, 3);
  assert.equal(task.queuedUserInputs.length, 0);
  assert.equal(task.turns[2].items[0].content, "c");
});

test("abort 语义: 当前 turn 标 aborted, task 与 session 标 aborted", () => {
  const s = createSession({ id: "s4" });
  const task = s.createTask();
  task.appendTurn({ role: "user", content: "a" });
  task.abort();
  assert.equal(task.currentTurn.status, "aborted");
  assert.equal(task.status, "aborted");
  assert.equal(s.status, "aborted");
});

test("serialize/deserialize 往返一致且可继续操作", () => {
  const s = createSession({ id: "s5" });
  const task = s.createTask();
  task.appendTurn({ role: "user", content: "hi" });
  task.turns[0].items.push({ role: "assistant", content: "reply" });
  task.completeTurn();
  const json = serializeSession(s);
  const s2 = deserializeSession(json);
  assert.equal(s2.id, "s5");
  assert.equal(s2.turnCount, s.turnCount);
  assert.equal(s2.tasks.length, 1);
  assert.equal(s2.tasks[0].turns.length, 1);
  assert.equal(s2.tasks[0].turns[0].items.length, 2);
  assert.equal(s2.tasks[0].turns[0].items[1].content, "reply");
  // 往返后方法仍可用: 继续追加 -> 自动开新 turn
  s2.currentTask().appendTurn({ role: "user", content: "again" });
  assert.equal(s2.tasks[0].turns.length, 2);
});

test("currentTask 返回最后一个 task", () => {
  const s = createSession({ id: "s6" });
  const a = s.createTask();
  const b = s.createTask();
  assert.equal(s.currentTask().id, b.id);
  assert.notEqual(a.id, b.id);
});
