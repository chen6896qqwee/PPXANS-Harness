// test/mcp.test.js - MCP 客户端 (零依赖)
// 覆盖: stdio 传输 + HTTP Streamable 传输 + 超时 + isError 透传
import { test } from "node:test";
import assert from "node:assert";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, extractToolText, extractToolResult, parseSSE } from "../src/mcp/client.js";
import { registerMcpTools } from "../src/mcp/index.js";
import { ToolCatalog } from "../src/tools/catalog.js";
import { TOOL_ERROR_PREFIX } from "../src/tools/catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "..", "fixtures", "mock-mcp-server.cjs");

// ---- 内联 mock HTTP MCP 服务器 (Streamable HTTP) ----
// 返回 { server, url }。含 session-id 维护 + boom 工具(报错) 供 isError 测试。
function startHttpMock() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg = {};
      try { msg = JSON.parse(body || "{}"); } catch {}
      const send = (code, obj, headers = {}) => {
        res.writeHead(code, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(obj));
      };
      if (msg.method === "initialize") {
        send(200, {
          jsonrpc: "2.0", id: msg.id,
          result: { protocolVersion: "2025-03-26", serverInfo: { name: "http-mock", version: "1.0" }, capabilities: { tools: {}, resources: {}, prompts: {} } },
        }, { "mcp-session-id": "mock-session-1" });
      } else if (msg.method === "tools/list") {
        send(200, {
          jsonrpc: "2.0", id: msg.id,
          result: { tools: [
            { name: "echo", description: "回显", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
            { name: "boom", description: "故意报错", inputSchema: { type: "object", properties: {} } },
          ] },
        });
      } else if (msg.method === "tools/call") {
        const name = msg.params?.name;
        const args = msg.params?.arguments || {};
        let result;
        if (name === "boom") result = { content: [{ type: "text", text: "boom!" }], isError: true };
        else result = { content: [{ type: "text", text: "echo:" + JSON.stringify(args) }] };
        send(200, { jsonrpc: "2.0", id: msg.id, result });
      } else if (msg.method === "resources/list") {
        send(200, { jsonrpc: "2.0", id: msg.id, result: { resources: [
          { uri: "mock://doc/readme", name: "README" },
        ] } });
      } else if (msg.method === "resources/read") {
        send(200, { jsonrpc: "2.0", id: msg.id, result: { contents: [
          { uri: "mock://doc/readme", mimeType: "text/plain", text: "这是 mock 资源内容" },
        ] } });
      } else if (msg.method === "prompts/list") {
        send(200, { jsonrpc: "2.0", id: msg.id, result: { prompts: [
          { name: "greet", description: "问候", arguments: [{ name: "name", required: true }] },
        ] } });
      } else if (msg.method === "prompts/get") {
        const name = msg.params?.arguments?.name || "世界";
        send(200, { jsonrpc: "2.0", id: msg.id, result: { messages: [{ role: "user", content: { type: "text", text: `你好, ${name}` } }] } });
      } else {
        send(200, { jsonrpc: "2.0", id: msg.id, result: {} });
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function urlOf(server) { return `http://127.0.0.1:${server.address().port}/mcp`; }

test("McpClient stdio 连接 + listTools + callTool", async () => {
  const client = new McpClient({ command: process.execPath, args: [FIXTURE] });
  await client.connect();
  const tools = await client.listTools();
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, "echo");
  const r = await client.callTool("add", { a: 2, b: 3 });
  assert.equal(r, "5");
  client.close();
});

test("McpClient HTTP 传输 (Streamable HTTP)", async () => {
  const server = await startHttpMock();
  const client = new McpClient({ url: urlOf(server), timeout: 5000 });
  await client.connect();
  const tools = await client.listTools();
  assert.equal(tools.length, 2);
  const r = await client.callTool("echo", { text: "hi" });
  assert.ok(r.includes("hi"));
  // 原始结果保留 isError 供上层判断
  const raw = await client.callToolRaw("boom", {});
  const { isError, text } = extractToolResult(raw);
  assert.equal(isError, true);
  assert.equal(text, "boom!");
  client.close();
  server.close();
});

test("McpClient 请求超时 (服务器不响应)", async () => {
  const server = http.createServer(() => {}); // 收到请求不回应
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const client = new McpClient({ url: urlOf(server), timeout: 200 });
  await assert.rejects(() => client.connect(), /超时/);
  client.close();
  server.close();
});

test("registerMcpTools HTTP 服务器 + isError 前缀透传 + 资源工具", async () => {
  const server = await startHttpMock();
  const catalog = new ToolCatalog();
  const r = await registerMcpTools(catalog, [{ url: urlOf(server), prefix: "h_" }]);
  // 2 个工具 + 2 个资源工具 (服务器声明 resources 能力)
  assert.equal(r.count, 4);
  assert.ok(catalog.has("h_echo"));
  // 正常工具
  const ok = await catalog.call("h_echo", { text: "x" });
  assert.ok(ok.includes("x"));
  // 报错工具 -> 带上 TOOL_ERROR_PREFIX, 触发皮皮虾自愈重试语义
  const bad = await catalog.call("h_boom", {});
  assert.ok(bad.startsWith(TOOL_ERROR_PREFIX), `期望以错误前缀开头, 实际: ${bad}`);
  // 资源工具: 列出 + 读取
  assert.ok(catalog.has("h_list_resources"));
  assert.ok(catalog.has("h_read_resource"));
  const list = await catalog.call("h_list_resources", {});
  assert.ok(list.includes("mock://doc/readme"));
  const read = await catalog.call("h_read_resource", { uri: "mock://doc/readme" });
  assert.ok(read.includes("mock 资源内容"));
  r.close();
  server.close();
});

test("parseSSE 解析 message 事件", () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\n: ping\n\n';
  const out = parseSSE(sse);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
});

test("McpClient 资源与提示 (resources/prompts)", async () => {
  const server = await startHttpMock();
  const client = new McpClient({ url: urlOf(server), timeout: 5000 });
  await client.connect();
  const prompts = await client.listPrompts();
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].name, "greet");
  const msgs = await client.getPrompt("greet", { name: "兄弟" });
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].content.text.includes("兄弟"));
  client.close();
  server.close();
});

test("extractToolText 提取文本", () => {
  assert.equal(extractToolText({ content: [{ type: "text", text: "hello" }] }), "hello");
  assert.equal(extractToolText("plain"), "plain");
  assert.equal(extractToolText(null), "");
});

test("registerMcpTools stdio 注册 MCP 工具到 catalog", async () => {
  const catalog = new ToolCatalog();
  const r = await registerMcpTools(catalog, [{ command: process.execPath, args: [FIXTURE], prefix: "mock_" }]);
  assert.equal(r.count, 2);
  assert.ok(catalog.has("mock_echo"));
  assert.ok(catalog.has("mock_add"));
  const result = await catalog.call("mock_add", { a: 10, b: 5 });
  assert.ok(result.includes("15"));
  r.close();
});

test("registerMcpTools 跳过无效配置", async () => {
  const catalog = new ToolCatalog();
  const r = await registerMcpTools(catalog, [{}]);
  assert.equal(r.count, 0);
  r.close();
});
