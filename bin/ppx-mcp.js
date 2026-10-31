#!/usr/bin/env node
// bin/ppx-mcp.js - MCP stdio 宿主入口 (`ppx mcp serve`)
// 让 Claude Code / ZCode / Cursor 等把皮皮虾作为 stdio 型 MCP 服务器接入:
//   claude mcp add ppx -- ppx mcp serve
// stdout 是协议信道, 日志全走 stderr (stdio-host 内部已改道)。
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runStdioHost } from "../src/mcp-stdio.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
await runStdioHost({ root: ROOT });
