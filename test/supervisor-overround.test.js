// test/supervisor-overround.test.js - 监督者编排超轮不丢结论回归 (2026-10-25 修复)
//
// 背景 (评估报告 P2): runSupervisorLoop 超轮 (maxRounds 用尽仍未接受) 时, 旧实现
//   返回一句占位语 —— 各专家最后一轮的原始结论被整轮丢弃 (旧 body 变量算了不用),
//   与文案"输出各方原始结论"的承诺相悖。修复后超轮应把各方最后一轮结论带回。
// 另钉住: spawn_agent schema 现已声明 supervisor / supervisor_rounds 参数 (此前隐藏)。
// 全程假 LLM + 假军团 —— 不起真子进程, 不依赖模型。
import { test } from "node:test";
import assert from "node:assert";
import { runSupervisorLoop, registerDelegateTools } from "../src/tools/delegate.js";
import { ToolCatalog } from "../src/tools/catalog.js";

function mkFakeEnv() {
  const spawned = [];
  const sent = [];
  const L = {
    spawnAgent(name, opts) { spawned.push(name); },
    send: async (name, msg) => { sent.push({ name, msg }); return { reply: `结论来自${name}: 该方案可行, 依据XYZ` }; },
    killAgent() {},
  };
  const agent = {
    dataDir: "/tmp/ppx-test-data",
    globalDataDir: "/tmp/ppx-test-data",
    lifecycle: null,
    llm: {
      // 监督者评审永远不接受 → 走满轮数 → 超轮路径。
      // 返回形态对齐 LLMClient.chat(): { content } (裸字符串会被 supervise 判定失败→默认接受)
      chat: async () => ({ content: `{"accept": false, "feedback": ["结论不够具体"]}` }),
    },
  };
  return { L, agent, spawned, sent };
}

test("runSupervisorLoop: 超轮时输出各方最后一轮原始结论 (不再丢弃)", { timeout: 15000 }, async () => {
  const { L, agent, sent } = mkFakeEnv();
  const out = await runSupervisorLoop({
    agent, L, task: "评估方案A", judge: null,
    expertKeys: [], role: "专家", maxRounds: 2,
  });
  assert.ok(out.includes("监督者未在 2 轮内接受"), "应明示超轮事实");
  // 两个默认专家 (分析/风险) 的回复都应出现在输出里
  const rounds = sent.length; // 2 轮 × 2 专家 = 4 次发送
  assert.equal(rounds, 4, "2 轮 × 2 专家");
  assert.ok(out.includes("分析专家"), "应含分析专家结论");
  assert.ok(out.includes("风险专家"), "应含风险专家结论");
  assert.ok(out.includes("该方案可行"), "结论正文应带回 (旧实现只回占位语)");
});

test("runSupervisorLoop: 轮数守恒 — 每轮给每位专家各发一次", { timeout: 15000 }, async () => {
  const { L, agent, sent } = mkFakeEnv();
  await runSupervisorLoop({ agent, L, task: "t", maxRounds: 3 });
  assert.equal(sent.length, 6, "3 轮 × 2 专家 = 6 次");
});

test("spawn_agent schema: supervisor / supervisor_rounds 已声明 (不再隐藏)", () => {
  const catalog = new ToolCatalog();
  registerDelegateTools(catalog, {});
  assert.ok(catalog.list().includes("spawn_agent"), "spawn_agent 应注册");
  const spec = catalog.toOpenAI().find((t) => t.function?.name === "spawn_agent");
  assert.ok(spec, "OpenAI 形态应有 spawn_agent");
  const props = spec.function?.parameters?.properties || {};
  assert.ok(props.supervisor, "schema 应声明 supervisor");
  assert.equal(props.supervisor.type, "boolean");
  assert.ok(props.supervisor_rounds, "schema 应声明 supervisor_rounds");
});
