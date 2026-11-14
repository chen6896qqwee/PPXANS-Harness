// src/mcp/index.js - MCP 工具注册 (接入 MCP 工具生态)
// 把 MCP 服务器的工具转换为皮皮虾 ToolCatalog 工具, 与内置工具同权。
// servers: [
//   { command, args, env, prefix }                         // stdio (本机)
//   { url, headers, prefix, timeout }                      // HTTP Streamable (远程)
// ]
import { createHash } from "node:crypto";
import { McpClient, extractToolResult, extractResourceText } from "./client.js";
import { TOOL_ERROR_PREFIX } from "../tools/catalog.js";
import { warn, info } from "../utils/logger.js";

// 2026-11-06 (评估 P1-1): 工具名契约 —— OpenAI 兼容后端只接受 ^[a-zA-Z0-9_-]+$ 且 ≤64。
//   旧清洗保留了 `.` (如 `fs.read_text` / `node.exe`), DeepSeek 直接 400 invalid_request_error;
//   再叠加 serverName__ 前缀后很容易超 64。现在: 字符合约 + 超长保留可读前缀并用内容哈希兜底,
//   既不越界也不把不同工具截成同一个名字。
const MCP_NAME_MAX = 64;
const MCP_NAME_RE = /[^A-Za-z0-9_-]/g;
const EXE_EXT_RE = /\.(?:exe|cmd|bat|ps1|com|sh)$/i;

function shortHash(s) {
  return createHash("sha256").update(String(s)).digest("hex").slice(0, 8);
}

export function fitMcpName(name) {
  const clean = String(name || "").replace(MCP_NAME_RE, "_");
  if (clean.length <= MCP_NAME_MAX) return clean;
  const suffix = "_" + shortHash(clean);
  return clean.slice(0, MCP_NAME_MAX - suffix.length) + suffix;
}

// v1.0.8: MCP 工具名清洗 (仅 A-Za-z0-9_-, 超长截断+哈希) — 防非法工具名/注入 + 兼容后端契约
export function sanitizeMcpName(name) {
  return fitMcpName(name);
}

// P1⑦ (2026-09-15): MCP 命名空间隔离 —— 防工具名碰撞 (Hermes 生产数据: 51 工具服务器上
//   幻觉工具名命中真实工具; cron job 本想调 kanban_list 结果执行了 list_goals)。
//   强制 serverName__toolName 前缀 + 精确匹配短路。
export function serverLabel(s) {
  // 取服务器可读标识: 配置 name > 包名 (args 里 @scope/pkg 或 *.py) > command 首段 > url host
  if (s && s.name) return sanitizeMcpName(s.name);
  const fromArgs = (s && s.args || []).find((a) => /(?:^|\/)[@\w.-]+(?:@[\w.]+)?$/.test(a) && !a.startsWith("-"));
  if (fromArgs) return sanitizeMcpName(fromArgs.split("/").pop());
  if (s && s.command) {
    const bin = String(s.command).split(/[\\/\s]/).filter(Boolean).pop() || "mcp";
    return sanitizeMcpName(bin.replace(EXE_EXT_RE, ""));
  }
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
  const lab = sanitizeMcpName(label);
  return clean ? fitMcpName(`${lab}__${clean}`) : lab;
}

