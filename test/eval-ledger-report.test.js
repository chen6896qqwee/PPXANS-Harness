import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildLedgerReport,
  classify,
  nearestRank,
  summarizeCalls,
} from "../scripts/eval-ledger-report.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "eval-ledger-report.js");
const ts = (suffix) => `2026-11-16T00:${suffix}.000Z`;
const tool = (taskId, suffix, extra = {}) => ({
  evt: "eval/tool", taskId, sessionId: "shared-process-session", ts: ts(suffix), ok: true, result: "ok", ...extra,
});
const turn = (taskId, suffix, taskOk, extra = {}) => ({
  evt: "eval/turn", taskId, sessionId: "shared-process-session", ts: ts(suffix), taskOk, ...extra,
});
const request = (taskId, suffix, extra = {}) => ({
  evt: "eval/request", taskId, sessionId: "shared-process-session", ts: ts(suffix), durationMs: 10, ...extra,
});

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-eval-ledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n") + "\n", "utf8");
}

test("五分类保持旧口径, 显式 category 优先且 denied_by_design 覆盖 ok=false", () => {
  assert.equal(classify("done", true), "success");
  assert.equal(classify("[exit=2]\n[工具错误] failed", true), "exitNonzero");
  assert.equal(classify("[工具错误] [permission] 路径越界, 被拒绝", true), "deniedByDesign");
  assert.equal(classify("[工具错误] 参数错误", true), "softError");
  assert.equal(classify("failed", false), "hardFail");
  assert.equal(classify("failed", false, "denied_by_design"), "deniedByDesign");
  assert.equal(classify("done", true, "hard_fail"), "hardFail");
  assert.equal(classify("done", true, "unknown_tool"), "hardFail");
  assert.equal(classify("done", true, "parameter_hallucination"), "hardFail");
  assert.equal(classify("failed", false, "success"), "success");
});

test("旧 tool/call 的 surface/strict/sessionChain/recovery/byDay 字段兼容", () => {
  const summary = summarizeCalls([
    { sessionId: "s1", ts: ts("01"), ok: true, result: "done" },
    { sessionId: "s1", ts: ts("02"), ok: true, result: "[exit=1]\n[工具错误] failed" },
    { sessionId: "s1", ts: ts("03"), ok: true, result: "[工具错误] [permission] 被拒绝" },
    { sessionId: "s1", ts: ts("04"), ok: true, result: "[工具错误] invalid" },
    { sessionId: "s1", ts: ts("05"), ok: false, result: "failed" },
  ]);
  assert.equal(summary.totalCalls, 5);
  assert.deepEqual(summary.classes, {
    success: 1, exitNonzero: 1, deniedByDesign: 1, softError: 1, hardFail: 1,
  });
  assert.deepEqual(summary.surface, { ok: 4, rate: 0.8 });
  assert.deepEqual(summary.strict, { ok: 1, rate: 0.2 });
  assert.deepEqual(summary.sessionChain, { total: 1, zeroFailure: 0, zeroExecutionFailure: 0 });
  assert.deepEqual(summary.recovery, { events: 2, recovered: 0, rate: 0 });
  assert.equal(summary.byDay["2026-11-16"].surfaceRate, 0.8);
  assert.equal(summary.byDay["2026-11-16"].strictRate, 0.2);
  assert.deepEqual(summary.stepSuccess, { ok: 1, total: 5, rate: 0.2, excludedShadowCalls: 0 });
  assert.equal(summary.taskSuccess.rate, null);
  assert.equal(summary.taskRecovery.rate, null);
});

