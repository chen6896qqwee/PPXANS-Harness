// test/fact-wal.test.js - FactStore WAL 增量落盘
// 覆盖: 增量追加 (主文件不每次全量写) / 阈值 compact / 崩溃恢复重放 / 重放幂等 / 全部变更操作走 WAL
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FactStore } from "../src/memory/fact-store.js";
import { walFileOf } from "../src/utils/wal.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-wal-"));
}

test("wal 默认关闭: 每次变更立即全量落盘 (兼容旧行为)", () => {
  const dir = tmpDir();
  const store = new FactStore(dir, {});
  store.add("事实A", { source: "test" });
  const raw = JSON.parse(fs.readFileSync(store.file, "utf8"));
  assert.equal(raw.length, 1);
  assert.ok(!fs.existsSync(walFileOf(store.file)), "默认不产生 WAL 文件");
});

test("wal 开启: 主文件延迟落盘, WAL 记录增量", () => {
  const dir = tmpDir();
  const store = new FactStore(dir, { wal: true, walThreshold: 100 });
  store.add("事实A", { source: "test" });
  store.add("事实B", { source: "test" });
  // 未达阈值: 主文件不更新, WAL 有两行
  const raw = JSON.parse(fs.readFileSync(store.file, "utf8"));
  assert.equal(raw.length, 0, "未 compact 前主文件保持初始快照");
  const walLines = fs.readFileSync(walFileOf(store.file), "utf8").trim().split("\n");
  assert.equal(walLines.length, 2);
  // 显式 flush: 全量落盘 + 清 WAL
  store.flush();
  const after = JSON.parse(fs.readFileSync(store.file, "utf8"));
  assert.equal(after.length, 2);
  assert.ok(!fs.existsSync(walFileOf(store.file)), "flush 后 WAL 清空");
});

test("wal 开启: 达阈值自动 compact", () => {
  const dir = tmpDir();
  const store = new FactStore(dir, { wal: true, walThreshold: 3 });
  store.add("事实A", { source: "test" });
  store.add("事实B", { source: "test" });
  // 3 条变更: add A (1) + add B (2) 未到 3; 第三条触发
  store.add("事实C", { source: "test" });
  const raw = JSON.parse(fs.readFileSync(store.file, "utf8"));
  assert.equal(raw.length, 3, "达阈值应自动 compact 全量落盘");
  assert.ok(!fs.existsSync(walFileOf(store.file)), "compact 后 WAL 清空");
});

test("崩溃恢复: 新实例重放 WAL 恢复全部变更", () => {
  const dir = tmpDir();
  const store = new FactStore(dir, { wal: true, walThreshold: 100 });
  store.add("事实A", { source: "test" });
  store.add("事实B", { source: "test" });
  const f = store.add("事实C", { source: "test" });
  store.hit(f.id);
  // 模拟崩溃: 不 flush 直接开新实例 (走 WAL 重放)
  const store2 = new FactStore(dir, { wal: true, walThreshold: 100 });
  assert.equal(store2.countLive(), 3, "重放后应恢复 3 条事实");
  assert.equal(store2.query("事实C")[0].hits, 1, "hit 变更应重放");
  // 重放后构造末尾 save() 落盘并清 WAL
  assert.ok(!fs.existsSync(walFileOf(store.file)), "重放后 WAL 清空");
  const onDisk = JSON.parse(fs.readFileSync(store.file, "utf8"));
  assert.equal(onDisk.length, 3);
});

test("崩溃恢复: 半行 WAL (中断写入) 静默丢弃, 不阻塞重放", () => {
  const dir = tmpDir();
  const store = new FactStore(dir, { wal: true, walThreshold: 100 });
  store.add("完整事实", { source: "test" });
  // 手动追加一条被截断的事件 (模拟写一半崩溃)
  fs.appendFileSync(walFileOf(store.file), '{"op":"upsert","fact":{"id":"f_broken","content":"未完成', "utf8");
  const store2 = new FactStore(dir, { wal: true, walThreshold: 100 });
  assert.equal(store2.countLive(), 1, "半行事件丢弃, 完整事件恢复");
  assert.equal(store2.query("完整事实").length, 1);
});

test("重放幂等: flush 后崩溃再重放不产生重复", () => {
  const dir = tmpDir();
  const store = new FactStore(dir, { wal: true, walThreshold: 3 });
  store.add("事实A", { source: "test" });
  store.add("事实B", { source: "test" });
  store.add("事实C", { source: "test" }); // 触发 compact, WAL 清空
  store.add("事实D", { source: "test" }); // 新 WAL
  // 此刻磁盘有 A/B/C, WAL 有 D。若崩溃后重放: D 恢复, A/B/C 不重复
  const store2 = new FactStore(dir, { wal: true, walThreshold: 3 });
  assert.equal(store2.countLive(), 4);
  const contents = store2.list().map((f) => f.content);
  assert.equal(new Set(contents).size, 4, "无重复事实");
});

test("wal 模式: 软删/回滚/更新/裁剪全部走增量, 重放后一致", () => {
  const dir = tmpDir();
  const store = new FactStore(dir, { wal: true, walThreshold: 100 });
  const a = store.add("要删除的事实", { source: "test" });
  const b = store.add("要更新的事实", { source: "test" });
  store.forget(a.id, { reason: "测试" });
  store.update(b.id, "更新后的事实（新内容）");
  // 崩溃重放
  const store2 = new FactStore(dir, { wal: true, walThreshold: 100 });
  assert.equal(store2.countLive(), 1, "软删后仅剩 1 条");
  assert.equal(store2.deletedList().length, 1);
  assert.equal(store2.query("新内容").length, 1, "更新内容生效");
  const top = store2.list()[0];
  assert.equal(top.content, "更新后的事实（新内容）");
  assert.ok(top.prevId, "版本链 prevId 应指向 archived");
  assert.equal(top.prevId, store2.facts.find((f) => f.status === "archived")?.id, "prevId 指向 archived 旧版");
});

test("wal 模式: importAll merge/replace 重放一致", () => {
  const dir = tmpDir();
  const store = new FactStore(dir, { wal: true, walThreshold: 100 });
  store.importAll([{ content: "导入甲" }, { content: "导入乙" }], { mode: "merge" });
  const store2 = new FactStore(dir, { wal: true, walThreshold: 100 });
  assert.ok(store2.query("导入甲").some((f) => f.content === "导入甲"), "导入甲应可检索");
  assert.ok(store2.query("导入乙").some((f) => f.content === "导入乙"), "导入乙应可检索");

  store2.importAll([{ content: "替换丙" }], { mode: "replace" });
  const store3 = new FactStore(dir, { wal: true, walThreshold: 100 });
  assert.equal(store3.countLive(), 1, "replace 整体替换");
  assert.equal(store3.query("替换丙").length, 1);
  assert.equal(store3.query("导入甲").length, 0);
});

test("wal 与文件锁共存: 多次变更后事实完整 (无覆盖丢失)", () => {
  const dir = tmpDir();
  const store = new FactStore(dir, { wal: true, walThreshold: 7 });
  for (let i = 0; i < 20; i++) store.add(`事实编号${i}`, { source: "bulk" });
  const store2 = new FactStore(dir, { wal: true, walThreshold: 7 });
  assert.equal(store2.countLive(), 20);
});
