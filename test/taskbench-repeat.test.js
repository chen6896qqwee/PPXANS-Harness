// test/taskbench-repeat.test.js — 真 LLM taskbench 重复试验的离线守卫 (不调用外部 LLM)
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import {
  aggregateTaskTrials,
  buildReport,
  hashTaskSet,
  parseRepeat,
  runAll,
  runOne,
  sampleStats,
  sanitizeProviderMetadata,
  wilson95,
} from "../scripts/taskbench.js";
import { compareBench } from "../scripts/bench-gate.js";

const TASK = {
  id: "repeat-mock",
  category: "mock",
  task: "offline mock only",
  verify: ({ reply }) => ({ pass: reply === "ok", detail: "mock verdict" }),
};

function mockAgent(sandbox, { reply = "ok", chatError = null, shutdownError = null, onShutdown = null } = {}) {
  return {
    config: {},
    llm: null,
    allProviders: [],
    async chat() {
      if (chatError) throw chatError;
      return reply;
    },
    async shutdown() {
      onShutdown?.(sandbox);
      if (shutdownError) throw shutdownError;
    },
  };
}

const closeTo = (actual, expected, epsilon = 1e-12) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
};

test("--repeat 只接受正整数, 默认严格为 1", () => {
  assert.equal(parseRepeat(), 1);
  assert.equal(parseRepeat("3"), 3);
  for (const value of [0, -1, 1.5, "abc", ""]) assert.throws(() => parseRepeat(value), /--repeat/);
});

test("runAll 缺省 repeat 不增加 agent 创建次数或 LLM 调用成本", async () => {
  const sandboxes = [];
  let agents = 0;
  let chats = 0;
  let shutdowns = 0;
  const results = await runAll([TASK, TASK], {
    quiet: true,
    createAgent(sandbox) {
      agents++;
      sandboxes.push(sandbox);
      const agent = mockAgent(sandbox, {
        onShutdown: () => { shutdowns++; },
      });
      const chat = agent.chat;
      agent.chat = async (...args) => { chats++; return chat(...args); };
      return agent;
    },
  });
  assert.equal(agents, 2, "两个任务默认各创建一个 agent");
  assert.equal(chats, 2, "两个任务默认各调用一次 chat, 无隐藏重试");
  assert.equal(shutdowns, 2);
  assert.deepEqual(results.map((r) => r.attempts), [1, 1]);
  assert.equal(new Set(sandboxes).size, 2);
  for (const dir of sandboxes) assert.equal(fs.existsSync(dir), false);
});

test("repeat=3 每 trial 独立 agent/sandbox, 严格多数 pass 且全部清理", async () => {
  const replies = ["ok", "bad", "ok"];
  const agents = [];
  const sandboxes = [];
  let shutdowns = 0;
  const [result] = await runAll([TASK], {
    quiet: true,
    repeat: 3,
    createAgent(sandbox) {
      const agent = mockAgent(sandbox, {
        reply: replies[agents.length],
        onShutdown: () => { shutdowns++; },
      });
      agents.push(agent);
      sandboxes.push(sandbox);
      return agent;
    },
  });
  assert.equal(agents.length, 3);
  assert.equal(new Set(agents).size, 3);
  assert.equal(new Set(sandboxes).size, 3);
  assert.equal(shutdowns, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.passes, 2);
  assert.equal(result.passRate, 2 / 3);
  assert.equal(result.pass, true);
  assert.deepEqual(result.failureSteps, { 0: 1 });
  assert.equal(result.msStats.n, 3);
  assert.equal(result.tokenStats.sampleVariance, 0);
  for (const dir of sandboxes) assert.equal(fs.existsSync(dir), false);
});

