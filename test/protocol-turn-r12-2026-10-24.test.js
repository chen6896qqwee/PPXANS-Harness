// test/protocol-turn-r12-2026-10-24.test.js - 第十二轮探测电池
// 对象: session/Turn 状态机 + protocol/SQ·EQ 双队列 (README v3.0 宣称的"交互主轴")。
// 方法论同 R11: 先探测后修复, 探测固化为本轮回归。
//   P1  Turn 状态机边界语义 (abort 残留 / aborted 后新输入 / 反序列化后 abort 污染历史)
//   P2  TurnProjection 接线 (宣称"投影层接入主链路", 实测是否真实可达)
//   P3  SQ 生产者/消费者 (chat 走一轮后 SQ 是否有真实 op 流转 + EQ 结构化事件)
//   P4  EQ seq 重启碰撞 (WAL 重启后 seq 是否从 WAL 续读)
//   P5  WAL 损坏行韧性 (replay 跳过坏行, 不丢好行)
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSession, serializeSession, deserializeSession } from "../src/session/turn.js";
import { TurnProjection } from "../src/session/projection.js";
import { createEventQueue, EventType } from "../src/protocol/index.js";
import { PPXAgent } from "../src/agent/index.js";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-r12-"));
}
function makeAgent() {
  const agent = new PPXAgent({ root: tmpRoot() });
  agent.llm = { chat: async () => ({ content: "" }) }; // "你好"走 _localIntent, 不触 LLM
  return agent;
}

// ---- P1: Turn 状态机边界语义 ----

test("P1a: abort 清空排队输入 (aborted turn 不遗留幽灵队列)", () => {
  const s = createSession({ id: "s-p1a" });
  const task = s.createTask();
  task.appendTurn("a");
  task.appendTurn("b"); // 排队
  task.appendTurn("c"); // 排队
  assert.equal(task.queuedUserInputs.length, 2);
  task.abort();
  // 中止语义: 被中断的 turn 连同它的排队输入一起作废 (codex TurnAborted 语义)
  assert.equal(task.queuedUserInputs.length, 0, "abort 后排队输入应清空");
});

test("P1b: 投影层 abort 后新输入开新 task (不复活 aborted task)", () => {
  const p = new TurnProjection();
  p.begin("k1", "第一轮");
  p.abort("k1");
  const before = p.status("k1");
  assert.equal(before.taskStatus, "aborted");
  p.begin("k1", "第二轮"); // 中止后用户再说话: 应开新 task, 而非在 aborted task 上续 turn
  const after = p.status("k1");
  assert.equal(after.taskStatus, "running", "新输入应开新 task");
  assert.equal(after.turnCount, 1, "新 task 的轮数从 1 起算");
  assert.equal(after.turns.length, 1);
  assert.equal(after.turns[0].status, "open");
});

test("P1c: 反序列化后 abort 不污染已 closed 的历史 turn", () => {
  const s = createSession({ id: "s-p1c" });
  const task = s.createTask();
  task.appendTurn("a");
  task.completeTurn(); // turn closed
  const s2 = deserializeSession(serializeSession(s));
  // 反序列化: 最后一个 turn 已 closed, currentTurn 不应指向它 (否则后续 abort 会
  // 把 closed 历史改写成 aborted —— 篡改历史)
  assert.equal(s2.tasks[0].currentTurn, null, "closed turn 不应被当作当前 turn 恢复");
  s2.tasks[0].abort();
  assert.equal(s2.tasks[0].turns[0].status, "closed", "abort 只能作用于 open turn, 不能改写 closed 历史");
});

// ---- P2: TurnProjection 接线 ----

