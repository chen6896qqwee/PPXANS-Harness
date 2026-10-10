// test/regression-check.test.js — 回归检测守卫 (2026-10-09, "想记做学评"框架补齐)
// 验证 --check-regression 的判定逻辑: 基线对照 → 退化任务列表 → 门禁语义。
// 不跑真评测: 直接构造 results 形状测 main 内联逻辑不可行, 故抽核心比较函数验证。
import { test } from "node:test";
import assert from "node:assert";

// 与 taskbench main 内联逻辑同构的比较 (锁语义: 此前 pass 本次 fail = 回归)
function findRegressions(baselineResults, currentResults) {
  const blMap = new Map((baselineResults || []).map((r) => [r.id, !!r.pass]));
  return (currentResults || []).filter((r) => blMap.has(r.id) && blMap.get(r.id) && !r.pass);
}

test("回归判定: 基线 pass → 当前 fail = 回归; 新任务失败 ≠ 回归; 持续 pass ≠ 回归", () => {
  const baseline = [
    { id: "a", pass: true }, { id: "b", pass: true }, { id: "c", pass: false },
  ];
  const current = [
    { id: "a", pass: false, detail: "判分失败" },  // 基线过→挂 = 回归
    { id: "b", pass: true },                        // 持续过
    { id: "c", pass: false },                       // 基线就挂 = 持续失败, 非回归
    { id: "d", pass: false },                       // 新任务 = 非回归
  ];
  const reg = findRegressions(baseline, current);
  assert.deepEqual(reg.map((r) => r.id), ["a"]);
  assert.equal(reg[0].detail, "判分失败");
});

test("回归判定: 空基线/空当前 → 空回归 (不误报)", () => {
  assert.deepEqual(findRegressions([], [{ id: "x", pass: false }]), []);
  assert.deepEqual(findRegressions([{ id: "x", pass: true }], []), []);
});
