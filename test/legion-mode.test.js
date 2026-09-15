// test/legion-mode.test.js - 多 Agent 军团模式 (Legion 接入 mode)
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { legionExecutor } from "../src/mode/legion.js";

function mockLegion({ broadcastReplies = [], dagResults = {} } = {}) {
  return {
    broadcast: async () => broadcastReplies,
    runDag: async (graph) => ({ results: dagResults, order: graph.nodes.map((n) => n.id) }),
  };
}

function mockAgent() {
  return { config: { agent: {} }, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ppx-legion-")) };
}

test("legion 模式: broadcast 取第一个有效回复", async () => {
  const L = mockLegion({ broadcastReplies: [
    { status: "fulfilled", value: { reply: "军团回复A" } },
    { status: "rejected", reason: "err" },
  ] });
  const out = await legionExecutor(mockAgent(), "帮我查", { legion: L });
  assert.ok(out.includes("军团回复A"), `应返回有效回复, 实际: ${out}`);
});

test("legion 模式: workflow 走 DAG 编排并汇总", async () => {
  const L = mockLegion({ dagResults: { a: "结果A", b: "结果B" } });
  const out = await legionExecutor(mockAgent(), "任务", {
    legion: L,
    workflow: [{ id: "a", task: "第一步" }, { id: "b", task: "第二步", dependsOn: ["a"] }],
  });
  assert.ok(out.includes("结果A") && out.includes("结果B"), `应汇总两节点, 实际: ${out}`);
  assert.ok(out.includes("【a】") && out.includes("【b】"), `应带节点标记, 实际: ${out}`);
});

test("legion 模式: 全部失败返回兜底提示", async () => {
  const L = mockLegion({ broadcastReplies: [{ status: "rejected", reason: "x" }] });
  const out = await legionExecutor(mockAgent(), "任务", { legion: L });
  assert.ok(out.includes("未返回有效结果"), `应兜底, 实际: ${out}`);
});

test("legion 模式: 已注册到 mode 系统", async () => {
  const { PPXAgent } = await import("../src/agent/index.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-legion-agent-"));
  const agent = new PPXAgent({ root });
  try {
    assert.ok(agent.ctx.consume("modes").has("legion"), "legion 模式应已注册");
  } finally {
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