test("样本统计: 均值/样本方差/最差值, n<2 方差为 null", () => {
  assert.deepEqual(sampleStats([5]), { n: 1, mean: 5, sampleVariance: null, worst: 5 });
  assert.deepEqual(sampleStats([]), { n: 0, mean: null, sampleVariance: null, worst: null });
  const stats = sampleStats([100, 200, 300]);
  assert.equal(stats.mean, 200);
  assert.equal(stats.sampleVariance, 10000);
  assert.equal(stats.worst, 300);
  const [single] = [aggregateTaskTrials(TASK, [{ pass: true, ms: 12, tokens: 7 }])];
  assert.equal(single.msStats.sampleVariance, null);
  assert.equal(single.tokenStats.sampleVariance, null);
});

test("聚合: attempts/passes/Wilson95/失败步分布/token 总成本保持正确", () => {
  const result = aggregateTaskTrials(TASK, [
    { pass: true, ms: 100, tokens: 10, score: { totalCalls: 1 } },
    { pass: false, ms: 300, tokens: 20, score: { totalCalls: 2 }, triage: { cause: "verification" } },
    { pass: false, ms: 200, tokens: 30, score: { totalCalls: 0 }, triage: { cause: "knowledge" } },
    { pass: true, ms: 400, tokens: 40, score: { totalCalls: 3 } },
  ]);
  assert.equal(result.attempts, 4);
  assert.equal(result.passes, 2);
  assert.equal(result.passRate, 0.5);
  assert.equal(result.pass, false, "2/4 平局沿用 majorityVerdict 保守判负");
  closeTo(result.wilson95.low, 0.15003898915214947);
  closeTo(result.wilson95.high, 0.8499610108478505);
  assert.equal(result.tokens, 100, "legacy tokens 字段是全 trials 成本");
  assert.equal(result.ms, 250);
  closeTo(result.msStats.sampleVariance, 50000 / 3);
  assert.equal(result.msStats.worst, 400);
  assert.equal(result.tokenStats.mean, 25);
  closeTo(result.tokenStats.sampleVariance, 500 / 3);
  assert.equal(result.tokenStats.worst, 40);
  assert.deepEqual(result.failureSteps, { 0: 1, 2: 1 });
  const w = wilson95(0, 0);
  assert.deepEqual(w, { low: null, high: null });
});

test("setup 异常也删除 sandbox, 且不创建 agent", async () => {
  let sandbox = null;
  let created = false;
  await assert.rejects(runOne({
    ...TASK,
    setup(dir) { sandbox = dir; throw new Error("setup boom"); },
  }, { quiet: true, createAgent: () => { created = true; return mockAgent(sandbox); } }), /setup boom/);
  assert.ok(sandbox);
  assert.equal(created, false);
  assert.equal(fs.existsSync(sandbox), false);
});

test("chat 异常转为判负但 shutdown/sandbox 清理仍完成", async () => {
  let sandbox = null;
  let shutdowns = 0;
  const result = await runOne(TASK, {
    quiet: true,
    createAgent(dir) {
      sandbox = dir;
      return mockAgent(dir, {
        chatError: new Error("chat boom"),
        onShutdown: () => { shutdowns++; },
      });
    },
  });
  assert.equal(result.pass, false);
  assert.match(result.reply, /chat boom/);
  assert.equal(shutdowns, 1);
  assert.equal(fs.existsSync(sandbox), false);
});

test("shutdown 异常仍删 sandbox, runAll 记录失败并继续后续独立 trial", async () => {
  const sandboxes = [];
  let calls = 0;
  const [result] = await runAll([TASK], {
    quiet: true,
    repeat: 2,
    createAgent(sandbox) {
      sandboxes.push(sandbox);
      calls++;
      return mockAgent(sandbox, {
        shutdownError: calls === 1 ? new Error("shutdown boom") : null,
      });
    },
  });
  assert.equal(calls, 2, "首个清理异常不能取消后续 trial");
  assert.equal(result.attempts, 2);
  assert.equal(result.passes, 1);
  assert.deepEqual(result.failureSteps, { unknown: 1 });
  assert.equal(new Set(sandboxes).size, 2);
  for (const dir of sandboxes) assert.equal(fs.existsSync(dir), false);
});

