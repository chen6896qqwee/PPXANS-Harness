// test/web-api-routes-2026-11-17.test.js — Web 管理 API 真实 HTTP 集成测试
// usage-stats / skills / mcp / plugin 四个路由域, 真 http.createServer + fetch 客户端。
// channel stub 只实现 handler 依赖的最小接口 (_json/_readBody/_requireAuth), 路由分派按
// http-api-core 的真实顺序; 落盘 (config/ppx.json / plugins/ / sessions/) 全在临时目录。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readBody, sendJson } from "../src/utils/http.js";
import { logicalDay } from "../src/utils/store.js";
import { handlePluginApi } from "../src/web/plugin-api.js";
import { handleUsageStatsApi } from "../src/web/usage-stats.js";
import { handleSkillsApi } from "../src/web/skills-api.js";
import { handleMcpApi } from "../src/web/mcp-api.js";

const TOKEN = "ppx-test-token";
const HANDLERS = [handlePluginApi, handleUsageStatsApi, handleSkillsApi, handleMcpApi];
// 账本日 = 本地今天 (logicalDay 同口径)。2026-11-18 教训: 夹具硬编码 "2026-11-17" 而会话
// 时间戳用 now, 跨天后两者构成连续两天, streak.current 断言 (1) 必挂 —— 日期敏感夹具必须参数化。
const USAGE_DAY = logicalDay();

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-webapi-${tag}-`));
}

function makeChannelStub(agent) {
  return {
    agent,
    _json(res, code, obj, headers = {}) { sendJson(res, code, obj, { headers }); },
    async _readBody(req, res) {
      const b = await readBody(req, { maxBytes: 1024 * 1024 });
      if (b === null) { this._json(res, 413, { error: "请求体过大" }); return null; }
      return b;
    },
    _requireAuth(req, res) {
      if (String(req.headers.authorization || "") === `Bearer ${TOKEN}`) return true;
      this._json(res, 401, { error: "未授权" });
      return false;
    },
  };
}

async function listen(channelStub) {
  const server = http.createServer(async (req, res) => {
    const reqPath = new URL(req.url, "http://localhost").pathname;
    for (const h of HANDLERS) {
      if (await h(channelStub, req, res, reqPath)) return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, get: (p, noAuth = false) => fetch(base + p, { headers: noAuth ? {} : auth() }),
    call: (p, opts = {}) => fetch(base + p, { headers: { ...auth(), ...(opts.headers || {}) }, ...opts, headersOverride: undefined }) };
}

function auth() {
  return { authorization: `Bearer ${TOKEN}` };
}

async function jsonOf(res) {
  const body = await res.json();
  return { status: res.status, body };
}

// ---- agent stubs per domain ----

function makeUsageAgent(tag) {
  const root = tmpdir(tag);
  const dataDir = path.join(root, "data");
  const sessions = path.join(dataDir, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(sessions, "s_abc.jsonl"), [
    JSON.stringify({ ts: now - 60000, type: "user/message" }),
    JSON.stringify({ ts: now - 30000, type: "assistant/message" }),
    JSON.stringify({ ts: now, type: "user/message" }),
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(sessions, "_titles.json"), JSON.stringify({ s_abc: "测试会话" }));
  return {
    root,
    dataDir,
    usageStats: {
      tokens: 1000, calls: 5, cost: 0.02, promptTokens: 800, cacheHitTokens: 200,
      lastCallAt: `${USAGE_DAY}T00:00:00Z`,
      byModel: { "test/model-a": { tokens: 700, calls: 4, cost: 0.02, cachedTokens: 100 } },
      days: { [USAGE_DAY]: { tokens: 1000, calls: 5, byModel: { "test/model-a": { tokens: 700, calls: 4, cachedTokens: 100 } } } },
      latency: { count: 4, sumMs: 8000, maxMs: 4000, buckets: { lt1s: 1, lt3s: 1, lt10s: 1, lt30s: 1 } },
      unpriced: { "local/llama": { calls: 2, tokens: 50 } },
    },
  };
}

function makeSkillsAgent(tag, { loader = true } = {}) {
  const root = tmpdir(tag);
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  const agent = {
    root,
    config: { skills: { disabled: [] } },
    reloadSettings: () => {},
  };
  if (loader) {
    agent.skills = {
      listAll: () => [{ id: "alpha", name: "Alpha", description: "示例技能", domain: "test", tags: [], source: "builtin", version: "1.0" }],
      usageAll: () => ({ alpha: { uses: 3, lastUsed: "2026-11-17T00:00:00Z" } }),
      disabled: [],
    };
  }
  return agent;
}

function makeMcpAgent(tag) {
  const root = tmpdir(tag);
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  return {
    root,
    config: { mcp: { servers: [] } },
    _mcpStatus: [{ name: "local1", ok: true, tools: 2 }],
    tools: { listDetailed: () => [{ category: "mcp", name: "local1__tool1" }] },
    reloadMcp: async () => ({ count: 1, servers: ["local1"], status: [{ name: "local1", ok: true, tools: 2 }] }),
  };
}

function makePluginAgent(tag) {
  const root = tmpdir(tag);
  fs.mkdirSync(path.join(root, "plugins"), { recursive: true });
  return { root, dataDir: path.join(root, "data"), config: { plugins: {} } };
}

// ---- usage-stats ----

test("usage-stats: 无 token → 401; 有 token → 200 聚合账本", async () => {
  const { server, base } = await listen(makeChannelStub(makeUsageAgent("usage")));
  try {
    const unauth = await jsonOf(await fetch(base + "/api/usage/stats"));
    assert.equal(unauth.status, 401);
    const res = await jsonOf(await fetch(base + "/api/usage/stats", { headers: auth() }));
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.totals.tokens, 1000);
    assert.equal(res.body.totals.calls, 5);
    assert.equal(res.body.daily.length, 1);
    assert.equal(res.body.daily[0].day, USAGE_DAY);
    assert.equal(res.body.daily[0].byModel["test/model-a"], 700);
    assert.equal(res.body.peak.day, USAGE_DAY);
    assert.equal(res.body.totals.models[0].model, "test/model-a");
    assert.equal(res.body.totals.models[0].costBasis, "recorded");
    assert.ok(res.body.totals.unpriced.some((m) => m.model === "local/llama"), "未定价模型单列");
    assert.equal(res.body.latency.count, 4);
    assert.equal(res.body.latency.approx, true);
    assert.ok(res.body.latency.p50Ms > 0, "分桶近似 p50");
    assert.equal(res.body.chat.sessions, 1, "sessions 目录扫到一个会话");
    assert.equal(res.body.chat.messages, 2, "user/message 计 2 条");
    assert.ok(res.body.chat.recent[0].title === "测试会话");
    assert.equal(res.body.streak.current, 1);
    assert.equal(res.body.reconciliation.totalCalls, 5);
  } finally { server.close(); }
});

// ---- skills ----

test("skills: 列表带用量; 缺加载器 → 409", async () => {
  const agent = makeSkillsAgent("skills");
  const { server, base } = await listen(makeChannelStub(agent));
  try {
    const res = await jsonOf(await fetch(base + "/api/skills", { headers: auth() }));
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.enabled, 1);
    assert.equal(res.body.skills[0].id, "alpha");
    assert.equal(res.body.skills[0].uses, 3);
    assert.equal(res.body.skills[0].enabled, true);
  } finally { server.close(); }

  const bare = makeChannelStub(makeSkillsAgent("skills-bare", { loader: false }));
  const s2 = http.createServer(async (req, res) => {
    if (await handleSkillsApi(bare, req, res, new URL(req.url, "http://x").pathname)) return;
    sendJson(res, 404, {});
  });
  await new Promise((r) => s2.listen(0, "127.0.0.1", r));
  try {
    const res = await jsonOf(await fetch(`http://127.0.0.1:${s2.address().port}/api/skills`, { headers: auth() }));
    assert.equal(res.status, 409);
    assert.match(res.body.error, /技能加载器未装配/);
  } finally { s2.close(); }
});

