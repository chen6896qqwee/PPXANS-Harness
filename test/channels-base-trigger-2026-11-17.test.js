// test/channels-base-trigger-2026-11-17.test.js — Channel.handleTrigger 执行路径分支测试
// 全程 stub agent (chat/chatAsync/threadForward/threadRoute/llm) + 真 workgraph 账本 (临时目录),
// 每个分支一条测试: DROP/REPLAY/DUPLICATE/THREAD/ASYNC/SYNC/提炼/元认知三规则/兜底辅助。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Channel } from "../src/channels/base.js";
import { createTrigger } from "../src/flow/trigger.js";
import { createWorkStore, createWorkService, DELIVERY_STATE } from "../src/workgraph/index.js";
import { DEFAULT_SYNC_DEADLINE_MS } from "../src/channels/receipts.js";

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-base-${tag}-`));
}

class FakeChannel extends Channel {
  constructor(agent, name = "fake") {
    super(name, agent);
    this.sent = [];
  }
  async send(to, text, meta = null) {
    this.sent.push({ to, text, meta });
    return { ok: true, messageId: "pm_1" };
  }
}

function makeWork(tag) {
  const store = createWorkStore({ dir: tmpdir(tag) });
  return { store, work: createWorkService({ store }) };
}

function makeAgent(overrides = {}) {
  const agent = {
    config: { channels: { output: {} }, agent: {} },
    threadRoute: () => null,
    chat: async (text, opts) => `echo:${text}`,
    chatAsync: null,
    threadForward: async () => ({ forwarded: true, reply: "thread-reply", envelope: null }),
    ...overrides,
  };
  return agent;
}

function gateLLM(payload) {
  return { chat: async () => ({ content: JSON.stringify(payload) }) };
}

const settle = () => new Promise((r) => setImmediate(r));

// ---- 基类默认行为 ----

test("base: 默认 connect/send 未实现, disconnect 置位, mount 为空", async () => {
  const ch = new Channel("bare", null);
  await assert.rejects(ch.connect(), /bare: connect\(\) 未实现/);
  await assert.rejects(ch.send("u", "t"), /bare: send\(\) 未实现/);
  await ch.disconnect();
  assert.equal(ch.connected, false);
  assert.equal(ch.mount({}), null);
});

test("base: test() 连接成功/失败两路", async () => {
  const ok = new FakeChannel(null, "fake");
  ok.connect = async () => { ok.connected = true; };
  assert.deepEqual(await ok.test(), { ok: true, detail: "fake 配置有效" });
  const bad = new FakeChannel(null, "fake");
  const r = await bad.test();
  assert.equal(r.ok, false);
  assert.match(r.detail, /connect\(\) 未实现/);
});

test("base: _registrar 优先统一路由表, 无主通道退化 server.on(request)", () => {
  const ch = new FakeChannel(null);
  const reg = [];
  const viaTable = ch._registrar({}, { registerWebhook: (p, f) => reg.push([p, f]) });
  viaTable("/hook", () => {});
  assert.equal(reg.length, 1);
  assert.equal(reg[0][0], "/hook");
  const events = [];
  const server = { on: (ev, f) => events.push([ev, f]) };
  ch._registrar(server, null)("/raw", () => {});
  assert.deepEqual(events, [["request", events[0][1]]]);
  assert.equal(events[0][0], "request");
});

test("base: _readBody 读满请求体 (多字节安全), _sendJson 写 JSON 响应", async () => {
  const ch = new FakeChannel(null);
  async function* chunks(...xs) { for (const x of xs) yield typeof x === "string" ? Buffer.from(x, "utf8") : x; }
  assert.equal(await ch._readBody(chunks('{"a":', "中}")), '{"a":中}', "Buffer 先拼接再整体 decode, 不破坏多字节字符");
  const writes = [];
  const res = { writeHead: (code, h) => writes.push(["head", code, h]), end: (b) => writes.push(["end", b]) };
  ch._sendJson(res, 418, { ok: true });
  assert.equal(writes[0][1], 418);
  assert.equal(writes[0][2]["Content-Type"], "application/json");
  assert.equal(writes[1][1], '{"ok":true}');
});

// ---- DROP ----

test("handleTrigger: 空 trigger 与空文本 → DROP 返回 null", async () => {
  const ch = new FakeChannel(makeAgent());
  assert.equal(await ch.handleTrigger(null), null);
  const empty = new FakeChannel(makeAgent(), "fake2");
  assert.equal(await empty.handleTrigger(createTrigger({ from: "u0", text: "" })), null);
  assert.equal(empty.sent.length, 0);
});

test("handleTrigger: mode=off 准入拒绝 → DROP", async () => {
  const agent = makeAgent({ config: { channels: {}, agent: { trigger_policy: { mode: "off" } } } });
  const ch = new FakeChannel(agent);
  assert.equal(await ch.handleTrigger(createTrigger({ from: "u1", text: "hi" })), null);
  assert.equal(ch.sent.length, 0);
});

// ---- SYNC 主路径 ----

test("handleTrigger: SYNC 主路径 — chat 收 sessionKey, 发送整形回复, 工单落 done", async () => {
  const { work, store } = makeWork("sync");
  let chatOpts = null;
  const agent = makeAgent({ work, chat: async (text, opts) => { chatOpts = opts; return `echo:${text}`; } });
  const ch = new FakeChannel(agent);
  const reply = await ch.handleTrigger(createTrigger({ source: "fake", from: "u1", messageId: "m1", text: "你好" }));
  assert.equal(reply, "echo:你好");
  assert.equal(chatOpts.sessionKey, "ppx:fake:u1:dm");
  assert.equal(ch.sent.length, 1);
  assert.equal(ch.sent[0].to, "u1");
  assert.equal(ch.sent[0].text, "echo:你好");
  const tickets = [...store.list?.() ?? []];
  const ticket = tickets.find((t) => t.result === "echo:你好");
  assert.ok(ticket, "工单应记录执行结果");
  assert.equal(ticket.status, "done");
});

test("handleTrigger: SYNC chat 抛错 → work.fail 落 failed 并上抛", async () => {
  const { work, store } = makeWork("syncfail");
  const agent = makeAgent({ work, chat: async () => { throw new Error("模型挂了"); } });
  const ch = new FakeChannel(agent);
  await assert.rejects(ch.handleTrigger(createTrigger({ from: "u1", messageId: "m2", text: "hi" })), /模型挂了/);
  const tickets = [...store.list?.() ?? []];
  assert.ok(tickets.some((t) => t.status === "failed"));
});

// ---- REPLAY / DUPLICATE ----

test("handleTrigger: 同 messageId 重试命中已完成工单 → REPLAY 重发缓存结果", async () => {
  const { work } = makeWork("replay");
  let chatCalls = 0;
  const agent = makeAgent({ work, chat: async () => { chatCalls += 1; return "首次回答"; } });
  const ch = new FakeChannel(agent);
  await ch.handleTrigger(createTrigger({ from: "u1", messageId: "m1", text: "hi" }));
  assert.equal(chatCalls, 1);
  assert.equal(ch.sent.length, 1);
  const replay = await ch.handleTrigger(createTrigger({ from: "u1", messageId: "m1", text: "hi" }));
  assert.equal(replay, "首次回答");
  assert.equal(chatCalls, 1, "REPLAY 不应重新执行");
  assert.equal(ch.sent.length, 2, "REPLAY 应重发缓存结果");
  assert.equal(ch.sent[1].text, "首次回答");
  assert.equal(ch.sent[1].meta.replyTo, "m1");
});

test("handleTrigger: 在途工单重投 → DUPLICATE 直接返回受理态", async () => {
  const { work, store } = makeWork("dup");
  const agent = makeAgent({ work });
  const trigger = createTrigger({ from: "u1", messageId: "m9", text: "在途" });
  work.submit(trigger, { sessionKey: "ppx:fake:u1:dm" });
  const ch = new FakeChannel(agent);
  const r = await ch.handleTrigger(trigger);
  assert.deepEqual(r, { deduped: true, ticketId: r.ticketId, status: "admitted" });
  const ticket = [...store.list?.() ?? []].find((t) => t.id === r.ticketId);
  assert.equal(ticket.status, "admitted");
  assert.equal(ch.sent.length, 0);
});

// ---- 需求提炼前缀 ----

test("handleTrigger: task_extract 启用 → [需求提炼] 前缀注入 SYNC 消息", async () => {
  const { work } = makeWork("extract");
  let saw = null;
  const agent = makeAgent({    work,
    chat: async (text) => { saw = text; return "ok"; },
    config: { channels: {}, agent: { task_extract: { enabled: true, semantic: false } } },
  });
  const ch = new FakeChannel(agent);
  await ch.handleTrigger(createTrigger({ from: "u1", text: "请整理这份清单并发给我，明天中午前完成" }));
  assert.ok(saw.startsWith("[需求提炼] "), "任务消息应带提炼前缀");
  assert.ok(saw.includes("请整理这份清单并发给我，明天中午前完成"), "原文必须保留");
  assert.ok(saw.includes("目标:"), "程序层应给出目标提示");
});

// ---- 元认知规则一/二/三 ----

test("handleTrigger: 规则一 lowConfidence → 回执 meta 与工单双路透传", async () => {
  const { work, store } = makeWork("lowconf");
  const agent = makeAgent({
    work,
    llm: gateLLM({ confidence: 0.2, rationale: "信息不足", suggested_action: "proceed" }),
    config: { channels: {}, agent: { metacognition_gate: { enabled: true, threshold: 0.9 } } },
  });
  const ch = new FakeChannel(agent);
  await ch.handleTrigger(createTrigger({ from: "u1", messageId: "lc1", text: "干点活" }));
  assert.equal(ch.sent.length, 1);
  assert.equal(ch.sent[0].meta.lowConfidence, true);
  const ticket = [...store.list?.() ?? []].find((t) => t.text === "干点活");
  assert.equal(ticket.lowConfidence, true);
});

test("handleTrigger: 规则二 同 dedupeKey 重复低置信 → escalated=repeated_low_confidence", async () => {
  const begun = [];
  const workStub = {
    submit: () => ({ id: "t-stub", dedupeKey: null, origin: "ingress" }),
    begin: (ticketId, extra) => { begun.push({ ticketId, extra }); return { id: "as1" }; },
    complete: () => {},
    fail: () => {},
  };
  const agent = makeAgent({
    work: workStub,
    llm: gateLLM({ confidence: 0.1, rationale: "没把握", suggested_action: "proceed" }),
    config: { channels: {}, agent: { metacognition_gate: { enabled: true, threshold: 0.9 } } },
  });
  const ch = new FakeChannel(agent);
  await ch.handleTrigger(createTrigger({ from: "u1", messageId: "r1", text: "第一遍", meta: { dedupeKey: "rk" } }));
  await ch.handleTrigger(createTrigger({ from: "u1", messageId: "r2", text: "第二遍", meta: { dedupeKey: "rk" } }));
  assert.equal(begun.length, 2);
  assert.equal(begun[0].extra.metacognition?.escalated, undefined);
  assert.equal(begun[1].extra.metacognition?.escalated, "repeated_low_confidence");
});

test("handleTrigger: 规则三 reroute_enabled 低置信 clarify → 不执行改提问", async () => {
  const { work, store } = makeWork("reroute");
  let chatCalls = 0;
  const agent = makeAgent({
    work,
    chat: async () => { chatCalls += 1; return "不该被调用"; },
    llm: gateLLM({ confidence: 0.2, rationale: "缺少目标", suggested_action: "clarify" }),
    config: { channels: {}, agent: { metacognition_gate: { enabled: true, reroute_enabled: true, threshold: 0.9 } } },
  });
  const ch = new FakeChannel(agent);
  const r = await ch.handleTrigger(createTrigger({ from: "u1", messageId: "rr1", text: "这个弄一下" }));
  assert.equal(chatCalls, 0, "改道后不应进入执行");
  assert.equal(r.rerouted, "clarify");
  assert.equal(r.reason, "缺少目标");
  assert.ok(r.confidence < 0.9);
  assert.equal(ch.sent.length, 1);
  assert.match(ch.sent[0].text, /\[需要澄清\]/);
  assert.match(ch.sent[0].text, /缺少目标/);
  assert.equal(ch.sent[0].meta.kind, "clarify");
  assert.equal(ch.sent[0].meta.rerouted, "clarify");
  const ticket = [...store.list?.() ?? []].find((t) => t.rerouted === "clarify");
  assert.ok(ticket, "工单应带 rerouted 标记");
});

test("handleTrigger: 规则三 clarify 发送失败 → workFail 落账并上抛", async () => {
  const { work, store } = makeWork("reroutefail");
  const agent = makeAgent({
    work,
    llm: gateLLM({ confidence: 0.2, rationale: "缺信息", suggested_action: "clarify" }),
    config: { channels: {}, agent: { metacognition_gate: { enabled: true, reroute_enabled: true, threshold: 0.9 } } },
  });
  const ch = new FakeChannel(agent);
  ch.send = async () => { throw new Error("通道挂了"); };
  await assert.rejects(ch.handleTrigger(createTrigger({ from: "u1", messageId: "rr2", text: "这个弄一下" })), /通道挂了/);
  const tickets = [...store.list?.() ?? []];
  assert.ok(tickets.some((t) => t.rerouted === "clarify"), "发送失败不改写已落的 rerouted 终态");
});

// ---- THREAD 直通 ----

test("handleTrigger: THREAD 直通 — 信封带 ticketId/assignmentId, onExecuted 收口, 工单落 done", async () => {
  const { work, store } = makeWork("thread");
  const seen = [];
  const agent = makeAgent({
    work,
    threadRoute: () => ({ name: "w1" }),
    threadForward: async (payload, opts) => {
      seen.push({ payload, timeoutMs: opts.timeoutMs });
      opts.onProgress({ rounds: 1 });
      opts.onExecuted("thread-reply", { rounds: 2, steps: 3 });
      return { forwarded: true, reply: "thread-reply", envelope: { rounds: 2, steps: 3 } };
    },
    _workProgressTick: () => {},
  });
  const ch = new FakeChannel(agent);
  const r = await ch.handleTrigger(createTrigger({ source: "fake", from: "u1", messageId: "t1", thread: "root1", text: "继续做" }));
  assert.deepEqual(r, { delegated: true, worker: "w1", reason: null });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].payload.text, "继续做");
  assert.equal(seen[0].payload.source, "fake");
  assert.ok(seen[0].payload.ticketId, "信封必须带 ticketId");
  assert.ok(seen[0].payload.assignmentId, "信封必须带 assignmentId");
  assert.equal(seen[0].payload.origin, "ingress");
  assert.equal(seen[0].timeoutMs, undefined, "无显式 forward_timeout_ms 沿用桥默认");
  const ticket = [...store.list?.() ?? []].find((t) => t.result === "thread-reply");
  assert.ok(ticket, "onExecuted 应把结果落账");
  assert.equal(ticket.status, "done");
});

test("handleTrigger: THREAD forwarded=true 但无 onExecuted → 兜底 workDone", async () => {
  const { work, store } = makeWork("thread2");
  const agent = makeAgent({
    work,
    threadRoute: () => ({ name: "w2" }),
    threadForward: async () => ({ forwarded: true, reply: "迟到的回复", envelope: null }),
  });
  const ch = new FakeChannel(agent);
  const r = await ch.handleTrigger(createTrigger({ from: "u1", messageId: "t2", text: "hi" }));
  assert.equal(r.delegated, true);
  const ticket = [...store.list?.() ?? []].find((t) => t.result === "迟到的回复");
  assert.ok(ticket, "无 onExecuted 也应兜底落账");
});

test("handleTrigger: THREAD forward 失败 → workFail 落 failed, 返回 delegated:false", async () => {
  const { work, store } = makeWork("thread3");
  const agent = makeAgent({
    work,
    threadRoute: () => ({ name: "w3" }),
    threadForward: async () => ({ forwarded: false, reason: "worker_busy" }),
  });
  const ch = new FakeChannel(agent);
  const r = await ch.handleTrigger(createTrigger({ from: "u1", messageId: "t3", text: "hi" }));
  assert.deepEqual(r, { delegated: false, worker: "w3", reason: "worker_busy" });
  const tickets = [...store.list?.() ?? []];
  assert.ok(tickets.some((t) => t.status === "failed"));
});

test("handleTrigger: threadForward 抛错 → workFail 并上抛", async () => {
  const { work, store } = makeWork("thread4");
  const agent = makeAgent({
    work,
    threadRoute: () => ({ name: "w4" }),
    threadForward: async () => { throw new Error("桥炸了"); },
  });
  const ch = new FakeChannel(agent);
  await assert.rejects(ch.handleTrigger(createTrigger({ from: "u1", messageId: "t4", text: "hi" })), /桥炸了/);
  const tickets = [...store.list?.() ?? []];
  assert.ok(tickets.some((t) => t.status === "failed"));
});

// ---- ASYNC 受理 ----

test("handleTrigger: ASYNC 受理 — 先回执, onDone 经回执链回投, 工单落 done+bgTaskId", async () => {
  const { work, store } = makeWork("async");
  let captured = null;
  const agent = makeAgent({
    work,
    chatAsync: (text, opts) => { captured = { text, opts }; return { id: "bg-1" }; },
  });
  const ch = new FakeChannel(agent);
  const r = await ch.handleTrigger(createTrigger({ from: "u1", messageId: "a1", text: "后台跑", meta: { async: true } }));
  assert.deepEqual(r, { accepted: true, taskId: "bg-1", ticketId: r.ticketId });
  assert.equal(captured.text, "后台跑");
  assert.ok(captured.opts.sessionKey, "chatAsync 应收到 sessionKey");
  assert.equal(ch.sent.length, 1, "受理阶段只发回执");
  assert.match(ch.sent[0].text, /\[已受理\] 后台任务 bg-1 处理中/);
  assert.equal(ch.sent[0].meta.replyTo, "a1");

  captured.opts.onDone("后台结果");
  await settle();
  await settle();
  assert.equal(ch.sent.length, 2, "完成后应回投结果");
  assert.equal(ch.sent[1].text, "后台结果");
  assert.equal(ch.sent[1].meta.kind, "done");
  assert.equal(ch.sent[1].meta.bgTaskId, "bg-1");
  assert.ok(ch.sent[1].meta.assignmentId, "回执应带 assignmentId");
  const ticket = [...store.list?.() ?? []].find((t) => t.result === "后台结果");
  assert.ok(ticket, "onDone 应把结果落账");
  assert.equal(ticket.bgTaskId, "bg-1");
});

test("handleTrigger: ASYNC onError → workFail + [后台任务失败] 回投", async () => {
  const { work, store } = makeWork("asyncerr");
  let captured = null;
  const agent = makeAgent({
    work,
    chatAsync: (text, opts) => { captured = opts; return { id: "bg-2" }; },
  });
  const ch = new FakeChannel(agent);
  await ch.handleTrigger(createTrigger({ from: "u1", messageId: "a2", text: "后台跑", meta: { async: true } }));
  captured.onError(new Error("后台炸了"));
  await settle();
  await settle();
  const last = ch.sent[ch.sent.length - 1];
  assert.match(last.text, /\[后台任务失败\] 后台炸了/);
  assert.equal(last.meta.kind, "error");
  const tickets = [...store.list?.() ?? []];
  assert.ok(tickets.some((t) => t.status === "failed"));
});

test("handleTrigger: chatAsync 同步抛错 → workFail 并上抛", async () => {
  const { work, store } = makeWork("asyncthrow");
  const agent = makeAgent({
    work,
    chatAsync: () => { throw new Error("队列满了"); },
  });
  const ch = new FakeChannel(agent);
  await assert.rejects(ch.handleTrigger(createTrigger({ from: "u1", messageId: "a3", text: "后台跑", meta: { async: true } })), /队列满了/);
  const tickets = [...store.list?.() ?? []];
  assert.ok(tickets.some((t) => t.status === "failed"));
});

test("handleTrigger: ASYNC 装配 delivery 队列 → enqueue 而非直发", async () => {
  const { work } = makeWork("asyncq");
  const queue = [];
  let captured = null;
  const agent = makeAgent({
    work,
    chatAsync: (text, opts) => { captured = opts; return { id: "bg-3" }; },
    channelManager: { delivery: { enqueue: (job) => queue.push(job) } },
  });
  const ch = new FakeChannel(agent);
  await ch.handleTrigger(createTrigger({ from: "u1", messageId: "a4", text: "后台跑", meta: { async: true } }));
  assert.equal(ch.sent.length, 1, "队列装配时回投走 enqueue");
  captured.onDone("排队结果");
  await settle();
  await settle();
  assert.equal(queue.length, 1);  assert.equal(queue[0].channel, "fake");
  assert.equal(queue[0].text, "排队结果");
  assert.equal(queue[0].meta.kind, "done");
  assert.ok(queue[0].policy, "契约 policy 应随 job 落队");
  assert.equal(queue[0].policy.kind, "async");
  assert.equal(ch.sent.length, 1, "enqueue 分支不应直发");
});

// ---- 账本兜底 ----

test("handleTrigger: work.begin/complete 抛错 → 吞掉不阻断回复", async () => {
  const ticketStub = { id: "t-stub", dedupeKey: null };
  const workStub = {
    submit: () => ticketStub,
    begin: () => { throw new Error("ledger-begin"); },
    complete: () => { throw new Error("ledger-complete"); },
    fail: () => { throw new Error("ledger-fail"); },
  };
  const agent = makeAgent({ work: workStub });
  const ch = new FakeChannel(agent);
  const reply = await ch.handleTrigger(createTrigger({ from: "u1", text: "照常答" }));
  assert.equal(reply, "echo:照常答");
  assert.equal(ch.sent.length, 1);
});

// ---- 兼容壳与辅助 ----

test("handleMessage: (from, text) 兼容壳 → 走完整 SYNC 主路径", async () => {
  const { work } = makeWork("compat");
  let saw = null;
  const agent = makeAgent({ work, chat: async (text) => { saw = text; return "壳回复"; } });
  const ch = new FakeChannel(agent);
  const r = await ch.handleMessage("u1", "壳消息");
  assert.equal(r, "壳回复");
  assert.equal(saw, "壳消息");
  assert.equal(ch.sent[0].text, "壳回复");
});

test("_deliverAsync: 无队列无工单身份 → 直发并透传 send 返回值", async () => {
  const ch = new FakeChannel(makeAgent());
  const r = await ch._deliverAsync("u9", "直发文本", {});
  assert.deepEqual(r, { ok: true, messageId: "pm_1" });
  assert.deepEqual(ch.sent, [{ to: "u9", text: "直发文本", meta: {} }]);
});

test("_deliverAsync: 有工单身份无队列 → 走回执链 sendSync", async () => {
  const ch = new FakeChannel(makeAgent());
  await ch._deliverAsync("u9", "回执文本", { ticketId: "t1", assignmentId: "as1", sessionKey: "s1" });
  assert.equal(ch.sent.length, 1);
  assert.equal(ch.sent[0].text, "回执文本");
});

test("_receipts: 缓存同一实例; emit 驱动 _eqPushRef 与 work.markDelivery*", () => {
  const calls = { eq: [], started: [], state: [] };
  const agent = makeAgent({
    _eqPushRef: (type, payload, ref) => calls.eq.push({ type, payload, ref }),
    work: {
      markDeliveryStarted: (id) => calls.started.push(id),
      markDeliveryState: (snap) => calls.state.push(snap),
    },
  });
  const ch = new FakeChannel(agent);
  const r1 = ch._receipts();
  const r2 = ch._receipts();
  assert.equal(r1, r2, "回执产出器应缓存");
  r1.accepted({ ticketId: "t1", assignmentId: "as1", channel: "fake", sessionKey: "s1" });
  assert.equal(calls.eq.length, 1);
  assert.equal(calls.eq[0].type, "delivery_accepted");
  assert.equal(calls.eq[0].ref.cause, "ingress");
  assert.deepEqual(calls.started, ["as1"]);
  r1.delivered({ ticketId: "t1", assignmentId: "as1" }, { at: 123 });
  assert.equal(calls.eq[1].type, "delivery_delivered");
  assert.equal(calls.state[0].state, DELIVERY_STATE.DELIVERED);
  assert.equal(calls.state[0].at, 123);
  r1.deadLetter({ ticketId: "t1", assignmentId: "as1", deadAt: 456, reason: "delivery_exhausted" });
  assert.equal(calls.state[1].state, DELIVERY_STATE.DEAD_LETTER);
  assert.equal(calls.state[1].reason, "delivery_exhausted");
  const throwing = new FakeChannel(makeAgent({ _eqPushRef: () => { throw new Error("eq 挂了"); } }));
  throwing._receipts().accepted({ ticketId: "t2", assignmentId: "as2" });
  assert.ok("观测失败不应抛出");
});

test("_syncDeadlineMs: 契约优先取 min, 次选通道配置, 默认 30s", () => {
  const agent = makeAgent({
    channelManager: { deliveryConfig: { syncDeadlineMs: 1234 } },
  });
  const ch = new FakeChannel(agent);
  assert.equal(ch._syncDeadlineMs(null), 1234, "无契约回退通道配置");
  const ch2 = new FakeChannel(makeAgent());
  assert.equal(ch2._syncDeadlineMs(null), DEFAULT_SYNC_DEADLINE_MS, "无配置用默认 30000");
  const contract = { policy: { kind: "sync", deadline_ms: 5000 }, execution: { timeout_ms: 0, deadline_at: null }, createdAt: Date.now() };
  assert.equal(ch2._syncDeadlineMs(contract), 5000, "契约 deadline 生效");
  const tight = { policy: { kind: "sync", deadline_ms: 30000 }, execution: { timeout_ms: 0, deadline_at: Date.now() + 50 }, createdAt: Date.now() };
  assert.ok(ch2._syncDeadlineMs(tight) <= 50, "execution 剩余预算应收紧 min");
});
