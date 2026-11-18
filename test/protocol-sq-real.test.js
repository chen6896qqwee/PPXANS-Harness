// test/protocol-sq-real.test.js - SQ 真实化回归 (2026-10-25)
//
// 背景 (评估报告 P1): SubmissionQueue 此前是"提交后同轮立即消费"的装饰性结构 ——
//   op 无时间戳、无队头语义、无腐烂清理, 中断也不走队列。本轮真实化:
//   1) op 带 submittedAt, FIFO 队头可判定 (atHead)
//   2) TTL 清扫: 崩溃轮遗留 op 不永久占队 (sweep), INTERRUPT 保留
//   3) consumeType: 只消费指定类型 (并发会话 USER_TURN 互不干扰)
//   4) interrupt() 走 SQ 控制通道: INTERRUPT op 入队 + EQ 推 TURN_ABORTED
//   5) 轮收口 (_turnObsEnd) 消费已生效的 INTERRU op, 队列回到真态
//   6) /health 暴露 protocol: { sqPending, eqSeq } 可观测
import test from "node:test";
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createSubmissionQueue, OpType } from "../src/protocol/index.js";
import { PPXAgent } from "../src/agent/index.js";

function tmpRoot(tag = "sqreal") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${tag}-`));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), "{}");
  return root;
}

test("SQ: op 带提交时刻, atHead 判定 FIFO 队头", () => {
  const sq = createSubmissionQueue();
  const a = sq.submit({ type: OpType.USER_TURN, payload: {} });
  const b = sq.submit({ type: OpType.USER_TURN, payload: {} });
  assert.equal(sq.atHead(a), true, "先提交的在队头");
  assert.equal(sq.atHead(b), false, "后提交的不在队头");
  assert.equal(sq.size(), 2);
  assert.ok(sq.pending().every((op) => typeof op.submittedAt === "number"), "op 应带 submittedAt");
});

test("SQ: sweep 清扫超时遗留 op, 但保留 INTERRUPT (控制 op 生命周期归轮收口)", () => {
  const sq = createSubmissionQueue();
  const now = Date.now();
  sq.submit({ type: OpType.USER_TURN, payload: {}, submittedAt: now - 20 * 60 * 1000 }); // 20min 前的死轮
  sq.submit({ type: OpType.INTERRUPT, payload: {}, submittedAt: now - 20 * 60 * 1000 }); // 同样老的中断
  sq.submit({ type: OpType.USER_TURN, payload: {} }); // 新鲜 op
  const stale = sq.sweep(10 * 60 * 1000);
  assert.equal(stale.length, 1, "只清扫超时的 USER_TURN");
  assert.equal(stale[0].type, OpType.USER_TURN);
  assert.equal(sq.size(), 2, "老 INTERRUPT + 新 op 保留");
  // pending 快照不消费
  assert.equal(sq.pending().length, 2);
  assert.equal(sq.size(), 2);
});

test("SQ: consumeType 只取走目标类型, 并发会话的 USER_TURN 不受影响", () => {
  const sq = createSubmissionQueue();
  sq.submit({ type: OpType.USER_TURN, payload: { sessionKey: "s1" } });
  sq.submit({ type: OpType.INTERRUPT, payload: {} });
  sq.submit({ type: OpType.USER_TURN, payload: { sessionKey: "s2" } });
  const taken = sq.consumeType(OpType.INTERRUPT);
  assert.equal(taken.length, 1);
  assert.equal(sq.size(), 2, "两个会话的在轮 op 应原样保留");
  assert.equal(sq.consumeType(OpType.INTERRUPT).length, 0, "再取为空");
});

test("agent: interrupt() 经 SQ 提交控制 op 并推 EQ 事件", () => {
  const root = tmpRoot("intr");
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  try {
    const bus = agent.protocolBus;
    assert.ok(bus?.sq, "协议总线应可用");
    const before = bus.sq.size();
    const eqBefore = bus.eq.history().length;
    agent.interrupt("sess-a");
    assert.equal(bus.sq.size(), before + 1, "INTERRUPT op 应入队");
    const pend = bus.sq.pending();
    assert.equal(pend[pend.length - 1].type, OpType.INTERRUPT);
    assert.equal(pend[pend.length - 1].payload.sessionKey, "sess-a");
    const hist = bus.eq.history();
    assert.equal(hist.length, eqBefore + 1, "EQ 应推一条事件");
    assert.equal(hist[hist.length - 1].type, "turn_aborted");
    assert.equal(hist[hist.length - 1].payload.cause, "interrupt");
    agent.clearInterrupt();
  } finally {
    agent.shutdown();
  }
});

test("agent: 轮收口消费已生效的 INTERRUPT, 并发会话 USER_TURN 原样保留", () => {
  const root = tmpRoot("obsend");
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  try {
    const bus = agent.protocolBus;
    // 模拟: 会话 s1 在轮 + 两个中断 op + 会话 s2 在轮
    agent._turnObsBegin("s1", "hi", "test");
    agent.interrupt();
    agent.interrupt();
    agent._turnObsBegin("s2", "yo", "test");
    assert.equal(bus.sq.size(), 4, "2 个 USER_TURN + 2 个 INTERRUPT");
    // s1 收口: 自己的 op + 全部 INTERRU 被消费
    const pendS1 = bus.sq.pending().find((op) => op.type === OpType.USER_TURN && op.payload.sessionKey === "s1");
    agent._turnObsEnd("s1", { opId: pendS1.id, turnId: null }, "aborted");
    const left = bus.sq.pending();
    assert.equal(left.length, 1, "只剩 s2 的在轮 op");
    assert.equal(left[0].payload.sessionKey, "s2");
    // s2 正常收口
    agent._turnObsEnd("s2", { opId: left[0].id, turnId: null }, "closed");
    assert.equal(bus.sq.size(), 0, "队列应清空");
  } finally {
    agent.shutdown();
  }
});

test("agent: protocolStats 暴露 sqPending/eqSeq (可观测)", () => {
  const root = tmpRoot("pstats");
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  try {
    const stats = agent.protocolStats();
    assert.equal(typeof stats.sqPending, "number");
    assert.equal(typeof stats.eqSeq, "number");
    agent._turnObsBegin("sx", "hi", "test");
    assert.equal(agent.protocolStats().sqPending, 1, "在轮 op 应计入 sqPending");
    const pend = agent.protocolBus.sq.pending();
    agent._turnObsEnd("sx", { opId: pend[0].id, turnId: null }, "closed");
    assert.equal(agent.protocolStats().sqPending, 0);
  } finally {
    agent.shutdown();
  }
});
