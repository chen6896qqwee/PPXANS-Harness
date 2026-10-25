// test/memory-governance.test.js - 记忆治理测试 (合并 ppx-v2 能力)
// 覆盖: 软删/回滚 / 版本链 / TTL 归档 / 按层清理 / 导出导入 / L4 程序性记忆慢衰减
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FactStore, L4_DECAY_PER_DAY } from "../src/memory/fact-store.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-memgov-"));
}

test("forget/restore: 软删后检索不到, 回滚后恢复可见", () => {
  const store = new FactStore(tmpDir(), {});
  const f = store.add("老板偏好用中文回复", { importance: 15 });
  assert.equal(store.query("中文回复").length, 1);

  const del = store.forget(f.id, { reason: "测试" });
  assert.equal(del.status, "deleted");
  assert.equal(del.deleteReason, "测试");
  assert.equal(store.query("中文回复").length, 0, "软删后不应被检索到");
  assert.equal(store.countLive(), 0);
  assert.equal(store.count(), 1, "数据仍在 (可回滚)");
  assert.equal(store.deletedList().length, 1);

  store.restore(f.id);
  assert.equal(store.countLive(), 1);
  assert.equal(store.query("中文回复").length, 1, "回滚后应重新可见");
  assert.equal(store.deletedList().length, 0);
});

test("forget: 支持按内容定位, 且幂等", () => {
  const store = new FactStore(tmpDir(), {});
  store.add("记住：项目用零依赖纯 Node 实现");
  const a = store.forget("项目用零依赖纯 Node 实现", { reason: "r1" });
  assert.ok(a, "应能按内容命中");
  const b = store.forget("项目用零依赖纯 Node 实现", { reason: "r2" });
  assert.equal(b.deleteReason, "r1", "重复 forget 应幂等, 不覆盖原原因");
  assert.equal(store.deletedList().length, 1);
});

test("forget: 已软删记忆不拦截新写入", () => {
  const store = new FactStore(tmpDir(), {});
  const f = store.add("临时笔记", { importance: 5 });
  store.forget(f.id);
  const again = store.add("临时笔记", { importance: 9 });
  assert.notEqual(again.id, f.id, "已删条目不应触发去重命中");
  assert.equal(store.countLive(), 1);
});

test("update: 保留旧版为 archived 版本链", () => {
  const store = new FactStore(tmpDir(), {});
  const f = store.add("项目用 Node 实现", { importance: 10 });
  const updated = store.update(f.id, "项目用零依赖纯 Node 实现（Node>=20）");
  assert.equal(updated.id, f.id, "更新保持原 id");
  assert.ok(updated.prevId, "应挂上版本链");
  assert.match(updated.content, /Node>=20/);

  const raw = JSON.parse(fs.readFileSync(path.join(store.dir, "facts.json"), "utf8"));
  const archived = raw.filter((x) => x.status === "archived");
  assert.equal(archived.length, 1);
  assert.equal(archived[0].id, updated.prevId);
  assert.match(archived[0].content, /^项目用 Node 实现$/, "归档条目应保留旧内容");
  assert.equal(store.countLive(), 1, "归档条目不算有效记忆");
});

test("sweepExpired: 超过 TTL 的旧记忆被软归档 (可回滚)", () => {
  const dataDir = tmpDir();
  const store = new FactStore(dataDir, {});
  const fresh = store.add("刚记的事", { importance: 10 });
  const old = store.add("很久以前的事", { importance: 10 });

  // 手工把 old 的 lastAccess 推到 200 天前
  const f = path.join(dataDir, "memory", "facts.json");
  const arr = JSON.parse(fs.readFileSync(f, "utf8"));
  const target = arr.find((x) => x.id === old.id);
  target.lastAccess = new Date(Date.now() - 200 * 86400000).toISOString();
  fs.writeFileSync(f, JSON.stringify(arr, null, 2), "utf8");

  const store2 = new FactStore(dataDir, {});
  const r = store2.sweepExpired({ ttlDays: 90 });
  assert.equal(r.swept, 1, "仅旧的 1 条应被归档");
  const after = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.equal(after.find((x) => x.id === old.id).status, "deleted");
  assert.equal(after.find((x) => x.id === fresh.id).status, "active", "新记忆不应被误伤");
  assert.equal(store2.countLive(), 1);
});

