// test/taskbench-timeout-guard.test.js — 基准超时预算护栏离线回归 (2026-10-05)
// 背景: 真跑 rename-symbol 因预算倒挂挂死 —— LLMClient 兜底单次超时 120s > 任务预算 90s,
// 重试永远够不着, 一次悬挂就输掉整个任务 (triage 判 llm_stall)。修复在 bench 侧注入
// 「单次超时 = 预算/3 + 重试封顶 < 预算」的按调用覆盖 (scripts/taskbench.js benchLlmGuard)。
// 本文件零 API 配额: 注入悬挂桩 LLM (不守约、无视/迟于 timeoutMs 才返回), 走真实
// runOne 代码路径, 证三件事:
//   (a) 悬挂调用在「单次超时」处被放弃 (而不是等任务级 90s 护栏);
//   (b) 放弃后确实发生重试, 任务在 TASK_BUDGET_MS 内正常完成;
//   (c) 永久悬挂的桩以干净失败收场: 重试烧完即抛, 无未处理 rejection, 无泄漏定时器。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { runOne, benchLlmGuard, TASK_BUDGET_MS } from "../scripts/taskbench.js";
import { triageFailure } from "../src/services/triage.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timerCount = () => process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;

// 悬挂桩 LLM: apiChat 前 hangAttempts 次「不守约」—— hangAfterMs>0 时迟于单次超时才返回
// (测完仍会兑现, 但调用方早已按 per-call 超时放弃), 否则永不 settle (永久悬挂)。
// 每次调用记录 opts 与进入时刻, 供断言护栏确实注入了 timeoutMs/retryMax 覆盖。
function hangStub({ hangAfterMs = 0, hangAttempts = 1 } = {}) {
  const st = {
    model: "stub-hang",
    backend: "http",
    vision: false,
    supportsNativeToolCalls: true,
    calls: 0,
    seenOpts: [],
    startedAt: [],
    health: async () => true,
    // 辅助调用 (记忆提炼/压缩等) 走 chat: 立即成功, 不干扰 apiChat 侧断言
    chat: async () => ({ content: "ok", usage: { total_tokens: 1 } }),
    apiChat: async (msgs, opts) => {
      st.calls++;
      st.seenOpts.push(opts || {});
      st.startedAt.push(Date.now());
      if (st.calls <= hangAttempts) {
        if (hangAfterMs > 0) await sleep(hangAfterMs); // 比单次超时慢: 调用方必须放弃
        else return new Promise(() => {});             // 永久悬挂: 永不 settle
      }
      return { message: { role: "assistant", content: "答案是 2", tool_calls: null }, usage: { total_tokens: 5 } };
    },
  };
  return st;
}

// createAgent 注入点: runOne 默认用真实 config/ppx.json 烧配额; 测试给工厂换桩。
function makeStubAgentFactory(stub) {
  return (sandbox) => {
    fs.mkdirSync(path.join(sandbox, "config"), { recursive: true });
    fs.writeFileSync(path.join(sandbox, "config", "ppx.json"), JSON.stringify({
      providers: [],
      agent: { localIntent: false, proactive: { enabled: false } },
    }), "utf8");
    const agent = new PPXAgent({
      root: sandbox,
      configFile: path.join(sandbox, "config", "ppx.json"),
      dataDir: path.join(sandbox, ".ppx"),
      globalDataDir: path.join(sandbox, ".ppx-global"),
    });
    agent.llm = stub;
    agent.allProviders = [stub];
    return agent;
  };
}

const TASKDEF = {
  id: "stub-hang-guard",
  category: "守卫",
  task: "1+1 等于几?",
  verify: ({ reply }) => ({ pass: /答案是 2/.test(String(reply || "")), detail: String(reply || "").slice(0, 80) }),
};

// ---- 1. 预算算术: 数字全部由 TASK_BUDGET_MS 推导, 关系不许漂移 ----
test("benchLlmGuard: 单次超时=预算/3, 重试后总耗时仍留 ≥1 个超时窗口", () => {
  const g = benchLlmGuard(TASK_BUDGET_MS);
  assert.equal(TASK_BUDGET_MS, 90000);
  assert.equal(g.timeoutMs, Math.floor(TASK_BUDGET_MS / 3), "单次超时 = 任务预算/3");
  assert.equal(g.retryMax, 1);
  assert.ok(g.timeoutMs < TASK_BUDGET_MS, "核心不变量: 单次超时必须小于任务级时限 (triage 处方)");
  // 最坏慢调用耗时 vs 预算: (1+retryMax)×timeout 必须给工具轮次/终答留 ≥1 个 timeout
  assert.ok((1 + g.retryMax) * g.timeoutMs <= TASK_BUDGET_MS - g.timeoutMs,
    `(1+${g.retryMax})×${g.timeoutMs} 应 ≤ ${TASK_BUDGET_MS - g.timeoutMs}`);
  // 小预算同样闭合 (测试用 3600 → 1200/1)
  const s = benchLlmGuard(3600);
  assert.deepEqual(s, { timeoutMs: 1200, retryMax: 1 });
  assert.ok((1 + s.retryMax) * s.timeoutMs <= 3600 - s.timeoutMs);
});

