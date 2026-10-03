// test/legion.test.js - 军团测试
// 2026-10-03: 补 dataDir 隔离。原先 spawnAgent(name) 不传 dataDir, worker 子进程
//   退回默认 root(项目根) → dataDir = <root>/data, 于是把记忆库 / 审计链 / L3 画像 /
//   定时任务全写进**真实 data/**。实测 139 个测试文件中仅此一个会写脏生产目录。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Legion } from "../src/orchestrator/index.js";

function mkTmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-legion-${tag}-`));
}

// 每个 worker 独立 tmp 数据目录; 结束后关闭军团并清理
async function withLegion(names, fn) {
  const dirs = names.map((_, i) => mkTmp(`w${i}`));
  const legion = new Legion();
  names.forEach((n, i) => legion.spawnAgent(n, { dataDir: dirs[i] }));
  try {
    return await fn(legion);
  } finally {
    await legion.shutdownAll();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
}

test("军团: 启动多 agent + ping", async () => {
  await withLegion(["侦察兵", "分析员"], async (legion) => {
    assert.equal(legion.list().length, 2);
    const r = await legion.send("侦察兵", { type: "ping" });
    assert.equal(r.type, "pong");
  });
});

test("军团: 并行 broadcast", async () => {
  await withLegion(["a1", "a2"], async (legion) => {
    const results = await legion.broadcast("ping", "hi");
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.type === "pong" || r.type === "error"));
  });
});

test("军团: 角色分工 dispatch", async () => {
  await withLegion(["a1", "a2"], async (legion) => {
    // 用 ping 验证派发路由 (不触发真实 LLM, 避免无 key 环境等网络超时)
    const results = await legion.dispatch("ping", ["任务1", "任务2"]);
    assert.equal(results.length, 2);
    assert.ok(results[0].agent && results[1].agent);
    assert.equal(results[0].type, "pong");
    assert.equal(results[1].type, "pong");
  });
});
