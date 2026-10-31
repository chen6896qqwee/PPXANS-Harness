// src/mcp-stdio.js - MCP stdio 传输宿主 (2026-10-31)
// 位置: src 根层组合入口 (与 server.js 同级) —— 它 import agent (组合根职责);
//   放进 src/mcp/ 会造成 agent → mcp (既有) + mcp → agent 依赖环, 已被 arch-guard 拦下。
// 让 Claude Code / ZCode / Cursor / MCP Inspector 等任何 MCP 客户端把皮皮虾作为 **stdio 型
// MCP 服务器**直接接入: `ppx mcp serve` (或 node bin/ppx-mcp.js)。
//   Claude Code:   claude mcp add ppx -- ppx mcp serve
//   通用 .mcp.json: { "mcpServers": { "ppx": { "command": "ppx", "args": ["mcp", "serve"] } } }
//
// 协议: JSON-RPC 2.0 over stdio, **逐行一个消息** (与 MCP stdio 规范一致; 自己的
//   StdioTransport 客户端同款分帧)。stdout 是协议信道 —— 进程内所有日志一律改道 stderr。
// 进度通知: 与 HTTP 传输同款 ctx.stream 契约 (mcp/http.js), 带 progressToken 的
//   tools/call 在流式回复时收到 notifications/progress + notifications/message。
// 生命周期: stdin 结束 → agent.shutdown() 后退出 (客户端断开即回收, 不留孤儿)。

import readline from "node:readline";
import { PPXAgent } from "./agent/index.js";
import { McpServer, MCP_ERROR } from "./mcp/server.js";

// 单行 JSON-RPC 分发: 返回要写回 stdout 的响应对象 (通知返回 null)
async function dispatchLine(server, line, write) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: MCP_ERROR.PARSE_ERROR, message: "Parse error: 非 JSON 行" } };
  }
  const isNotification = msg && typeof msg === "object" && msg.id === undefined;
  try {
    // 带 progressToken 的请求 (流式工具) 注入 ctx.stream —— 通知实时写 stdout
    const progressToken = msg?.params?._meta?.progressToken;
    const ctx = progressToken !== undefined
      ? {
          stream: {
            onDelta: (delta, extra = {}) => write({
              jsonrpc: "2.0", method: "notifications/progress",
              params: { progressToken, progress: extra.progress, total: extra.total, message: String(delta).slice(0, 4000) },
            }),
            onMessage: (text) => write({
              jsonrpc: "2.0", method: "notifications/message",
              params: { level: "info", data: String(text).slice(0, 4000) },
            }),
            onTool: (ev) => {
              if (!ev) return;
              write({
                jsonrpc: "2.0", method: "notifications/message",
                params: { level: "info", data: { type: "tool", tool: ev.tool, status: ev.type || ev.status, ok: ev.ok, durationMs: ev.durationMs } },
              });
            },
            onStep: (ev) => {
              if (!ev) return;
              write({
                jsonrpc: "2.0", method: "notifications/message",
                params: { level: "info", data: { type: "step", round: ev.round, maxRounds: ev.maxRounds } },
              });
            },
          },
        }
      : {};
    const { result } = await server.handle(msg, ctx);
    if (isNotification) return null; // 通知无响应
    return { jsonrpc: "2.0", id: msg.id, result: result ?? null };
  } catch (e) {
    if (isNotification) return null;
    const code = e && typeof e.code === "number" ? e.code : MCP_ERROR.INTERNAL_ERROR;
    const err = { code, message: String((e && e.message) || e) };
    if (e && e.data != null) err.data = e.data;
    return { jsonrpc: "2.0", id: msg && msg.id !== undefined ? msg.id : null, error: err };
  }
}

/**
 * 启动 stdio MCP 宿主 (阻塞直到 stdin 结束)。
 * @param {object} [opts]
 * @param {string} [opts.root] 工作区根 (默认进程 cwd 的仓库根)
 * @param {NodeJS.ReadableStream} [opts.input] 默认 process.stdin (可注入, 测试用)
 * @param {NodeJS.WritableStream} [opts.output] 默认 process.stdout (可注入, 测试用)
 * @param {boolean} [opts.redirectLogs=true] 把 console.log/warn 改道 stderr (保 stdout 协议纯净)
 * @returns {Promise<{ agent, server }>} stdin 结束并完成 shutdown 后 resolve
 */
export async function runStdioHost({
  root,
  input = process.stdin,
  output = process.stdout,
  redirectLogs = true,
} = {}) {
  // stdout 是协议信道: 全进程日志改道 stderr (logger 用 console.log/warn, 直接改道最保险)
  if (redirectLogs) {
    console.log = (...a) => console.error(...a);
    console.warn = (...a) => console.error(...a);
  }
  const agent = new PPXAgent(root ? { root } : {});
  const server = new McpServer(agent, { name: agent.config?.agent?.name || "ppxans-harness" });

  const write = (obj) => {
    try { output.write(JSON.stringify(obj) + "\n"); } catch { /* 流已关闭: 静默 */ }
  };
  console.error(`[ppx-mcp] stdio 宿主就绪: ${server.serverInfo.name} v${server.serverInfo.version} · ${agent.tools?.list?.().length ?? "?"} 工具 (JSON-RPC over stdio, 逐行分帧)`);

  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    try { await agent.shutdown(); } catch { /* 关闭失败不强退 */ }
  };

  const rl = readline.createInterface({ input, terminal: false });
  rl.on("line", (line) => {
    const s = String(line || "").trim();
    if (!s) return;
    dispatchLine(server, s, write)
      .then((resp) => { if (resp) write(resp); })
      .catch((e) => {
        // dispatch 内部已兜错; 这里是最后防线
        console.error("[ppx-mcp] 分发异常:", e?.message || e);
      });
  });
  await new Promise((resolve) => {
    rl.on("close", async () => {
      await shutdown();
      resolve();
    });
  });
  return { agent, server };
}
