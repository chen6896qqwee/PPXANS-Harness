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
