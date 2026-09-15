// test/asset-hub.test.js - P3⑩: 记忆资产中枢 (TencentDB Memory Asset 思想, 自研)
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssetHub, VISIBILITY } from "../src/memory/asset-hub.js";

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-asset-")); }

test("asset: 登记资产并持久化", () => {
  const dir = tmpDir();
  const hub = new AssetHub(dir);
  const a = hub.register({ name: "公司制度", kind: "document", scope: "company", owner: "me" });
  assert.ok(a.id);
  assert.equal(a.visibility, VISIBILITY.PRIVATE, "默认私有");
  assert.equal(a.version, 1);
  assert.equal(a.uses, 0);

  const hub2 = new AssetHub(dir);
  assert.equal(hub2.list().length, 1, "重启后仍在");
  assert.equal(hub2.list()[0].name, "公司制度");
});

test("asset: 软删 + 恢复", () => {
  const hub = new AssetHub(tmpDir());
  const a = hub.register({ name: "临时资产" });
  assert.equal(hub.remove(a.id), true);
  assert.equal(hub.list().length, 0, "软删后默认隐藏");
  assert.equal(hub.list({ includeDeleted: true }).length, 1, "可查软删");
  assert.equal(hub.restore(a.id), true);
  assert.equal(hub.list().length, 1, "恢复后可见");
});

test("asset: equip 记录使用次数", () => {
  const hub = new AssetHub(tmpDir());
  const a = hub.register({ name: "量化策略" });
  hub.equip(a.id);
  hub.equip(a.id);
  const got = hub.get(a.id);
  assert.equal(got.uses, 2);
  assert.equal(hub.stats().totalUses, 2);
});

test("asset: availableFor 过滤 (owner 私有 + team 共享)", () => {
  const hub = new AssetHub(tmpDir());
  hub.register({ name: "我的私有", owner: "alice", visibility: "private" });
  hub.register({ name: "团队共享", owner: "bob", visibility: "team" });
  hub.register({ name: "别人私有", owner: "bob", visibility: "private" });

  const mine = hub.availableFor({ owner: "alice" });
  const names = mine.map((a) => a.name);
  assert.ok(names.includes("我的私有"));
  assert.ok(names.includes("团队共享"), "团队资产共享");
  assert.ok(!names.includes("别人私有"), "别人私有不可见");
});

test("asset: renderAvailable 空返回空串", () => {
  const hub = new AssetHub(tmpDir());
  assert.equal(hub.renderAvailable(), "");
});

test("asset: renderAvailable 有资产返回清单", () => {
  const hub = new AssetHub(tmpDir());
  hub.register({ name: "公司制度", kind: "document", scope: "company" });
  const s = hub.renderAvailable();
  assert.ok(s.includes("公司制度"));
  assert.ok(s.includes("[document]"));
  assert.ok(s.includes("scope:company"));
});

test("asset: stats 统计", () => {
  const hub = new AssetHub(tmpDir());
  hub.register({ name: "a", kind: "document" });
  hub.register({ name: "b", kind: "skill" });
  hub.register({ name: "c", kind: "document" });
  const s = hub.stats();
  assert.equal(s.total, 3);
  assert.equal(s.active, 3);
  assert.deepEqual(s.byKind, { document: 2, skill: 1 });
});

test("asset: 非法注册抛错", () => {
  const hub = new AssetHub(tmpDir());
  assert.throws(() => hub.register({}), /name/);
});

test("asset: 删除不存在的资产返回 false", () => {
  const hub = new AssetHub(tmpDir());
  assert.equal(hub.remove("nope"), false);
});
