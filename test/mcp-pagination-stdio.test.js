// test/mcp-pagination-stdio.test.js — tools/list 真分页 + stdio 宿主 (2026-10-31)
// 此前 tools/list 分页是占位实现 (单页全量, cursor 非空仅回 nextCursor:null);
// stdio 宿主此前不存在 —— Claude Code / ZCode 只能走 HTTP 端点接皮皮虾。
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { McpServer, MCP_ERROR, MODERN_PROTOCOL_VERSION } from "../src/mcp/server.js";
import { McpClient } from "../src/mcp/client.js";
import { runStdioHost } from "../src/mcp-stdio.js";
import { PPXAgent } from "../src/agent/index.js";
import http from "node:http";

// ---- 测试脚手架 ----

function fakeAgent(nTools) {
  return {
    config: {},
    tools: {
      listDetailed: () => Array.from({ length: nTools }, (_, i) => ({
        name: `tool_${String(i).padStart(2, "0")}`,
        enabled: true,
        description: `t${i}`,
        parameters: { type: "object", properties: {} },
      })),
      has: (n) => /^tool_/.test(String(n)),
    },
  };
}

const modernMsg = (method, params = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION } },
});

function tmpRoot(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-mcp-${tag}-`));
  fs.mkdirSync(path.join(d, "config"), { recursive: true });
  fs.writeFileSync(path.join(d, "config", "ppx.json"), JSON.stringify({ providers: [] }));
  return d;
}

// ---- 服务端真分页 ----

test("分页: 逐页翻完, 聚合结果与全量一致, 末页无 nextCursor", async () => {
  const server = new McpServer(fakeAgent(7), { pageSize: 3 });
  const all = [];
  let cursor;
  let pages = 0;
  do {
    const { result } = await server.handle(modernMsg("tools/list", cursor ? { cursor } : {}));
    assert.ok(Array.isArray(result.tools));
    all.push(...result.tools.map((t) => t.name));
    cursor = result.nextCursor || null;
    pages++;
    assert.ok(pages < 10, "不失控");
  } while (cursor);
  assert.equal(pages, 3, "7 内置 + 2 chat 虚拟 = 9 个 / 每页 3 = 3 页");
  // 顺序保持: 目录工具在前 (序保持), chat 虚拟工具殿后
  assert.deepEqual(all, [
    ...Array.from({ length: 7 }, (_, i) => `tool_${String(i).padStart(2, "0")}`),
    "ppx.chat.send", "ppx.chat.stream",
  ]);
});

test("分页: 列表不超页时不发 nextCursor (存量客户端零感知)", async () => {
  const server = new McpServer(fakeAgent(5), { pageSize: 128 });
  const { result } = await server.handle(modernMsg("tools/list"));
  assert.equal(result.tools.length, 7, "5 目录 + 2 chat 虚拟");
  assert.equal(result.nextCursor, undefined, "单页装满 → 无游标");
});

test("分页: 默认 pageSize=128 (现状 120+ 工具单页)", async () => {
  const server = new McpServer(fakeAgent(7));
  const { result } = await server.handle(modernMsg("tools/list"));
  assert.equal(result.nextCursor, undefined);
});

test("分页: 非法 cursor → INVALID_PARAMS; 越界 cursor → 空页不炸", async () => {
  const server = new McpServer(fakeAgent(3), { pageSize: 2 });
  await assert.rejects(
    () => server.handle(modernMsg("tools/list", { cursor: "not-a-cursor!!" })),
    (e) => e.code === MCP_ERROR.INVALID_PARAMS,
  );
  const beyond = Buffer.from(String(99), "utf8").toString("base64url");
  const { result } = await server.handle(modernMsg("tools/list", { cursor: beyond }));
  assert.deepEqual(result.tools, [], "越界 → 空页");
  assert.equal(result.nextCursor, undefined);
});

test("分页: legacy initialize 握手不受影响 (回归)", async () => {
  const server = new McpServer(fakeAgent(2), { pageSize: 1 });
  const { result } = await server.handle({
    jsonrpc: "2.0", id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", clientInfo: { name: "legacy", version: "1" } },
  });
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.ok(result.serverInfo.name);
});

// ---- 客户端 follow cursor ----

test("客户端 listTools: 按服务端 nextCursor 翻页聚合", async () => {
  const PAGE = 2;
  const ALL = ["a", "b", "c", "d", "e"];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg = {};
      try { msg = JSON.parse(body || "{}"); } catch {}
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", serverInfo: { name: "pg", version: "1" }, capabilities: { tools: {} } } }));
        return;
      }
      if (msg.method === "tools/list") {
        const start = msg.params && msg.params.cursor ? Number(Buffer.from(String(msg.params.cursor), "base64url").toString("utf8")) : 0;
        const page = ALL.slice(start, start + PAGE);
        const out = { tools: page.map((n) => ({ name: n, inputSchema: { type: "object", properties: {} } })) };
        if (start + page.length < ALL.length) out.nextCursor = Buffer.from(String(start + page.length), "utf8").toString("base64url");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: out }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const client = new McpClient({ url: `http://127.0.0.1:${server.address().port}/mcp`, timeout: 5000 });
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ALL, "三页聚合完整");
  } finally {
    client.close();
    await new Promise((r) => server.close(r));
  }
});

