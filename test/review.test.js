// test/review.test.js - 分级审查流水线 单测
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { planReview, groupChanges, reviewGroup, relocateIssues, filterNoise, runReview } from "../src/review/index.js";

function tmpRoot(n) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-rv-${n}-`)); }
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}

test("planReview: 返回五阶段计划与分组预估", () => {
  const plan = planReview({ files: ["a.js", "b.js", "c.js", "d.js", "e.js"], context: "修复登录" });
  assert.equal(plan.stages.length, 5);
  assert.equal(plan.stages[0].name, "plan");
  assert.equal(plan.stages[4].name, "filter");
  assert.ok(plan.groups >= 1, "分组预估>=1");
});

test("groupChanges: 按目录/扩展名语义分组 + 解析 diff", () => {
  const groups1 = groupChanges(["src/a.js", "src/b.js", "lib/c.py"]);
  assert.equal(groups1.length, 2, "src(js) 一组 + lib(py) 一组");
  const diff = [
    "diff --git a/foo.js b/foo.js",
    "+++ b/foo.js",
    "@@ -1 +1 @@",
    "+console.log(1)",
    "diff --git a/bar.js b/bar.js",
    "--- a/bar.js",
    "+++ b/bar.js",
  ].join("\n");
  const groups2 = groupChanges(diff);
  assert.equal(groups2.length, 1, "同一扩展名归一组");
  assert.deepEqual(groups2[0].files.sort(), ["bar.js", "foo.js"]);
});

test("reviewGroup: 命中硬编码密钥/TODO/空catch 规则", () => {
  const root = tmpRoot("a");
  const f = write(root, "svc.js", [
    "const cfg = { apiKey: 'sk_live_abcdef1234567890' };",
    "function handler() {",
    "  // TODO: 补日志",
    "  try { doThing(); } catch (e) {}",
    "}",
    "",
  ].join("\n"));
  const group = { key: "x", files: [f] };
  const issues = reviewGroup(group);
  const titles = issues.map((i) => i.title);
  assert.ok(titles.includes("硬编码敏感凭据"), "命中密钥规则");
  assert.ok(titles.includes("待办/临时标记残留"), "命中 TODO 规则");
  assert.ok(titles.includes("空 catch 吞掉异常"), "命中空 catch 规则");
  fs.rmSync(root, { recursive: true, force: true });
});

test("reviewGroup: 超长函数与 == 与 XSS 规则", () => {
  const root = tmpRoot("b");
  const lines = ["function big() {", "  let x = 1;"];
  for (let i = 0; i < 250; i++) lines.push(`  x = x + ${i};`);
  lines.push("  if (x == 5) { element.innerHTML = '<b>' + x + '</b>'; }");
  lines.push("}");
  const f = write(root, "big.js", lines.join("\n"));
  const issues = reviewGroup({ key: "x", files: [f] });
  const titles = issues.map((i) => i.title);
  assert.ok(titles.includes("函数过长(>200行)"), "命中超长函数");
  assert.ok(titles.includes("使用松散相等 == (建议 ===)"), "命中 == 规则");
  assert.ok(titles.includes("未转义 HTML 拼接(XSS 风险)"), "命中 XSS 规则");
  fs.rmSync(root, { recursive: true, force: true });
});

test("relocateIssues: 同签名重复去重", () => {
  const issues = [
    { severity: "low", file: "old/util.js", title: "待办/临时标记残留", detail: "TODO: x" },
    { severity: "low", file: "new/util.js", title: "待办/临时标记残留", detail: "TODO: x" },
  ];
  const moved = relocateIssues(issues, [{ signature: "待办/临时标记残留@TODO: x" }]);
  assert.equal(moved.length, 1, "换位重复去重保留一份");
});

test("filterNoise: 过滤 lock/生成目录/空变更", () => {
  const issues = [
    { severity: "high", file: "package-lock.json", title: "硬编码敏感凭据", detail: "x" },
    { severity: "low", file: "dist/bundle.js", title: "调试输出残留", detail: "x" },
    { severity: "low", file: "src/app.js", title: "", detail: "空标题" },
    { severity: "high", file: "src/app.js", title: "硬编码敏感凭据", detail: "x" },
  ];
  const kept = filterNoise(issues);
  assert.equal(kept.length, 1, "仅保留 src/app.js 的有效问题");
});

test("runReview: 全流程产出 P0/P1/P2 报告", () => {
  const root = tmpRoot("c");
  const f = write(root, "api.js", [
    "const config = { secret: 'supersecret123456' };",
    "function process() {",
    "  try { risky(); } catch (e) {}",
    "  // FIXME: 边界未处理",
    "}",
    "",
  ].join("\n"));
  const { issues, graded, report } = runReview({ files: [f] });
  assert.ok(graded.high.length >= 1, "P0 至少 1 条(密钥)");
  assert.ok(graded.medium.length >= 1, "P1 至少 1 条(空catch)");
  assert.ok(graded.low.length >= 1, "P2 至少 1 条(FIXME)");
  assert.ok(report.includes("# 代码审查报告"), "报告含标题");
  assert.ok(report.includes("P0"), "报告含 P0 分级");
  assert.ok(report.includes("P1"), "报告含 P1 分级");
  assert.ok(report.includes("P2"), "报告含 P2 分级");
  fs.rmSync(root, { recursive: true, force: true });
});
