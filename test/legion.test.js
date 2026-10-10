// test/legion.test.js - 军团测试
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Legion } from "../src/orchestrator/index.js";

// 数据隔离 (2026-10-09): 派生的 worker 子进程默认往 <项目>/data 写记忆/日志/看板,
// 跑一次本测试就污染生产数据目录 (实测 10 个文件)。改为每个军团给独立临时目录。
function tmpData() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-legion-"));
  return { dataDir: d, globalDataDir: d };
}
// 统一入口: 不让任何一个 spawnAgent 落到默认目录
function spawn(l, name) { return l.spawnAgent(name, tmpData()); }

test("军团: 启动多 agent + ping", async () => {
  const legion = new Legion();
  spawn(legion, "侦察兵");
  spawn(legion, "分析员");
  assert.equal(legion.list().length, 2);
  const r = await legion.send("侦察兵", { type: "ping" });
  assert.equal(r.type, "pong");
  await legion.shutdownAll();
});

test("军团: 并行 broadcast", async () => {
  const legion = new Legion();
  spawn(legion, "a1");
  spawn(legion, "a2");
  const results = await legion.broadcast("ping", "hi");
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.type === "pong" || r.type === "error"));
  await legion.shutdownAll();
});

test("军团: 角色分工 dispatch", async () => {
  const legion = new Legion();
  spawn(legion, "a1");
  spawn(legion, "a2");
  // 用 ping 验证派发路由 (不触发真实 LLM, 避免无 key 环境等网络超时)
  const results = await legion.dispatch("ping", ["任务1", "任务2"]);
  assert.equal(results.length, 2);
  assert.ok(results[0].agent && results[1].agent);
  assert.equal(results[0].type, "pong");
  assert.equal(results[1].type, "pong");
  await legion.shutdownAll();
});