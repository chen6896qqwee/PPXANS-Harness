// test/mcp-server.test.js - MCP 服务器核心 (零依赖, 双 era)
// 覆盖: server/discover / tools/list / tools/call / resources / prompts / legacy initialize
//       + Streamable HTTP 传输端到端 (版本头/通知 202/错误码/SSE 流式)
import { test } from "node:test";
import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { McpServer, McpError, MCP_ERROR, MODERN_PROTOCOL_VERSION } from "../src/mcp/server.js";
import { createMcpHttpHandler } from "../src/mcp/http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function tmpRoot(n) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${n}-`)); }

function makeAgent() {
  return new PPXAgent({ root: tmpRoot("mcpsrv") });
}

function modernMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function discoverReq(id = 1) {
  return { jsonrpc: "2.0", id, method: "server/discover", params: { _meta: modernMeta() } };
}

// ---- McpServer 直接分发 (不经过 HTTP) ----
test("server/discover 现代 era: 版本/能力/身份", async () => {
  const agent = makeAgent();
  const srv = new McpServer(agent);
  const { result } = await srv.handle(discoverReq());
  assert.equal(result.resultType, "complete");
  assert.ok(result.supportedVersions.includes(MODERN_PROTOCOL_VERSION));
  assert.ok(result.capabilities.tools);
  assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, agent.config.agent.name);
  agent.shutdown();
});

test("不支持协议版本 -> UnsupportedProtocolVersionError (-32022)", async () => {
  const agent = makeAgent();
  const srv = new McpServer(agent, { supportedVersions: [MODERN_PROTOCOL_VERSION] });
  const msg = { jsonrpc: "2.0", id: 1, method: "ping", params: { _meta: { ...modernMeta(), "io.modelcontextprotocol/protocolVersion": "1999-01-01" } } };
  await assert.rejects(() => srv.handle(msg), (e) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, MCP_ERROR.UNSUPPORTED_PROTOCOL_VERSION);
    assert.ok(e.data.supported.includes(MODERN_PROTOCOL_VERSION));
    assert.equal(e.data.requested, "1999-01-01");
    return true;
  });
  agent.shutdown();
});

test("tools/list 导出 catalog 全量 + 虚拟对话工具", async () => {
  const agent = makeAgent();
  const srv = new McpServer(agent);
  const { result } = await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modernMeta() } });
  assert.equal(result.resultType, "complete");
  const names = result.tools.map((t) => t.name);
  // catalog 内置工具
  assert.ok(names.includes("read_file"), "应有 read_file");
  assert.ok(names.includes("get_time"), "应有 get_time");
  // 虚拟对话工具
  assert.ok(names.includes("ppx.chat.send"), "应有对话工具");
  assert.ok(names.includes("ppx.chat.stream"), "应有流式对话工具");
  // 每个工具都有 inputSchema
  for (const t of result.tools) {
    assert.ok(t.inputSchema && t.inputSchema.type === "object", `${t.name} 应有 inputSchema`);
  }
  agent.shutdown();
});

test("tools/call 调真实 catalog 工具 (get_time)", async () => {
  const agent = makeAgent();
  const srv = new McpServer(agent);
  const { result } = await srv.handle({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "get_time", arguments: {}, _meta: modernMeta() },
  });
  assert.equal(result.resultType, "complete");
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content[0].type, "text");
  assert.ok(result.content[0].text.length > 0);
  agent.shutdown();
});

test("tools/call 未知工具 -> INVALID_PARAMS", async () => {
  const agent = makeAgent();
  const srv = new McpServer(agent);
  await assert.rejects(() => srv.handle({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "no_such_tool_xyz", arguments: {}, _meta: modernMeta() },
  }), (e) => e.code === MCP_ERROR.INVALID_PARAMS);
  agent.shutdown();
});

test("tools/call 调用工具报错 -> isError 透传 (TOOL_ERROR_PREFIX)", async () => {
  const agent = makeAgent();
  const srv = new McpServer(agent);
  // run_command 带 deny 规则会返回 [工具错误] 前缀, 模拟一个失败: read_file 不存在的文件
  const { result } = await srv.handle({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "read_file", arguments: { path: "___no_such_file___" }, _meta: modernMeta() },
  });
  assert.equal(result.resultType, "complete");
  assert.equal(result.isError, true, "工具错误应标记 isError");
  assert.ok(
    result.content[0].text.includes("工具错误") || result.content[0].text.includes("error"),
    `应带错误标记: ${result.content[0].text}`,
  );
  agent.shutdown();
});

test("resources/list + read (memory/traces/stats/sessions)", async () => {
  const agent = makeAgent();
  const srv = new McpServer(agent);
  const { result } = await srv.handle({ jsonrpc: "2.0", id: 1, method: "resources/list", params: { _meta: modernMeta() } });
  const uris = result.resources.map((r) => r.uri);
  assert.ok(uris.includes("memory://facts"));
  assert.ok(uris.includes("traces://recent"));
  const read = await srv.handle({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "memory://facts", _meta: modernMeta() } });
  assert.ok(Array.isArray(read.result.contents));
  assert.equal(read.result.contents[0].mimeType, "application/json");
  agent.shutdown();
});

