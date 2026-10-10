// test/taskbench-report.test.js - 公开口径报告 buildReport (2026-10-08, 路线图缺口 5)
// 离线纯函数验证: schema 版本化 / 无模型自由文本 (reply 不外泄) / 判分事实完整 / meta 元数据。
import { test } from "node:test";
import assert from "node:assert";
import { buildReport } from "../scripts/taskbench.js";

const SUMMARY = {
  total: 3,
  pass: 2,
  passRate: 0.6667,
  totalTokens: 1500,
  avgMs: 4200,
  costEfficiency: 133.33,
  byCategory: { json_edit: { total: 2, pass: 2, tokens: 900, ms: 8000 } },
  failures: [{ id: "t3", detail: "x", reply: "含敏感内容的模型回复" }],
};
const RESULTS = [
  { id: "t1", category: "json_edit", pass: true, tokens: 500, ms: 4000, reply: "回复正文-不得外泄", triage: null },
  { id: "t2", category: "json_edit", pass: true, tokens: 400, ms: 4000, reply: "另一段回复" },
  { id: "t3", category: "net", pass: false, tokens: 600, ms: 4600, reply: "失败回复", triage: { cause: "timeout", confidence: 0.9, evidence: ["e"], action: "a" } },
];

test("report: schema 版本化 + 汇总与覆盖度正确", () => {
  const rep = buildReport(SUMMARY, RESULTS, { version: "3.2.3", gitCommit: "abc1234", totalTasks: 20 });
  assert.equal(rep.report_schema, 2); // v2 (2026-10-09): summary.gpa + 逐任务 score
  assert.equal(rep.suite, "taskbench");
  assert.equal(rep.coverage, "3/20");
  assert.equal(rep.summary.pass, 2);
  assert.equal(rep.summary.passRate, 66.7);
  assert.equal(rep.summary.costEfficiency, 133.33);
  assert.equal(rep.env.version, "3.2.3");
  assert.equal(rep.env.git_commit, "abc1234");
  assert.match(rep.env.node, /^v\d+/);
  assert.ok(rep.env.platform.includes(process.platform));
});

test("report: 模型自由文本 (reply) 绝不进公开口径, 判分事实完整", () => {
  const rep = buildReport(SUMMARY, RESULTS, {});
  const json = JSON.stringify(rep);
  for (const leak of ["回复正文-不得外泄", "另一段回复", "含敏感内容的模型回复"]) {
    assert.ok(!json.includes(leak), `reply 泄漏: ${leak}`);
  }
  assert.deepEqual(rep.results.map((r) => r.id), ["t1", "t2", "t3"]);
  assert.deepEqual(rep.results.map((r) => r.pass), [true, true, false]);
  assert.equal(rep.results[2].cause, "timeout");
  assert.equal(rep.results[0].cause, null);
  // failures 里的 reply 片段 (summarize 生成) 也不得被带进 report
  assert.ok(!("failures" in rep));
});

test("report: meta 缺省时不炸, pass 布尔化 (truthy 非布尔不外漏)", () => {
  const rep = buildReport({ total: 1, pass: 1, passRate: 1, totalTokens: 0, avgMs: 0 }, [{ id: "x", category: "c", pass: 1 }]);
  assert.equal(rep.env.version, null);
  assert.equal(rep.env.git_commit, null);
  assert.equal(rep.coverage, "1/1");
  assert.equal(rep.results[0].pass, true);
  assert.strictEqual(typeof rep.results[0].pass, "boolean");
});