test("skills: 停用/启用写盘 config/ppx.json + reloadSettings; 未知 id → 404; 缺 id → 400", async () => {
  const agent = makeSkillsAgent("skills-toggle");
  let reloads = 0;
  // 真实 reloadSettings 的契约: 重读磁盘配置, 回填内存 config 与技能加载器的 disabled 视图
  agent.reloadSettings = () => {
    reloads += 1;
    const cfg = JSON.parse(fs.readFileSync(path.join(agent.root, "config", "ppx.json"), "utf8"));
    agent.config.skills.disabled = [...(cfg.skills?.disabled || [])];
    agent.skills.disabled = [...(cfg.skills?.disabled || [])];
  };
  const { server, base } = await listen(makeChannelStub(agent));
  try {
    const post = (body) => fetch(base + "/api/skills/disable", {
      method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const ghost = await jsonOf(await post({ id: "ghost" }));
    assert.equal(ghost.status, 404);
    const noid = await jsonOf(await post({}));
    assert.equal(noid.status, 400);
    const off = await jsonOf(await post({ id: "alpha" }));
    assert.equal(off.status, 200, `off 失败: ${JSON.stringify(off.body)}`);
    assert.match(off.body.message, /已停用技能: alpha/);
    assert.equal(agent.skills.disabled.length, 1);
    const cfg = JSON.parse(fs.readFileSync(path.join(agent.root, "config", "ppx.json"), "utf8"));
    assert.deepEqual(cfg.skills.disabled, ["alpha"]);
    assert.equal(reloads, 1);
    const after = await jsonOf(await fetch(base + "/api/skills", { headers: auth() }));
    assert.equal(after.body.skills[0].enabled, false);
    const on = await jsonOf(await post({ id: "alpha", enabled: true }));
    assert.match(on.body.message, /已启用技能: alpha/);
    assert.equal(on.body.skills[0].enabled, true);
  } finally { server.close(); }
});

// ---- mcp ----

test("mcp: 增删改查全流程落盘 config/ppx.json + 热重连; 校验失败 → 400", async () => {
  const agent = makeMcpAgent("mcp");
  const { server, base } = await listen(makeChannelStub(agent));
  const cfgPath = path.join(agent.root, "config", "ppx.json");
  const post = (body) => fetch(base + "/api/mcp/servers", {
    method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    let res = await jsonOf(await fetch(base + "/api/mcp/servers", { headers: auth() }));
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 0);

    res = await jsonOf(await post({ server: { name: "local1", command: "node", args: ["srv.js"], env: { KEY: "secret" } } }));
    assert.equal(res.status, 201);
    assert.match(res.body.message, /已添加 MCP 服务器: local1/);
    assert.equal(res.body.count, 1, "热重连返回");
    assert.equal(res.body.connected, 1);
    let cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.equal(cfg.mcp.servers[0].name, "local1");
    assert.deepEqual(cfg.mcp.servers[0].env, { KEY: "secret" });

    // 同名更新: 未提交字段保持原值 (env 密钥不丢)
    res = await jsonOf(await post({ server: { name: "local1", args: ["srv2.js"] } }));
    assert.equal(res.status, 200);
    assert.match(res.body.message, /已更新 MCP 服务器: local1/);
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.deepEqual(cfg.mcp.servers[0].args, ["srv2.js"]);
    assert.deepEqual(cfg.mcp.servers[0].env, { KEY: "secret" });

    res = await jsonOf(await fetch(base + "/api/mcp/servers", { headers: auth() }));
    assert.equal(res.body.total, 1);
    assert.equal(res.body.servers[0].transport, "stdio");
    assert.equal(res.body.servers[0].env_set, true, "密钥只回 set 标志");
    assert.equal(res.body.servers[0].status.connected, true);
    assert.equal(res.body.servers[0].tools, 1, "listDetailed 按 prefix 过滤");

    res = await jsonOf(await post({ server: { name: "bad" } }));
    assert.equal(res.status, 400, "无 command 且无 url 校验拒绝");

    res = await jsonOf(await fetch(base + "/api/mcp/servers?name=ghost", { method: "DELETE", headers: auth() }));
    assert.equal(res.status, 404);
    res = await jsonOf(await fetch(base + "/api/mcp/servers?name=local1", { method: "DELETE", headers: auth() }));
    assert.equal(res.status, 200);
    assert.match(res.body.message, /已删除/);
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.equal(cfg.mcp.servers.length, 0);

    res = await jsonOf(await fetch(base + "/api/mcp/reconnect", { method: "POST", headers: auth() }));
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 1);
  } finally { server.close(); }
});

test("mcp: reloadMcp 未装配 → 409", async () => {
  const agent = makeMcpAgent("mcp-noreload");
  delete agent.reloadMcp;
  const { server, base } = await listen(makeChannelStub(agent));
  try {
    const res = await jsonOf(await fetch(base + "/api/mcp/reconnect", { method: "POST", headers: auth() }));
    assert.equal(res.status, 409);
    assert.match(res.body.error, /热重连/);
  } finally { server.close(); }
});

// ---- usage-stats 边界 ----

test("usage-stats: 空账本/昨日活跃/账本抛错三态", async () => {
  // 空账本: 无 usageStats 无 sessions → ledger.since null, streak 全零
  const s1 = await listen(makeChannelStub({ root: tmpdir("usage-empty"), usageStats: {} }));
  try {
    const empty = await jsonOf(await fetch(s1.base + "/api/usage/stats", { headers: auth() }));
    assert.equal(empty.body.ledger.since, null);
    assert.equal(empty.body.streak.current, 0);
    assert.equal(empty.body.latency.count, 0);
    assert.equal(empty.body.latency.p50Ms, null, "空桶不编造分位");
  } finally { s1.server.close(); }

  // 最后活跃在两天前 (今天/昨天都没开工) → current 0; 昨天活跃则锚定 current=1
  const yRoot = tmpdir("usage-yesterday");
  const ySessions = path.join(yRoot, "data", "sessions");
  fs.mkdirSync(ySessions, { recursive: true });
  const twoDaysAgo = Date.now() - 2 * 86400000;
  fs.writeFileSync(path.join(ySessions, "s_yda.jsonl"), [
    JSON.stringify({ ts: twoDaysAgo - 60000, type: "user/message" }),
    JSON.stringify({ ts: twoDaysAgo, type: "assistant/message" }),
  ].join("\n") + "\n");
  const s2 = await listen(makeChannelStub({ root: yRoot, usageStats: {} }));
  try {
    const y1 = await jsonOf(await fetch(s2.base + "/api/usage/stats", { headers: auth() }));
    assert.equal(y1.body.streak.current, 0, "隔了两天没开工, 连续清零");
    assert.ok(y1.body.streak.lastDay, "仍能看到最近活跃日");
  } finally { s2.server.close(); }

  // 账本读取抛错 → handler 兜底 500 而不是断连
  const boomAgent = { root: tmpdir("usage-boom"), get usageStats() { throw new Error("账本炸了"); } };
  const s3 = await listen(makeChannelStub(boomAgent));
  try {
    const boom = await jsonOf(await fetch(s3.base + "/api/usage/stats", { headers: auth() }));
    assert.equal(boom.status, 500);
    assert.match(boom.body.error, /账本炸了/);
  } finally { s3.server.close(); }
});

test("usage-stats: 超 16MB 会话文件走头尾切片, 中段不计入", async () => {
  const agent = makeUsageAgent("usage-big");
  const sessions = path.join(agent.dataDir, "sessions");
  const now = Date.now();
  const bigFile = path.join(sessions, "s_big.jsonl");
  const fd = fs.openSync(bigFile, "w");
  fs.writeSync(fd, JSON.stringify({ ts: now - 900000, type: "user/message" }) + "\n");
  const padLine = JSON.stringify({ type: "noise", note: "x".repeat(64) }) + "\n";
  const chunk = padLine.repeat(64);
  while (fs.statSync(bigFile).size < 17 * 1024 * 1024) fs.writeSync(fd, chunk);
  fs.writeSync(fd, JSON.stringify({ ts: now, type: "user/message" }) + "\n");
  fs.closeSync(fd);
  const s = await listen(makeChannelStub(agent));
  try {
    const res = await jsonOf(await fetch(s.base + "/api/usage/stats", { headers: auth() }));
    const big = res.body.chat.recent.find((x) => x.id === "s_big");
    assert.ok(big, "超大会话仍被统计");
    assert.equal(big.messages, 2, "只读头尾: 中段噪声不计入");
  } finally { s.server.close(); }
});

// ---- plugin 边界 ----

test("plugins: 缺省模板落盘; 散文件插件只读展示; 坏清单报错; 无清单目录不算插件", async () => {
  const agent = makePluginAgent("plugins-edge");
  const { server, base } = await listen(makeChannelStub(agent));
  const pluginsDir = path.join(agent.root, "plugins");
  fs.writeFileSync(path.join(pluginsDir, "loose.cjs"), "module.exports = () => 42;");
  fs.mkdirSync(path.join(pluginsDir, "notplugin"), { recursive: true });
  fs.mkdirSync(path.join(pluginsDir, "broken"), { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, "broken", "ppx.plugin.json"), "{ not json");
  const post = (body) => fetch(base + "/api/plugins", {
    method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    let res = await jsonOf(await post({ id: "templated", name: "T" }));
    assert.equal(res.status, 201, "缺省 code 用内置模板");
    const tpl = fs.readFileSync(path.join(pluginsDir, "templated", "index.cjs"), "utf8");
    assert.match(tpl, /ctx\.provide\("user\.templated"/, "模板生成可装配的入口");

    res = await jsonOf(await fetch(base + "/api/plugins", { headers: auth() }));
    const loose = res.body.plugins.find((p) => p.id === "loose");
    assert.ok(loose?.loose, "散文件插件标记 loose");
    const broken = res.body.plugins.find((p) => p.id === "broken");
    assert.match(broken?.error, /清单解析失败/, "坏清单不吞错");
    assert.equal(res.body.plugins.find((p) => p.id === "notplugin"), undefined, "普通目录不算插件");

    res = await jsonOf(await fetch(base + "/api/plugins/loose", { headers: auth() }));
    assert.equal(res.status, 404, "散文件不可详情编辑");

    res = await jsonOf(await fetch(base + "/api/plugins/loose", { method: "DELETE", headers: auth() }));
    assert.equal(res.status, 200, "散文件删除走回收站");
    assert.ok(!fs.existsSync(path.join(pluginsDir, "loose.cjs")));

    const put = (body, p = "/api/plugins/templated") => fetch(base + p, {
      method: "PUT", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify(body),
    });
    res = await jsonOf(await put({ enabled: false, code: "module.exports = (ctx) => ctx.provide('x', 1);" }));
    assert.equal(res.status, 200);
    const man = JSON.parse(fs.readFileSync(path.join(pluginsDir, "templated", "ppx.plugin.json"), "utf8"));
    assert.equal(man.enabled, false);
    assert.match(fs.readFileSync(path.join(pluginsDir, "templated", "index.cjs"), "utf8"), /ctx\.provide/);

    res = await jsonOf(await put({ access: "root" }));
    assert.equal(res.status, 400, "非法 access 拒绝");

    res = await jsonOf(await put({}, "/api/plugins/notplugin"));
    assert.equal(res.status, 409, "无清单目录拒绝更新");
  } finally { server.close(); }
});

// ---- mcp 校验矩阵与 index 定位 ----

test("mcp: 字段校验矩阵逐条拒绝; index 定位更新; 未知方法 404", async () => {
  const agent = makeMcpAgent("mcp-valid");
  const { server, base } = await listen(makeChannelStub(agent));
  const post = (body) => fetch(base + "/api/mcp/servers", {
    method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const bad = [
      { server: { name: "v2", command: "n", args: "no" } },
      { server: { name: "v3", command: "n", timeout: -1 } },
      { server: { name: "v4", command: "n", env: { K: 1 } } },
      { server: { name: "v5", command: "n", headers: "str" } },
      { server: { name: "v6", url: "ftp://x" } },
      { server: { name: "v7" } },
    ];
    for (const [i, body] of bad.entries()) {
      const r = await jsonOf(await post(body));
      assert.equal(r.status, 400, `校验矩阵 #${i} 应拒绝`);
    }
    let r = await jsonOf(await post({ server: { name: "idx0", command: "node" } }));
    assert.equal(r.status, 201);
    await jsonOf(await post({ server: { name: "idx1", command: "node" } }));
    r = await jsonOf(await post({ index: 1, server: { name: "renamed", args: ["a"] } }));
    assert.equal(r.status, 200);
    const cfg = JSON.parse(fs.readFileSync(path.join(agent.root, "config", "ppx.json"), "utf8"));
    assert.equal(cfg.mcp.servers[1].name, "renamed");
    assert.equal(cfg.mcp.servers[1].command, "node", "index 更新合并原值");
    r = await jsonOf(await fetch(base + "/api/mcp/servers", { method: "PUT", headers: auth() }));
    assert.equal(r.status, 404, "未支持方法落到下一路由");
  } finally { server.close(); }
});


test("plugins: 创建→详情→更新→删除(回收站); 非法 id/语法错误/未知 id 各自拒绝", async () => {
  const agent = makePluginAgent("plugins");
  const { server, base } = await listen(makeChannelStub(agent));
  const pluginsDir = path.join(agent.root, "plugins");
  const post = (body, p = "/api/plugins") => fetch(base + p, {
    method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    let res = await jsonOf(await fetch(base + "/api/plugins", { headers: auth() }));
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 0);

    res = await jsonOf(await post({ id: "demo", name: "Demo 插件", description: "示例", code: "module.exports = () => {};" }));
    assert.equal(res.status, 201);
    assert.equal(res.body.id, "demo");
    const dir = path.join(pluginsDir, "demo");
    assert.ok(fs.existsSync(path.join(dir, "ppx.plugin.json")));
    assert.ok(fs.existsSync(path.join(dir, "index.cjs")));

    res = await jsonOf(await post({ id: "bad id!" }));
    assert.equal(res.status, 400);
    res = await jsonOf(await post({ id: "demo2", code: "function {" }));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /代码语法错误/);

    res = await jsonOf(await fetch(base + "/api/plugins", { headers: auth() }));
    assert.equal(res.body.total, 1);
    assert.equal(res.body.plugins[0].id, "demo");

    res = await jsonOf(await fetch(base + "/api/plugins/demo", { headers: auth() }));
    assert.equal(res.status, 200);
    assert.equal(res.body.plugin.name, "Demo 插件");
    assert.equal(res.body.plugin.code, "module.exports = () => {};");

    const put = (body) => fetch(base + "/api/plugins/demo", {
      method: "PUT", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify(body),
    });
    res = await jsonOf(await put({ description: "更新后的描述" }));
    assert.equal(res.status, 200);
    const man = JSON.parse(fs.readFileSync(path.join(dir, "ppx.plugin.json"), "utf8"));
    assert.equal(man.description, "更新后的描述");
    res = await jsonOf(await put({ capabilities: ["not-a-cap"] }));
    assert.equal(res.status, 400);

    res = await jsonOf(await fetch(base + "/api/plugins/ghost", { headers: auth() }));
    assert.equal(res.status, 404);
    res = await jsonOf(await fetch(base + "/api/plugins/ghost", { method: "DELETE", headers: auth() }));
    assert.equal(res.status, 404);

    res = await jsonOf(await fetch(base + "/api/plugins/demo", { method: "DELETE", headers: auth() }));
    assert.equal(res.status, 200);
    assert.match(res.body.trash, /^data\/plugin-trash\/demo-/);
    assert.ok(!fs.existsSync(dir), "插件目录已移走");
    assert.ok(fs.readdirSync(path.join(agent.root, "data", "plugin-trash")).some((n) => n.startsWith("demo-")), "回收站保留原目录");

    res = await jsonOf(await fetch(base + "/api/plugins/no-such-route", { headers: auth() }));
    assert.equal(res.status, 404);
  } finally { server.close(); }
});