test("resources/read 未知 uri -> 不存在错误", async () => {
  const agent = makeAgent();
  const srv = new McpServer(agent);
  await assert.rejects(() => srv.handle({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "xxx://nope", _meta: modernMeta() } }),
    (e) => e.code === MCP_ERROR.INVALID_PARAMS);
  agent.shutdown();
});

test("prompts/list + get (方法型技能)", async () => {
  const agent = makeAgent();
  const srv = new McpServer(agent);
  const { result } = await srv.handle({ jsonrpc: "2.0", id: 1, method: "prompts/list", params: { _meta: modernMeta() } });
  const names = result.prompts.map((p) => p.name);
  assert.ok(names.includes("humanize"));
  assert.ok(names.includes("plan"));
  const got = await srv.handle({ jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: "humanize", arguments: { text: "你好" }, _meta: modernMeta() } });
  assert.equal(got.result.messages[0].role, "user");
  assert.ok(got.result.messages[0].content.text.includes("你好"));
  agent.shutdown();
});

test("legacy era: initialize 握手兼容", async () => {
  const agent = makeAgent();
  const srv = new McpServer(agent);
  const { result } = await srv.handle({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "legacy", version: "1" } },
  });
  assert.equal(result.protocolVersion, "2024-11-05");
  assert.ok(result.capabilities.tools);
  assert.equal(result.serverInfo.name, agent.config.agent.name);
  agent.shutdown();
});

test("未知方法 -> METHOD_NOT_FOUND (-32601)", async () => {
  const agent = makeAgent();
  const srv = new McpServer(agent);
  await assert.rejects(() => srv.handle({ jsonrpc: "2.0", id: 1, method: "foo/bar", params: { _meta: modernMeta() } }),
    (e) => e.code === MCP_ERROR.METHOD_NOT_FOUND);
  agent.shutdown();
});

// ---- Streamable HTTP 传输端到端 ----
function startHttp(srv, opts = {}) {
  const handler = createMcpHttpHandler(srv, opts);
  const server = http.createServer((req, res) => { handler(req, res).catch(() => {}); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}

function post(url, body, headers = {}) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

test("HTTP 端到端: discover + tools/list + tools/call", async () => {
  const agent = makeAgent();
  const srv = new McpServer(agent);
  const { server, url } = await startHttp(srv);
  try {
    // discover
    const r1 = await post(url, discoverReq(), { "mcp-protocol-version": MODERN_PROTOCOL_VERSION, "accept": "application/json, text/event-stream" });
    assert.equal(r1.status, 200);
    const d = await r1.json();
    assert.equal(d.result.resultType, "complete");
    assert.ok(d.result.supportedVersions.includes(MODERN_PROTOCOL_VERSION));
    // tools/call
    const r2 = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_time", arguments: {}, _meta: modernMeta() } },
      { "mcp-protocol-version": MODERN_PROTOCOL_VERSION, "accept": "application/json, text/event-stream" });
    assert.equal(r2.status, 200);
    const c = await r2.json();
    assert.ok(c.result.content[0].text.length > 0);
  } finally {
    server.close();
    agent.shutdown();
  }
});

test("HTTP: 版本头与 body 不一致 -> 400 HeaderMismatch", async () => {
  const agent = makeAgent();
  const srv = new McpServer(agent);
  const { server, url } = await startHttp(srv);
  try {
    const r = await post(url, discoverReq(), { "mcp-protocol-version": "2025-03-26", "accept": "application/json" });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error.code, MCP_ERROR.HEADER_MISMATCH);
  } finally {
    server.close();
    agent.shutdown();
  }
});

