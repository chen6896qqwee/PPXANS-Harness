// test/audit-2026-10-03.test.js - 体检修复回归守卫 (2026-10-03)
// 每项锁一个 2026-10-03 体检报告中的 P0/P1 缺陷, 防止"修完又退化"。
// 历史教训 (本文件要防的事): 9-18 的 /sessions/delete 修复只对齐了后端解析,
//   测试也用了与后端相同的错误字段名 { key }, 前端真实契约 { sessionKey } 无人覆盖 →
//   测试全绿但"删任意会话恒删 default"在产品路径上原样存活。
import { test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { HttpChannel } from "../src/channels/http.js";
import { runToolLoop } from "../src/core/policy.js";
import { buildProvider } from "../src/llm/presets.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ppx-audit-1003-"));

function makeAgent(root) {
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"),
    JSON.stringify({ channels: { http: { mcp: { enabled: false } } } }));
  return new PPXAgent({ root, dataDir: path.join(root, "data") });
}

// ---- P0-1: aml-server 直跑必须真正监听 (原入口正则 /\\\\/g 恒 false → 静默退出) ----
test("P0-1: node src/aml-server.js 直跑可监听, /health 免鉴权可达", { timeout: 20000 }, async () => {
  const dataDir = tmp();
  const port = 18990 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [path.join(ROOT, "src", "aml-server.js")], {
    env: { ...process.env, PPX_AML_PORT: String(port), PPX_AML_DATA: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (d) => { stdout += d; });
  try {
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        ok = res.status === 200;
      } catch { /* 未起好, 继续等 */ }
    }
    assert.ok(ok, "aml-server 应在 4s 内可探活");
    assert.ok(stdout.includes("listening"), `应打印监听日志, 实际: ${stdout.slice(0, 100)}`);
    // 非法 JSON → 400 (原实现与超限共用 413)
    const bad = await fetch(`http://127.0.0.1:${port}/v1/memories/search`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad",
    });
    assert.equal(bad.status, 400, "非法 JSON 应回 400 而非 413");
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---- P0-2: 前端真实契约 { sessionKey } 必须能删对会话, default 不被误删 ----
test("P0-2: /sessions/delete 接受前端契约 { sessionKey }, 不误删 default", async () => {
  const root = tmp();
  const agent = makeAgent(root);
  agent.sessionStore.append("default", "user/message", { content: "主会话" });
  agent.sessionStore.append("side", "user/message", { content: "旁支" });
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  ch.authToken = "tok";
  await ch.connect();
  const port = ch.server.address().port;
  try {
    // public/app.js delSession 发的就是 sessionKey (与 9-18 测试用的 key 不同)
    const res = await fetch(`http://127.0.0.1:${port}/sessions/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({ sessionKey: "side" }),
    });
    assert.equal(res.status, 200);
    const keys = agent.sessionStore.list().map((s) => s.key);
    assert.ok(!keys.includes("side"), "目标会话应被删除");
    assert.ok(keys.includes("default"), "default 主会话必须保留");
  } finally {
    await ch.disconnect(); agent.shutdown();
  }
});

// ---- P1: 工具消息必须带标准 tool_call_id (严格 OpenAI 兼容后端第二轮 400 根因) ----
test("P1: tool 消息携带 tool_call_id 与 assistant tool_calls.id 配对", async () => {
  const seen = [];
  const llm = {
    async apiChat(messages) {
      seen.push(messages);
      if (seen.length === 1) {
        return { message: { tool_calls: [{ id: "call_x1", type: "function", function: { name: "get_time", arguments: "{}" } }], content: null } };
      }
      return { message: { tool_calls: [], content: "done" } };
    },
  };
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "几点" }],
    llm, tools: [], config: {},
    runTool: async () => "10:30",
    shrinkMessages: (m) => m,
  });
  assert.equal(out, "done");
  const toolMsg = seen[1].find((m) => m.role === "tool");
  assert.ok(toolMsg, "第二轮应包含 tool 消息");
  assert.equal(toolMsg.tool_call_id, "call_x1", "必须携带标准 tool_call_id 字段");
});

// ---- P1: 本地预设生成的 provider 必须可调用 (原缺 api_key → LLMClient 必 throw) ----
test("P1: lmstudio/ollama 预设 build 出的 provider 带可用 api_key", () => {
  for (const id of ["lmstudio", "ollama"]) {
    const p = buildProvider(id, { model: "test-model" });
    assert.ok(p, `${id} 预设应存在`);
    assert.ok(p.api_key, `${id} provider 应注入占位 api_key (原实现缺失 → _request 必抛)`);
  }
});

// ---- P1: 权限引擎异常必须 fail-closed (原 fail-open: 引擎崩了防线全开) ----
test("P1: permissions.check 抛异常时拒绝执行工具 (fail-closed)", async () => {
  const root = tmp();
  const agent = makeAgent(root);
  agent.permissions = { check: async () => { throw new Error("引擎崩溃模拟"); } };
  try {
    const r = await agent._admitToolCall("run_command", { command: "echo hi" }, "c1", Date.now());
    assert.equal(r.ok, false, "引擎异常必须拒绝放行");
    assert.ok(String(r.error).includes("权限引擎异常"), "错误应可判读");
  } finally {
    agent.shutdown();
  }
});

// ---- P1: _fail 必须净化内部错误原文 (不把 ERR_*/堆栈细节回给客户端) ----
test("P1: _fail 走 publicErrorMessage 净化内部错误", async () => {
  const root = tmp();
  const agent = makeAgent(root);
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  try {
    let captured = null;
    ch._json = (res, code, obj) => { captured = { code, obj }; };
    ch._fail({}, new Error("ERR_HTTP_HEADERS_SENT: cannot write headers"), 500);
    assert.equal(captured.code, 500);
    assert.equal(captured.obj.error, "连接状态异常, 请重试", "内部错误原文必须被净化");
    assert.ok(!captured.obj.error.includes("ERR_"), "不得外泄 ERR_* 原文");
  } finally {
    agent.shutdown();
  }
});

// ================= 2026-10-03 第二轮优化守卫 =================

// ---- 记忆 API 命名统一: forget/restore 双向兼容 id 与 id_or_content ----
test("优化: memory_forget/restore 双向兼容 id 与 id_or_content", async () => {
  const root = tmp();
  const agent = makeAgent(root);
  try {
    const add = JSON.parse(await agent.tools.call("memory_add", { content: "命名统一验证 G-1" }));
    const f1 = JSON.parse(await agent.tools.call("memory_forget", { id: add.id }));
    assert.equal(f1.ok, true, "forget 应接受 {id}");
    const r1 = JSON.parse(await agent.tools.call("memory_restore", { id_or_content: add.id }));
    assert.equal(r1.ok, true, "restore 应接受 {id_or_content}");
    const f2 = JSON.parse(await agent.tools.call("memory_forget", { id_or_content: add.id }));
    assert.equal(f2.ok, true, "forget 仍应接受 {id_or_content} (向后兼容)");
    const r2 = JSON.parse(await agent.tools.call("memory_restore", { id: add.id }));
    assert.equal(r2.ok, true, "restore 仍应接受 {id}");
    const bad = JSON.parse(await agent.tools.call("memory_forget", {}));
    assert.ok(bad.error, "空参数应报可判读错误");
  } finally {
    agent.shutdown();
  }
});

// ---- bootstrapPayload 必须返回 model/toolsCount/root (设置面板三项死绑定根因) ----
test("优化: /api/bootstrap 返回 model/toolsCount/root 供设置面板展示", async () => {
  const root = tmp();
  const agent = makeAgent(root);
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  try {
    const payload = ch.bootstrapPayload({});
    assert.ok("model" in payload && "toolsCount" in payload && "root" in payload, "三个新字段必须存在");
    assert.equal(typeof payload.toolsCount, "number", "toolsCount 应为工具数量");
    assert.ok(payload.root, "root 应为工作区路径");
  } finally {
    await ch.disconnect(); agent.shutdown();
  }
});

// ---- SSE /events: 鉴权 + 主动提醒广播 + EQ 结构化事件桥接 ----
test("优化: /events SSE 鉴权/reminder 广播/EQ 桥接", { timeout: 15000 }, async () => {
  const root = tmp();
  const agent = makeAgent(root);
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  ch.authToken = "tok";
  await ch.connect();
  const port = ch.server.address().port;
  const readSse = (path, expect) => new Promise((resolve, reject) => {
    const req = fetch(`http://127.0.0.1:${port}${path}`).then(async (res) => {
      if (!res.ok) return resolve({ status: res.status });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (expect.some((k) => buf.includes(k))) { req; return resolve({ status: res.status, buf }); }
      }
      resolve({ status: res.status, buf });
    }).catch(reject);
  });
  try {
    // ① 鉴权
    const noTok = await fetch(`http://127.0.0.1:${port}/events`);
    assert.equal(noTok.status, 401, "无 token 必须 401 (拒绝不得返 200)");
    const badTok = await fetch(`http://127.0.0.1:${port}/events?token=wrong`);
    assert.equal(badTok.status, 401, "错 token 必须 401");
    // ② reminder 广播 (send 不再是 no-op)
    const p1 = readSse("/events?token=tok", ["reminder"]);
    await new Promise((r) => setTimeout(r, 200));
    await ch.send("web", "【主动提醒】守卫测试 R-9");
    const got1 = await p1;
    assert.ok(got1.buf.includes("R-9"), "send() 必须经 SSE 广播到 /events 客户端");
    // ③ EQ 结构化事件桥 (协议总线不再零消费者)
    const p2 = readSse("/events?token=tok", ["TASK_TURN_BEGAN"]);
    await new Promise((r) => setTimeout(r, 200));
    agent.protocolBus.eq.push({ type: "TASK_TURN_BEGAN", payload: { sessionKey: "t" } });
    const got2 = await p2;
    assert.ok(got2.buf.includes("TASK_TURN_BEGAN"), "EQ 事件必须桥接到 SSE");
  } finally {
    await ch.disconnect(); agent.shutdown();
  }
});

