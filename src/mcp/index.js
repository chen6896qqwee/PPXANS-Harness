// src/mcp/index.js - MCP 工具注册 (接入 MCP 工具生态)
// 把 MCP 服务器的工具转换为皮皮虾 ToolCatalog 工具, 与内置工具同权。
// servers: [
//   { command, args, env, prefix }                         // stdio (本机)
//   { url, headers, prefix, timeout }                      // HTTP Streamable (远程)
// ]
import { McpClient, extractToolResult, extractResourceText } from "./client.js";
import { TOOL_ERROR_PREFIX } from "../tools/catalog.js";
import { warn, info } from "../utils/logger.js";

// v1.0.8: MCP 工具名清洗 (只留 \w.-, 截断) — 防恶意服务器注册非法工具名/注入
export function sanitizeMcpName(name) {
  return String(name || "").replace(/[^\w.-]/g, "_").slice(0, 64);
}

// v1.0.8: MCP 工具描述清洗 (单行化 + 截断) — 服务器描述直接进 LLM prompt, 防换行/长文本注入指令
export function sanitizeMcpDescription(desc, name) {
  const s = String(desc || "").replace(/\s+/g, " ").trim();
  return s.slice(0, 200) || `MCP 工具: ${name}`;
}

// 连接所有 MCP 服务器, 列出工具并注册到 catalog。
// 除 tools 外, 服务器声明 resources/prompts 能力时, 额外注册对应读写工具 (P2⑥)。
// 返回 { count, clients, close } — close() 关闭全部连接 (调用方负责生命周期)
export async function registerMcpTools(catalog, servers = []) {
  const clients = [];
  let count = 0;
  for (const s of servers) {
    if (!s) { warn("[mcp] 跳过无效服务器配置"); continue; }
    if (!s.command && !s.url) { warn("[mcp] 跳过无效服务器配置 (缺 command/url)"); continue; }
    const client = new McpClient(s);
    try {
      await client.connect();
      const tools = await client.listTools();
      for (const t of tools) {
        if (!t || !t.name) continue;
        const name = (s.prefix || "") + sanitizeMcpName(t.name);
        catalog.register({
          name,
          description: sanitizeMcpDescription(t.description, t.name),
          parameters: t.inputSchema || { type: "object", properties: {} },
          category: "mcp",
          // isError 时加错误前缀, 让皮皮虾的自愈重试语义对 MCP 工具同样生效
          execute: async (args) => {
            const raw = await client.callToolRaw(t.name, args || {});
            const { text, isError } = extractToolResult(raw);
            return isError ? `${TOOL_ERROR_PREFIX} MCP 工具 ${t.name}: ${text}` : text;
          },
        });
        count += 1;
      }
      count += registerResourceTools(catalog, client, s);
      clients.push(client);
    } catch (e) {
      warn(`[mcp] 服务器 ${s.command || s.url} 连接失败: ${e.message}`);
      client.close();
    }
  }
  if (count) info(`[mcp] 已注册 ${count} 个 MCP 工具`);
  return { count, clients, close: () => clients.forEach((c) => c.close()) };
}

// 服务器声明 resources 能力时, 注册 list_resources / read_resource 两个工具 (让 LLM 可读远程资源)
function registerResourceTools(catalog, client, s) {
  if (!client.capabilities?.resources) return 0;
  const prefix = s.prefix || "";
  const label = s.command || s.url || "MCP";
  catalog.register({
    name: prefix + "list_resources",
    description: `列出 MCP 服务器 ${label} 提供的资源 (URI 列表)`,
    parameters: { type: "object", properties: {}, required: [] },
    category: "mcp",
    execute: async () => {
      const res = await client.listResources();
      return res.map((r) => `${r.uri || "?"}${r.name ? ` — ${r.name}` : ""}`).join("\n") || "(无资源)";
    },
  });
  catalog.register({
    name: prefix + "read_resource",
    description: `读取 MCP 服务器 ${label} 的资源内容 (按 uri)`,
    parameters: { type: "object", properties: { uri: { type: "string", description: "资源 URI" } }, required: ["uri"] },
    category: "mcp",
    execute: async (args) => extractResourceText(await client.readResource((args || {}).uri)),
  });
  return 2;
}