test("新事件按 taskId||traceId 分组, 最终成功/恢复与旧下一步恢复分离", () => {
  const summary = summarizeCalls([
    // A: 中间真错误, 最终成功 -> 最终恢复。
    request("A", "01", { durationMs: 10, usage: { total_tokens: 100, cost: 0.1 } }),
    tool("A", "02", { result: "[工具错误] transient", category: "soft_error" }),
    tool("A", "03"),
    turn("A", "04", true),
    // B: 与 A 共用进程 sessionId; 下一步虽成功, 最终失败 -> 不算最终恢复。
    request("B", "01", { durationMs: 20, usage: { total_tokens: 200, cost: 0.2 } }),
    tool("B", "02", { ok: false, result: "failed" }),
    tool("B", "03"),
    turn("B", "04", false),
    // C: ok=false 但显式按设计拒绝, 不进恢复分母; 未定价不是免费。
    request("C", "01", { durationMs: 30, usage: { total_tokens: 300, cost: 0 }, priced: false }),
    tool("C", "02", { ok: false, result: "denied", category: "denied_by_design" }),
    turn("C", "03", true),
    // D: shadow 错误不进实际单步分母, 也不制造成最终恢复事件; 已定价 0 合法。
    request("D", "01", { durationMs: 40, usage: { total_tokens: 400, cost: 0 }, priced: true }),
    tool("D", "02", { ok: false, result: "shadow failed", category: "hard_fail", shadow_call: true }),
    turn("D", "03", true),
  ]);

  assert.equal(summary.sessionChain.total, 4, "同一进程 session 下的 A/B 必须分为不同任务");
  assert.equal(summary.totalCalls, 6);
  assert.equal(summary.classes.deniedByDesign, 1);
  assert.deepEqual(summary.stepSuccess, { ok: 2, total: 5, rate: 0.4, excludedShadowCalls: 1 });
  assert.deepEqual(summary.taskSuccess, { total: 4, ok: 3, rate: 0.75, unknownOutcome: 0, missingOutcome: 0 });
  assert.deepEqual(summary.taskRecovery, { eligible: 3, recovered: 2, rate: 0.6667 });
  assert.equal(summary.recovery.recovered, 2, "旧字段仍统计 A/B 错误后的下一步成功");
  assert.deepEqual(summary.hallucinations, {
    totalAttempts: 6,
    unknown_tool: { count: 0, rate: 0 },
    shadow_call: { count: 1, rate: 0.1667 },
    parameter_hallucination: { count: 0, rate: 0 },
  });
  assert.deepEqual(summary.requestUsage, { total: 4, provider: 0, estimated: 0, none: 0, unknown: 4 });

  assert.deepEqual(summary.requestLatency, {
    total: 4, samples: 4, p50Ms: 20, p95Ms: 40, method: "nearest-rank",
  });
  const cost = summary.successfulTaskCost;
  assert.equal(cost.tasks, 3);
  assert.equal(cost.totalTokens, 800, "未定价不影响已知 token 汇总");
  assert.equal(cost.avgTokens, 266.6667);
  assert.equal(cost.amount, null, "C 未定价, 成功任务完整金额必须未知而不是 $0.1 或免费");
  assert.equal(cost.avgAmount, null);
  assert.equal(cost.pricedAmount, 0.1, "已定价子合计只含 A/D, B 最终失败被排除");
  assert.equal(cost.pricedTasks, 2);
  assert.equal(cost.unpricedTasks, 1);
  assert.equal(cost.amountComplete, false);
});

test("未知工具/参数幻觉分别计费且计入最终任务恢复", () => {
  const summary = summarizeCalls([
    tool("unknown", "01", { ok: false, category: "unknown_tool", result: "missing" }),
    turn("unknown", "02", true),
    tool("parameter", "01", { ok: false, category: "parameter_hallucination", result: "bad args" }),
    turn("parameter", "02", true),
    turn("unknown-outcome", "01", null),
    tool("missing-outcome", "01"),
  ]);
  assert.deepEqual(summary.hallucinations, {
    totalAttempts: 3,
    unknown_tool: { count: 1, rate: 0.3333 },
    shadow_call: { count: 0, rate: 0 },
    parameter_hallucination: { count: 1, rate: 0.3333 },
  });
  assert.deepEqual(summary.taskRecovery, { eligible: 2, recovered: 2, rate: 1 });
  assert.deepEqual(summary.taskSuccess, {
    total: 2, ok: 2, rate: 1, unknownOutcome: 1, missingOutcome: 1,
  });
});

