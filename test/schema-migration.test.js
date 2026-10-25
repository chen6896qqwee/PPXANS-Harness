// test/schema-migration.test.js - 数据文件 schema 版本 + 迁移钩子
// 覆盖: 基线兼容 / 版本标记 / 迁移链执行 / 无迁移安全跳过 / 数据文件保持纯数组 (读取方无感)
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSchema, writeSchema, migrateData, registerMigration, SCHEMA_BASE_VERSION } from "../src/utils/schema.js";
import { FactStore, FACTS_SCHEMA_VERSION } from "../src/memory/fact-store.js";
import { SceneStore, SCENES_SCHEMA_VERSION } from "../src/memory/l2.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-schema-"));
}

test("无 .schema 文件的历史数据视为基线 v1", () => {
  const dir = tmpDir();
  const file = path.join(dir, "data.json");
  fs.writeFileSync(file, JSON.stringify([{ id: 1 }]), "utf8");
  assert.equal(readSchema(file), SCHEMA_BASE_VERSION);
});

test("writeSchema 原子写版本, readSchema 读回", () => {
  const dir = tmpDir();
  const file = path.join(dir, "data.json");
  writeSchema(file, "test", 3);
  assert.equal(readSchema(file), 3);
  const meta = JSON.parse(fs.readFileSync(file + ".schema", "utf8"));
  assert.equal(meta.name, "test");
  assert.equal(meta.version, 3);
});

test("migrateData 沿迁移链逐级推进并写回数据", () => {
  const dir = tmpDir();
  const file = path.join(dir, "data.json");
  fs.writeFileSync(file, JSON.stringify([{ id: 1, name: "a" }]), "utf8");
  registerMigration("chain-test", 1, 2, (data) => data.map((x) => ({ ...x, v2: true })));
  registerMigration("chain-test", 2, 3, (data) => data.map((x) => ({ ...x, v3: true })));

  const r = migrateData({ file, name: "chain-test", data: [{ id: 1, name: "a" }], currentVersion: 3 });
  assert.equal(r.from, 1);
  assert.deepEqual(r.applied.map((a) => a.to), [2, 3]);
  assert.equal(r.data[0].v2, true);
  assert.equal(r.data[0].v3, true);
  // 磁盘已写回 + 版本已推进
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk[0].v3, true);
  assert.equal(readSchema(file), 3);
});

test("migrateData 无迁移函数时安全跳过 (数据原样, 版本标记到目标)", () => {
  const dir = tmpDir();
  const file = path.join(dir, "data.json");
  const orig = [{ id: 1 }];
  fs.writeFileSync(file, JSON.stringify(orig), "utf8");
  const r = migrateData({ file, name: "no-mig", data: orig, currentVersion: 5 });
  assert.equal(r.from, 1);
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].note, "no-migration");
  assert.deepEqual(r.data, orig, "数据不应被改动");
  assert.equal(readSchema(file), 5);
});

test("迁移幂等: 已到目标版本再跑不重复执行", () => {
  const dir = tmpDir();
  const file = path.join(dir, "data.json");
  fs.writeFileSync(file, JSON.stringify([{ id: 1 }]), "utf8");
  registerMigration("idem-test", 1, 2, (data) => data.map((x) => ({ ...x, once: true })));
  const r1 = migrateData({ file, name: "idem-test", data: [{ id: 1 }], currentVersion: 2 });
  const r2 = migrateData({ file, name: "idem-test", data: r1.data, currentVersion: 2 });
  assert.equal(r1.applied.length, 1);
  assert.equal(r2.applied.length, 0, "二次迁移不应执行");
  assert.equal(readSchema(file), 2);
});

test("registerMigration 拒绝跳级/冲突注册", () => {
  assert.throws(() => registerMigration("bad-1", 3, 2, () => []), /非法迁移/);
  registerMigration("dup-test", 1, 2, (d) => d);
  assert.throws(() => registerMigration("dup-test", 1, 3, (d) => d), /冲突/);
});

test("FactStore 构造: 旧纯数组数据自动标记 schema 版本, 文件保持数组格式", () => {
  const dir = tmpDir();
  const store = new FactStore(dir, {});
  store.add("老数据", { source: "test" });
  // 数据文件仍是纯数组 (healer/外部读取者无感)
  const raw = JSON.parse(fs.readFileSync(store.file, "utf8"));
  assert.ok(Array.isArray(raw), "facts.json 必须保持纯数组");
  assert.equal(readSchema(store.file), FACTS_SCHEMA_VERSION);
});

test("SceneStore 构造: 兼容并标记 schema 版本", () => {
  const dir = tmpDir();
  const store = new SceneStore(dir);
  store.create({ name: "测试场景", keywords: ["测试"] });
  const raw = JSON.parse(fs.readFileSync(store.file, "utf8"));
  assert.ok(Array.isArray(raw), "scenes.json 必须保持纯数组");
  assert.equal(readSchema(store.file), SCENES_SCHEMA_VERSION);
});
