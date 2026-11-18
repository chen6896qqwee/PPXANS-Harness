// test/failure-episode.test.js - P1⑥: 故障记忆 (ReLoop/Vial 思想, 自研)
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FailureEpisodeStore } from "../src/memory/failure-episode.js";

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-fe-")); }

test("fe: 记录失败 episode 并持久化", () => {
  const dir = tmpDir();
  const store = new FailureEpisodeStore(dir);
  const e = store.record({
    tool: "http_request",
    error: "ECONNREFUSED 连接被拒绝",
    category: "network",
    rootCause: "目标服务未启动",
    fix: "先启动服务再重试",
    confidence: 0.9,
  });
  assert.ok(e.id);
  assert.equal(e.category, "network");
  assert.equal(e.traceRef, null);
  assert.equal(store.stats().total, 1);

  const store2 = new FailureEpisodeStore(dir);
  assert.equal(store2.stats().total, 1, "重启后仍在");
});

test("fe: 非法类别回退 unknown", () => {
  const dir = tmpDir();
  const store = new FailureEpisodeStore(dir);
  const e = store.record({ tool: "x", error: "y", category: "bogus" });
  assert.equal(e.category, "unknown");
});

test("fe: 相似故障检索按工具+错误文本排序, 命中计数", () => {
  const dir = tmpDir();
  const store = new FailureEpisodeStore(dir);
  store.record({ tool: "http_request", error: "ECONNREFUSED 连接被拒绝", fix: "起服务" });
  store.record({ tool: "read_file", error: "ENOENT 文件不存在", fix: "检查路径" });
  store.record({ tool: "http_request", error: "ETIMEDOUT 请求超时", fix: "加大超时" });

  const hits = store.search({ tool: "http_request", error: "ECONNREFUSED 连接被拒绝", limit: 2 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].tool, "http_request", "同工具强信号优先");
  assert.ok(hits[0].score >= 0.5);
  // 命中计数已写回
  const store2 = new FailureEpisodeStore(dir);
  assert.ok(store2.stats().totalHits >= 1, "命中次数被记录");
});

test("fe: 无关错误不命中 (低分过滤)", () => {
  const dir = tmpDir();
  const store = new FailureEpisodeStore(dir);
  store.record({ tool: "http_request", error: "ECONNREFUSED 连接被拒绝" });
  const hits = store.search({ error: "红烧肉怎么做", minScore: 0.3 });
  assert.equal(hits.length, 0);
});

test("fe: fixRate 统计", () => {
  const dir = tmpDir();
  const store = new FailureEpisodeStore(dir);
  store.record({ tool: "a", error: "e1", fix: "修复方案" });
  store.record({ tool: "b", error: "e2" }); // 无 fix
  const s = store.stats();
  assert.equal(s.total, 2);
  assert.equal(s.withFix, 1);
  assert.equal(s.fixRate, "50.0%");
  assert.deepEqual(s.byCategory, { unknown: 2 });
});

test("fe: 容量保护裁剪最旧", () => {
  const dir = tmpDir();
  const store = new FailureEpisodeStore(dir, { maxEpisodes: 3 });
  for (let i = 0; i < 5; i++) store.record({ tool: "t" + i, error: "e" + i });
  assert.equal(store.stats().total, 3);
  // 新记录 unshift 在前, 保留最新 t4/t3/t2, 裁剪最旧 t1/t0
  assert.ok(!store.list().some((e) => e.tool === "t1" || e.tool === "t0"), "最旧被裁剪");
  assert.ok(store.list().some((e) => e.tool === "t4"));
});

test("fe: clear 清空", () => {
  const dir = tmpDir();
  const store = new FailureEpisodeStore(dir);
  store.record({ tool: "a", error: "e" });
  store.clear();
  assert.equal(store.stats().total, 0);
});