test("已定价的零金额与正金额可求成功任务总成本, 失败任务成本排除", () => {
  const summary = summarizeCalls([
    request("free", "01", { usage: { total_tokens: 10, cost: 0 }, priced: true, usageSource: "provider" }),
    turn("free", "02", true),
    request("paid", "01", { usage: { total_tokens: 20, cost: 0.2 }, priced: true, usageSource: "estimated" }),
    turn("paid", "02", true),
    request("failed", "01", { usage: { total_tokens: 999, cost: 9 }, priced: true, usageSource: "none" }),
    turn("failed", "02", false),
  ]);
  assert.deepEqual(summary.successfulTaskCost, {
    tasks: 2,
    totalTokens: 30,
    avgTokens: 15,
    knownTokens: 30,
    tokenTasks: 2,
    missingTokenTasks: 0,
    currency: "USD",
    amount: 0.2,
    avgAmount: 0.1,
    pricedAmount: 0.2,
    pricedTasks: 2,
    unpricedTasks: 0,
    amountComplete: true,
  });
  assert.deepEqual(summary.requestUsage, { total: 3, provider: 1, estimated: 1, none: 1, unknown: 0 });
});

test("traceId 可在 taskId 缺失时关联完整任务", () => {
  const summary = summarizeCalls([
    { evt: "eval/request", traceId: "trace-1", ts: ts("01"), durationMs: 8, totalTokens: 5, cost: 0.01 },
    { evt: "eval/tool", traceId: "trace-1", ts: ts("02"), ok: true, result: "ok" },
    { evt: "eval/turn", traceId: "trace-1", ts: ts("03"), taskOk: true },
  ]);
  assert.equal(summary.taskSuccess.total, 1);
  assert.equal(summary.taskSuccess.ok, 1);
  assert.equal(summary.successfulTaskCost.totalTokens, 5);
  assert.equal(summary.successfulTaskCost.amount, 0.01);
});

test("请求 P50/P95 使用 nearest-rank, 不插值", () => {
  const values = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(nearestRank(values, 0.5), 10);
  assert.equal(nearestRank(values, 0.95), 19);
  assert.equal(nearestRank([], 0.5), null);
  const events = values.map((n) => ({
    evt: "eval/request", taskId: `t${n}`, ts: ts("01"), durationMs: 21 - n,
  }));
  const summary = summarizeCalls(events);
  assert.equal(summary.requestLatency.samples, 20);
  assert.equal(summary.requestLatency.p50Ms, 10);
  assert.equal(summary.requestLatency.p95Ms, 19);
  assert.equal(summary.requestLatency.method, "nearest-rank");
});

test("byStrata 保留 model×difficulty 完整复合组合并分别汇总", () => {
  const events = [];
  const rows = [
    ["m1", "easy", true, 10],
    ["m1", "hard", false, 20],
    ["m2", "easy", true, 30],
    ["m2", "hard", true, 40],
  ];
  for (const [model, difficulty, taskOk, durationMs] of rows) {
    const taskId = `${model}-${difficulty}`;
    const strata = { model, difficulty };
    events.push(request(taskId, "01", { durationMs, totalTokens: 1, cost: 0, strata }));
    events.push(tool(taskId, "02", { category: taskOk ? "success" : "hard_fail", ok: taskOk, strata }));
    events.push(turn(taskId, "03", taskOk, { strata }));
  }
  const summary = summarizeCalls(events);
  const keys = Object.keys(summary.byStrata);
  assert.equal(keys.length, 4, "同一 model 或 difficulty 不得跨另一维度合并");
  const easyM1 = summary.byStrata['{"difficulty":"easy","model":"m1"}'];
  const hardM1 = summary.byStrata['{"difficulty":"hard","model":"m1"}'];
  const easyM2 = summary.byStrata['{"difficulty":"easy","model":"m2"}'];
  assert.deepEqual(easyM1.strata, { difficulty: "easy", model: "m1" });
  assert.equal(easyM1.taskSuccess.rate, 1);
  assert.equal(hardM1.taskSuccess.rate, 0);
  assert.equal(easyM2.taskSuccess.rate, 1);
  assert.equal(easyM1.stepSuccess.total, 1);
  assert.equal(easyM1.requestLatency.p50Ms, 10);
  assert.equal(hardM1.requestLatency.p95Ms, 20);
});

