// test/cost-gate-wiring.test.js — 成本护栏「接线完整性」回归守卫 (2026-10-10)
//
// 背景: 2026-10-10 评价发现两处「功能写了但没接线」的静默失效:
//   ① estimateCost 被调用却未 import → ReferenceError 被空 catch 吞掉, 金额/分账/闸门/落盘四条链路全死;
//   ② _budgetBlocked() 定义了却无任何调用方 → 预算闸门即使置位也拦不住下一次 chat。
// 共性病根: 新功能加进 src/ 却没有可执行路径验证它「真的跑到了」。
// 本文件用「真实记账包装 + 假 client」端到端钉死接线, 任何一环断了都会红。
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ppx-gate-"));

// 假 client: 带 model + usage, 记录被调用次数 (零网络)
function fakeClient(model, usage, calls) {
  return { model, apiChat: async () => { calls.n++; return { message: { role: "assistant", content: "ok" }, usage }; } };
}

test("接线①: 记账包装真能把 cost/byModel/闸门/落盘四条链路跑起来", async () => {
  const root = tmp();
  try {
    const a = new PPXAgent({ root });
    a.config.budget = { usd: 0.000001, model_prices: { "glm-4.7": { prompt: 0.5, completion: 1.5 } } };
    const calls = { n: 0 };
    a.llm = fakeClient("glm-4.7", { prompt_tokens: 1000, completion_tokens: 500 }, calls);
    a._installUsageTracking();
    await a.llm.apiChat([{ role: "user", content: "hi" }]);

    assert.ok(a.usageStats.cost > 0, `金额折算必须生效 (曾因缺 import 恒为 0), 实际 ${a.usageStats.cost}`);
    assert.deepEqual(Object.keys(a.usageStats.byModel), ["glm-4.7"], "按模型分账必须落地");
    assert.equal(a._budgetExceeded, true, "超限后闸门必须置位");

    // 周期落盘: 再跑满 10 次 (阈值) 应见 usage-stats.json
    for (let i = 0; i < 10; i++) await a.llm.apiChat([{ role: "user", content: "x" }]);
    assert.ok(fs.existsSync(path.join(a.dataDir, "usage-stats.json")), "周期落盘必须触发");
    a.shutdown();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("接线②: 闸门置位后 chat 入口必须拦住下一次调用 (曾定义却无调用方)", async () => {
  const root = tmp();
  try {
    const a = new PPXAgent({ root });
    a.config.budget = { usd: 0.000001 };
    const calls = { n: 0 };
    a.llm = fakeClient("gpt-4o-mini", { prompt_tokens: 1000, completion_tokens: 500 }, calls);
    a.allProviders = [a.llm];
    a._installUsageTracking();

    const r1 = await a.chat("第一问");
    assert.equal(r1, "ok");
    assert.equal(a._budgetExceeded, true, "第一次调用后应超限");
    const before = calls.n;

    const r2 = await a.chat("第二次不应再发请求");
    assert.equal(calls.n, before, "闸门置位后不得再调用模型 (接线断过就会多一次)");
    assert.ok(String(r2).includes("预算耗尽"), `应返回预算提示, 实际: ${String(r2).slice(0, 50)}`);
    a.shutdown();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("接线②(流式): chatStream 闸门置位时不得发上游请求, 且 onDelta 收到提示", async () => {
  const root = tmp();
  try {
    const a = new PPXAgent({ root });
    a.config.budget = { usd: 0.000001 };
    const calls = { n: 0 };
    a.llm = fakeClient("gpt-4o-mini", { prompt_tokens: 1000, completion_tokens: 500 }, calls);
    a.allProviders = [a.llm];
    a._installUsageTracking();

    await a.chat("预热"); // 触发超限
    assert.equal(a._budgetExceeded, true);
    const before = calls.n;
    const deltas = [];
    const out = await a.chatStream("流式也不该发", { onDelta: (d) => deltas.push(d) });
    assert.equal(calls.n, before, "流式路径同样不得再发请求");
    assert.ok(String(out).includes("预算耗尽"));
    assert.ok(deltas.join("").includes("预算耗尽"), "onDelta 也应收到提示");
    a.shutdown();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
