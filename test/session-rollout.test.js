// test/session-rollout.test.js - JSONL rollout 持久化 / fork / rewind 测试
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Rollout } from "../src/session/rollout.js";

test("append/load 往返, 每行带 ts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-rollout-"));
  Rollout.append(dir, "s1", { seq: 1, type: "message", payload: "a" });
  Rollout.append(dir, "s1", { seq: 2, type: "message", payload: "b" });
  const items = Rollout.load(dir, "s1");
  assert.equal(items.length, 2);
  assert.equal(items[0].seq, 1);
  assert.equal(items[0].payload, "a");
  assert.ok(items[0].ts, "追加行带 ts");
  assert.equal(items[1].payload, "b");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("append: 目录不存在先建", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-rollout-"));
  const nested = path.join(dir, "deep", "sub");
  Rollout.append(nested, "s1", { seq: 1, type: "m", payload: 1 });
  assert.ok(fs.existsSync(path.join(nested, "s1.rollout.jsonl")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fork 复制 seq<=uptoSeq 到新会话文件", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-rollout-"));
  for (let i = 1; i <= 5; i++) Rollout.append(dir, "src", { seq: i, type: "m", payload: i });
  Rollout.fork(dir, "src", "dst", 3);
  const d = Rollout.load(dir, "dst");
  assert.equal(d.length, 3);
  assert.equal(d[0].seq, 1);
  assert.equal(d[2].seq, 3);
  // 源不被改动
  assert.equal(Rollout.load(dir, "src").length, 5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rewind 删除 seq>uptoSeq (tmp+rename, tmp 已清理)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-rollout-"));
  for (let i = 1; i <= 5; i++) Rollout.append(dir, "s1", { seq: i, type: "m", payload: i });
  const kept = Rollout.rewind(dir, "s1", 2);
  assert.equal(kept.length, 2);
  const items = Rollout.load(dir, "s1");
  assert.equal(items.length, 2);
  assert.equal(items[1].seq, 2);
  assert.ok(!fs.existsSync(Rollout._file(dir, "s1") + ".tmp"), "tmp 已清理");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("load 不存在的会话返回空数组", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-rollout-"));
  assert.deepEqual(Rollout.load(dir, "nope"), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
