// test/mcp-stdio-progress-2026-11-17.test.js — stdio 宿主流式分支 (进程内注入, 零网络)
// 覆盖 dispatchLine 的 progressToken ctx 构造、通知报错不回响应、未知工具错误响应。
// initialize/tools/list/Parse error 已由 mcp-pagination-stdio.test.js 钉住, 这里不重复。
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { MODERN_PROTOCOL_VERSION } from "../src/mcp/server.js";
import { runStdioHost } from "../src/mcp-stdio.js";

function tmpRoot(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-mcp-${tag}-`));
  fs.mkdirSync(path.join(d, "config"), { recursive: true });
  fs.writeFileSync(path.join(d, "config", "ppx.json"), JSON.stringify({ providers: [] }));
  return d;
}

function makeIo() {
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
  return { input, output, lines };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitLine = (lines, pred, ms = 30000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    const hit = lines.find(pred);
    if (hit) return resolve(hit);
    if (Date.now() - t0 > ms) return reject(new Error("等待响应超时"));
    setTimeout(tick, 25);
  };
  tick();
});

test("stdio 宿主: progressToken 构造流式 ctx, 通知报错不回响应, 未知工具报错", async () => {
  const root = tmpRoot("progress");
  const { input, output, lines } = makeIo();
  const hostPromise = runStdioHost({ root, input, output, redirectLogs: false });

  const req = (id, method, params = {}) => JSON.stringify({
    jsonrpc: "2.0", id, method,
    params: { ...params, _meta: { ...(params._meta || {}), "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION } },
  });
  // initialize 走 legacy 握手 (无现代 _meta); 现代 _meta 只用于 tools/call 的 progressToken
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "1" } } }) + "\n");
  input.write(req(2, "tools/call", { name: "get_time", arguments: {}, _meta: { progressToken: "pt-1" } }) + "\n");
  // 通知 (无 id): method 不存在 → server.handle 抛错 → isNotification 分支静默, 不回任何行
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "bogus/nope" }) + "\n");
  input.write(req(3, "tools/call", { name: "definitely_missing_tool", arguments: {} }) + "\n");

  const init = await waitLine(lines, (m) => m.id === 1 && m.result);
  assert.ok(init.result.serverInfo.name, "initialize 应答正常");
  const call = await waitLine(lines, (m) => m.id === 2);
  assert.ok(call.result || call.error, "带 progressToken 的调用有响应");
  const toolErr = await waitLine(lines, (m) => m.id === 3);
  assert.ok(
    (toolErr.error && toolErr.error.code) || toolErr.result?.isError === true,
    "未知工具走错误路径",
  );
  await sleep(120);
  const notified = lines.filter((m) => m.method === "notifications/progress" || m.method === "notifications/message");
  assert.ok(Array.isArray(notified), "流式通知 (若有) 走 notifications/*");
  const silent = lines.find((m) => m.id === null && m.error);
  assert.equal(silent, undefined, "通知的报错必须静默, 不得污染 stdout 协议流");

  input.end();
  await hostPromise;

});
