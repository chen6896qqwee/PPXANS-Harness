// scripts/openclaw-smoke.js - OpenClaw 底座连通性 + 工具调用(围栏代理)测试
// 需用满足 OpenClaw 要求的 Node 运行: node >=22.22.3 / >=24.15 / >=25.9 (推荐 26.x)
// 用法: "C:/Program Files/nodejs/node.exe" scripts/openclaw-smoke.js
import { execFileSync } from "node:child_process";
import path from "node:path";
import { LLMClient, nodeVersionOk } from "../src/llm/client.js";
import { buildFencePrompt, parseToolFence } from "../src/llm/fence.js";

const NODE = process.versions.node;
console.log(`→ Node v${NODE} | nodeVersionOk=${nodeVersionOk(NODE)}`);

function globalOpenclawMjs() {
  try {
    const cmd = process.platform === "win32" ? ["/c", "npm root -g"] : ["-c", "npm root -g"];
    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd" : "sh";
    const root = execFileSync(shell, cmd, { encoding: "utf8" }).trim();
    return path.join(root, "openclaw", "openclaw.mjs");
  } catch { return undefined; }
}
const MJS = process.env.PPX_OPENCLAW_MJS || globalOpenclawMjs();

const client = new LLMClient({
  id: "openclaw",
  backend: "openclaw",
  mjs: MJS,
  session_key: "ppx:smoke",
  timeout_ms: 120000,
});

(async () => {
  // 1. 健康检查
  const h = await client.health();
  console.log(`→ health: ${h ? "OK" : "失败(版本不满足或引擎不可用)"}`);
  if (!h) process.exit(1);

  // 2. 基础对话
  console.log(`\n=== 基础对话 ===`);
  const t0 = Date.now();
  const r = await client.chat([{ role: "user", content: "只回复两个字：你好" }]);
  console.log(`✓ (${Date.now() - t0}ms): ${String(r.content).slice(0, 120)}`);

  // 3. 工具调用 (围栏代理)
  console.log(`\n=== 工具调用 (围栏代理) ===`);
  const tools = [
    { function: { name: "get_time", description: "获取当前时间" } },
    { function: { name: "read_file", description: "读取文件内容" } },
  ];
  const toolRunner = async (name, args) => {
    if (name === "get_time") return "现在是 " + new Date().toLocaleString("zh-CN");
    return "[工具] " + name + " 结果";
  };
  const t1 = Date.now();
  const res = await client.apiChat(
    [{ role: "user", content: "现在几点了？用 get_time 工具告诉我。" }],
    { tools, toolRunner }
  );
  console.log(`✓ (${Date.now() - t1}ms): ${String(res.message?.content).slice(0, 200)}`);
  console.log(`→ 工具是否被调用: ${String(res.message?.content).includes("2026") || String(res.message?.content).includes("现在") ? "已走围栏工具循环" : "未触发工具"}`);

  // 4. 围栏解析纯函数自检 (不依赖引擎)
  console.log(`\n=== 围栏解析自检 ===`);
  const { calls } = parseToolFence('⟪tool:read_file│{"path":"a.txt"}⟫');
  console.log(`→ parseToolFence 解析出 ${calls.length} 个调用: ${calls.map(c => c.function.name).join(",") || "(无)"}`);
  console.log(`→ buildFencePrompt 注入行数: ${buildFencePrompt(tools).split("\n").length}`);
})().catch((e) => {
  console.error(`✗ 失败: ${e.message}`);
  process.exit(1);
});
