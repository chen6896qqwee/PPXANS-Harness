// test/legion-governor.test.js - Legion 挂接 ConcurrencyGovernor (2026-10-31 一期)
// 覆盖: .governor 字段与 spawnAgents 方法存在 (接通 delegate.js/team-room.js 预留口);
//       整批 spawn 走许可; 复用进程不占新许可; 缺 name 拒绝。
//       spawn 本体用 stub 替换 —— 不真起子进程 (离线且快)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Legion } from "../src/orchestrator/legion.js";
import { getGovernor } from "../src/orchestrator/governor.js";

test("Legion: .governor 挂接 + spawnAgents 方法存在 (接通预留调用口)", () => {
  const L = new Legion();
  assert.ok(L.governor, "此前 governor 写好了却没挂上, spawn 绕过配额");
  assert.equal(L.governor, getGovernor(), "与 orchestration.js 统计视图同一单例");
  assert.equal(typeof L.spawnAgents, "function", "delegate.js:202 / team-room.js:89 的 typeof 检查从恒 false 变为可用");
});

test("spawnAgents: 逐个 acquire 许可并 spawn, stub spawnAgent 被调用", async () => {
  const L = new Legion();
  const spawned = [];
  L.spawnAgent = (name, opts) => { spawned.push([name, opts]); return { proc: null }; };
  const r = await L.spawnAgents([
    { name: "a", opts: { env: { PPX_AGENT_READONLY: "1" } } },
    { name: "b", opts: null },
  ]);
  assert.deepEqual(spawned.map((x) => x[0]), ["a", "b"]);
  assert.equal(spawned[0][1].env.PPX_AGENT_READONLY, "1", "opts 原样透传");
  assert.ok(r.every((x) => x.ok));
});

test("spawnAgents: 已存在的稳定名 (team-room 复用场景) 不重复 spawn 不占新许可", async () => {
  const L = new Legion();
  L.agents.set("room1_coder", { proc: { once() {} }, pending: new Map(), counter: 0 });
  L.spawnAgent = () => { throw new Error("复用场景不应再 spawn"); };
  const r = await L.spawnAgents([{ name: "room1_coder", opts: {} }]);
  assert.equal(r[0].ok, true);
  assert.equal(r[0].reused, true);
});

test("spawnAgents: 缺 name 返回 ok:false, 不抛 (编排不因单条坏 spec 中断)", async () => {
  const L = new Legion();
  L.spawnAgent = () => { throw new Error("不应被调到"); };
  const r = await L.spawnAgents([{ opts: {} }, null]);
  assert.equal(r[0].ok, false);
  assert.equal(r[1].ok, false);
});

test("spawnAgents: spawnAgent 抛错 → 该条 ok:false 且许可归还 (后续条目继续)", async () => {
  const L = new Legion();
  let calls = 0;
  L.spawnAgent = (name) => {
    calls++;
    if (name === "boom") throw new Error("spawn 失败");
    return { proc: null };
  };
  const r = await L.spawnAgents([{ name: "boom", opts: {} }, { name: "good", opts: {} }]);
  assert.equal(r[0].ok, false);
  assert.match(r[0].error, /spawn 失败/);
  assert.equal(r[1].ok, true);
  assert.equal(calls, 2, "坏一条不挡好一条");
});
