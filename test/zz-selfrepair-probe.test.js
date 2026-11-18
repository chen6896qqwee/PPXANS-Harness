// test/zz-selfrepair-probe.test.js - 自主修复闭环探针 (2026-10-31)
// 考卷: 断言 add 的正确语义。失败驱动 selfiterate 定位并修复 sandbox-probe/calc.js。
import test from "node:test";
import assert from "node:assert/strict";

import { add, mul } from "../sandbox-probe/calc.js";

test("probe: add 执行加法", () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
});

test("probe: mul 执行乘法 (对照, 应始终绿)", () => {
  assert.equal(mul(3, 4), 12);
});
