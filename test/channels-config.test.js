// test/channels-config.test.js - 通道配置 CRUD + 连通性测试 + 统一注册表
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";
import {
  listChannels, updateChannel, setChannelEnabled, removeChannel, validateChannel,
  CHANNEL_SCHEMAS,
} from "../src/config/channels.js";
import { ChannelManager, BUILTIN_CHANNEL_TYPES } from "../src/channels/index.js";
import { FeishuChannel } from "../src/channels/feishu.js";
import { WechatWebhookChannel } from "../src/channels/wechat.js";
import { Channel } from "../src/channels/base.js";

function tmpRoot(n) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-chcfg-${n}-`));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({ channels: {} }));
  return root;
}

// ---- 配置 CRUD ----
test("channels 配置: listChannels 返回默认状态", () => {
  const root = tmpRoot("list");
  const rows = listChannels(root);
  assert.deepEqual(rows.map((r) => r.name).sort(), ["feishu", "http", "log", "wechat"].sort());
  const http = rows.find((r) => r.name === "http");
  assert.equal(http.enabled, true, "http 默认启用");
  assert.equal(http.fields.port, 8899);
  const feishu = rows.find((r) => r.name === "feishu");
  assert.equal(feishu.enabled, false, "feishu 默认禁用");
});

test("channels 配置: updateChannel 校验未知字段/类型", () => {
  const root = tmpRoot("val");
  assert.throws(() => updateChannel(root, "feishu", { bogus: 1 }), /未知字段/);
  assert.throws(() => updateChannel(root, "nope", { enabled: true }), /未知通道/);
  const { clean, errors } = validateChannel("http", { port: "abc" });
  assert.equal(errors.length, 1, "端口类型错误被拒");
  assert.equal(clean.port, undefined);
});

test("channels 配置: update/enable/disable/remove 写盘生效", () => {
  const root = tmpRoot("rw");
  // 写 feishu 配置 (secret 字段不暴露明文)
  updateChannel(root, "feishu", { appId: "cli_123", appSecret: "sec_456", enabled: true });
  let rows = listChannels(root);
  let feishu = rows.find((r) => r.name === "feishu");
  assert.equal(feishu.enabled, true);
  assert.equal(feishu.fields.appId, "cli_123");
  assert.equal(feishu.fields.appSecret_set, true, "secret 只暴露已设置标志");
  assert.equal("appSecret" in feishu.fields, false, "明文 secret 不外泄");
  // disable
  setChannelEnabled(root, "feishu", false);
  rows = listChannels(root);
  assert.equal(rows.find((r) => r.name === "feishu").enabled, false);
  // remove
  assert.equal(removeChannel(root, "feishu"), true);
  rows = listChannels(root);
  assert.equal(rows.find((r) => r.name === "feishu").fields.appId, undefined, "移除后恢复默认");
});

// ---- 连通性测试 ----
test("channels 连通性: log 总是可用, 未知类型失败", async () => {
  const root = tmpRoot("test");
  const mgr = new ChannelManager({ root, config: { agent: {} } }, {});
  const log = await mgr.test("log");
  assert.equal(log.ok, true);
  const unknown = await mgr.test("nope");
  assert.equal(unknown.ok, false);
  assert.match(unknown.detail, /未知通道/);
});

test("channels 连通性: http 用临时端口可启动, feishu 未配置明确失败", async () => {
  const root = tmpRoot("httpt");
  const mgr = new ChannelManager({ root, config: { agent: {} } }, { http: { port: 0 }, feishu: {} });
  const http = await mgr.test("http");
  assert.equal(http.ok, true, "http 端口可绑定");
  // 临时屏蔽环境凭据 (本机可能配了 FEISHU_APP_ID), 验证"未配置"分支
  const saved = { id: process.env.FEISHU_APP_ID, secret: process.env.FEISHU_APP_SECRET };
  process.env.FEISHU_APP_ID = "";
  process.env.FEISHU_APP_SECRET = "";
  try {
    const feishu = await mgr.test("feishu");
    assert.equal(feishu.ok, false);
    assert.match(feishu.detail, /未配置/);
  } finally {
    if (saved.id !== undefined) process.env.FEISHU_APP_ID = saved.id; else delete process.env.FEISHU_APP_ID;
    if (saved.secret !== undefined) process.env.FEISHU_APP_SECRET = saved.secret; else delete process.env.FEISHU_APP_SECRET;
  }
});

// ---- 统一注册表 (server 侧已覆盖, 这里验证 manager.list 与内置类型) ----
test("channels 统一: manager.list 反映配置状态", () => {
  const root = tmpRoot("mgr");
  const agent = new PPXAgent({ root });
  const mgr = new ChannelManager(agent, { http: { enabled: true, port: 0 }, log: { enabled: false } });
  const list = mgr.list();
  assert.equal(list.find((c) => c.name === "http").enabled, true);
  assert.equal(list.find((c) => c.name === "log").enabled, false);
  assert.equal(list.find((c) => c.name === "feishu").enabled, false);
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});

test("channels 统一: 内置类型注册表包含全部 schema", () => {
  for (const name of Object.keys(CHANNEL_SCHEMAS)) {
    assert.ok(BUILTIN_CHANNEL_TYPES[name], `注册表含 ${name}`);
  }
});

// ---- 主动提醒 → 通道端到端 ----
test("主动提醒: 飞书 send('*') 回最近联系人 (lastUser)", () => {
  const ch = new FeishuChannel({}, {});
  assert.equal(ch._resolveTarget("*"), null, "无 lastUser 时报缺接收人");
  ch.lastUser = "ou_123";
  assert.equal(ch._resolveTarget("*"), "ou_123");
  assert.equal(ch._resolveTarget("ou_abc"), "ou_abc");
});

test("主动提醒: 微信收到消息后记录 lastUser", async () => {
  const ch = new WechatWebhookChannel({ chat: async () => "收到" }, {});
  await ch._replyFromXml(`<xml><FromUserName><![CDATA[user_99]]></FromUserName><Content><![CDATA[你好]]></Content></xml>`);
  assert.equal(ch.lastUser, "user_99", "收到消息记录最近联系人");
});

test("主动提醒: broadcast 把文本广播到所有已启用通道", async () => {
  class FakeChannel extends Channel {
    constructor(agent, cfg = {}) { super("fake", agent); this.sent = []; }
    async connect() { this.connected = true; return this; }
    async send(to, text) { this.sent.push({ to, text }); return text; }
  }
  const root = tmpRoot("bc");
  const agent = new PPXAgent({ root });
  const mgr = new ChannelManager(agent, { fake: { enabled: true }, http: { enabled: false } }, { fake: FakeChannel });
  await mgr.start();
  await mgr.broadcast("【主动提醒】明天提交周报");
  assert.deepEqual(mgr.get("fake").sent, [{ to: "*", text: "【主动提醒】明天提交周报" }]);
  await mgr.stop();
  agent.shutdown();
  fs.rmSync(agent.dataDir, { recursive: true, force: true });
});
