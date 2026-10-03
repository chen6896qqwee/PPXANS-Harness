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
  const { server, port } = svc;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    const data = await r.json();
    assert.equal(r.status, 200);
    assert.equal(data.status, "ok");
  } finally {
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

test("CORS: 未配置默认收紧 —— 外部来源不发 ACAO (浏览器拒绝跨域读), 本机同端口来源回显 (v3.0.1 P1#9)", async () => {
  const root = corsBoot();
  const agent = new PPXAgent({ root });
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  await ch.connect();
  const port = ch.server.address().port;
  try {
    // 外部恶意来源: 不再回 ACAO (原为 *), 浏览器侧自然无法读取响应
    const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: "http://evil.example.com" } });
    assert.equal(r.status, 200, "外部来源业务请求仍处理 (无 ACAO 浏览器读不到)");
    assert.equal(r.headers.get("access-control-allow-origin"), null, "外部来源不下发 ACAO");
    // 本机回环但不同端口: 同样不下发 (P1#9 端口判据)
    const crossPort = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: `http://127.0.0.1:9999` } });
    assert.equal(crossPort.headers.get("access-control-allow-origin"), null, "同机不同端口来源不下发 ACAO");
    // 本机回环同端口 (自带 UI): 回显来源
    const samePort = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    assert.equal(samePort.status, 200, "同端口本机来源放行");
    assert.equal(samePort.headers.get("access-control-allow-origin"), `http://127.0.0.1:${port}`, "同端口本机来源回显 ACAO");
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