// ---- 语境 Playbook 接线: 持有 + system prompt 注入 + 落盘 ----
test("优化: playbook 引擎接入 agent (注入 system prompt, 空库零 token)", async () => {
  const root = tmp();
  const agent = makeAgent(root);
  try {
    assert.ok(agent.playbook, "agent 应持有 playbook store");
    assert.ok(!agent._context("hi").includes("经验策略 (Playbook"), "空库不应注入 (零 token 成本)");
    await agent.playbook.apply([{ op: "ADD", kind: "strategy", content: "守卫策略 G-7" }]);
    assert.ok(agent._context("hi").includes("G-7"), "bullets 必须注入 system prompt");
    assert.ok(fs.existsSync(path.join(root, "data", "evolve", "playbook.json")), "playbook 必须落盘");
  } finally {
    agent.shutdown();
  }
});

// ---- 协议总线 WAL 默认开启 + replay 可用 ----
test("优化: 协议总线 EQ WAL 默认落盘且可 replay", async () => {
  const root = tmp();
  const agent = makeAgent(root);
  try {
    const wal = path.join(root, "data", "protocol", "eq.wal.jsonl");
    assert.ok(!fs.existsSync(wal), "push 前不应预创建 WAL 文件 (惰性)");
    agent.protocolBus.eq.push({ type: "TASK_TURN_ENDED", payload: { sessionKey: "w" } });
    assert.ok(fs.existsSync(wal), "push 后 WAL 必须落盘 (原硬编码 null)");
    const evs = agent.protocolBus.eq.replay();
    assert.ok(evs.length >= 1 && evs.some((e) => e.type === "TASK_TURN_ENDED"), "replay 必须能读回事件");
  } finally {
    agent.shutdown();
  }
});

