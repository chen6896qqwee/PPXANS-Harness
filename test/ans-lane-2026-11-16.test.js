// test/ans-lane-2026-11-16.test.js — ANS 车道运行时路由 (假 manager/agent, 零网络)
// 钉住: handles 闸门、notify/submit 双模式、IM 降噪、显式/周期桶去重、限流、
// 加严工具黑名单的安装与还原、失败回投、async/sync/直发三条投递路径。
import test from "node:test";
import assert from "node:assert/strict";
import { createAnsLane } from "../src/channels/ans-lane.js";

function lane(overrides = {}) {
  return {
    version: "ans_lane.v1", enabled: true, internal_only: true, origin: "ans",
    sources: ["proactive", "watchdog"], mode: "notify", create_ticket: false,
    targets: [{ channel: "feishu", to: "chat-1" }],
    delivery: { route: "async", max_attempts: 4, backoff_ms: 2000, backoff_cap_ms: 60000, jitter_ratio: 0, ttl_ms: 3600000, deadline_ms: 15000 },
    dedupe: { strategy: "none", bucket_ms: 1000, key_prefix: "ans", window_ms: 30000 },
    rate_limit: { min_interval_ms: 0, max_per_hour: 100 },
    security: { inherit: true, extra_deny_tools: [] },
    ...overrides,
  };
}

function fakeManager({ delivery, channelSend } = {}) {
  const calls = { sends: [], enqueues: [], sendSync: [] };
  const manager = {
    config: { output: {} },
    get(name) {
      if (name !== "feishu") return null;
      return { send: async (to, text, meta) => { calls.sends.push({ to, text, meta }); return { messageId: "m1" }; } };
    },
    delivery,
  };
  if (delivery === undefined) {
    manager.delivery = { enqueue: (job) => { calls.enqueues.push(job); return { queued: true, id: "q1" }; } };
  }
  manager.calls = calls;
  return manager;
}
function fakeAgent() {
  const agent = {};
  agent.calls = [];
  agent.chatTracked = async (text, opts) => { agent.calls.push({ text, opts }); return { reply: "**done**", ticketId: "t1", assignmentId: "a1" }; };
  return agent;
}
const send = async () => ({ messageId: "m1" });

test("ans-lane: handles 闸门 (enabled/internal_only/来源白名单)", async () => {
  const off = createAnsLane({ lane: { ...lane(), enabled: false }, manager: fakeManager() });
  assert.equal(off.handles("proactive"), false);
  const noInternal = createAnsLane({ lane: { ...lane(), internal_only: false }, manager: fakeManager() });
  assert.equal(noInternal.handles("proactive"), false);
  const on = createAnsLane({ lane: lane(), manager: fakeManager() });
  assert.equal(on.handles("proactive"), true);
  assert.equal(on.handles("watchdog"), true);
  assert.equal(on.handles("cron"), false);
  const bare = createAnsLane({ manager: fakeManager() });
  assert.equal(bare.handles("proactive"), false);
});

test("ans-lane: notify 关闭/空文本路径", async () => {
  const off = createAnsLane({ lane: { ...lane(), enabled: false }, manager: fakeManager() });
  assert.equal((await off.notify({ source: "proactive", text: "x" })).handled, false);
  const on = createAnsLane({ lane: lane(), manager: fakeManager() });
  const empty = await on.notify({ source: "proactive", text: "" });
  assert.equal(empty.handled, true);
  assert.equal(empty.reason, "empty_text");
});

test("ans-lane: notify async 入队, IM 降噪生效, 计数正确", async () => {
  const manager = fakeManager();
  const on = createAnsLane({ lane: lane(), manager });
  const r = await on.notify({ source: "proactive", text: "**提醒**\n### 体检" });
  assert.equal(r.handled, true);
  assert.equal(r.mode, "notify");
  assert.equal(r.targets.length, 1);
  assert.equal(r.targets[0].queued, true);
  assert.ok(r.targets[0].deliveryId.startsWith("ans:proactive:"));
  const job = manager.calls.enqueues[0];
  assert.equal(job.channel, "feishu");
  assert.equal(job.to, "chat-1");
  assert.equal(job.text, "提醒\n【体检】", "IM 信道应剥离 markdown");
  assert.equal(job.meta.origin, "ans");
  assert.equal(job.meta.ansSource, "proactive");
  assert.ok(job.meta.deliveryId);
  const s = on.stats();
  assert.equal(s.notified, 1);
  assert.equal(s.queued, 1);
});

