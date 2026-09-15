// test/architecture.test.js - ANS 模块独立 + 通道注册表 + proactive 契约
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";
import { Lifecycle } from "../src/ans/lifecycle.js";
import { valuesPrompt, DEFAULT_VALUES } from "../src/ans/values.js";
import { pendingTasks, suggestProactive } from "../src/ans/proactive.js";
import { ChannelManager, BUILTIN_CHANNEL_TYPES, LogChannel } from "../src/channels/index.js";
import { Channel } from "../src/channels/base.js";

function tmp(n) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-arch-${n}-`)); }

// ---- ANS 模块独立性: 可单独引入、可更换 ----
test("values 模块: valuesPrompt 纯函数 (独立可用)", () => {
  assert.ok(Array.isArray(DEFAULT_VALUES) && DEFAULT_VALUES.length >= 3, "默认核心价值");
  assert.equal(valuesPrompt([]), "", "空数组不注入");
  const out = valuesPrompt(["永远不泄露密钥"]);
  assert.ok(out.startsWith("【核心价值·不可违背】"), "固定格式头");
  assert.ok(out.includes("永远不泄露密钥"));
});

test("lifecycle 模块: Lifecycle 类独立可用 (born → growing → mature)", () => {
  const lc = new Lifecycle();
  assert.equal(lc.stage, "born");
  for (let i = 0; i < 11; i++) lc.tick();
  assert.equal(lc.chats, 11);
  assert.equal(lc.stage, "mature");
  lc.to("evolving", "refine");
  assert.equal(lc.stage, "evolving");
  const st = lc.status();
  assert.equal(st.stage, "evolving");
  assert.equal(st.chats, 11);
  assert.ok(Array.isArray(st.recent) && st.recent.length >= 3, "阶段日志保留");
});

// ---- proactive 契约: 结构化 payload + 字符串兼容 ----
test("proactive: pendingTasks 返回结构化条目", () => {
  const agent = new PPXAgent({ root: tmp("pt") });
  agent.facts.add("记得下周要研究 A 股策略", { importance: 15 });
  agent.facts.add("今天天气不错", { importance: 5 });
  const tasks = pendingTasks(agent);
  assert.ok(Array.isArray(tasks));
  assert.equal(tasks.length, 1, "只有待办信号被筛出");
  assert.equal(tasks[0].content, "记得下周要研究 A 股策略");
  assert.equal(tasks[0].importance, 15);
  assert.ok("source" in tasks[0] && "id" in tasks[0], "契约字段齐全");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("proactive: suggestProactive 返回 payload {ts, items, text}, proactiveSuggest 保持字符串", async () => {
  const agent = new PPXAgent({ root: tmp("pp") });
  agent.facts.add("记得下周要研究 A 股策略", { importance: 15 });
  const msg = await agent.proactiveSuggest();
  assert.equal(typeof msg, "string", "兼容旧契约: 返回字符串");
  assert.ok(msg.includes("A 股策略"));
  // 去重新语义 (v1.0.7): 刚提醒过, 窗口内再次调用返回 null (不重复打扰)
  assert.equal(await agent.proactiveSuggest(), null, "窗口内不重复提醒");
  // 新待办 → 验证结构化 payload
  agent.facts.add("记得要准备下周的例会材料", { importance: 15 });
  const payload = await suggestProactive(agent);
  assert.ok(payload, "有新待办时返回 payload");
  assert.equal(typeof payload.ts, "number", "时间戳");
  assert.ok(Array.isArray(payload.items) && payload.items.length >= 1, "结构化条目");
  assert.ok(payload.text.includes("例会材料"), "text 可直接投递");
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("proactive: 无待办信号返回 null (不打扰)", async () => {
  const agent = new PPXAgent({ root: tmp("pn") });
  agent.facts.add("今天天气不错", { importance: 5 });
  assert.equal(await suggestProactive(agent), null);
  assert.equal(await agent.proactiveSuggest(), null);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

// ---- 通道注册表: config 驱动 + 可注入自定义类型 ----
test("channels: 注册表只启启用的通道, log 通道可 connect/send", async () => {
  const agent = new PPXAgent({ root: tmp("ch") });
  const mgr = new ChannelManager(agent, { http: { enabled: false }, log: { enabled: true } });
  const started = await mgr.start();
  assert.deepEqual(started, ["log"], "只启动 log 通道");
  const logCh = mgr.get("log");
  assert.ok(logCh instanceof LogChannel);
  assert.ok(logCh.connected);
  const out = await logCh.send("*", "test hello");
  assert.equal(out, "test hello");
  await mgr.stop();
  assert.equal(logCh.connected, false);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("channels: 支持注入自定义通道类型 (更换实现)", async () => {
  class FakeChannel extends Channel {
    constructor(agent, cfg = {}) { super("fake", agent); this.cfg = cfg; }
    async connect() { this.connected = true; return this; }
    async send(to, text) { this.sent = { to, text }; return text; }
  }
  const agent = new PPXAgent({ root: tmp("fc") });
  const mgr = new ChannelManager(agent, { fake: { enabled: true, tag: "x" }, http: { enabled: false } }, { fake: FakeChannel });
  const started = await mgr.start();
  assert.deepEqual(started, ["fake"], "自定义类型被注册表驱动");
  const ch = mgr.get("fake");
  assert.ok(ch instanceof FakeChannel);
  assert.equal(ch.cfg.tag, "x", "config 透传给通道");
  await mgr.broadcast("hi");
  assert.equal(ch.sent.text, "hi");
  await mgr.stop();
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("channels: 内置类型注册表齐全", () => {
  for (const n of ["http", "feishu", "wechat", "log"]) {
    assert.ok(BUILTIN_CHANNEL_TYPES[n], `内置通道类型 ${n}`);
  }
});
