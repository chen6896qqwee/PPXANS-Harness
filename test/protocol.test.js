// test/protocol.test.js - SQ/EQ 双队列 + 便捷总线测试
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSubmissionQueue,
  createEventQueue,
  createProtocolBus,
  OpType,
  EventType,
} from "../src/protocol/index.js";

test("SQ: submit 返回 id 且按提交顺序排队", () => {
  const sq = createSubmissionQueue();
  const id1 = sq.submit({ type: OpType.USER_TURN, payload: { text: "hi" } });
  const id2 = sq.submit({ type: OpType.INTERRUPT, payload: {} });
  assert.ok(id1 && id2);
  const all = sq.drain();
  assert.equal(all.length, 2);
  assert.equal(all[0].id, id1);
  assert.equal(all[1].id, id2);
  assert.equal(sq.drain().length, 0); // 已清空
});

test("SQ: nextIdle 逐个出队 (空则 null)", () => {
  const sq = createSubmissionQueue();
  const id1 = sq.submit({ type: OpType.USER_TURN, payload: {} });
  const id2 = sq.submit({ type: OpType.APPROVE, payload: {} });
  assert.equal(sq.nextIdle().id, id1);
  assert.equal(sq.nextIdle().id, id2);
  assert.equal(sq.nextIdle(), null);
});

test("SQ: 默认 id 形如 t_<时间戳>_<序号>", () => {
  const sq = createSubmissionQueue();
  const id = sq.submit({ type: OpType.USER_TURN, payload: {} });
  assert.match(id, /^t_\d+_\d+$/);
});

test("EQ: push 自增 seq 并同步通知订阅回调", () => {
  const eq = createEventQueue();
  const seen = [];
  eq.subscribe((ev) => seen.push(ev));
  const e1 = eq.push({ type: EventType.AGENT_MESSAGE, payload: { text: "a" } });
  const e2 = eq.push({ type: EventType.TOOL_CALLED, payload: { name: "x" } });
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].seq, 2);
});

test("EQ: history 内存历史 + replay 读 WAL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-eq-"));
  const wal = path.join(dir, "eq.jsonl");
  const eq = createEventQueue({ walPath: wal });
  eq.push({ type: EventType.TASK_STARTED, payload: {} });
  eq.push({ type: EventType.TASK_COMPLETE, payload: {} });
  assert.equal(eq.history().length, 2);
  const eq2 = createEventQueue({ walPath: wal });
  const replayed = eq2.replay();
  assert.equal(replayed.length, 2);
  assert.equal(replayed[0].seq, 1);
  assert.equal(replayed[1].type, EventType.TASK_COMPLETE);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("EQ: walPath 给定时追加写 JSONL (含不存在的目录)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-eq-"));
  const wal = path.join(dir, "sub", "eq.jsonl"); // 子目录不存在
  const eq = createEventQueue({ walPath: wal });
  eq.push({ type: EventType.ERROR, payload: { msg: "x" } });
  assert.ok(fs.existsSync(wal), "WAL 文件已创建 (含目录自动创建)");
  const lines = fs.readFileSync(wal, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("error"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("常量齐全: OpType 与 EventType", () => {
  for (const k of ["USER_TURN", "INTERRUPT", "RESUME", "APPROVE", "DENY"]) {
    assert.ok(OpType[k], `OpType.${k}`);
  }
  for (const k of [
    "TASK_STARTED", "AGENT_MESSAGE", "TOOL_CALLED", "TOOL_OUTPUT",
    "APPROVAL_REQUESTED", "APPROVAL_RESOLVED", "TASK_COMPLETE", "TASK_ABORTED",
    "TURN_DIFF", "ERROR", "TOKEN_COUNT", "PLAN_UPDATED", "COMPACTED",
  ]) {
    assert.ok(EventType[k], `EventType.${k}`);
  }
});

test("ProtocolBus: submitUserTurn/interrupt 写入 SQ, close 可调用", () => {
  const bus = createProtocolBus({});
  assert.ok(bus.sq && bus.eq);
  const id = bus.submitUserTurn("hello");
  assert.equal(bus.sq.nextIdle().id, id);
  const iid = bus.interrupt();
  assert.equal(bus.sq.nextIdle().type, OpType.INTERRUPT);
  assert.doesNotThrow(() => bus.close());
});

test("ProtocolBus: walPath 透传到 EQ", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-eq-"));
  const wal = path.join(dir, "bus.jsonl");
  const bus = createProtocolBus({ walPath: wal });
  bus.eq.push({ type: EventType.TOKEN_COUNT, payload: { n: 1 } });
  assert.ok(bus.eq.replay().length >= 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
