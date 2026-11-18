// fixtures/mock-mcp-server.cjs - MCP stdio mock 服务器 (测试专用)
// 协议: JSON-RPC 2.0, 换行分隔 (匹配 src/mcp/client.js StdioTransport)
// 工具: echo (回显) + add (加法)
"use strict";
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // 通知 (notifications/initialized 等) 无 id, 不回复
  if (msg.id == null) return;

  const id = msg.id;
  const method = msg.method;
  let result;

  switch (method) {
    case "initialize":
      result = {
        protocolVersion: (msg.params && msg.params.protocolVersion) || "2024-11-05",
        serverInfo: { name: "mock-mcp-server", version: "1.0.0" },
        capabilities: { tools: {} },
      };
      break;
    case "tools/list":
      result = {
        tools: [
          {
            name: "echo",
            description: "回显",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
            },
          },
          {
            name: "add",
            description: "加法",
            inputSchema: {
              type: "object",
              properties: { a: { type: "number" }, b: { type: "number" } },
            },
          },
        ],
      };
      break;
    case "tools/call": {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      if (name === "echo") {
        result = { content: [{ type: "text", text: "echo:" + JSON.stringify(args) }] };
      } else if (name === "add") {
        const sum = Number(args.a || 0) + Number(args.b || 0);
        result = { content: [{ type: "text", text: String(sum) }] };
      } else {
        result = { content: [{ type: "text", text: "unknown tool: " + name }], isError: true };
      }
      break;
    }
    default:
      result = {};
  }

  send({ jsonrpc: "2.0", id, result });
});
