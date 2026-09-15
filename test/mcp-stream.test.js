// test/mcp-stream.test.js - MCP 流式对话 SSE 实测 (零依赖)
// 覆盖: ppx.chat.stream 经 Streamable HTTP 的 SSE 响应流
//   - progress 通知 (notifications/progress) 逐字推送
//   - 最终 JSON-RPC 响应含完整文本
//   - 长文本 (>4KB) 分段推送不丢失
// 用 stub LLM 注入 (streamChat 逐字 onDelta), 无真实网络
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import http from "node:http";

function stubLLM() {
  return {
    providerId: "stub",
    supportsStream: true,
    chat: async () => ({ content: "[stub] 你好, 兄弟!" }),
    streamChat: async (_m, { onDelta } = {}) => {
      const long = "皮皮虾流式测试。" + "这是一段很长的测试文本用于验证 SSE 逐字推送不丢失。" .repeat(300);
      for (let i = 0; i < long.length; i += 3) { onDelta && onDelta(long.slice(i, i + 3)); }
      return long;
    },
    apiChat: async () => ({ message: { role: "assistant", content: "[stub]", tool_calls: null } }),
  };
}

async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-stream-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({ providers: [], tools: { enabled: false }, channels: { http: { mcp: { enabled: true } } } }));
  const svc = await startServer({ root, port: 0, host: "127.0.0.1", llm: stubLLM() });
  const port = svc.server.address().port;
  const token = svc.http.authToken;
  return { ...svc, port, token, root };
}

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "stream-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function parseSSE(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    try { events.push(JSON.parse(dataLine.slice(5).trim())); } catch { /* 忽略注释/心跳 */ }
  }
  return events;
}

test("ppx.chat.stream SSE: progress 通知 + 最终响应 + 长文本完整", async () => {
  const svc = await boot();
  try {
    const body = JSON.stringify({
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "ppx.chat.stream", arguments: { message: "写一篇长文", sessionId: "stream-test" }, _meta: META },
    });
    const r = await fetch(`http://127.0.0.1:${svc.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "text/event-stream, application/json",
        "mcp-protocol-version": "2026-07-28",
        "authorization": `Bearer ${svc.token}`,
      },
      body,
    });
    assert.equal(r.status, 200);
    const ct = r.headers.get("content-type") || "";
    assert.ok(ct.includes("text/event-stream"), `应为 SSE: ${ct}`);

    const raw = await r.text();
    const events = parseSSE(raw);
    assert.ok(events.length >= 2, `至少 progress + 响应: ${events.length}`);

    const progress = events.filter((e) => e.method === "notifications/progress");
    assert.ok(progress.length > 0, "应有 progress 通知");
    // 长文本分段推送: 总推送字数应接近完整文本
    const pushed = progress.map((p) => p.params?.message || "").join("");
    assert.ok(pushed.length > 4000, `长文本应分段推送完整: ${pushed.length} 字`);

    const finalResp = events.find((e) => e.id === 7 && e.result);
    assert.ok(finalResp, "应有最终 JSON-RPC 响应");
    const text = (finalResp.result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    assert.ok(text.length > 4000, `最终响应完整: ${text.length} 字`);
    assert.ok(text.includes("流式测试"), "内容正确");

    // progress 携带 progressToken: 仅当请求 _meta 声明 progressToken 时才回显 (MCP 规范: 可选)
    // 本测试未声明, 故不强制; 这里验证进度消息体结构完整即可
    for (const p of progress) {
      assert.ok(p.params && typeof p.params.message === "string", "progress 应有 message");
    }
  } finally {
    await new Promise((res) => svc.server.close(res));
    svc.agent.shutdown();
    try { fs.rmSync(svc.root, { recursive: true, force: true }); } catch {}
  }
});

test("ppx.chat.send 非流式: 单 JSON 响应无 SSE", async () => {
  const svc = await boot();
  try {
    const body = JSON.stringify({
      jsonrpc: "2.0", id: 8, method: "tools/call",
      params: { name: "ppx.chat.send", arguments: { message: "hi", sessionId: "plain" }, _meta: META },
    });
    const r = await fetch(`http://127.0.0.1:${svc.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "authorization": `Bearer ${svc.token}` },
      body,
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    const t = j.result.content[0].text || "";
    assert.ok(t.length > 0, `应有回复: ${t}`);
  } finally {
    await new Promise((res) => svc.server.close(res));
    svc.agent.shutdown();
    try { fs.rmSync(svc.root, { recursive: true, force: true }); } catch {}
  }
});

// ---- 结构化工具/轮次事件 SSE 透传 (onTool/onStep) ----
import { createMcpHttpHandler } from "../src/mcp/http.js";
import { McpServer } from "../src/mcp/server.js";

test("SSE: 虚拟工具通过 ctx.stream.onTool/onStep 发结构化通知", async () => {
  // 复用 boot 的 agent (已注入 stub), 在其上建 McpServer + handler
  const svc = await boot();
  const srv = new McpServer(svc.agent, { extraTools: [{
    name: "test.stream.events",
    description: "测试事件",
    inputSchema: { type: "object", properties: {} },
    execute: async (args, ctx) => {
      ctx.stream.onStep({ round: 0, maxRounds: 2 });
      ctx.stream.onTool({ tool: "demo", type: "start" });
      ctx.stream.onDelta("第一段");
      ctx.stream.onTool({ tool: "demo", type: "done", ok: true, durationMs: 42 });
      ctx.stream.onDelta("第二段");
      return { content: [{ type: "text", text: "完整" }] };
    },
  }] });
  const handler = createMcpHttpHandler(srv);
  const server = http.createServer((req, res) => { handler(req, res).catch(() => {}); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "test.stream.events", arguments: {}, _meta: META } });
    const r = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "text/event-stream", "mcp-protocol-version": "2026-07-28" },
      body,
    });
    const raw = await r.text();
    const events = parseSSE(raw);
    const steps = events.filter((e) => e.method === "notifications/message" && e.params?.data?.type === "step");
    const tools = events.filter((e) => e.method === "notifications/message" && e.params?.data?.type === "tool");
    const progresses = events.filter((e) => e.method === "notifications/progress");
    assert.equal(steps.length, 1, "应有 step 事件");
    assert.equal(steps[0].params.data.round, 0);
    assert.equal(tools.length, 2, "应有 start+done 两个 tool 事件");
    assert.equal(tools[0].params.data.status, "start");
    assert.equal(tools[1].params.data.status, "done");
    assert.equal(tools[1].params.data.durationMs, 42);
    assert.ok(progresses.length >= 2, "应有 delta progress");
    const final = events.find((e) => e.id === 9 && e.result);
    assert.ok(final, "应有最终响应");
  } finally {
    server.close();
    svc.agent.shutdown();
    await new Promise((res) => svc.server.close(res));
    try { fs.rmSync(svc.root, { recursive: true, force: true }); } catch {}
  }
});
