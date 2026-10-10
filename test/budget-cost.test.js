// test/budget-cost.test.js - 成本折算 + 支出预算闸门回归守卫 (2026-10-03l)
// 对齐增强框架第 8 条 "预算控制": usageStats 只有 token 数不算成本控制,
// 必须落到金额 + 支出上限。本文件锁四件事:
//   1. pricing 价格表前缀匹配 (最长命中, glm-4-flash 不落进 glm-4 档)
//   2. config.budget.model_prices 覆盖优先级 (精确 > 前缀 > 内置)
//   3. agent 级 cost 累计 + budget.usd 达限后 chat/chatStream 拒绝继续烧钱
//   4. 未配预算时行为零变化 (cost 照记, 永不拦截)
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { estimateCost, resolvePrice } from "../src/llm/pricing.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ppx-budget-"));

function writeConfig(root, cfg) {
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify(cfg));
}

function makeAgent(root) {
  return new PPXAgent({ root, dataDir: path.join(root, "data") });
}

// 假 provider: chaos.test.js 同款形状, 带 usage 上报
function fakeLLM(model, usage, callsRef) {
  return {
    name: model,
    model,
    backend: "http",
    vision: false,
    supportsNativeToolCalls: true,
    calls: 0,
    apiChat: async () => {
      callsRef.calls++;
      return { message: { role: "assistant", content: "ok" }, usage };
    },
    health: async () => true,
  };
}

// ---- 1. pricing 单元 ----
test("pricing: 前缀最长命中, glm-4-flash 不误入 glm-4 收费档", () => {
  assert.deepEqual(resolvePrice("glm-4-flash"), { prompt: 0, completion: 0 });
  assert.deepEqual(resolvePrice("GLM-4-Flash-9B"), { prompt: 0, completion: 0 }); // 大小写不敏感
  assert.equal(resolvePrice("glm-4-plus").prompt, 0.5);
  assert.equal(resolvePrice("deepseek-chat").completion, 1.1);
});

test("pricing: 未知模型返回 null, estimateCost 保持未知", () => {
  assert.equal(resolvePrice("totally-unknown-model-xyz"), null);
  assert.equal(estimateCost("totally-unknown-model-xyz", { prompt_tokens: 999999, completion_tokens: 999999 }), null);
});

test("pricing: override 精确命中 > 前缀命中 > 内置表", () => {
  const ov = {
    "deepseek-chat": { prompt: 1, completion: 2 },        // 精确
    "deepseek": { prompt: 3, completion: 4 },             // 前缀 (被精确压住)
  };
  assert.deepEqual(resolvePrice("deepseek-chat", ov), { prompt: 1, completion: 2 });
  assert.deepEqual(resolvePrice("deepseek-reasoner", ov), { prompt: 3, completion: 4 }); // 前缀覆盖内置
  assert.equal(resolvePrice("gpt-4o", ov).prompt, 2.5); // 无覆盖回落内置
  // 非法价格条目被忽略 → 回落内置表 (免费档), 不炸、不编数
  assert.deepEqual(resolvePrice("glm-4-flash", { "glm-4-flash": { prompt: "x" } }), { prompt: 0, completion: 0 });
});