test("任务集 hash 冻结有序定义与判分器, 报告记录 Node/platform/git/provider/model", () => {
  const a = { id: "a", category: "c", task: "prompt", setup() {}, verify() { return { pass: true }; } };
  const same = { ...a };
  const changed = { ...a, task: "changed" };
  const hash = hashTaskSet([a]);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hashTaskSet([same]), hash);
  assert.notEqual(hashTaskSet([changed]), hash);

  const row = aggregateTaskTrials(TASK, [{
    pass: true,
    ms: 10,
    tokens: 3,
    reply: "完整回复不得外泄",
    toolCalls: [{ tool: "write_file", args: { content: "工具参数不得外泄" } }],
    score: { totalCalls: 1, failedCalls: 0, toolErrorRate: 0, redundancy: 0, uniqueTools: 1, planFollowed: true },
  }]);
  const report = buildReport({ total: 1, pass: 1, passRate: 1, totalTokens: 3, avgMs: 10 }, [row], {
    taskSetHash: hash,
    gitCommit: "0123456789abcdef",
    repeat: 1,
    providers: [{ id: "mock-provider", model: "mock-model", api_key: "sk-secret-value", base_url: "https://user:password@example.invalid" }],
  });
  const json = JSON.stringify(report);
  assert.equal(report.task_set_hash, hash);
  assert.equal(report.env.git_commit, "0123456789abcdef");
  assert.match(report.env.node, /^v\d+/);
  assert.ok(report.env.platform.includes(process.platform));
  assert.deepEqual(report.env.providers, [{ provider: "mock-provider", model: "mock-model" }]);
  assert.deepEqual(report.summary.repeat, { trialsPerTask: 1, totalAttempts: 1 });
  for (const secret of ["完整回复不得外泄", "工具参数不得外泄", "sk-secret-value", "password", "api_key", "base_url"]) {
    assert.ok(!json.includes(secret), `报告不得包含 ${secret}`);
  }
  assert.equal(report.results[0].attempts, 1);
  assert.equal(report.results[0].passes, 1);
  assert.equal(report.results[0].msStats.sampleVariance, null);
  assert.equal(report.results[0].tokenStats.sampleVariance, null);
  assert.ok(!("reply" in report.results[0]));
  assert.ok(!("toolCalls" in report.results[0]));
});

test("provider/model 白名单去重并遮蔽误放进名称里的凭证", () => {
  const rows = sanitizeProviderMetadata([
    { providerId: "p1", model: "m1", apiKey: "do-not-copy" },
    { providerId: "p1", model: "m1", api_key: "also-do-not-copy" },
    { provider: "api_key=abc123", model: "sk-abcdefgh" },
  ]);
  assert.deepEqual(rows[0], { provider: "p1", model: "m1" });
  assert.equal(rows.length, 2);
  const json = JSON.stringify(rows);
  for (const secret of ["do-not-copy", "also-do-not-copy", "abc123", "sk-abcdefgh"]) assert.ok(!json.includes(secret));
});

test("重复报告保留 results[].id/pass, bench-gate 可直接消费", () => {
  const row = aggregateTaskTrials(TASK, [
    { pass: true, ms: 1, tokens: 1 },
    { pass: true, ms: 2, tokens: 2 },
    { pass: false, ms: 3, tokens: 3 },
  ]);
  const report = buildReport({ total: 1, pass: 1, passRate: 1 }, [row], { repeat: 3 });
  assert.deepEqual(report.results.map(({ id, pass }) => ({ id, pass })), [{ id: TASK.id, pass: true }]);
  const gate = compareBench({ results: [{ id: TASK.id, pass: true }] }, report);
  assert.equal(gate.ok, true, gate.reasons.join("; "));
});
