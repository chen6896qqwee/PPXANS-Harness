// scripts/probe-r14-mcp-real.js - 第十四轮真模型探测: 模型真实选择并调用 MCP 外部工具
// 用法: node scripts/probe-r14-mcp-real.js   (需真实 GLM/deepseek 配置)
// 链路: 真模型 → tool_call(namespaced MCP 工具) → stdio 子进程 (fixtures/mock-mcp-server.cjs)
//       → 结果回流 → 模型消化后回答。审批 (ON_REQUEST) 走 R13 审批 sink 自动放行。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "fixtures", "mock-mcp-server.cjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-r14-real-"));

const agent = new PPXAgent({
  root: ROOT,
  dataDir: path.join(tmp, "main"),
  globalDataDir: path.join(tmp, "global"),
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? `  (${detail})` : ""}`);
}

const t0 = Date.now();

// 1) 连接 fixture MCP 服务器 (stdio 子进程)
const count = await agent.connectMcp([{ command: process.execPath, args: [FIXTURE] }]);
check("P4-1: fixture MCP 连接并注册", count >= 2, `注册 ${count} 个工具`);
const mcpNames = (agent.tools.list() || []).map((t) => t.name || t).filter((n) => n.includes("__"));
const nsAdd = mcpNames.find((n) => n.includes("add"));
const nsEcho = mcpNames.find((n) => n.includes("echo"));
check("P4-2: namespaced 工具在池中", Boolean(nsAdd && nsEcho), mcpNames.slice(0, 4).join(", "));

// 2) R13 审批闭环: ON_REQUEST 模式下 MCP 工具会请求审批, 挂 sink 自动放行 (记录事实)
const approved = [];
agent._onApprovalEvent = (req) => {
  approved.push(req.tool);
  agent.resolveApproval(req.id, "approve");
};

// 3) 真模型选择 MCP 工具 (add) 并消化结果
const reply = await agent.chat("请用名字带 add 的工具计算 21 加 21, 只告诉我结果数字。", { sessionKey: "r14-real" });
check("P4-3: 真模型回复含 42", /42/.test(String(reply)), `${String(reply).slice(0, 60)}`);
check("P4-4: 审批闭环真实走过 (自动放行)", approved.length > 0, `放行: ${approved.join(",")}`);

// 4) echo 工具
const reply2 = await agent.chat("请用名字带 echo 的工具回显字符串 mcp-roundtrip, 然后原样告诉我它返回了什么。", { sessionKey: "r14-real" });
check("P4-5: echo 回环真实发生", /mcp-roundtrip/.test(String(reply2)), `${String(reply2).slice(0, 60)}`);

const dt = Math.round((Date.now() - t0) / 100) / 10;
const failed = results.filter((r) => !r.ok);
console.log(`\n===== R14 真模型探测: ${results.length - failed.length}/${results.length} 通过, 耗时 ${dt}s =====`);
try { agent.shutdown(); } catch {}
process.exit(failed.length ? 1 : 0);