test("pricing: 金额折算正确; 仅 total_tokens 时按 completion 价 (预算保守侧)", () => {
  // gpt-4o-mini: 0.15/1M prompt, 0.6/1M completion
  const cost = estimateCost("gpt-4o-mini", { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
  assert.equal(cost, 0.75);
  const totalOnly = estimateCost("gpt-4o-mini", { total_tokens: 1_000_000 });
  assert.equal(totalOnly, 0.6);
});

// ---- 2. agent 级: cost 累计 + 预算闸门 ----
function budgetSetup(root, budgetCfg) {
  const callsRef = { calls: 0 };
  writeConfig(root, {
    providers: [],
    agent: { localIntent: false, proactive: { enabled: false } },
    channels: { http: { mcp: { enabled: false } } },
    ...(budgetCfg ? { budget: budgetCfg } : {}),
  });
  const agent = makeAgent(root);
  // 用假 provider 顶换 (gpt-4o-mini: 1000 prompt + 500 completion = $0.00045/次)
  // 注意: chat() 入口判 this.llm, react 模式取 allProviders —— 两者都要指到同一 client
  const client = fakeLLM("gpt-4o-mini", { prompt_tokens: 1000, completion_tokens: 500 }, callsRef);
  agent.llm = client;
  agent.allProviders = [client];
  agent._installUsageTracking(); // 换 provider 后重包装 (构造期包装的是旧实例)
  return { agent, client, callsRef };
}

test("budget: 达到 budget.usd 后 chat 拒绝继续调用模型", async () => {
  const root = tmp();
  // 每次调用 $0.00045, 上限 $0.0005 → 第 2 次调用后超限
  const { agent, client, callsRef } = budgetSetup(root, { usd: 0.0005 });
  try {
    const r1 = await agent.chat("hello budget");
    assert.equal(r1, "ok", "未超限前正常应答");
    assert.equal(callsRef.calls, 1);
    assert.ok(agent.usageStats.cost > 0, "cost 应有金额");
    assert.ok(!agent._budgetExceeded, "未达限不置位");

    const r2 = await agent.chat("hello again");
    assert.equal(callsRef.calls, 2); // 第二次仍放行 (放行后才判定超限)
    assert.ok(agent._budgetExceeded, "达限应置位");

    const r3 = await agent.chat("third time");
    assert.equal(callsRef.calls, 2, "超限后不得再发请求");
    assert.ok(r3.includes("预算耗尽"), `应返回预算提示, 实际: ${String(r3).slice(0, 60)}`);
    assert.ok(r3.includes("budget.usd"), "提示应包含调整入口");
  } finally {
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("budget: 未配置预算时零拦截, cost 照常累计", async () => {
  const root = tmp();
  const { agent, callsRef } = budgetSetup(root, null);
  try {
    await agent.chat("hello a");
    await agent.chat("hello b");
    await agent.chat("hello c");
    assert.equal(callsRef.calls, 3, "无预算上限不应拦截");
    assert.ok(!agent._budgetExceeded);
    assert.ok(Math.abs(agent.usageStats.cost - 3 * 0.00045) < 1e-9, `cost 应为 3 笔合计, 实际 ${agent.usageStats.cost}`);
  } finally {
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("budget: budget.usd=0 或缺省视为不限; usage-stats.json 落盘含 cost/budget_usd", async () => {
  const root = tmp();
  const { agent } = budgetSetup(root, { usd: 0 });
  try {
    await agent.chat("hello zero");
    assert.ok(!agent._budgetExceeded, "usd=0 是不限, 不是立即超限");
    agent.shutdown();
    const stats = JSON.parse(fs.readFileSync(path.join(agent.dataDir, "usage-stats.json"), "utf8"));
    assert.ok(stats.calls >= 1 && typeof stats.cost === "number");
    // usd=0 不写入 budget_usd (未生效的预算不假装生效)
    assert.equal(stats.budget_usd, undefined);
  } finally {
    try { agent.shutdown(); } catch { /* 幂等 */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("budget: chatStream 超限同样拦截并以提示收尾", async () => {
  const root = tmp();
  const { agent, callsRef } = budgetSetup(root, { usd: 0.0001 });
  try {
    await agent.chat("warm up"); // 一次 $0.00045 > $0.0001 → 立即超限
    assert.ok(agent._budgetExceeded);
    const deltas = [];
    const out = await agent.chatStream("stream me", { onDelta: (d) => deltas.push(d) });
    assert.equal(callsRef.calls, 1, "流式路径也不得再发请求");
    assert.ok(out.includes("预算耗尽"));
    assert.ok(deltas.join("").includes("预算耗尽"), "onDelta 也应收到提示");
  } finally {
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- 3. 周期落盘: 长跑进程被 kill 时不丢账 (2026-10-03m) ----
test("usage-stats: 周期落盘 — 未 shutdown 也有账可查", async () => {
  const root = tmp();
  const { agent } = budgetSetup(root, null);
  try {
    for (let i = 0; i < 10; i++) await agent.chat(`hello flush ${i}`);
    const file = path.join(agent.dataDir, "usage-stats.json");
    assert.ok(fs.existsSync(file), "满 10 次调用后应自动落盘 (无需 shutdown)");
    const stats = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(stats.calls >= 10, `落盘 calls 应 >= 10, 实际 ${stats.calls}`);
    assert.ok(typeof stats.cost === "number" && stats.cost > 0, "落盘应含 cost 金额");
    agent._flushUsageStats(); // 手动 flush 幂等
  } finally {
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
