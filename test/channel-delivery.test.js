// test/channel-delivery.test.js — 渠道投递队列 (2026-10-31, 队列⑦)
// 钉住: 失败重试 (指数退避, 上限) / 无队头阻塞 (失败通道不拖慢其它通道) / TTL 过期丢弃 /
//       容量上限丢最旧 / WAL 续投 (重启 replay, done 不重发, 过期不复活) / per-channel 有序 /
//       manager 集成 (broadcast 入队回执 / enabled=false 直发回退 / stop 留 WAL)。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeliveryQueue } from "../src/channels/delivery.js";
import { ChannelManager } from "../src/channels/index.js";
import { Channel } from "../src/channels/base.js";
import { PPXAgent } from "../src/agent/index.js";

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-delivery-${tag}-`));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 20s 默认上限: 条件满足即刻返回, 只有真卡住才等满 —— 全量并发跑时 2000+ 个测试
// 抢占调度, 5s 曾偶发超时 (2026-10-31 评估轮实测), 放宽的是等待上限不是断言。
async function waitUntil(fn, timeoutMs = 20000, step = 10) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitUntil 超时");
    await sleep(step);
  }
}

// ---- 核心队列 ----

test("delivery: 成功直投; 失败指数退避重试直到成功", async () => {
  const attempts = [];
  const q = createDeliveryQueue({
    send: async (channel, to, text) => {
      attempts.push({ channel, to, text, at: Date.now() });
      if (attempts.length < 3) throw new Error("暂时不可用");
      return text;
    },
    retryMax: 3, backoffMs: 10, walPath: null,
  });
  const r = q.enqueue({ channel: "feishu", to: "ou_1", text: "提醒" });
  assert.equal(r.queued, true);
  await q.idle();
  assert.equal(attempts.length, 3, "第 3 次成功 (共 3 次尝试)");
  assert.deepEqual([attempts[0].channel, attempts[0].to], ["feishu", "ou_1"]);
  const st = q.stats();
  assert.equal(st.sent, 1);
  assert.equal(st.retried, 2);
  assert.equal(st.pending, 0);
  assert.ok(attempts[1].at - attempts[0].at >= 8, "首次退避 ≥ backoffMs");
  assert.ok(attempts[2].at - attempts[1].at >= 16, "二次退避指数 ×2");
});

test("delivery: 重试耗尽 → 终态失败, 记入 lastErrors 可观测", async () => {
  let calls = 0;
  const q = createDeliveryQueue({
    send: async () => { calls++; throw new Error("永久故障"); },
    retryMax: 2, backoffMs: 5, walPath: null,
  });
  q.enqueue({ channel: "wechat", text: "会丢的消息" });
  await q.idle();
  await sleep(20); // 最后一次退避窗口
  await q.idle();
  assert.equal(calls, 3, "1 首发 + 2 重试 = 总尝试上限");
  const st = q.stats();
  assert.equal(st.failed, 1);
  assert.equal(st.pending, 0);
  assert.equal(st.lastErrors.length, 1);
  assert.ok(st.lastErrors[0].reason.includes("永久故障"));
});

test("delivery: 无队头阻塞 —— 失败通道重试期间, 其它通道消息照常送出", async () => {
  const sent = [];
  const t0 = Date.now();
  const q = createDeliveryQueue({
    send: async (channel) => {
      if (channel === "bad") throw new Error("挂了");
      sent.push({ channel, at: Date.now() });
    },
    retryMax: 3, backoffMs: 300, walPath: null, // bad 的重试窗口很长
  });
  q.enqueue({ channel: "bad", text: "会重试" });
  q.enqueue({ channel: "good", text: "不该被拖住" });
  await q.idle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "good");
  assert.ok(sent[0].at - t0 < 200, "good 不等 bad 的 300ms 退避");
  q.shutdown();
});

test("delivery: TTL 过期丢弃 (重试窗口跨过 TTL 也要拦)", async () => {
  let sends = 0;
  // 真实时钟小窗口: 10ms 退避持续重试, 60ms 后 TTL 拦截 (重试窗口真实跨过 TTL)
  const q = createDeliveryQueue({
    send: async () => { sends++; throw new Error("x"); },
    retryMax: 99, backoffMs: 10, ttlMs: 60, walPath: null,
  });
  q.enqueue({ channel: "feishu", text: "会过期" });
  await q.idle(); // pending 归零 = TTL 丢弃完成
  const st = q.stats();
  assert.equal(st.dropped, 1, "过期后丢弃");
  assert.equal(st.sent, 0);
  assert.ok(sends >= 2, "TTL 拦截前确实重试过 (首发 + 至少一次重试)");
  q.shutdown();
});

test("delivery: 容量上限丢最旧 (O(maxQueue) 内)", async () => {
  const sent = [];
  const q = createDeliveryQueue({
    send: async (channel, to, text) => sent.push(text),
    retryMax: 0, backoffMs: 100000, walPath: null, maxQueue: 3,
  });
  // send 永远挂起 (退避 100s) → 4 条入队后触发上限
  for (const text of ["m1", "m2", "m3", "m4"]) q.enqueue({ channel: "c", text });
  await sleep(30);
  const st = q.stats();
  assert.equal(st.dropped, 1, "超限丢最旧");
  assert.ok(!sent.includes("m1"), "最旧的 m1 被丢");
  q.shutdown();
});

test("delivery: 同通道消息保持入队顺序", async () => {
  const order = [];
  const q = createDeliveryQueue({
    send: async (_c, _to, text) => { await sleep(Math.random() < 0.5 ? 1 : 5); order.push(text); },
    retryMax: 0, backoffMs: 1, walPath: null,
  });
  for (const text of ["a", "b", "c", "d"]) q.enqueue({ channel: "feishu", text });
  await q.idle();
  assert.deepEqual(order, ["a", "b", "c", "d"], "单 worker 按 enqueuedAt 串行, 同通道有序");
});

// ---- WAL 续投 ----

test("delivery WAL: 入队落盘; 终态打 done; 重启 replay 只续未完成的", async () => {
  const dir = tmpDir("wal");
  const wal = path.join(dir, "delivery.wal.jsonl");
  let releaseHanging = () => {};
  const hangGate = new Promise((resolve) => { releaseHanging = resolve; });
  // 第一生命周期: 一条成功, 一条失败耗尽重试, 一条 send 挂起 (shutdown 时仍在途 → 留 WAL)
  const q1 = createDeliveryQueue({
    send: async (_c, _to, text) => {
      if (text === "成功") return text;
      if (text === "失败") throw new Error("坏");
      await hangGate; // "进行中": 挂在 send 里
    },
    retryMax: 1, backoffMs: 5, walPath: wal, ttlMs: 3600000,
  });
  q1.enqueue({ channel: "feishu", text: "成功" });
  q1.enqueue({ channel: "feishu", text: "失败" });
  // "进行中" 用独立通道: 组间并行 —— wechat 的挂起 send 不阻塞 feishu 组的重试推进
  q1.enqueue({ channel: "wechat", text: "进行中" });
  await waitUntil(() => { const s = q1.stats(); return s.sent === 1 && s.failed === 1; });
  const stopped = q1.shutdown();
  assert.equal(stopped.abandoned, 1, "进行中那条留在 WAL");
  releaseHanging(); // 释放挂起的 send (内存态已弃, 不影响 WAL)

  // 第二生命周期: replay 续投 "进行中"; "成功"/"失败" 的 done 标记不重发
  const seen = [];
  const q2 = createDeliveryQueue({
    send: async (_c, _to, text) => { seen.push(text); return text; },
    retryMax: 1, backoffMs: 5, walPath: wal, ttlMs: 3600000,
  });
  await q2.idle();
  const st = q2.stats();
  assert.equal(st.replayed, 1, "只 replay 未完成的一条");
  assert.deepEqual(seen, ["进行中"], "已终态的不重发");
  q2.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("delivery WAL: 过期条目 replay 时丢弃并压缩 WAL", async () => {
  const dir = tmpDir("wal-ttl");
  const wal = path.join(dir, "delivery.wal.jsonl");
  let t = 1000000;
  const q1 = createDeliveryQueue({
    send: async () => { await sleep(60000); },
    retryMax: 0, backoffMs: 1, walPath: wal, ttlMs: 100, now: () => t,
  });
  q1.enqueue({ channel: "c", text: "老消息" });
  q1.shutdown();
  t += 100000; // 远超 TTL
  let sends = 0;
  const q2 = createDeliveryQueue({
    send: async () => { sends++; },
    retryMax: 0, backoffMs: 1, walPath: wal, ttlMs: 100, now: () => t,
  });
  await sleep(20);
  assert.equal(sends, 0, "过期消息不复活");
  assert.equal(q2.stats().replayed, 0);
  const raw = fs.readFileSync(wal, "utf8").trim();
  assert.equal(raw, "", "replay 后 WAL 被压缩 (done/过期清空)");
  q2.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- ChannelManager 集成 ----

function makeManager(tmpRoot, channelDefs, channelsCfg = {}) {
  const agent = new PPXAgent({ root: tmpRoot });
  const mgr = new ChannelManager(agent, { http: { enabled: false }, ...channelsCfg }, channelDefs);
  return { agent, mgr };
}

test("manager 集成: broadcast 走队列 (入队回执, 发送异步完成, 失败可观测)", async () => {
  const root = tmpDir("mgr");
  class FlakyChannel extends Channel {
    constructor(agent, cfg = {}) { super("flaky", agent); this.calls = 0; }
    async connect() { this.connected = true; return this; }
    async send(to, text) {
      this.calls++;
      if (this.calls === 1) throw new Error("第一次限流");
      return text;
    }
  }
  const { agent, mgr } = makeManager(root, { flaky: FlakyChannel }, { flaky: { enabled: true } });
  await mgr.start();
  const receipt = await mgr.broadcast("提醒内容");
  assert.equal(receipt.length, 1);
  assert.equal(receipt[0].channel, "flaky");
  assert.equal(receipt[0].queued, true, "走队列, 返回入队回执");
  await mgr.delivery.idle();
  const ch = mgr.get("flaky");
  assert.equal(ch.calls, 2, "首试失败 → 队列重试成功");
  const st = mgr.deliveryStats();
  assert.equal(st.sent, 1);
  assert.equal(st.retried, 1);
  assert.ok(fs.existsSync(path.join(agent.dataDir, "channels", "delivery.wal.jsonl")), "WAL 已落盘");
  await mgr.stop();
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("manager 集成: delivery.enabled=false 回退同步直发 (旧行为)", async () => {
  const root = tmpDir("mgr-off");
  class FakeChannel extends Channel {
    constructor(agent, cfg = {}) { super("fake", agent); this.sent = []; }
    async connect() { this.connected = true; return this; }
    async send(to, text) { this.sent.push({ to, text }); return text; }
  }
  const { agent, mgr } = makeManager(root, { fake: FakeChannel }, { fake: { enabled: true }, delivery: { enabled: false } });
  await mgr.start();
  assert.equal(mgr.delivery, null, "队列未创建");
  const out = await mgr.broadcast("直发");
  assert.deepEqual(mgr.get("fake").sent, [{ to: "*", text: "直发" }], "await 即发送完成 (旧行为)");
  assert.equal(out[0], "直发", "返回 send 结果数组");
  await mgr.stop();
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("manager 集成: stop 时未投出的消息留 WAL, 重启续投", async () => {
  const root = tmpDir("mgr-wal");
  class HangingChannel extends Channel {
    constructor(agent) { super("hang", agent); }
    async connect() { this.connected = true; return this; }
    async send() { await sleep(60000); }
  }
  const agent = new PPXAgent({ root });
  const mgr = new ChannelManager(agent, { hang: { enabled: true }, http: { enabled: false } }, { hang: HangingChannel });
  await mgr.start();
  await mgr.broadcast("重启后应续投");
  await sleep(30); // 首次尝试挂起中
  await mgr.stop();
  const wal = path.join(agent.dataDir, "channels", "delivery.wal.jsonl");
  assert.ok(fs.existsSync(wal), "WAL 存在");
  const walRaw = fs.readFileSync(wal, "utf8");
  assert.ok(!walRaw.includes('"kind":"done"'), "未投出 → 无 done 标记");

  // 重启 (新 manager, 同一 dataDir): replay 续投
  const mgr2 = new ChannelManager(agent, { hang: { enabled: true }, http: { enabled: false } }, { hang: HangingChannel });
  await mgr2.start();
  assert.equal(mgr2.deliveryStats().replayed, 1, "上次未投出的被续投");
  await mgr2.stop();
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});