test("ans-lane: notify 去重三条路径 (enqueue duplicate / explicit key / 周期桶)", async () => {
  const dupManager = fakeManager({ delivery: { enqueue: () => ({ queued: false, reason: "duplicate" }) } });
  const a = createAnsLane({ lane: lane(), manager: dupManager });
  await a.notify({ source: "proactive", text: "x" });
  const s = a.stats();
  assert.equal(s.deduped, 1);

  const manager = fakeManager();
  const explicit = createAnsLane({ lane: lane({ dedupe: { strategy: "none", bucket_ms: 1000, key_prefix: "ans", window_ms: 5000 } }), manager });
  await explicit.notify({ source: "proactive", text: "x", key: "k1" });
  const again = await explicit.notify({ source: "proactive", text: "x", key: "k1" });
  assert.equal(again.deduped, true);
  assert.equal(explicit.stats().deduped, 1);

  let t = 1000;
  const bucketManager = fakeManager();
  const bucket = createAnsLane({
    lane: lane({ dedupe: { strategy: "period_bucket", bucket_ms: 1000, key_prefix: "ans", window_ms: 5000 } }),
    manager: bucketManager, now: () => t,
  });
  await bucket.notify({ source: "proactive", text: "x" });
  t = 1500;
  const same = await bucket.notify({ source: "proactive", text: "x" });
  assert.equal(same.deduped, true, "同周期桶应去重");
  t = 2000;
  const next = await bucket.notify({ source: "proactive", text: "x" });
  assert.equal(next.deduped, false, "跨周期不再去重");
});

test("ans-lane: notify 入队抛错计 failed; 通道未启动计 skipped", async () => {
  const manager = fakeManager({ delivery: { enqueue: () => { throw new Error("queue down"); } } });
  const a = createAnsLane({ lane: lane(), manager });
  const r = await a.notify({ source: "proactive", text: "x" });
  assert.equal(r.targets[0].error, "queue down");
  assert.equal(a.stats().failed, 1);
  const noChan = fakeManager();
  noChan.get = () => null;
  const b = createAnsLane({ lane: lane(), manager: noChan });
  const r2 = await b.notify({ source: "proactive", text: "x" });
  assert.equal(r2.targets[0].skipped, true);
  assert.equal(r2.targets[0].reason, "channel_not_started");
  assert.equal(b.stats().skipped, 1);
});

test("ans-lane: notify sync 路径与直发降级", async () => {
  const syncManager = fakeManager({ delivery: { sendSyncJob: (job) => { return { ok: true }; } } });
  const a = createAnsLane({ lane: lane({ delivery: { route: "sync", max_attempts: 4, backoff_ms: 2000, backoff_cap_ms: 60000, jitter_ratio: 0, ttl_ms: 3600000, deadline_ms: 15000 } }), manager: syncManager });
  const r = await a.notify({ source: "proactive", text: "x" });
  assert.equal(r.targets[0].sent, true);
  assert.equal(a.stats().sent, 1);
  const syncThrow = fakeManager({ delivery: { sendSyncJob: () => { throw new Error("sync down"); } } });
  const b = createAnsLane({ lane: lane({ delivery: { route: "sync", max_attempts: 4, backoff_ms: 2000, backoff_cap_ms: 60000, jitter_ratio: 0, ttl_ms: 3600000, deadline_ms: 15000 } }), manager: syncThrow });
  const r2 = await b.notify({ source: "proactive", text: "x" });
  assert.equal(r2.targets[0].sent, false);
  assert.equal(b.stats().failed, 1);
  const direct = fakeManager({ delivery: null });
  const c = createAnsLane({ lane: lane(), manager: direct });
  const r3 = await c.notify({ source: "proactive", text: "x" });
  assert.equal(r3.targets[0].sent, true);
  assert.equal(direct.calls.sends.length, 1);
  const noSend = fakeManager({ delivery: null });
  noSend.get = () => ({}); // 通道已启动但缺 send 实现
  const d = createAnsLane({ lane: lane(), manager: noSend });
  const r4 = await d.notify({ source: "proactive", text: "x" });
  assert.equal(r4.targets[0].error, "no_delivery");
});

test("ans-lane: notify 限流 (每小时内/max_per_hour)", async () => {
  const manager = fakeManager();
  const a = createAnsLane({ lane: lane({ rate_limit: { min_interval_ms: 0, max_per_hour: 1 } }), manager });
  const first = await a.notify({ source: "proactive", text: "x" });
  assert.equal(first.targets[0].queued, true);
  const second = await a.notify({ source: "proactive", text: "y" });
  assert.equal(second.targets[0].rateLimited, true);
  const s = a.stats();
  assert.equal(s.rateLimited, 1);
  assert.equal(s.dropped, 1);
});