test("buildLedgerReport 读取任意四位年份及新旧事件, 忽略非日期文件和坏行", (t) => {
  const dir = tempDir(t);
  const traces = path.join(dir, "traces");
  writeJsonl(path.join(traces, "2025-01-02.jsonl"), [
    { evt: "eval/request", taskId: "file-task", ts: "2025-01-02T00:00:00Z", latencyMs: 123, totalTokens: 7, cost: 0.03 },
    "not-json",
  ]);
  writeJsonl(path.join(traces, "2027-12-31.jsonl"), [
    { evt: "tool/call", taskId: "file-task", sessionId: "legacy", ts: "2025-01-02T00:00:01Z", ok: true, result: "ok" },
    { evt: "eval/turn", taskId: "file-task", ts: "2025-01-02T00:00:02Z", taskOk: true },
    { evt: "other/event", taskId: "ignored" },
  ]);
  writeJsonl(path.join(traces, "2026-1-02.jsonl"), [
    { evt: "tool/call", taskId: "wrong-year-width", ok: true, result: "ignored" },
  ]);
  writeJsonl(path.join(traces, "notes.jsonl"), [
    { evt: "tool/call", taskId: "wrong-file", ok: true, result: "ignored" },
  ]);
  const auditFile = path.join(dir, "audit.ndjson");
  writeJsonl(auditFile, [{ ok: true }, { ok: false }, "bad-json"]);

  const report = buildLedgerReport({ traceDir: traces, auditFile });
  assert.equal(report.trace.totalCalls, 1);
  assert.equal(report.trace.taskSuccess.total, 1);
  assert.equal(report.trace.taskSuccess.rate, 1);
  assert.equal(report.trace.requestLatency.p50Ms, 123);
  assert.equal(report.trace.successfulTaskCost.totalTokens, 7);
  assert.equal(report.trace.successfulTaskCost.amount, 0.03);
  assert.deepEqual(report.audit, {
    total: 2,
    ok: 1,
    fail: 1,
    surfaceRate: 0.5,
    note: "audit.ndjson 无结果体, 只能算表面口径; 严格口径以 trace 侧为准",
  });
  assert.match(report.caliberContract.requestLatency, /nearest-rank/);
});

test("CLI 总结同步输出单步/最终任务/恢复/成本/分位数及未定价提示", (t) => {
  const dataDir = tempDir(t);
  writeJsonl(path.join(dataDir, "logs", "traces", "2030-01-01.jsonl"), [
    { evt: "eval/request", taskId: "cli", ts: "2030-01-01T00:00:00Z", durationMs: 5, totalTokens: 9, priced: false },
    { evt: "eval/tool", taskId: "cli", ts: "2030-01-01T00:00:01Z", ok: true, result: "ok" },
    { evt: "eval/turn", taskId: "cli", ts: "2030-01-01T00:00:02Z", taskOk: true },
  ]);
  const run = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, PPX_DATA_DIR: dataDir },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /单步成功率: 1 \(1\/1\)/);
  assert.match(run.stdout, /最终任务成功率 1/);
  assert.match(run.stdout, /最终任务恢复率 null \(0\/0\)/);
  assert.match(run.stdout, /成功任务 tokens 9 \| 金额 未知 \(未定价任务 1\)/);
  assert.match(run.stdout, /请求 P50 5ms \/ P95 5ms \(nearest-rank\)/);
});
