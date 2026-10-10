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

// P1⑦ (2026-09-15): MCP 命名空间隔离 —— 防工具名碰撞 (Hermes 生产数据: 51 工具服务器上
//   幻觉工具名命中真实工具; cron job 本想调 kanban_list 结果执行了 list_goals)。
//   强制 serverName__toolName 前缀 + 精确匹配短路。
export function serverLabel(s) {
  // 取服务器可读标识: 配置 name > 包名 (args 里 @scope/pkg 或 *.py) > command 首段 > url host
  if (s && s.name) return sanitizeMcpName(s.name);
  const fromArgs = (s && s.args || []).find((a) => /(?:^|\/)[@\w.-]+(?:@[\w.]+)?$/.test(a) && !a.startsWith("-"));
  if (fromArgs) return sanitizeMcpName(fromArgs.split("/").pop());
  if (s && s.command) return sanitizeMcpName(String(s.command).split(/[\\/\s]/).filter(Boolean).pop() || "mcp");
  if (s && s.url) {
    try {
      const host = new URL(s.url).hostname.split(".").filter(Boolean);
      // 取二级域: mcp.example.com → example; www.google.com → google
      return sanitizeMcpName(host.length >= 2 ? host[host.length - 2] : host[0] || "mcp");
    } catch {}
  }
  return "mcp";
}

export function namespacedMcpName(label, raw) {
  const clean = sanitizeMcpName(raw);
  return clean ? `${label}__${clean}` : label;
}

// v1.0.8: MCP 工具描述清洗 (单行化 + 截断) — 服务器描述直接进 LLM prompt, 防换行/长文本注入指令
// P1⑦: 额外剔除危险 flag (--system/--dangerously 等命令行注入惯用手法)
export function sanitizeMcpDescription(desc, name) {
  let s = String(desc || "").replace(/\s+/g, " ").trim();
  // 危险 flag 清洗: 描述里出现命令行注入惯用 flag 视为可疑, 剔除该片段
  s = s.replace(/--(?:system|dangerously[-\w]*|yes|force|no[-\w]+|y)\b/g, "[flag]");
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
      // P1⑦: 命名空间强制前缀 (serverLabel) —— 默认开启, 可显式 prefix 覆盖/关闭
      const label = serverLabel(s);
      const ns = s.prefix != null ? s.prefix : `${label}__`;
      for (const t of tools) {
        if (!t || !t.name) continue;
        const name = ns + sanitizeMcpName(t.name);
        // P1⑦: 精确匹配短路 —— 注册时登记原始名 (供幻觉工具名防御: 无前缀名永不执行)
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
      count += registerResourceTools(catalog, client, s, ns);
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
function registerResourceTools(catalog, client, s, ns = "") {
  if (!client.capabilities?.resources) return 0;
  const label = s.command || s.url || "MCP";
  catalog.register({
    name: ns + "list_resources",
    description: `列出 MCP 服务器 ${label} 提供的资源 (URI 列表)`,
    parameters: { type: "object", properties: {}, required: [] },
    category: "mcp",
    execute: async () => {
      const res = await client.listResources();
      return res.map((r) => `${r.uri || "?"}${r.name ? ` — ${r.name}` : ""}`).join("\n") || "(无资源)";
    },
  });
  catalog.register({
    name: ns + "read_resource",
    description: `读取 MCP 服务器 ${label} 的资源内容 (按 uri)`,
    parameters: { type: "object", properties: { uri: { type: "string", description: "资源 URI" } }, required: ["uri"] },
    category: "mcp",
    execute: async (args) => extractResourceText(await client.readResource((args || {}).uri)),
  });
  return 2;
}