test("ans-lane: submit 成功路径 (加严工具安装与还原, 回执身份带工单)", async () => {
  const manager = fakeManager();
  const agent = fakeAgent();
  const a = createAnsLane({
    lane: lane({ security: { inherit: true, extra_deny_tools: ["run_command"] } }),
    manager, agent,
  });
  let denyDuring = null;
  agent.chatTracked = async (text, opts) => {
    denyDuring = agent._ansDenyToolsBySession?.get(opts.sessionKey);
    agent.calls.push({ text, opts });
    return { reply: "**done**", ticketId: "t1", assignmentId: "a1" };
  };
  const r = await a.submit({ source: "proactive", text: "做体检" });
  assert.equal(r.handled, true);
  assert.equal(r.submitted, true);
  assert.equal(r.ticketId, "t1");
  assert.equal(r.assignmentId, "a1");
  assert.equal(r.targets.length, 1);
  const job = manager.calls.enqueues[0];
  assert.equal(job.meta.ticketId, "t1");
  assert.equal(job.meta.assignmentId, "a1");
  assert.equal(job.text, "done", "回投文本同样经 IM 降噪");
  assert.ok(denyDuring.has("run_command"), "submit 期间按会话加严黑名单");
  assert.ok(!agent._ansDenyToolsBySession.has("ppx:ans:proactive"), "结束后应还原");
  const s = a.stats();
  assert.equal(s.submitted, 1);
  assert.equal(s.queued, 1);
});

test("ans-lane: submit 空文本/no_agent/被工作流去重", async () => {
  const manager = fakeManager();
  const empty = createAnsLane({ lane: lane(), manager, agent: fakeAgent() });
  const e = await empty.submit({ source: "proactive", text: "" });
  assert.equal(e.reason, "empty_text");
  const noAgent = createAnsLane({ lane: lane(), manager });
  const n = await noAgent.submit({ source: "proactive", text: "x" });
  assert.equal(n.reason, "no_agent");
  const agent = fakeAgent();
  agent.chatTracked = async () => ({ deduped: true, ticketId: "t9" });
  const d = createAnsLane({ lane: lane(), manager, agent });
  const r = await d.submit({ source: "proactive", text: "x" });
  assert.equal(r.deduped, true);
  assert.equal(r.ticketId, "t9");
  assert.equal(d.stats().deduped, 1);
});

test("ans-lane: submit 抛错回投失败且不占去重窗口", async () => {
  const manager = fakeManager();
  const agent = fakeAgent();
  let n = 0;
  agent.chatTracked = async () => {
    n += 1;
    if (n === 1) { const e = new Error("boom"); e.ticketId = "t2"; throw e; }
    return { reply: "ok2", ticketId: "t3", assignmentId: "a3" };
  };
  const a = createAnsLane({ lane: lane(), manager, agent });
  const fail = await a.submit({ source: "proactive", text: "x" });
  assert.equal(fail.submitted, false);
  assert.equal(fail.error, "boom");
  assert.equal(fail.ticketId, "t2");
  assert.equal(fail.targets.length, 1);
  const failureJob = manager.calls.enqueues[0];
  assert.match(failureJob.text, /ANS proactive 执行失败/);
  assert.equal(failureJob.meta.ticketId, "t2");
  const retry = await a.submit({ source: "proactive", text: "x" });
  assert.equal(retry.submitted, true, "失败不占去重窗口, 下一次允许重试");
  assert.equal(n, 2);
  assert.equal(a.stats().failed, 1);
});

test("ans-lane: submit 限流按来源整体计数", async () => {
  const manager = fakeManager();
  const agent = fakeAgent();
  const a = createAnsLane({
    lane: lane({ rate_limit: { min_interval_ms: 0, max_per_hour: 1 } }),
    manager, agent,
  });
  await a.submit({ source: "proactive", text: "x" });
  const second = await a.submit({ source: "proactive", text: "y" });
  assert.equal(second.rateLimited, true);
  assert.equal(agent.calls.length, 1);
  const s = a.stats();
  assert.equal(s.rateLimited, 1);
});

test("ans-lane: statsSnapshot 反映各计数", async () => {
  const manager = fakeManager();
  const a = createAnsLane({ lane: lane(), manager });
  await a.notify({ source: "proactive", text: "x" });
  const s = a.stats();
  assert.equal(s.notified, 1);
  assert.equal(s.queued, 1);
  assert.equal(s.recentKeys, 0, "strategy=none 不留去重键");
});