// ---- Supervisor 编排接线: spawn_agent supervisor 模式走监督者循环 ----
test("优化: spawn_agent supervisor=true 走监督者编排循环 (mock legion/llm)", async () => {
  const root = tmp();
  const agent = makeAgent(root);
  try {
    // 监督者 LLM: 第一轮打回, 第二轮接受, 最后定稿
    let judgeCalls = 0;
    agent.llm = {
      chat: async (msgs) => {
        const sys = String(msgs?.[0]?.content || "");
        if (sys.includes("评估各专家子 agent")) {
          judgeCalls++;
          return { content: judgeCalls === 1
            ? '{"accept": false, "feedback": ["结论不够具体"]}'
            : '{"accept": true, "feedback": []}' };
        }
        return { content: "定稿结论: 采用方案 B" };
      },
    };
    const spawned = [];
    const sends = [];
    agent._legion = {
      spawnAgent: (name, opts) => spawned.push({ name, opts }),
      send: async (name, msg) => { sends.push({ name, msg }); return { reply: `专家 ${name} 的结论` }; },
    };
    const res = await agent.tools.call("spawn_agent", {
      task: "评估两个方案的取舍",
      supervisor: true,
      judge: "必须可执行",
    }, { agent });
    assert.equal(spawned.length, 2, "默认应编排 2 个专家子 agent");
    assert.ok(spawned.every((s) => !s.opts?.env?.PPX_AGENT_READONLY), "非只读专家不设 readonly");
    assert.ok(sends.length >= 2, "每轮向每个专家派发");
    assert.ok(res.includes("✅ 监督者编排"), `应输出编排结果头, 实际: ${res.slice(0, 60)}`);
    assert.ok(res.includes("定稿结论"), "应含监督者定稿");
    assert.ok(judgeCalls >= 1, "监督者评审应被调用");
    // lifecycle: 繁衍计数推进 (reproducing 真阶段)
    assert.ok(agent.lifecycle.reproduced >= 2, "编排后繁衍计数应增加");
  } finally {
    agent.shutdown();
  }
});