test("sweepExpired: dryRun 只报告不改数据", () => {
  const dataDir = tmpDir();
  const store = new FactStore(dataDir, {});
  const old = store.add("陈年旧事", { importance: 10 });
  const f = path.join(dataDir, "memory", "facts.json");
  const arr = JSON.parse(fs.readFileSync(f, "utf8"));
  arr.find((x) => x.id === old.id).lastAccess = new Date(Date.now() - 500 * 86400000).toISOString();
  fs.writeFileSync(f, JSON.stringify(arr, null, 2), "utf8");

  const store2 = new FactStore(dataDir, {});
  const r = store2.sweepExpired({ ttlDays: 30, dryRun: true });
  assert.equal(r.swept, 1);
  assert.equal(r.dryRun, true);
  assert.equal(store2.countLive(), 1, "dryRun 不应改动数据");
});

test("clearLayer: 默认软删可回滚, hard=true 才物理删除", () => {
  const store = new FactStore(tmpDir(), {});
  store.add("一条事实记忆", { layer: 1 });
  store.add("另一条事实记忆", { layer: 1 });
  store.add("部署流程: 先自愈再发版", { layer: 4 });

  const soft = store.clearLayer(1);
  assert.equal(soft.affected, 2);
  assert.equal(soft.hard, false);
  assert.equal(store.countLive(), 1, "仅剩 L4 程序性记忆");
  assert.equal(store.stats().by_layer[4], 1);
  assert.equal(store.deletedList().length, 2);

  const hard = store.clearLayer(4, { hard: true });
  assert.equal(hard.affected, 1);
  assert.equal(store.count(), 2, "L4 被物理删除, 只剩 2 条软删的 L1");
});

test("exportAll/importAll: 导出可迁移, merge 模式按内容去重", () => {
  const src = new FactStore(tmpDir(), {});
  src.add("事实甲", { importance: 8 });
  src.add("事实乙", { importance: 6 });
  const gone = src.add("会被删的", { importance: 5 });
  src.forget(gone.id);

  const dump = src.exportAll();
  assert.equal(dump.count, 3, "默认含软删条目");
  assert.equal(dump.items.length, 3);

  const dst = new FactStore(tmpDir(), {});
  const r1 = dst.importAll(dump);
  assert.equal(r1.ok, true);
  assert.equal(r1.imported, 3);
  const r2 = dst.importAll(dump);
  assert.equal(r2.imported, 0, "重复导入应全部跳过");
  assert.equal(r2.skipped, 3);

  const dst2 = new FactStore(tmpDir(), {});
  const clean = src.exportAll({ includeDeleted: false });
  dst2.importAll(clean, { mode: "replace" });
  assert.equal(dst2.countLive(), 2, "replace 模式应整体替换");
});

test("importAll: 非法数据格式被拒绝", () => {
  const store = new FactStore(tmpDir(), {});
  assert.equal(store.importAll({ nope: 1 }).ok, false);
  assert.equal(store.importAll(null).ok, false);
});

test("L4 程序性记忆: 衰减远慢于 L1 事实", () => {
  const store = new FactStore(tmpDir(), {});
  const l1 = store.add("普通事实", { layer: 1 });
  const l4 = store.add("部署流程方法论", { layer: 4 });
  assert.equal(l1.layer, 1);
  assert.equal(l4.layer, 4);

  // 直接对比同分同天数下的衰减结果 (7 天: 高斯衰减下 L1 已明显掉分, L4 仍保留大部分)
  const days = 7;
  const scoreL1 = store._decay(100, days, 1);
  const scoreL4 = store._decay(100, days, 4);
  assert.ok(scoreL4 > scoreL1 * 1.5, `L4 衰减必须显著慢于 L1 (L1=${scoreL1}, L4=${scoreL4})`);
  assert.ok(scoreL4 > 70, `L4 七天衰减后应 >70, 实际 ${scoreL4}`);
  assert.ok(scoreL1 < 45, `L1 七天衰减后应明显降低, 实际 ${scoreL1}`);
  assert.ok(L4_DECAY_PER_DAY < 0.02);
});

test("stats: 报告 live/deleted/archived/by_layer", () => {
  const store = new FactStore(tmpDir(), {});
  const a = store.add("甲", { layer: 1 });
  store.add("乙", { layer: 4 });
  store.forget(a.id);
  const s = store.stats();
  assert.equal(s.total, 2);
  assert.equal(s.live, 1);
  assert.equal(s.deleted, 1);
  assert.equal(s.archived, 0);
  assert.equal(s.by_layer[1], 1);
  assert.equal(s.by_layer[4], 1);
});
