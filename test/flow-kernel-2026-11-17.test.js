// test/flow-kernel-2026-11-17.test.js — 入站流决策内核 (纯决策函数, 零发送/执行)
// 钉住: drop → replay → duplicate → thread → async/sync 的决策顺序与字段。
import test from "node:test";
import assert from "node:assert/strict";
import { planIngress, FLOW_ACTION } from "../src/flow/kernel.js";

const TRIGGER = {
  source: "feishu", from: "u1", group: "g1", thread: "",
  messageId: "m1", text: "hello", meta: {},
};

function stubAgent(overrides = {}) {
  return {
    config: { channels: { feishu: { async_reply: false } } },
    work: null,
    threadRoute: () => null,
    emitMessageReceived: () => {},
    ...overrides,
  };
}

test("kernel: 准入拒绝 → drop", async () => {
  const plan = await planIngress({
    agent: stubAgent(), channelName: "feishu", trigger: TRIGGER,
    admit: () => ({ allow: false, reason: "blacklist" }),
  });
  assert.equal(plan.action, FLOW_ACTION.DROP);
});

test("kernel: 空文本 → drop", async () => {
  const plan = await planIngress({
    agent: stubAgent(), channelName: "feishu",
    trigger: { ...TRIGGER, text: "" },
  });
  assert.equal(plan.action, FLOW_ACTION.DROP);
});

test("kernel: 已完成工单重发 → replay + cachedResult", async () => {
  const agent = stubAgent({
    work: { submit: () => ({ deduped: true, status: "done", result: "cached answer" }) },
  });
  const plan = await planIngress({ agent, channelName: "feishu", trigger: TRIGGER });
  assert.equal(plan.action, FLOW_ACTION.REPLAY);
  assert.equal(plan.cachedResult, "cached answer");
});

test("kernel: 在途工单去重 → duplicate", async () => {
  const agent = stubAgent({
    work: { submit: () => ({ deduped: true, status: "working" }) },
  });
  const plan = await planIngress({ agent, channelName: "feishu", trigger: TRIGGER });
  assert.equal(plan.action, FLOW_ACTION.DUPLICATE);
});

test("kernel: 长驻 worker 直通 → thread + threadPayload", async () => {
  const agent = stubAgent({
    work: { submit: () => null },
    threadRoute: (sk) => ({ worker: "w1" }),
  });
  const plan = await planIngress({ agent, channelName: "feishu", trigger: TRIGGER });
  assert.equal(plan.action, FLOW_ACTION.THREAD);
  assert.equal(plan.threadPayload.text, "hello");
  assert.equal(plan.threadPayload.sessionKey, plan.sessionKey);
});

test("kernel: 通道 async_reply → async", async () => {
  const agent = stubAgent({
    config: { channels: { feishu: { async_reply: true } } },
  });
  const plan = await planIngress({ agent, channelName: "feishu", trigger: TRIGGER });
  assert.equal(plan.action, FLOW_ACTION.ASYNC);
});

test("kernel: 默认同步 → sync, ticket 由 work.submit 建", async () => {
  const agent = stubAgent({
    work: { submit: (t, opts) => ({ id: "tk1", origin: "ingress" }) },
  });
  const plan = await planIngress({ agent, channelName: "feishu", trigger: TRIGGER });
  assert.equal(plan.action, FLOW_ACTION.SYNC);
  assert.ok(plan.ticket);
  assert.equal(plan.ticket.id, "tk1");
  assert.equal(plan.replyTo, "u1");
});

test("kernel: emitMessageReceived 观测不阻断", async () => {
  let emitted = 0;
  const agent = stubAgent({
    emitMessageReceived: () => { emitted++; throw new Error("EQ down"); },
  });
  const plan = await planIngress({ agent, channelName: "feishu", trigger: TRIGGER });
  assert.equal(emitted, 1);
  assert.equal(plan.action, FLOW_ACTION.SYNC);
});

test("kernel: replyMeta 有 thread/messageId 时产出 replyTo", async () => {
  const agent = stubAgent();
  const trigger = { ...TRIGGER, thread: "th1", messageId: "m99" };
  const plan = await planIngress({ agent, channelName: "feishu", trigger });
  assert.equal(plan.meta?.thread, "th1");
  assert.equal(plan.meta?.replyTo, "m99");
});
