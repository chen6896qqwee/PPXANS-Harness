// test/trajectory-score.test.js — 轨迹评分器守卫 (评测体系 v2, 2026-10-09)
// GPA 过程级指标: 计划遵循度 / 工具错误率 / 冗余度。纯确定性计算, 零配额可测。
import { test } from "node:test";
import assert from "node:assert";
import { scoreTrajectory, TASK_PLANS, buildReport } from "../scripts/taskbench.js";

test("计划遵循度: oracle 声明的工具全部出现 → true", () => {
  const calls = [
    { tool: "read_file", args: { path: "a.js" }, ok: true },
    { tool: "apply_patch", args: { patch: "x" }, ok: true },
    { tool: "run_command", args: { command: "node --check a.js" }, ok: true },
  ];
  const s = scoreTrajectory(calls, { plan: TASK_PLANS["fix-syntax"] });
  assert.equal(s.planFollowed, true);
  assert.equal(s.toolErrorRate, 0);
  assert.equal(s.redundancy, 0);
});

test("计划遵循度: 漏调 oracle 工具 → false (如 git-flow 里漏 add_all 场景)", () => {
  const calls = [{ tool: "git_commit", args: { message: "x" }, ok: false }];
  const s = scoreTrajectory(calls, { plan: ["delete_file"] });
  assert.equal(s.planFollowed, false);
  assert.equal(s.toolErrorRate, 1);
});

test("冗余度: 完全相同的 tool+args 重复调用被计入, 不同参数不算冗余", () => {
  const calls = [
    { tool: "read_file", args: { path: "a" }, ok: true },
    { tool: "read_file", args: { path: "a" }, ok: true },
    { tool: "read_file", args: { path: "b" }, ok: true },
  ];
  const s = scoreTrajectory(calls);
  assert.equal(s.redundancy, 0.333, "1/3 应四舍五入到 3 位小数");
  assert.equal(s.uniqueTools, 1);
});

test("未声明 plan 的任务 planFollowed=null (不硬造指标)", () => {
  const s = scoreTrajectory([{ tool: "get_time", ok: true }], { plan: null });
  assert.equal(s.planFollowed, null);
});

test("空轨迹: 指标为 null 而非 NaN", () => {
  const s = scoreTrajectory([]);
  assert.equal(s.totalCalls, 0);
  assert.equal(s.toolErrorRate, null);
  assert.equal(s.redundancy, null);
});

test("buildReport: GPA 聚合进 summary, schema 升至 2, 逐任务带 score", () => {
  const results = [
    { id: "a", category: "文件", pass: true, tokens: 100, ms: 1000, score: { totalCalls: 3, failedCalls: 0, toolErrorRate: 0, redundancy: 0, uniqueTools: 2, planFollowed: true } },
    { id: "b", category: "文件", pass: false, tokens: 200, ms: 2000, score: { totalCalls: 2, failedCalls: 1, toolErrorRate: 0.5, redundancy: 0.5, uniqueTools: 1, planFollowed: false } },
  ];
  const summary = { pass: 1, total: 2, passRate: 0.5, totalTokens: 300, avgMs: 1500 };
  const rep = buildReport(summary, results, { totalTasks: 2, version: "test" });
  assert.equal(rep.report_schema, 2);
  assert.equal(rep.summary.gpa.planFollowedRate, 0.5);
  assert.equal(rep.summary.gpa.toolErrorRate, 0.25);
  assert.equal(rep.summary.gpa.redundancy, 0.25);
  assert.equal(rep.summary.gpa.plannedTasks, 2);
  assert.equal(rep.results[0].score.totalCalls, 3);
  assert.equal(rep.results[0].pass, true, "公开口径 pass 严格布尔");
});

test("TASK_PLANS 覆盖全部 20 个基准任务 (防计划表漏配)", async () => {
  const { TASKS } = await import("../bench/tasks.js");
  const missing = TASKS.filter((t) => !TASK_PLANS[t.id]).map((t) => t.id);
  assert.deepEqual(missing, [], "每个基准任务都应声明 oracle 工具计划");
});