test("P2: agent 装配 TurnProjection 且 chat 触发 turn 生命周期事件", async () => {
  const agent = makeAgent();
  try {
    assert.ok(agent.turnProjection, "agent 应装配 TurnProjection (projection.js 宣称已接入主链路)");
    const events = [];
    agent.bus?.on?.("chat/turn/begin", (ev) => events.push(ev));
    agent.bus?.on?.("chat/turn/end", (ev) => events.push(ev));
    await agent.chat("你好", { sessionKey: "p2-k" });
    const begins = events.filter((e) => e.type === "chat/turn/begin");
    const ends = events.filter((e) => e.type === "chat/turn/end");
    assert.equal(begins.length, 1, "应 emit 一次 chat/turn/begin");
    assert.equal(ends.length, 1, "应 emit 一次 chat/turn/end");
    assert.equal(ends[0].payload?.status, "closed");
    assert.equal(begins[0].payload?.sessionKey, "p2-k");
    // 投影状态可见
    const st = agent.turnProjection.status("p2-k");
    assert.equal(st.turnCount, 1);
    assert.equal(st.turns[0].status, "closed");
  } finally {
    agent.shutdown();
  }
});

// ---- P3: SQ 生产者/消费者 + EQ 结构化事件 ----

test("P3: chat 走一轮 = SQ 有 USER_TURN op 流转且收口清空 + EQ 收到 TURN_* 事件", async () => {
  const agent = makeAgent();
  try {
    const bus = agent.protocolBus;
    assert.ok(bus?.sq && bus?.eq, "protocolBus 应由 v3 插件装配");
    const eqEvents = [];
    bus.eq.subscribe((ev) => eqEvents.push(ev));
    await agent.chat("你好", { sessionKey: "p3-k" });
    const types = eqEvents.map((e) => e.type);
    assert.ok(types.includes(EventType.TURN_STARTED), `EQ 应收到 TURN_STARTED, 实际: ${types.join(",")}`);
    assert.ok(types.includes(EventType.TURN_CLOSED), `EQ 应收到 TURN_CLOSED, 实际: ${types.join(",")}`);
    const started = eqEvents.find((e) => e.type === EventType.TURN_STARTED);
    assert.equal(started.payload?.sessionKey, "p3-k");
    // SQ 收口: 本轮 op 已消费, 队列不留残留 (防长跑膨胀)
    assert.equal(bus.sq.size(), 0, `SQ 应收口清空, 实际残留 ${bus.sq.size()}`);
  } finally {
    agent.shutdown();
  }
});

// ---- P4: EQ seq 重启碰撞 ----

test("P4: EQ 重启后 seq 从 WAL 续读 (不与历史事件撞号)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-r12-wal-"));
  const wal = path.join(dir, "eq.wal.jsonl");
  const eq1 = createEventQueue({ walPath: wal });
  eq1.push({ type: "A" });
  eq1.push({ type: "B" });
  // 进程重启: 同一 WAL 新建 EQ
  const eq2 = createEventQueue({ walPath: wal });
  const ev = eq2.push({ type: "C" });
  const seqs = eq2.replay().map((e) => e.seq);
  assert.deepEqual(
    [...new Set(seqs)].length,
    seqs.length,
    `seq 不应重复: ${seqs.join(",")}`,
  );
  assert.equal(ev.seq, 3, `重启后 seq 应从 WAL 续读 (期望 3), 实际 ${ev.seq}`);
});

// ---- P5: WAL 损坏行韧性 ----

test("P5: WAL 中间损坏行被跳过, 好行不丢", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-r12-wal2-"));
  const wal = path.join(dir, "eq.wal.jsonl");
  fs.writeFileSync(
    wal,
    [
      JSON.stringify({ id: "e1", ts: 1, seq: 1, type: "A", payload: {} }),
      "{corrupted!!!",
      JSON.stringify({ id: "e2", ts: 2, seq: 2, type: "B", payload: {} }),
      "",
    ].join("\n"),
    "utf8",
  );
  const eq = createEventQueue({ walPath: wal });
  const replayed = eq.replay();
  assert.equal(replayed.length, 2, "坏行跳过, 好行全回放");
  assert.deepEqual(replayed.map((e) => e.id), ["e1", "e2"]);
});
