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
  // ⚠ 桩必须使用真实的 broadcast 返回形状 { agent, id, type:'reply', reply }
  //   历史上桩伪造了 { status:'fulfilled', value:{reply} }, 导致消费方按虚构契约取值,
  //   军团 broadcast 在真实环境恒走兜底串而测试全绿 (test double drift)。
  const L = mockLegion({ broadcastReplies: [
    { agent: "a", id: 1, type: "reply", reply: "军团回复A" },
    { agent: "b", type: "error", error: "err" },
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
  const L = mockLegion({ broadcastReplies: [{ agent: "a", type: "error", error: "x" }] });
  const out = await legionExecutor(mockAgent(), "任务", { legion: L });
  assert.ok(out.includes("未返回有效结果"), `应兜底, 实际: ${out}`);
});

// ===== 契约守卫: 生产 broadcast 形状 vs 消费方取值 (test double drift 防线) =====
test("契约守卫: Legion.broadcast 包装出 {agent,type,reply}, 且消费方能取到", async () => {
  const { Legion } = await import("../src/orchestrator/legion.js");
  // 只替换 _mapBounded (子进程派发的底座), 保留 broadcast 的包装逻辑本身
  const fake = {
    agents: new Map([["a", {}], ["b", {}]]),
    _mapBounded: async (items) => items.map(() => ({ id: 1, type: "reply", reply: "ok" })),
  };
  const results = await Legion.prototype.broadcast.call(fake, "chat", "hi");
  assert.equal(results.length, 2);
  assert.equal(results[0].agent, "a");
  assert.equal(results[0].type, "reply");
  assert.equal(results[0].reply, "ok");
  assert.equal("status" in results[0], false, "不应有 status 字段 (消费方不得依赖虚构契约)");
  assert.equal("value" in results[0], false, "不应有 value 包装");

  // 端到端: 真实形状喂给消费方, 必须产出有效回复而非兜底串
  const out = await legionExecutor(mockAgent(), "问题", { legion: mockLegion({ broadcastReplies: results }) });
  assert.ok(out.includes("ok"), `真实形状应被消费, 实际: ${out}`);
  assert.ok(!out.includes("未返回有效结果"), "不应落到兜底分支");
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