// 注册期名字构造器: 显式 prefix 覆盖命名空间, 否则 serverLabel__toolName;
// used 集合用于同进程内去重 (清洗/截断后可能撞名), 冲突时用原始身份哈希加后缀。
export function makeMcpToolName({ label, raw, prefix = null, used = null } = {}) {
  const base = prefix != null
    ? fitMcpName(sanitizeMcpName(prefix) + sanitizeMcpName(raw))
    : namespacedMcpName(label, raw);
  if (!used) return base;
  let name = base;
  if (used.has(name)) {
    const suffix = "_" + shortHash(`${label}/${raw}`);
    name = name.slice(0, MCP_NAME_MAX - suffix.length) + suffix;
  }
  let n = 2;
  const stem = name;
  while (used.has(name)) {
    const suffix = "_" + n++;
    name = stem.slice(0, MCP_NAME_MAX - suffix.length) + suffix;
  }
  used.add(name);
  return name;
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
  const status = []; // 每个服务器一条连接结果 (管理页展示用; 不改动 count/clients 既有语义)
  const usedNames = new Set(); // 跨服务器去重: 清洗/截断后同名工具不能互相覆盖
  let count = 0;
  for (const s of servers) {
    if (!s) { warn("[mcp] 跳过无效服务器配置"); continue; }
    if (!s.command && !s.url) { warn("[mcp] 跳过无效服务器配置 (缺 command/url)"); continue; }
    const client = new McpClient(s);
    const label = serverLabel(s);
    const transport = s.url ? "http" : "stdio";
    try {
      await client.connect();
      const tools = await client.listTools();
      let registered = 0;
      for (const t of tools) {
        if (!t || !t.name) continue;
        const name = makeMcpToolName({ label, raw: t.name, prefix: s.prefix, used: usedNames });
        // P1⑦: 精确匹配短路 —— 注册时登记原始名 (供幻觉工具名防御: 无前缀名永不执行)
        catalog.register({
          name,
          description: sanitizeMcpDescription(t.description, t.name),
          parameters: t.inputSchema || { type: "object", properties: {} },
          category: "mcp",
          // (R14) 信任开关: 外部 MCP 工具是未审计的第三方代码, 其名称不可能命中
          // 基于名字的 REQUIRES_APPROVAL_TOOLS 名单, ON_REQUEST 模式下曾静默放行
          // (真模型探测实锤)。默认 fail closed: server 配 trusted: true 才免审批。
          mcpTrusted: s.trusted === true,
          // isError 时加错误前缀, 让皮皮虾的自愈重试语义对 MCP 工具同样生效
          execute: async (args) => {
            const raw = await client.callToolRaw(t.name, args || {});
            const { text, isError } = extractToolResult(raw);
            return isError ? `${TOOL_ERROR_PREFIX} MCP 工具 ${t.name}: ${text}` : text;
          },
        });
        registered += 1;
      }
      registered += registerResourceTools(catalog, client, s, label, usedNames);
      count += registered;
      clients.push(client);
      status.push({ name: label, transport, ok: true, tools: registered, error: null });
    } catch (e) {
      warn(`[mcp] 服务器 ${s.command || s.url} 连接失败: ${e.message}`);
      client.close();
      status.push({ name: label, transport, ok: false, tools: 0, error: String(e?.message || e).slice(0, 300) });
    }
  }
  if (count) info(`[mcp] 已注册 ${count} 个 MCP 工具`);
  return { count, clients, status, close: () => clients.forEach((c) => c.close()) };
}

// 服务器声明 resources 能力时, 注册 list_resources / read_resource 两个工具 (让 LLM 可读远程资源)
function registerResourceTools(catalog, client, s, label, used = null) {
  if (!client.capabilities?.resources) return 0;
  const connector = s.command || s.url || "MCP";
  const make = (raw) => makeMcpToolName({ label, raw, prefix: s.prefix, used });
  catalog.register({
    name: make("list_resources"),
    description: `列出 MCP 服务器 ${connector} 提供的资源 (URI 列表)`,
    parameters: { type: "object", properties: {}, required: [] },
    category: "mcp",
    execute: async () => {
      const res = await client.listResources();
      return res.map((r) => `${r.uri || "?"}${r.name ? ` — ${r.name}` : ""}`).join("\n") || "(无资源)";
    },
  });
  catalog.register({
    name: make("read_resource"),
    description: `读取 MCP 服务器 ${connector} 的资源内容 (按 uri)`,
    parameters: { type: "object", properties: { uri: { type: "string", description: "资源 URI" } }, required: ["uri"] },
    category: "mcp",
    execute: async (args) => extractResourceText(await client.readResource((args || {}).uri)),
  });
  return 2;
}
