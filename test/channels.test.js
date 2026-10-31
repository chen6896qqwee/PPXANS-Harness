// test/channels.test.js - 通道测试
// 动态端口(0) + 读取自动生成的鉴权 token, 避免端口冲突与 401
// P0 测试隔离: boot 用 tmp 根目录, 绝不写生产 data/ (防止 stub LLM 污染真实会话/记忆)
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";

function stubLLM() {
  return {
    chat: async () => ({ content: "[stub] 你好, 兄弟!" }),
    streamChat: async (_m, { onDelta } = {}) => { onDelta && onDelta("[stub] 你好, 兄弟!"); return "[stub] 你好, 兄弟!"; },
    apiChat: async () => ({ message: { role: "assistant", content: "[stub] 你好, 兄弟!", tool_calls: null } }),
  };
}

async function boot(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-ch-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({ providers: [] }));
  const svc = await startServer({ root, port: 0, host: "127.0.0.1", ...opts });
  const port = svc.server.address().port;
  const token = svc.http.authToken; // 自动生成的鉴权 token
  const headers = token ? { "Content-Type": "application/json", "Authorization": `Bearer ${token}` } : { "Content-Type": "application/json" };
  return { ...svc, port, headers, root };
}

// 统一清理: agent + server 由调用方 close, 这里只删 tmp 根
function cleanup(svc) {
  if (!svc) return;
  if (svc.root) { try { fs.rmSync(svc.root, { recursive: true, force: true }); } catch {} }
}

test("HTTP 通道: 启动 + /health", async () => {
  const svc = await boot();
  const { server, agent, port } = svc;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    const data = await r.json();
    assert.equal(r.status, 200);
    assert.equal(data.status, "ok");
  } finally {
    agent.shutdown(); // boot() 起的是完整 agent: 构造期挂的定时器必须显式回收, 否则进程挂住
    await new Promise((res) => server.close(res));
    cleanup(svc);
  }
});

test("HTTP 通道: POST /message 对话", async () => {
  const svc = await boot({ llm: stubLLM() });
  const { server, agent, port, headers } = svc;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/message`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "你好皮皮虾" }),
    });
    const data = await r.json();
    assert.equal(r.status, 200);
    assert.ok(data.reply && data.reply.length > 0, "有回复");
  } finally {
    agent.shutdown();
    await new Promise((res) => server.close(res));
    cleanup(svc);
  }
});

test("HTTP 通道: 缺 message 返回 400", async () => {
  const svc = await boot();
  const { server, agent, port, headers } = svc;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/message`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  } finally {
    agent.shutdown();
    await new Promise((res) => server.close(res));
    cleanup(svc);
  }
});

// ---- CORS 白名单 (v1.0.7) ----
import { PPXAgent } from "../src/agent/index.js";
import { HttpChannel } from "../src/channels/http.js";

function corsBoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-cors-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({ providers: [] }));
  return root;
}

// 2026-10-31 安全默认收紧: 未配置 cors_origin = same-origin 严格模式 (此前默认 *)
test("CORS: 未配置默认 same-origin 严格模式 (跨源 403, 非浏览器放行)", async () => {
  const root = corsBoot();
  const agent = new PPXAgent({ root });
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  await ch.connect();
  const port = ch.server.address().port;
  try {
    const evil = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: "http://evil.example.com" } });
    assert.equal(evil.status, 403, "跨源 Origin 一律 403");
    // 本机页面 (如 Web UI 自己) 不受影响: 回环 Origin 放行
    const local = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    assert.equal(local.status, 200, "回环来源放行");
    const noOrigin = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(noOrigin.status, 200, "非浏览器请求 (无 Origin) 放行");
    assert.equal(noOrigin.headers.get("access-control-allow-origin"), null, "严格模式不下发 ACAO:*");
  } finally {
    await ch.disconnect();
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 显式放开仍支持: cors_origin: "*" (旧写法兼容, 交由用户自担风险)
test("CORS: 显式 cors_origin:\"*\" 恢复放行任意来源", async () => {
  const root = corsBoot();
  const agent = new PPXAgent({ root });
  agent.config.channels.http.cors_origin = "*";
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  await ch.connect();
  const port = ch.server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: "http://evil.example.com" } });
    assert.equal(r.status, 200, "显式 * 放行");
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  } finally {
    await ch.disconnect();
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CORS: 配置白名单后不匹配来源 403, 匹配放行, 无 Origin 放行", async () => {
  const root = corsBoot();
  const agent = new PPXAgent({ root });
  agent.config.channels.http.cors_origin = ["http://localhost:3000"]; // 构造前配置白名单
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  await ch.connect();
  const port = ch.server.address().port;
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: "http://localhost:3000" } });
    assert.equal(ok.status, 200, "白名单内来源放行");
    assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:3000");
    const denied = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: "http://evil.example.com" } });
    assert.equal(denied.status, 403, "白名单外来源拒绝");
    const noOrigin = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(noOrigin.status, 200, "无 Origin 的非浏览器请求放行");
  } finally {
    await ch.disconnect();
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
