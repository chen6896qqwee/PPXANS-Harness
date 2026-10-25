// test/mcp-e2e-r14-2026-10-24.test.js - 第十四轮探测/回归: MCP 双向全链路
// 背景: README 宣称"标准 MCP 服务端+客户端"。存量测试只覆盖到零件级
//   (McpClient 连 fixture 子进程 / registerMcpTools 注册进 catalog / /mcp 端点协议),
//   缺最关键的三段全链路:
//   P1 agent 级: MCP 工具注册进工具池 → 模型工具循环真实调用 → 子进程结果回流 LLM;
//   P2 装配级: config mcp.auto_connect=true → 启动即连 (宣称的"接入外部工具"主路径);
//   P3 自宿主: 皮皮虾自己的 MCP 客户端 (HTTP 传输) 连自己的 /mcp 服务端 (鉴权+93 工具)。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { HttpChannel } from "../src/channels/http.js";
import { McpClient } from "../src/mcp/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "..", "fixtures", "mock-mcp-server.cjs");

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-mcp-r14-")); }

function writeConfig(root, extra = {}) {
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({
    channels: { http: { mcp: { enabled: false } } },
    agent: { approval_mode: "never", localIntent: false },
    ...extra,
  }));
}

function mcpServerCfg() {
  return { command: process.execPath, args: [FIXTURE_PATH] };
}

// 从工具池里找 MCP 注册的 namespaced 工具名 (不猜前缀, 以实际注册结果为准)
function findMcpTool(agent, frag) {
  const names = (agent.tools.list ? agent.tools.list() : []).map((t) => t.name || t);
  return names.find((n) => n.includes(frag));
}

test("P1: MCP 工具进池后, 模型工具循环真实调用子进程并回流结果", async () => {
  const root = tmp();
  writeConfig(root);
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  try {
    const n = await agent.connectMcp([mcpServerCfg()]);
    assert.ok(n >= 2, `fixture 应注册 echo+add 两个工具, 实际 ${n}`);
    const nsEcho = findMcpTool(agent, "echo");
    assert.ok(nsEcho, "工具池应有 namespaced echo 工具");
    // 模型可见性: toOpenAI 的 tools 数组里必须有 MCP 工具 (否则模型永远调不到)
    const openai = agent.tools.toOpenAI();
    assert.ok(openai.some((t) => t.function && t.function.name === nsEcho), "MCP 工具应出现在模型可见的 tools 数组里");
    // 工具循环全链路: 桩 LLM 第 1 轮调 MCP echo, 第 2 轮引用子进程返回值
    let calls = 0;
    agent.llm = {
      model: "stub-mcp",
      async apiChat(messages, { tools } = {}) {
        calls += 1;
        if (calls === 1) {
          assert.ok(tools.some((t) => t.function.name === nsEcho), "工具循环应把 MCP 工具带给模型");
          return { message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: nsEcho, arguments: JSON.stringify({ text: "ppx-mcp-alive" }) } }] }, usage: {} };
        }
        // 第 2 轮: 消息历史里应有 MCP 子进程的执行结果
        const toolMsg = messages.find((m) => m.role === "tool");
        assert.ok(toolMsg, "MCP 工具结果应作为 tool 消息回流");
        assert.ok(String(toolMsg.content).includes("ppx-mcp-alive"), `子进程结果应原样回流, 实际: ${String(toolMsg.content).slice(0, 100)}`);
        return { message: { role: "assistant", content: "MCP 回环确认: ppx-mcp-alive" }, usage: {} };
      },
    };
    const reply = await agent.chat("调用 echo 工具回显 ppx-mcp-alive", { sessionKey: "r14-p1" });
    assert.ok(String(reply).includes("ppx-mcp-alive"), `最终回复应包含 MCP 子进程产物, 实际: ${String(reply).slice(0, 100)}`);
  } finally {
    agent.shutdown();
  }
});

test("P2: config mcp.auto_connect=true → 启动即连 (状态可见)", async () => {
  const root = tmp();
  writeConfig(root, { mcp: { auto_connect: true, servers: [mcpServerCfg()] } });
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  try {
    // 构造函数非阻塞连接, 轮询等待就绪
    let count = 0;
    // 10s 预算: Windows 下首次 spawn 子进程 + 装配在重载机器上可能超 4s (--with-tests 偶发实证)
    for (let i = 0; i < 100 && !count; i++) {
      await new Promise((r) => setTimeout(r, 100));
      count = (agent._mcp && agent._mcp.count) || 0;
    }
    assert.ok(count >= 2, `auto_connect 应在启动时注册 MCP 工具, 实际 ${count}`);
    const st = agent.stats();
    assert.equal(st.mcp.connected, true, "agent.stats 应报告 MCP 已连接");
    assert.ok(st.mcp.count >= 2);
    const nsAdd = findMcpTool(agent, "add");
    assert.ok(nsAdd, "auto_connect 注册的 add 工具应在池中");
  } finally {
    agent.shutdown(); // 应回收 MCP 子进程 (R14 确认 _mcp.close 已接)
  }
});

