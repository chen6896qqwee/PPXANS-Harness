// test/evidence.test.js - 证据边界与看板 单测
import test from "node:test";
import assert from "node:assert";
import {
  Evidence, markPrepared, markObserved, validateEvidence,
  createHandoffManifest, createGoalBoard, conformanceCheck,
} from "../src/evidence/index.js";

test("Evidence 常量与标记: prepared/observed 不可变", () => {
  const p = markPrepared({ query: "天气", answer: "晴" }, { source: "web-search" });
  assert.equal(p.__evidence, Evidence.PREPARED);
  assert.equal(p.__source, "web-search");
  assert.ok(typeof p.__ts === "string");
  assert.ok(Object.isFrozen(p), "标记后冻结");

  const o = markObserved({ stdout: "done" }, { tool: "shell" });
  assert.equal(o.__evidence, Evidence.OBSERVED);
  assert.equal(o.__tool, "shell");
  assert.ok(Object.isFrozen(o));

  // 冻结后不可改
  assert.throws(() => { "use strict"; p.answer = "改不了"; });
});

test("markPrepared/markObserved 不污染入参", () => {
  const raw = { a: 1 };
  const p = markPrepared(raw, { source: "s" });
  assert.notEqual(p, raw, "返回的是副本而非原引用");
  assert.equal(raw.a, 1, "原对象未被改动");
  assert.ok(Object.isFrozen(p), "副本已冻结");
  // 冻结后不可改 (strict 模式赋值应被拒绝)
  assert.throws(() => { "use strict"; p.a = 999; }, "冻结对象赋值抛错");
});

test("validateEvidence: 校验标记合法性", () => {
  const ok = markObserved({ x: 1 }, { tool: "t" });
  assert.deepEqual(validateEvidence(ok), { valid: true, type: Evidence.OBSERVED, reason: "ok" });
  assert.equal(validateEvidence({}).valid, false, "无标记无效");
  const bad = { __evidence: Evidence.PREPARED, __source: "s" }; // 缺 __ts 的非法证据
  assert.equal(validateEvidence(bad).valid, false, "缺时间戳无效");
});

test("createHandoffManifest: 条目哈希 + 整体摘要", () => {
  const items = [
    { type: "doc", source: "web", data: { q: "a" } },
    markObserved({ r: 1 }, { tool: "shell" }),
  ];
  const m = createHandoffManifest(items);
  assert.equal(m.version, 1);
  assert.ok(Array.isArray(m.entries) && m.entries.length === 2);
  assert.equal(m.entries[0].hash.length, 16, "哈希取前16位");
  assert.ok(typeof m.digest === "string" && m.digest.length === 16);
});

test("conformanceCheck: 一致通过 / 篡改失败", () => {
  const items = [{ type: "doc", source: "web", data: { q: "a" } }, { type: "tool", source: "shell", data: { r: 1 } }];
  const m = createHandoffManifest(items);
  const pass = conformanceCheck(m, items);
  assert.equal(pass.ok, true, "一致应通过");
  assert.equal(pass.mismatches.length, 0);

  const tampered = items.map((x, i) => (i === 0 ? { ...x, data: { q: "CHANGED" } } : x));
  const fail = conformanceCheck(m, tampered);
  assert.equal(fail.ok, false, "数据被篡改应失败");
  assert.ok(fail.mismatches.length >= 1);
});

test("createGoalBoard: 全生命周期 + 看板渲染", () => {
  const board = createGoalBoard();
  board.addGoal({ id: "g1", title: "修复登录", priority: "P0", status: "in_progress" });
  board.addGoal({ id: "g2", title: "写文档", priority: "P2" });
  board.addGoal({ id: "g3", title: "性能优化", priority: "P1" });
  assert.equal(board.get("g2").status, "pending", "默认 pending");
  board.updateStatus("g2", "done");
  assert.equal(board.get("g2").status, "done");
  assert.throws(() => board.updateStatus("g2", "nonsense"), "非法状态抛错");

  const list = board.list();
  assert.equal(list[0].id, "g1", "按 P0>P1>P2 排序");
  assert.equal(list[1].id, "g3");
  assert.equal(list[2].id, "g2");

  const text = board.render();
  assert.ok(text.includes("# 目标看板"), "渲染标题");
  assert.ok(text.includes("P0") && text.includes("P1") && text.includes("P2"), "含优先级标签");
  assert.ok(text.includes("修复登录"), "含目标标题");
  assert.ok(text.includes("in_progress"), "含状态");
});