// ---- stdio 宿主端到端 (进程内, 可注入流) ----

function waitLine(getter, pred, ms = 30000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = getter().find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return reject(new Error("等待响应超时"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test("stdio 宿主: initialize + tools/list 全链路, stdin 结束后干净退出", async () => {
  const root = tmpRoot("stdio");
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  agent.shutdown(); // runStdioHost 会自建 agent; 这个仅用于确保模块级单例? (防御性: 不需要)
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  const lines = [];
  let buf = "";
  output.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { try { lines.push(JSON.parse(line)); } catch { /* 非协议行 */ } }
    }
  });

  const hostPromise = runStdioHost({ root, input, output });
  // 逐行发请求 (PassThrough 会缓冲到宿主开始读)
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "test-client", version: "1" } } }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  input.write("not-json-line\n"); // 坏行 → Parse error 响应, 不断流

  const initResp = await waitLine(() => lines, (m) => m.id === 1 && m.result);
  assert.ok(initResp.result.serverInfo.name, "initialize 应答带 serverInfo");
  const toolsResp = await waitLine(() => lines, (m) => m.id === 2 && m.result);
  assert.ok(Array.isArray(toolsResp.result.tools) && toolsResp.result.tools.length >= 2, "tools/list 有工具 (内置 + chat 虚拟)");
  assert.ok(toolsResp.result.tools.some((t) => t.name === "ppx.chat.send"), "对话虚拟工具在列");
  const parseErr = await waitLine(() => lines, (m) => m.id === null && m.error);
  assert.equal(parseErr.error.code, MCP_ERROR.PARSE_ERROR, "坏行回 Parse error");

  // stdin 结束 → 宿主 shutdown 并 resolve
  input.end();
  await hostPromise;
});

test("stdio 宿主: 通知 (无 id) 不回响应, ping 可达", async () => {
  const root = tmpRoot("stdio2");
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  const lines = [];
  let buf = "";
  output.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { try { lines.push(JSON.parse(line)); } catch { /* 忽略 */ } }
    }
  });
  const hostPromise = runStdioHost({ root, input, output });
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION } } }) + "\n");
  // 给通知一点时间: 若通知被误回 (带 id:null 或 result), waitLine 之前的短等待会看到
  await new Promise((r) => setTimeout(r, 300));
  const ping = await waitLine(() => lines, (m) => m.id === 9 && m.result);
  assert.ok(ping.result, "ping 应答");
  assert.ok(!lines.some((m) => m.id === null && m.method === undefined && m.result && m.result.resultType === "complete" && !("tools" in m.result) && lines.indexOf(m) < lines.indexOf(ping)), "通知不产生响应");
  input.end();
  await hostPromise;
});
