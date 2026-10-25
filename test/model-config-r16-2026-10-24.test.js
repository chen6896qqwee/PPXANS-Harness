// test/model-config-r16-2026-10-24.test.js - 第十六轮: 模型配置功能补全
// 缺口 (侦察实锤):
//   P1 (bug)  UI 表单有 context_window 字段且卡片展示它, 但 PROVIDER_KEYS 白名单
//             不含该键 —— add/update 写盘时被静默丢弃, 用户填了等于没填。
//   P2        provider 无启用/禁用: 想临时停用一个只能删除 (配置+key 全丢)。
//   P3        model_routing.aux 分层路由: 引擎支持 (agent/index.js), diagnose.js
//             还建议用户启用它, 但零 API 零 UI —— 功能存在却无法触达。
//   P4        用量只有全局聚合 (usageStats.calls/tokens), byModel 有数据无处可看。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { HttpChannel } from "../src/channels/http.js";
import {
  addProvider, updateProvider, listProviders, readConfig,
} from "../src/config/providers.js";
import { isUsableProvider } from "../src/llm/router.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-r16-")); }
function writeCfg(root, cfg = {}) {
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify(cfg));
}
const H = { "Content-Type": "application/json", Authorization: "Bearer tok" };

test("P1: context_window 经 add/update 持久化 (白名单不再丢弃)", () => {
  const root = tmp();
  writeCfg(root);
  const p = addProvider(root, { id: "alpha", base_url: "http://x/v1", model: "m1", api_key: "k", context_window: 131072 });
  assert.equal(p.context_window, 131072, "add 应保留 context_window");
  assert.equal(listProviders(root)[0].context_window, 131072, "列表视图应回传");
  const u = updateProvider(root, "alpha", { context_window: 65536 });
  assert.equal(u.context_window, 65536, "update 应写入 context_window");
  const { raw } = readConfig(root);
  assert.equal(raw.providers[0].context_window, 65536, "写盘应持久化");
});

test("P2: provider 可禁用/启用 — 磁盘字段保留, 路由判不可用, 卡片可见", () => {
  const root = tmp();
  writeCfg(root);
  addProvider(root, { id: "beta", base_url: "http://y/v1", model: "m2", api_key: "k" });
  // add/update 返回脱敏视图 (无 api_key), 路由判定须用磁盘原始对象
  const raw1 = readConfig(root).providers[0];
  assert.notEqual(isUsableProvider(raw1), false, "默认应可用");
  const off = updateProvider(root, "beta", { enabled: false });
  assert.equal(off.enabled, false, "禁用应持久化 (脱敏视图也可见)");
  const raw2 = readConfig(root).providers[0];
  assert.equal(isUsableProvider(raw2), false, "禁用的 provider 路由应判不可用");
  assert.equal(isUsableProvider({ base_url: "http://z", model: "m", api_key: "k" }), true, "未声明 enabled 的不受影响 (向后兼容)");
  updateProvider(root, "beta", { enabled: true });
  assert.equal(isUsableProvider(readConfig(root).providers[0]), true, "重新启用应恢复");
  // 禁用不清 key/模型: 配置完整保留
  const { raw } = readConfig(root);
  assert.equal(raw.providers[0].model, "m2");
  assert.ok(raw.providers[0].api_key, "禁用不得丢 key");
});

test("P3: /api/routing — aux 分层路由 + model_preference 读写热生效", async () => {
  const root = tmp();
  writeCfg(root, {
    providers: [
      { id: "main", base_url: "http://a/v1", model: "big", api_key: "k1" },
      { id: "cheap", base_url: "http://b/v1", model: "small", api_key: "k2" },
    ],
  });
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  ch.authToken = "tok";
  await ch.connect();
  const port = ch.server.address().port;
  try {
    const g = await (await fetch(`http://127.0.0.1:${port}/api/routing`, { headers: H })).json();
    assert.ok(Array.isArray(g.providers) && g.providers.length === 2, "GET 应返回候选列表");
    assert.equal(g.routing.aux, null, "默认无 aux");
    const put = await fetch(`http://127.0.0.1:${port}/api/routing`, {
      method: "PUT", headers: H,
      body: JSON.stringify({ aux: "cheap", preference: "cloud" }),
    });
    assert.equal(put.status, 200);
    const j = await put.json();
    assert.equal(j.routing.aux, "cheap", "PUT 应回读 aux");
    assert.equal(j.routing.preference, "cloud");
    // 热生效: agent 内存 config 已更新
    assert.equal(agent.config.model_routing?.aux, "cheap", "agent 应热重载 model_routing");
    assert.equal(agent.config.agent?.model_preference, "cloud");
    // 非法值被拒
    const bad = await fetch(`http://127.0.0.1:${port}/api/routing`, {
      method: "PUT", headers: H, body: JSON.stringify({ aux: "nobody" }),
    });
    assert.equal(bad.status, 400, "不存在的 provider id 应 400");
  } finally {
    await ch.disconnect(); agent.shutdown();
  }
});

test("P4: /api/providers/usage — byModel 用量按 provider 聚合可读", async () => {
  const root = tmp();
  writeCfg(root, {
    providers: [
      { id: "one", base_url: "http://a/v1", model: "m-a", api_key: "k" },
      { id: "two", base_url: "http://b/v1", model: "m-b", api_key: "k" },
    ],
  });
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  agent.usageStats = { calls: 3, tokens: 900, cost: 0.01, byModel: { "m-a": { calls: 2, tokens: 600, cost: 0.006 }, "m-b": { calls: 1, tokens: 300, cost: 0.004 } } };
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  ch.authToken = "tok";
  await ch.connect();
  const port = ch.server.address().port;
  try {
    const r = await (await fetch(`http://127.0.0.1:${port}/api/providers/usage`, { headers: H })).json();
    const one = r.usage.find((u) => u.id === "one");
    const two = r.usage.find((u) => u.id === "two");
    assert.ok(one && two, "每个 provider 应有一条用量");
    assert.equal(one.calls, 2);
    assert.equal(one.tokens, 600);
    assert.equal(two.cost, 0.004);
  } finally {
    await ch.disconnect(); agent.shutdown();
  }
});
