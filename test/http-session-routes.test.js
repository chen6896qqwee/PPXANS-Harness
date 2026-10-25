// test/http-session-routes.test.js - HTTP 会话路由回归 (2026-09-18 重构)
// 背景: /sessions/rename 与 /sessions/delete 原先把 _readBody 返回的【原始 JSON 字符串】
//   当对象使用 (body.from / body.key 恒为 undefined), 导致:
//     · 重命名永远失败 (rename(undefined, undefined) → false → 404)
//     · 删除永远落到 "default" 兜底 → 误删主会话
//   前端 public/app.js 的契约一直是 post("/sessions/rename", { from, to }) / { key }。
// 本测试锁死该契约, 防止再次退化。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { HttpChannel } from "../src/channels/http.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-http-sessions-")); }

function makeAgent(root) {
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  // 关掉 MCP 端点, 专注 REST 路由
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({ channels: { http: { mcp: { enabled: false } } } }));
  return new PPXAgent({ root, dataDir: path.join(root, "data") });
}

test("HTTP /sessions/rename: 解析 JSON body, 按 from/to 重命名 (不再恒失败)", async () => {
  const root = tmp();
  const agent = makeAgent(root);
  agent.sessionStore.append("alpha", "user/message", { content: "hi" });
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  ch.authToken = "tok";
  await ch.connect();
  const port = ch.server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/sessions/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({ from: "alpha", to: "beta" }),
    });
    assert.equal(res.status, 200, "重命名应成功");
    assert.deepEqual(await res.json(), { ok: true });
    const keys = agent.sessionStore.list().map((s) => s.key);
    assert.ok(keys.includes("beta"), "新 key 应存在");
    assert.ok(!keys.includes("alpha"), "旧 key 应消失");
  } finally {
    await ch.disconnect(); agent.shutdown();
  }
});

test("HTTP /sessions/delete: 删除指定 key, 不误删 default 主会话", async () => {
  const root = tmp();
  const agent = makeAgent(root);
  agent.sessionStore.append("default", "user/message", { content: "主会话" });
  agent.sessionStore.append("side", "user/message", { content: "旁支" });
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  ch.authToken = "tok";
  await ch.connect();
  const port = ch.server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/sessions/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({ key: "side" }),
    });
    assert.equal(res.status, 200);
    const keys = agent.sessionStore.list().map((s) => s.key);
    assert.ok(!keys.includes("side"), "目标会话应被删除");
    assert.ok(keys.includes("default"), "default 主会话必须保留 (原实现会误删)");
  } finally {
    await ch.disconnect(); agent.shutdown();
  }
});

// 2026-10-09 补: 同一缺陷二次回归的守卫。
// 复发形态: 后端读 data.key, 前端却发 { sessionKey } → 仍恒 undefined → 仍兜底删 default。
// 上面两个用例只锁了【后端读到 key 时行为正确】, 没能发现【前端发的字段名变了】——
// 因为测试自己按后端契约发请求, 与真实前端脱钩。故这里补两类断言:
//   (a) 后端对 { sessionKey } 向后兼容, 且【缺字段时拒绝】而不是兜底 default;
//   (b) 静态断言真实前端源码发出的就是 key —— 跨端契约必须两侧一起锁。
test("HTTP /sessions/delete: 向后兼容 { sessionKey }, 且缺字段时拒绝而不兜底 default", async () => {
  const root = tmp();
  const agent = makeAgent(root);
  agent.sessionStore.append("default", "user/message", { content: "主会话" });
  agent.sessionStore.append("side", "user/message", { content: "旁支" });
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  ch.authToken = "tok";
  await ch.connect();
  const port = ch.server.address().port;
  const call = (body) => fetch(`http://127.0.0.1:${port}/sessions/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
    body: JSON.stringify(body),
  });
  try {
    // (a1) 旧字段名仍可用
    let res = await call({ sessionKey: "side" });
    assert.equal(res.status, 200, "sessionKey 应向后兼容");
    let keys = agent.sessionStore.list().map((s) => s.key);
    assert.ok(!keys.includes("side"), "sessionKey 指定的会话应被删除");
    assert.ok(keys.includes("default"), "default 仍必须保留");

    // (a2) 缺字段必须拒绝, 绝不能兜底删 default —— 兜底才是误删的根因
    res = await call({});
    assert.equal(res.status, 400, "缺 key 应返回 400 而不是静默成功");
    keys = agent.sessionStore.list().map((s) => s.key);
    assert.ok(keys.includes("default"), "缺字段时 default 主会话必须完好无损");
  } finally {
    await ch.disconnect(); agent.shutdown();
  }
});

test("跨端契约: public/app.js 调用 /sessions/delete 时必须发 key 字段", () => {
  // 直接用 URL 读 (fs 支持 URL 入参, 免去相对路径层级计算)
  const appJs = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const m = appJs.match(/post\(\s*["']\/sessions\/delete["']\s*,\s*\{([^}]*)\}/);
  assert.ok(m, "应能在 app.js 中找到 /sessions/delete 的调用");
  assert.ok(/\bkey\s*:/.test(m[1]),
    `前端必须发 { key }, 实际发的是 { ${m[1].trim()} } —— 后端读 data.key, 不匹配会误删 default 主会话`);
  assert.ok(!/sessionKey\s*:/.test(m[1]),
    "前端不应再发 sessionKey (历史回归根因: 前后端字段名不一致)");
});

test("HTTP /sessions/rename: 目标已存在时拒绝覆盖 (404)", async () => {
  const root = tmp();
  const agent = makeAgent(root);
  agent.sessionStore.append("a", "user/message", { content: "1" });
  agent.sessionStore.append("b", "user/message", { content: "2" });
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  ch.authToken = "tok";
  await ch.connect();
  const port = ch.server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/sessions/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({ from: "a", to: "b" }),
    });
    assert.equal(res.status, 404, "目标已存在应拒绝");
    assert.equal((agent.sessionStore.list().map((s) => s.key)).length, 2, "两侧数据都应保留");
  } finally {
    await ch.disconnect(); agent.shutdown();
  }
});
