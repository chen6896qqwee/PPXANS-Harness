// test/edit-snapshot.test.js — 快照与回滚单测
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Snapshot } from "../src/edit/snapshot.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-snap-"));
}

test("begin + rollback: 恢复被修改的文件", () => {
  const dir = tmpDir();
  const f = path.join(dir, "a.txt");
  fs.writeFileSync(f, "原始内容", "utf8");

  const snap = Snapshot.begin([f]);
  fs.writeFileSync(f, "被改坏了", "utf8");
  assert.equal(fs.readFileSync(f, "utf8"), "被改坏了");

  Snapshot.rollback(snap);
  assert.equal(fs.readFileSync(f, "utf8"), "原始内容");
});

test("begin + rollback: 删除运行期间新建的文件", () => {
  const dir = tmpDir();
  const f = path.join(dir, "new.txt");
  const snap = Snapshot.begin([f]); // 不存在 -> existed=false
  fs.writeFileSync(f, "新建内容", "utf8");
  assert.ok(fs.existsSync(f));

  Snapshot.rollback(snap);
  assert.equal(fs.existsSync(f), false);
});

test("begin + rollback: 目录不存在时先建目录再恢复", () => {
  const dir = tmpDir();
  const f = path.join(dir, "sub", "deep.txt");
  const snap = Snapshot.begin([f]);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "内容", "utf8");

  Snapshot.rollback(snap); // existed=false -> 删除新建文件
  assert.equal(fs.existsSync(f), false);
});

test("list: 返回快照内文件清单", () => {
  const dir = tmpDir();
  const f = path.join(dir, "x.txt");
  fs.writeFileSync(f, "x", "utf8");
  const snap = Snapshot.begin([f, path.join(dir, "missing.txt")]);
  const list = Snapshot.list(snap);
  assert.equal(list.length, 2);
  assert.ok(list.includes(f));
});

test("rollback 幂等: 多次回滚不报错", () => {
  const dir = tmpDir();
  const f = path.join(dir, "y.txt");
  fs.writeFileSync(f, "y", "utf8");
  const snap = Snapshot.begin([f]);
  fs.writeFileSync(f, "z", "utf8");
  Snapshot.rollback(snap);
  Snapshot.rollback(snap);
  assert.equal(fs.readFileSync(f, "utf8"), "y");
});
