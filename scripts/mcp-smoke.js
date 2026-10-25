// scripts/mcp-smoke.js - MCP 服务器连通性冒烟测试 (独立运行, 不进 node --test)
// 用途: 验证皮皮虾的零依赖 MCP 客户端能连上一个真实/本机的 MCP 服务器并列出工具。
//
// 用法:
//   node scripts/mcp-smoke.js '{"url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer xxx"}}'
//   node scripts/mcp-smoke.js '{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","C:/data"]}'
//
// 不传参时, 读 config/ppx.json 的 mcp.servers[0]。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpClient } from "../src/mcp/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function loadServerConfig() {
  const arg = process.argv[2];
  if (arg) {
    try { return JSON.parse(arg); } catch { console.error("无法解析服务器配置 JSON:", arg); process.exit(1); }
  }
  try {
    const cfg = JSON.parse(readFileSync(path.join(root, "config", "ppx.json"), "utf8"));
    const s = cfg?.mcp?.servers?.[0];
    if (!s) { console.error("config/ppx.json 未配置 mcp.servers"); process.exit(1); }
    return s;
  } catch (e) {
    console.error("读取 config/ppx.json 失败:", e.message);
    process.exit(1);
  }
}

async function main() {
  const srv = loadServerConfig();
  const label = srv.url || `${srv.command} ${(srv.args || []).join(" ")}`;
  console.log(`→ 连接 MCP 服务器: ${label}`);
  const client = new McpClient(srv);
  try {
    await client.connect();
    const tools = await client.listTools();
    console.log(`✓ 已连接, 协议版本 ${client.protocolVersion}, 共 ${tools.length} 个工具:\n`);
    for (const t of tools) {
      console.log(`  - ${srv.prefix || ""}${t.name}: ${(t.description || "").split("\n")[0].slice(0, 80)}`);
    }
    // 仅当服务器声明了相应能力时才探测, 避免对不支持的能力干等超时
    if (client.capabilities?.prompts) {
      try {
        const prompts = await client.listPrompts();
        if (prompts.length) console.log(`\n  [prompts] ${prompts.length} 个: ${prompts.map((p) => p.name).join(", ")}`);
      } catch (e) { console.log(`\n  [prompts] 探测失败: ${e.message}`); }
    }
    if (client.capabilities?.resources) {
      try {
        const res = await client.listResources();
        if (res.length) console.log(`  [resources] ${res.length} 个: ${res.map((r) => r.uri).slice(0, 5).join(", ")}`);
      } catch (e) { console.log(`  [resources] 探测失败: ${e.message}`); }
    }
  } catch (e) {
    console.error(`✗ 连接/列工具失败: ${e.message}`);
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

main();