// ---- MCP 工厂不再吞参: createMcpEndpoint 透传 skipOriginCheck ----
test("优化: mcp 工厂透传 skipOriginCheck, 宿主与 handler 共享白名单", async () => {
  const { createMcpEndpoint, createMcpHttpHandler } = await import("../src/mcp/http.js");
  const root = tmp();
  const agent = makeAgent(root);
  try {
    // 直接验证 handler 的 origin 判定语义: 未传 allowedOrigins 时非回环 Origin 拒绝 (安全默认)
    const fakeAgent = { callTool: async () => ({ content: [] }), listTools: async () => [] };
    const handler = createMcpHttpHandler({ callTool: async () => ({}), listTools: async () => [] }, {});
    let status = null;
    const fakeRes = { setHeader() {}, writeHead(c) { status = c; }, end() {} };
    await handler({ method: "POST", headers: { origin: "http://evil.example" } }, fakeRes);
    assert.equal(status, 403, "非回环 Origin 必须被 handler 拒绝 (rebinding 防线)");
    // 工厂转发: 构造端点后内部 handler 应承认 skipOriginCheck (不再二次拦截)
    const { handler: h2 } = createMcpEndpoint(fakeAgent, { skipOriginCheck: true });
    status = null;
    await h2({ method: "POST", headers: { origin: "http://evil.example" } }, fakeRes);
    assert.notEqual(status, 403, "显式 skipOriginCheck 时 handler 不应 403 (契约透传)");
  } finally {
    agent.shutdown();
  }
});
