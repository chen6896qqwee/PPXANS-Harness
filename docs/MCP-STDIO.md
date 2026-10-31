# MCP stdio 宿主 (`ppx mcp serve`)

2026-10-31 起皮皮虾可以作为 **stdio 型 MCP 服务器**被任何 MCP 客户端直接接入 —— 不需要开 HTTP 端口、不需要 token 配置。

## 各客户端接入方式

**Claude Code**

```bash
claude mcp add ppx -- ppx mcp serve
# 或指定完整路径 (未全局安装时):
claude mcp add ppx -- node /path/to/PPXANS-Harness/bin/ppx-mcp.js
```

**Cursor / ZCode / 通用 `.mcp.json`**

```jsonc
{
  "mcpServers": {
    "ppx": {
      "command": "ppx",          // 未全局安装: "node"
      "args": ["mcp", "serve"]   // 未全局安装: ["/path/to/PPXANS-Harness/bin/ppx-mcp.js"]
    }
  }
}
```

**MCP Inspector**

```bash
npx @modelcontextprotocol/inspector ppx mcp serve
```

等价 npm 脚本：`npm run mcp:serve`。

## 暴露内容

- **tools/list + tools/call**：98 内置工具 + 2 个对话虚拟工具（`ppx.chat.send` / `ppx.chat.stream`，驱动完整工具调用循环）。工具调用统一走 agent 准入链（PreToolUse 钩子 → 权限引擎 → 审批 → 审计），stdio 端点不是权限旁路。
- **tools/list 真分页**：每页默认 128 个，超出按 `nextCursor` 翻页（官方客户端语义；当前列表单页装得下，不发烧游标）。
- **resources**：`memory://facts`、`memory://scenes`、`traces://recent`、`stats://overview`、`sessions://list`、`sessions://<key>/history`
- **prompts**：`humanize` / `plan` / `debug` / `verify` / `write_article`
- **进度通知**：带 `progressToken` 的流式工具调用（`ppx.chat.stream`）实时收到 `notifications/progress` + `notifications/message`（与 HTTP 传输同款契约）。

## 协议与生命周期

- JSON-RPC 2.0 over stdio，**逐行一个消息**（MCP stdio 规范分帧）。
- stdout 是协议信道：进程内所有日志（含 agent 启动日志）自动改道 stderr，保证协议流纯净。
- 客户端关闭 stdin → 宿主 `agent.shutdown()` 后退出（不留孤儿进程）。
- 协议版本：legacy `initialize` 握手（≤ 2025-06-18）+ 现代 `_meta` 逐请求（2026-07-28），与 HTTP 端点同一实现（`src/mcp/server.js`）。

## 与 HTTP 端点的取舍

| | stdio（`ppx mcp serve`） | HTTP（`POST /mcp`） |
|---|---|---|
| 鉴权 | 无需（子进程随客户端生命周期） | Bearer token |
| 多客户端 | 单客户端独占 | 多客户端共享 |
| 适用 | 桌面/编辑器 MCP 客户端接入 | 远程/多端/自建 Web |
