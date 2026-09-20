// test/http-body-limit.test.js - 请求体上限的三条链路回归 (2026-09-18 重构)
//
// 背景 (重构中暴露的真实缺陷):
//   原先 channels/http.js、mcp/http.js 的 readBody 在超限时【直接从 for await 里 return】,
//   这会销毁请求流 —— 客户端还在上传时就断连, 收到的是网络错误而不是 413, 表现为请求挂死。
//   只有 aml-server.js 的实现是对的 (超限后继续消费剩余数据, 不断连)。
//   收敛到 utils/http.readBody 后统一为「超限只丢弃不累积, 读完再返回 null」。
//
// 本测试覆盖三条链路, 确保 413 能真的送达客户端 (而不是超时/断连):
//   1) HTTP 通道      POST /message          超大 body → 413
//   2) MCP HTTP       POST /mcp              超大 body → 400 (INVALID_REQUEST)
//   3) AML server     POST /v1/memories/add  超大 body → 413
import test from "node:test";
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";
import { HttpChannel } from "../src/channels/http.js";
import { createMcpEndpoint } from "../src/mcp/http.js";
import { createAmlServer } from "../src/aml-server.js";

function tmpRoot(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-body-${tag}-`));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "config", "ppx.json"),
    JSON.stringify({ channels: { http: { mcp: { enabled: false } } } }),
  );
  return root;
}

test("HTTP 通道: 超大请求体返回 413 (不挂死)", { timeout: 20000 }, async () => {
  const root = tmpRoot("chan");
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  ch.authToken = "tok";
  await ch.connect();
  const port = ch.server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({ text: "x".repeat(2 * 1024 * 1024) }),
    });
    assert.equal(res.status, 413, "超过 1MB 应回 413 且响应可达");
  } finally {
    await ch.disconnect();
    agent.shutdown();
  }
});

test("MCP HTTP: 超大请求体返回 400 (不挂死)", { timeout: 20000 }, async () => {
  const root = tmpRoot("mcp");
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  const { handler } = createMcpEndpoint(agent, {});
  const http = await import("node:http");
  const server = http.createServer((req, res) => { handler(req, res).catch(() => {}); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(2 * 1024 * 1024) }),
    });
    assert.equal(res.status, 400, "超过 1MB 应回 400 且响应可达");
  } finally {
    await new Promise((r) => server.close(r));
    agent.shutdown();
  }
});

test("AML server: 超大请求体返回 413 (不挂死)", { timeout: 20000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-body-aml-"));
  process.env.PPX_AML_DATA = dataDir;
  process.env.PPX_AML_AUTH = "none";
  const server = createAmlServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/memories/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "s", messages: [{ content: "x".repeat(2 * 1024 * 1024) }] }),
    });
    assert.equal(res.status, 413, "超过 1MB 应回 413 且响应可达");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
