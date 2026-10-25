// test/fixes-2026-09-18b.test.js - 第二轮体检修复回归
// 覆盖: runDag executor 异常不崩进程 / runtime-bus "*" 通配分发 / command 超时定时器清理 /
//       circuit-breaker half_open 探测超时兜底 / repo_map 路径防护
import test from "node:test";
import assert from "node:assert";
import { runDag } from "../src/orchestrator/dag.js";
import RuntimeBus from "../src/bus/runtime-bus.js";
import { CircuitBreaker } from "../src/bus/circuit-breaker.js";
import { registerV3Tools } from "../src/tools/v3.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- 1. runDag: executor 抛错 → 错误入结果, 不产生 unhandled rejection, 下游可感知 ----
test("runDag: executor 异常被捕获, 错误文本作为节点结果且下游继续执行", async () => {
  const graph = {
    nodes: [
      { id: "a", task: "会失败" },
      { id: "b", task: "下游", dependsOn: ["a"] },
      { id: "c", task: "独立" },
    ],
  };
  const { results, order } = await runDag(graph, async (id, node, deps) => {
    if (id === "a") throw new Error("boom");
    return Object.keys(deps).length ? `got:[${Object.entries(deps).map(([k, v]) => k + "=" + v).join(",")}]` : node.task;
  }, {});
  assert.match(results.a, /\[执行失败\] boom/);
  assert.match(results.b, /a=\[执行失败\] boom/);
  assert.equal(results.c, "独立");
  assert.equal(order.length, 3, "所有节点均完成");
});

// ---- 2. runtime-bus: on("*") 通配订阅能收到所有事件, off 可退订 ----
test("runtime-bus: on('*') 通配分发 + off 退订", () => {
  const bus = new RuntimeBus();
  const seen = [];
  const off = bus.on("*", (ev) => seen.push(ev.type));
  bus.emit("alpha", {});
  bus.emit("beta", {});
  off();
  bus.emit("gamma", {});
  assert.deepEqual(seen, ["alpha", "beta"], "通配订阅者收到精确事件, off 后不再收");
  // 精确订阅不受影响
  const hits = [];
  bus.on("alpha", () => hits.push(1));
  bus.emit("alpha", {});
  assert.equal(hits.length, 1);
});

// ---- 3. runtime-bus: command 超时路径 + 完成后不挂定时器 ----
test("runtime-bus: command 超时返回 command-timeout, 快速完成不等待 timeoutMs", async () => {
  const bus = new RuntimeBus();
  // 超时路径: handler 永不完成
  bus.register("slow", () => new Promise(() => {}));
  const t0 = Date.now();
  const r = await bus.command("slow", {}, { timeoutMs: 30 });
  assert.equal(r.ok, false);
  assert.equal(r.error, "command-timeout");
  assert.ok(Date.now() - t0 < 1000, "超时按期返回");
  // 无 handler 立即短路
  const r2 = await bus.command("nope", {}, { timeoutMs: 5000 });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /no-command-handler/);
});

// ---- 4. circuit-breaker: half_open 探测未回报时, 冷却期后允许重新探测 ----
test("circuit-breaker: half_open 探测无回报不永久卡死 (reprobe 兜底)", async () => {
  const cb = new CircuitBreaker({ threshold: 1, windowMs: 60000, cooldownMs: 5, failPolicy: "fail-closed" });
  cb.after(false);
  assert.equal(cb.state, "open");
  await new Promise((r) => setTimeout(r, 10));
  const v1 = cb.before();
  assert.equal(v1.probe, true);
  assert.equal(cb.state, "half_open");
  // 探测方"失忆", 不调用 after(); 冷却期 (5ms) 过后应允许重新探测而非永久全拒绝
  await new Promise((r) => setTimeout(r, 10));
  const v2 = cb.before();
  assert.equal(v2.allowed, true, "超时后重新放行探测");
  assert.equal(v2.probe, true);
  assert.equal(v2.reprobe, true);
  // 冷却期内仍然只放一个探测
  const v3 = cb.before();
  assert.equal(v3.allowed, false);
  assert.equal(v3.reason, "circuit-half-open");
});

// ---- 5. repo_map: 越界路径拒绝, 正常路径不受影响 ----
test("repo_map: 绝对路径/.. 穿越被 safePath 拒绝", async () => {
  const registered = [];
  const catalog = { register: (t) => registered.push(t) };
  registerV3Tools(catalog, { rootDir: ROOT, agent: null });
  const repoMap = registered.find((t) => t.name === "repo_map");
  assert.ok(repoMap, "repo_map 已注册");
  const out1 = JSON.parse(await repoMap.execute({ root: "C:\\Windows" }));
  assert.ok(out1.error && /路径被拒绝/.test(out1.error), "绝对路径越界拒绝");
  const out2 = JSON.parse(await repoMap.execute({ root: "../../" }));
  assert.ok(out2.error && /路径被拒绝/.test(out2.error), ".. 穿越拒绝");
  const out3 = JSON.parse(await repoMap.execute({ root: "src" }));
  assert.ok(!out3.error && out3.stats, "工作区内正常路径可用");
});