// ---- 2. (a)+(b): 悬挂在单次超时被放弃 → 重试 → 任务在预算内完成 ----
test("悬挂桩: 单次超时即放弃 + 重试真实发生 + 任务在 TASK_BUDGET_MS 内完成", async () => {
  const budgetMs = 3600;
  const guard = benchLlmGuard(budgetMs); // {1200, 1}
  // attempt1 迟至 4×timeout 才"回话" —— 必须被 1200ms 单次超时砍掉, 不能等它
  const stub = hangStub({ hangAfterMs: guard.timeoutMs * 4, hangAttempts: 1 });
  const r = await runOne(TASKDEF, { quiet: true, budgetMs, createAgent: makeStubAgentFactory(stub) });

  assert.equal(stub.calls, 2, "第 1 次被放弃后确实重试了第 2 次");
  const gap = stub.startedAt[1] - stub.startedAt[0];
  assert.ok(gap >= guard.timeoutMs - 50, `重试应等满单次超时窗口, 实测间隔 ${gap}ms`);
  assert.ok(gap < budgetMs, `间隔应远小于任务预算 (证明放弃发生在 per-call 超时而非任务护栏), 实测 ${gap}ms`);
  // 护栏沿 client 既有「按调用覆盖」形状注入 (同 AUX_TIMEOUT_MS 约定), 不改全局默认
  assert.equal(stub.seenOpts[0].timeoutMs, guard.timeoutMs, "应注入 per-call timeoutMs 覆盖");
  assert.equal(stub.seenOpts[0].retryMax, 0, "重试收口在 bench 层, 底层禁内部重试防预算算术不闭合");
  assert.equal(r.pass, true, `重试后任务应判通过, 实际回复: ${r.reply}`);
  assert.ok(r.ms < budgetMs, `任务应在 TASK_BUDGET_MS 内完成, 实测 ${r.ms}ms`);
});

// ---- 3. (c): 永久悬挂 → 干净失败, 无未处理 rejection, 无泄漏定时器 ----
test("永久悬挂桩: 重试烧完即干净失败 (早于任务护栏), triage 处方指向现实", async () => {
  const budgetMs = 3600;
  const guard = benchLlmGuard(budgetMs);
  const stub = hangStub({ hangAfterMs: 0, hangAttempts: Infinity });
  const rejections = [];
  const onUnhandled = (e) => rejections.push(e);
  process.on("unhandledRejection", onUnhandled);
  const timersBefore = timerCount();
  let r;
  try {
    r = await runOne(TASKDEF, { quiet: true, budgetMs, createAgent: makeStubAgentFactory(stub) });
  } finally {
    await sleep(120); // 给任何延迟爆雷的 rejection/定时器一点浮出水面时间
    process.off("unhandledRejection", onUnhandled);
  }
  assert.equal(rejections.length, 0, `不应有未处理 rejection: ${rejections.map(String).join(" / ")}`);
  assert.equal(stub.calls, 1 + guard.retryMax, `恰好 1+retryMax 次尝试后止损, 不无限重试`);
  assert.equal(r.pass, false, "永久悬挂必须判负");
  assert.ok(r.ms >= (1 + guard.retryMax) * guard.timeoutMs - 100, "重试预算应烧满");
  assert.ok(r.ms < budgetMs, `应在任务护栏到点前止损, 实测 ${r.ms}/${budgetMs}ms`);
  assert.match(r.reply, /超时|timeout/, "失败回复应如实带上超时原因 (LLM_FAILED_HINT 透传)");
  // 定时器不泄漏: bench 层 withTimeout 均经 finally clearTimeout
  assert.ok(timerCount() <= timersBefore, `定时器数应回落: before=${timersBefore} after=${timerCount()}`);
  // 归因诚实: llm_stall 处方指向已落地的护栏, 不再开"改 provider.timeout_ms"的旧药方
  assert.equal(r.triage?.cause, "llm_stall");
  assert.match(r.triage.action, /benchLlmGuard/, `处方应指向现实: ${r.triage.action}`);
  assert.doesNotMatch(r.triage.action, /provider\.timeout_ms/, "任务级护栏兜住的场景不应再误标底层来源");

  // 直调路径兜底: 任务护栏先到 (真·90s 吃满) 的场景仍判 llm_stall 且处方更新
  const t = triageFailure({ reply: "任务 stub 超时 (90s)", toolCalls: [], ms: 90000, budgetMs: 90000 });
  assert.equal(t.cause, "llm_stall");
  assert.match(t.action, /任务预算\/3/);
});
