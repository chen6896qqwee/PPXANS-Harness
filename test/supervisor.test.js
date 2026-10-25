// test/supervisor.test.js - P3⑨: supervisor 编排模式 (LangGraph supervisor 拓扑思想, 自研)
import { test } from "node:test";
import assert from "node:assert";
import { findDisagreement, buildRevisionPrompt, withTimeout } from "../src/orchestrator/supervisor.js";

// ---- 分歧检测纯函数 ----
test("sup: 一致结果 → consensus 高, 不分歧", () => {
  const r = findDisagreement([
    { agent: "a", reply: "市场回调时先看情绪指标再决定" },
    { agent: "b", reply: "市场回调时应该先看情绪指标" },
  ]);
  assert.ok(r.consensus >= 0.5, "相似结果归一组");
  assert.equal(r.divergent, false);
  assert.equal(r.clusters.length, 1);
});

test("sup: 明显分歧 → divergent", () => {
  const r = findDisagreement([
    { agent: "a", reply: "应该买入" },
    { agent: "b", reply: "应该卖出" },
  ], { minConsensus: 0.6 });
  assert.equal(r.divergent, true, "分歧被识别");
  assert.ok(r.consensus < 0.6);
});

test("sup: 单结果不分歧", () => {
  const r = findDisagreement([{ agent: "a", reply: "唯一答案" }]);
  assert.equal(r.divergent, false);
  assert.equal(r.consensus, 1);
});

test("sup: 空/无回复过滤", () => {
  const r = findDisagreement([{ agent: "a", reply: "" }, { agent: "b", reply: "有内容" }]);
  assert.equal(r.divergent, false, "空回复被过滤");
});

test("sup: buildRevisionPrompt 带反馈修正", () => {
  const p = buildRevisionPrompt("写一份报告", ["缺少数据支撑", "结论不明确"]);
  assert.ok(p.includes("写一份报告"));
  assert.ok(p.includes("缺少数据支撑"));
  assert.ok(p.includes("结论不明确"));
  assert.ok(p.includes("监督者反馈"));
});

// ---- withTimeout ----
test("sup: withTimeout 正常完成清理定时器", async () => {
  const r = await withTimeout(Promise.resolve("ok"), 100, "t");
  assert.equal(r, "ok");
});

test("sup: withTimeout 超时拒绝", async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 20, "t"),
    /超时/
  );
});
