// test/majority-verdict.test.js — 多数投票判定守卫 (2026-10-09 迭代闭环)
// 语义: 多数过=过 / 平局=保守判负 / 单次方差进元数据
import { test } from "node:test";
import assert from "node:assert";
import { majorityVerdict } from "../scripts/taskbench.js";

test("多数过 → pass (2/3, 3/5)", () => {
  assert.equal(majorityVerdict([true, false, true]).pass, true);
  assert.equal(majorityVerdict([true, true, false, false, true]).pass, true);
});

test("多数挂 → fail; 平局 → 保守判负 (1/2, 2/4)", () => {
  assert.equal(majorityVerdict([false, true, false]).pass, false);
  assert.equal(majorityVerdict([true, false]).pass, false, "1/2 平局应判负");
  assert.equal(majorityVerdict([true, true, false, false]).pass, false, "2/4 平局应判负");
});

test("passRate 元数据可观测 (单次方差)", () => {
  assert.equal(majorityVerdict([true, false, true]).passRate, 2 / 3);
  assert.equal(majorityVerdict([]).passRate, 0);
});
