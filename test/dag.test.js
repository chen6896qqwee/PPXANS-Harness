// test/dag.test.js - 军团 DAG 任务编排
import test from "node:test";
import assert from "node:assert";
import { topoLevels, runDag } from "../src/orchestrator/dag.js";

test("topoLevels: 拓扑分层 (同层可并行)", () => {
  const levels = topoLevels([
    { id: "a" },
    { id: "b", dependsOn: ["a"] },
    { id: "c", dependsOn: ["a"] },
    { id: "d", dependsOn: ["b", "c"] },
  ]);
  assert.deepEqual(levels, [["a"], ["b", "c"], ["d"]]);
});

test("topoLevels: 检测环", () => {
  assert.throws(() => topoLevels([
    { id: "a", dependsOn: ["b"] },
    { id: "b", dependsOn: ["a"] },
  ]), /环/);
});

test("runDag: 依赖数据流 + 拓扑执行顺序", async () => {
  const graph = {
    nodes: [
      { id: "a", task: "取A" },
      { id: "b", task: "取B", dependsOn: ["a"] },
      { id: "c", task: "取C", dependsOn: ["a"] },
      { id: "d", task: "汇总", dependsOn: ["b", "c"] },
    ],
  };
  const { results, order } = await runDag(graph, async (id, node, deps) => {
    if (id === "a") return "A";
    if (id === "b") return "B" + deps.a;      // BA
    if (id === "c") return "C" + deps.a;      // CA
    if (id === "d") return deps.b + deps.c;   // BACA
  });
  assert.equal(results.a, "A");
  assert.equal(results.b, "BA");
  assert.equal(results.c, "CA");
  assert.equal(results.d, "BACA", "下游节点应拿到上游结果");
  // 拓扑序: a 最先, d 最后, b/c 在中间 (同层顺序不保证)
  assert.equal(order[0], "a");
  assert.equal(order[order.length - 1], "d");
  assert.equal(new Set(order).size, 4);
});

test("runDag: concurrency 限流 (层内并发不超过上限)", async () => {
  const graph = {
    nodes: [
      { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" },
    ],
  };
  let active = 0, peak = 0, calls = 0;
  const { results } = await runDag(graph, async (id) => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--; calls++;
    return id;
  }, { concurrency: 2 });
  assert.equal(calls, 4, "全部节点执行");
  assert.ok(peak <= 2, `并发峰值 ${peak} <= 2`);
  assert.deepEqual(Object.keys(results).sort(), ["a", "b", "c", "d"]);
});

test("runDag: concurrency 缺省时不限流 (兼容旧调用)", async () => {
  const graph = { nodes: [{ id: "a" }, { id: "b" }, { id: "c" }] };
  let peak = 0, active = 0;
  await runDag(graph, async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 3)); active--; }, {});
  assert.equal(peak, 3, "层内 3 节点全部并行");
});
