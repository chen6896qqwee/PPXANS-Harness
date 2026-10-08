// test/lifecycle-2026-10-04.test.js — 2026-10-04 Task#4 (并发与生命周期) 回归守卫
//   L1 军团子进程按需回收 (killAgent + spawn_agent finally)
//   L2 agent.shutdown() 可等待 (回收完成才 exit)
//   L3 工具失败统一 [工具错误] 前缀 (policy 熔断/错误重试都靠它判读)
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Legion } from "../src/orchestrator/legion.js";
import { PPXAgent } from "../src/agent/index.js";
import { registerDelegateTools } from "../src/tools/delegate.js";
import { TOOL_ERROR_PREFIX } from "../src/tools/index.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-lc-${tag}-`)); }

// 桩 worker: 收到 {id,...} 回一个 reply; 收到 shutdown 立即退出 (与真 agent-worker 协议一致)
const STUB_WORKER = `
import fs from "node:fs";
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.type === "shutdown") { fs.writeSync(1, JSON.stringify({ id: req.id, type: "bye" }) + "\\n"); process.exit(0); }
    fs.writeSync(1, JSON.stringify({ id: req.id, type: "reply", reply: "ok-" + req.type }) + "\\n");
  }
});
`;

function stubWorkerFile() {
  const p = path.join(tmp("worker"), "stub-worker.mjs");
  fs.writeFileSync(p, STUB_WORKER, "utf8");
  return p;
}

const procAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test("L1 Legion.killAgent: 摘除登记并真的终止子进程", async () => {
  const L = new Legion({ workerPath: stubWorkerFile() });
  const dataDir = tmp("l1");
  L.spawnAgent("w1", { dataDir });
  const pid = L.list()[0].pid;
  assert.equal(procAlive(pid), true, "spawn 后进程应在");
  const r = await L.send("w1", { type: "chat", message: "hi" });
  assert.equal(r.reply, "ok-chat");
  assert.equal(await L.killAgent("w1"), true);
  assert.deepEqual(L.list(), [], "回收后不再登记");
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(procAlive(pid), false, "子进程应真的退出");
  assert.equal(await L.killAgent("w1"), false, "重复回收幂等");
  await L.shutdownAll();
});

test("L1 spawn_agent: 每个委派子进程都在本轮 finally 里回收", async () => {
  const agent = new PPXAgent({ root: tmp("l2"), dataDir: tmp("l2d") });
  agent.llm = { chat: async () => "仲裁结果" }; // 无模型时 spawn_agent 直接拒绝, 不会走到委派
  const killed = [];
  const spawned = [];
  agent._legion = {
    spawnAgent: (n) => { spawned.push(n); },
    send: async () => ({ reply: "done" }),
    killAgent: async (n) => { killed.push(n); return true; },
    list: () => spawned.map((n) => ({ name: n })),
  };
  const catalog = { registered: null, register(def) { this.registered = def; } };
  registerDelegateTools(catalog);
  const out = await catalog.registered.execute({ tasks: ["任务A", "任务B"] }, { agent });
  assert.ok(spawned.length >= 2, "并行委派应各起一个子 agent");
  assert.deepEqual(killed.sort(), [...spawned].sort(), `全部回收: ${JSON.stringify({ spawned, killed })}`);
  assert.ok(String(out).includes("done"), "结果照常返回");
  await agent.shutdown();
});

test("L1 spawn_agent: 失败路径同样回收 (不靠成功分支)", async () => {
  const agent = new PPXAgent({ root: tmp("l3"), dataDir: tmp("l3d") });
  agent.llm = { chat: async () => "仲裁结果" };
  const killed = [];
  agent._legion = {
    spawnAgent: () => {},
    send: async () => { throw new Error("worker 卡死"); },
    killAgent: async (n) => { killed.push(n); return true; },
    list: () => [],
  };
  const catalog = { registered: null, register(def) { this.registered = def; } };
  registerDelegateTools(catalog);
  const out = await catalog.registered.execute({ task: "会失败的任务" }, { agent });
  assert.ok(String(out).includes("子任务1失败"), "失败照常回灌给模型");
  assert.equal(killed.length, 1, `异常分支也要回收, 实际 ${JSON.stringify(killed)}`);
  await agent.shutdown();
});

test("L2 agent.shutdown() 返回 Promise 并等完军团回收", async () => {
  const agent = new PPXAgent({ root: tmp("l4"), dataDir: tmp("l4d") });
  let closed = 0;
  agent._legion = {
    shutdownAll: async () => { await new Promise((r) => setTimeout(r, 30)); closed = 1; },
    list: () => [{ name: "x" }],
  };
  const p = agent.shutdown();
  assert.ok(p && typeof p.then === "function", "shutdown 必须可 await");
  await p;
  assert.equal(closed, 1, "exit 前子进程回收必须已完成");
});

test("L2 真实军团: shutdown 后无残留 worker 进程", async () => {
  const L = new Legion({ workerPath: stubWorkerFile() });
  const agent = new PPXAgent({ root: tmp("l5"), dataDir: tmp("l5d") });
  agent._legion = L;
  L.spawnAgent("real", { dataDir: tmp("l5w") });
  const pid = L.list()[0].pid;
  await agent.shutdown();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(procAlive(pid), false, "shutdown 之后进程不应还活着");
});

test("L3 工具失败统一 TOOL_ERROR_PREFIX (policy 判读依赖它)", async () => {
  assert.equal(TOOL_ERROR_PREFIX, "[工具错误]");
  const agent = new PPXAgent({ root: tmp("l6"), dataDir: tmp("l6d") });
  // 未知工具 / 参数校验失败 / 执行抛异常 三条路径都必须是同一前缀
  const unknown = await agent._runTool("no_such_tool", {});
  assert.ok(String(unknown).startsWith(TOOL_ERROR_PREFIX), `未知工具: ${String(unknown).slice(0, 60)}`);
  const badArgs = await agent._runTool("read_file", {});
  assert.ok(String(badArgs).startsWith(TOOL_ERROR_PREFIX), `缺参数: ${String(badArgs).slice(0, 60)}`);
  agent.tools.register({
    name: "lc_boom",
    description: "测试用: 总是抛异常",
    parameters: { type: "object", properties: {} },
    execute: async () => { throw new Error("炸了"); },
  });
  const boom = await agent._runTool("lc_boom", {});
  assert.ok(String(boom).startsWith(TOOL_ERROR_PREFIX), `执行异常: ${String(boom).slice(0, 80)}`);
  await agent.shutdown();
});

test("L3 sandbox 内联执行被拒也走统一前缀", async () => {
  const agent = new PPXAgent({ root: ROOT, dataDir: tmp("l7d") });
  const out = await agent._runTool("run_command", { command: "node -e \"process.exit(0)\"" });
  assert.ok(String(out).startsWith(TOOL_ERROR_PREFIX), `内联执行应被拒: ${String(out).slice(0, 80)}`);
  await agent.shutdown();
});