test("P3: 自宿主回环 —— 皮皮虾 MCP 客户端 (HTTP 传输) 连自己的 /mcp 服务端", async () => {  const root = tmp();
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({ agent: { approval_mode: "never" } }));
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  ch.authToken = "tok";
  await ch.connect();
  const port = ch.server.address().port;
  const client = new McpClient({ url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer tok" } });
  try {
    await client.connect();
    const tools = await client.listTools();
    // 113 = 91 内置 + 2 (裸 McpServer 自带) + 20 admin 管理虚拟工具 (v2.6.0 产品壳,
    // ppx.sessions/providers/settings/task.*) —— 外部客户端在 /mcp 上真实可见的面。
    // 2026-10-24 (R14 发现): README 锚点 mcp_tools=93 量的是裸 McpServer.handle,
    // 少了外部客户端真实可见的 20 个 admin 工具 —— 闸门量错面, 已随本轮修正。
    assert.equal(tools.length, 113, `外部 MCP 客户端应看到全部 113 个工具, 实际 ${tools.length}`);
    const names = new Set(tools.map((t) => t.name));
    assert.ok(names.has("get_time"), "内置工具应在 /mcp 暴露");
    assert.ok([...names].some((n) => n.startsWith("ppx.")), "admin 管理工具应在 /mcp 暴露");
    const res = await client.callTool("get_time", {});
    assert.ok(res, "自宿主调用内置工具应返回结果");
    const text = JSON.stringify(res);
    assert.ok(text.length > 2, "返回非空");
    // 未带 token 的客户端应被拒 (401)
    const anon = new McpClient({ url: `http://127.0.0.1:${port}/mcp` });
    await assert.rejects(() => anon.connect(), /401|未授权|unauthorized/i, "未鉴权 MCP 客户端应被拒绝");
  } finally {
    client.close();
    await ch.disconnect(); agent.shutdown();
  }
});

test("P6: ON_REQUEST 档下未信任 MCP 工具需审批 (R14 安全闸门), trusted 服务器豁免", async () => {
  // 默认审批档 (ON_REQUEST): MCP 工具名不可能命中基于名字的审批名单,
  // 此前静默放行 (真模型探测实锤)。现默认 fail closed: 走审批, 可拒绝/放行。
  const root = tmp();
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({ agent: { localIntent: false } }));
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  try {
    await agent.connectMcp([mcpServerCfg()]);
    const nsEcho = findMcpTool(agent, "echo");
    const decisions = [];
    agent._onApprovalEvent = (req) => {
      decisions.push(req.tool);
      agent.resolveApproval(req.id, "deny");
    };
    const denied = await agent._runTool(nsEcho, { text: "x" });
    assert.ok(String(denied).includes("审批被拒绝") || String(denied).includes("拒绝"), `未信任 MCP 工具应被审批拒绝, 实际: ${String(denied).slice(0, 120)}`);
    assert.equal(decisions.length, 1, "应真实发起过一次审批请求");
    // 放行路径: sink 改 approve
    agent._onApprovalEvent = (req) => agent.resolveApproval(req.id, "approve");
    const ok = await agent._runTool(nsEcho, { text: "ppx-approved" });
    assert.ok(String(ok).includes("ppx-approved"), `放行后应执行子进程, 实际: ${String(ok).slice(0, 120)}`);
    // trusted 服务器: 注册即免审批 (不触发审批请求)
    let trustedAsk = 0;
    await agent.connectMcp([{ command: process.execPath, args: [FIXTURE_PATH], trusted: true, prefix: "trusted__" }]);
    agent._onApprovalEvent = (req) => { trustedAsk += 1; agent.resolveApproval(req.id, "approve"); };
    const nsTEcho = findMcpTool(agent, "trusted__echo") || findMcpTool(agent, "trusted__");
    const out = await agent._runTool(nsTEcho, { text: "trusted-ok" });
    assert.ok(String(out).includes("trusted-ok"), `trusted 服务器工具应免审批执行, 实际: ${String(out).slice(0, 120)}`);
    assert.equal(trustedAsk, 0, "trusted 服务器不应发起审批");
  } finally {
    agent.shutdown();
  }
});