test("HTTP: 通知 (无 id) -> 202 Accepted", async () => {
  const agent = makeAgent();
  const srv = new McpServer(agent);
  const { server, url } = await startHttp(srv);
  try {
    const r = await post(url, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    assert.equal(r.status, 202);
  } finally {
    server.close();
    agent.shutdown();
  }
});

test("HTTP: 未知方法 -> 404 + -32601", async () => {
  const agent = makeAgent();
  const srv = new McpServer(agent);
  const { server, url } = await startHttp(srv);
  try {
    const r = await post(url, { jsonrpc: "2.0", id: 1, method: "bogus/method", params: { _meta: modernMeta() } },
      { "mcp-protocol-version": MODERN_PROTOCOL_VERSION, "accept": "application/json" });
    assert.equal(r.status, 404);
    const j = await r.json();
    assert.equal(j.error.code, MCP_ERROR.METHOD_NOT_FOUND);
  } finally {
    server.close();
    agent.shutdown();
  }
});

test("HTTP: 非 POST -> 405", async () => {
  const agent = makeAgent();
  const srv = new McpServer(agent);
  const { server, url } = await startHttp(srv);
  try {
    const r = await fetch(url, { method: "GET" });
    assert.equal(r.status, 405);
  } finally {
    server.close();
    agent.shutdown();
  }
});

test("HTTP: 对话工具 ppx.chat.send 离线可回复", async () => {
  const agent = makeAgent();
  const srv = new McpServer(agent);
  const { server, url } = await startHttp(srv);
  try {
    const r = await post(url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ppx.chat.send", arguments: { message: "你好皮皮虾" }, _meta: modernMeta() } },
      { "mcp-protocol-version": MODERN_PROTOCOL_VERSION, "accept": "application/json, text/event-stream" });
    assert.equal(r.status, 200);
    const c = await r.json();
    assert.ok(c.result.content[0].text.length > 0, "离线也应回复");
  } finally {
    server.close();
    agent.shutdown();
  }
});

test("HTTP: Origin 校验拒绝跨源", async () => {
  const agent = makeAgent();
  const srv = new McpServer(agent);
  const { server, url } = await startHttp(srv);
  try {
    const r = await post(url, discoverReq(), { "origin": "https://evil.example.com", "mcp-protocol-version": MODERN_PROTOCOL_VERSION, "accept": "application/json" });
    assert.equal(r.status, 403);
  } finally {
    server.close();
    agent.shutdown();
  }
});

// ---- REST 退役开关 (legacy_rest) ----
import { startServer } from "../src/server.js";

async function bootLegacy(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-legacy-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({ providers: [], channels: { http: { mcp: { legacy_rest: opts.legacyRest } } } }));
  const svc = await startServer({ root, port: 0, host: "127.0.0.1" });
  const port = svc.server.address().port;
  const token = svc.http.authToken;
  const headers = token ? { "Content-Type": "application/json", "Authorization": `Bearer ${token}` } : { "Content-Type": "application/json" };
  return { ...svc, port, headers, root };
}

test("REST 退役: legacy_rest=false 时 /api/* 与 /message 返回 410", async () => {
  const svc = await bootLegacy({ legacyRest: false });
  try {
    const r1 = await fetch(`http://127.0.0.1:${svc.port}/api/stats`, { headers: svc.headers });
    assert.equal(r1.status, 410);
    const j1 = await r1.json();
    assert.ok(j1.error.includes("MCP"), `应引导到 /mcp: ${j1.error}`);
    const r2 = await fetch(`http://127.0.0.1:${svc.port}/message`, { method: "POST", headers: svc.headers, body: JSON.stringify({ message: "hi" }) });
    assert.equal(r2.status, 410);
  } finally {
    await new Promise((res) => svc.server.close(res));
    svc.agent.shutdown();
    try { fs.rmSync(svc.root, { recursive: true, force: true }); } catch {}
  }
});

test("REST 兼容: 默认 (legacy_rest 缺省) 时 /api/* 与 /message 仍可用", async () => {
  const svc = await bootLegacy({ legacyRest: undefined });
  try {
    const r1 = await fetch(`http://127.0.0.1:${svc.port}/api/stats`, { headers: svc.headers });
    assert.equal(r1.status, 200);
    const r2 = await fetch(`http://127.0.0.1:${svc.port}/message`, { method: "POST", headers: svc.headers, body: JSON.stringify({ message: "hi" }) });
    assert.equal(r2.status, 200);
  } finally {
    await new Promise((res) => svc.server.close(res));
    svc.agent.shutdown();
    try { fs.rmSync(svc.root, { recursive: true, force: true }); } catch {}
  }
});

test("CORS: /mcp 响应带 Access-Control-Allow-Origin + OPTIONS 预检", async () => {
  const svc = await bootLegacy({ legacyRest: undefined });
  try {
    // 实际 POST (带 Origin) 应有 ACAO 头
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION, "io.modelcontextprotocol/clientInfo": { name: "x", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } });
    const r = await fetch(`http://127.0.0.1:${svc.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": MODERN_PROTOCOL_VERSION, "origin": "http://localhost:3000", ...svc.headers },
      body,
    });
    assert.equal(r.status, 200);
    assert.ok(r.headers.get("access-control-allow-origin") != null, "应带 ACAO 头 (浏览器跨域必需)");
    // OPTIONS 预检
    const o = await fetch(`http://127.0.0.1:${svc.port}/mcp`, {
      method: "OPTIONS",
      headers: { "origin": "http://localhost:3000", "access-control-request-method": "POST", "access-control-request-headers": "content-type,mcp-protocol-version,authorization" },
    });
    assert.equal(o.status, 204);
    const ah = (o.headers.get("access-control-allow-headers") || "").toLowerCase();
    assert.ok(ah.includes("mcp-protocol-version"), `Allow-Headers 应含 MCP 头: ${ah}`);
  } finally {
    await new Promise((res) => svc.server.close(res));
    svc.agent.shutdown();
    try { fs.rmSync(svc.root, { recursive: true, force: true }); } catch {}
  }
});
