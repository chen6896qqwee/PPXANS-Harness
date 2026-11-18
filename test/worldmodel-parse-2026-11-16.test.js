// test/worldmodel-parse-2026-11-16.test.js — shell 效果提取 (纯函数)
// 边界: 只认简单命令; 通配符/变量/管道/子shell/后台符一律拒绝 (半模拟比不模拟更危险)。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseShellEffects } from "../src/worldmodel/index.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-wm-parse-"));
}
const ends = (p, tail) => path.resolve(p).toLowerCase().endsWith(tail.toLowerCase());

test("wm-parse: 空命令拒绝", () => {
  const r = parseShellEffects("   ");
  assert.equal(r.parseable, false);
  assert.match(r.reason, /空命令/);
});

test("wm-parse: rm -rf 递归删除, 多目标逐个入效果", () => {
  const cwd = tmp();
  try {
    const r = parseShellEffects("rm -rf build dist", { cwd });
    assert.equal(r.parseable, true);
    assert.equal(r.effects.length, 2);
    assert.equal(r.effects[0].type, "delete");
    assert.equal(r.effects[0].recursive, true);
    assert.ok(ends(r.effects[0].path, "build"));
    assert.ok(ends(r.effects[1].path, "dist"));
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("wm-parse: 引号路径保留空格", () => {
  const cwd = tmp();
  try {
    const r = parseShellEffects('rm "my file.txt"', { cwd });
    assert.equal(r.parseable, true);
    assert.ok(r.effects[0].path.endsWith("my file.txt"), r.effects[0].path);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("wm-parse: mv/cp 需要两个路径, cp 用写目标表达", () => {
  const cwd = tmp();
  try {
    const mv = parseShellEffects("mv a b", { cwd });
    assert.equal(mv.parseable, true);
    assert.equal(mv.effects[0].type, "move");
    assert.ok(ends(mv.effects[0].path, "a"));
    assert.ok(ends(mv.effects[0].to, "b"));
    const cp = parseShellEffects("cp a b", { cwd });
    assert.equal(cp.parseable, true);
    assert.equal(cp.effects[0].type, "write");
    assert.ok(ends(cp.effects[0].path, "b"));
    assert.ok(ends(cp.effects[0]._cpFrom, "a"));
    assert.equal(parseShellEffects("mv a", { cwd }).parseable, false);
    assert.equal(parseShellEffects("cp a", { cwd }).parseable, false);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("wm-parse: mkdir/touch/truncate/dd 的简单形态", () => {
  const cwd = tmp();
  try {
    const mk = parseShellEffects("mkdir -p a/b c", { cwd });
    assert.equal(mk.parseable, true);
    assert.equal(mk.effects.filter((e) => e.type === "mkdir").length, 2);
    const touch = parseShellEffects("touch a.txt", { cwd });
    assert.equal(touch.effects[0].type, "write");
    assert.equal(touch.effects[0]._touch, true);
    assert.equal(parseShellEffects("truncate -s 0 a.txt", { cwd }).effects[0].type, "write");
    assert.equal(parseShellEffects("truncate a.txt", { cwd }).parseable, false);
    assert.equal(parseShellEffects("dd if=a of=b", { cwd }).effects[0].type, "write");
    assert.equal(parseShellEffects("dd if=a", { cwd }).parseable, false);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("wm-parse: cd 链式改变相对路径基准", () => {
  const cwd = tmp();
  try {
    const r = parseShellEffects("cd sub && rm f", { cwd });
    assert.equal(r.parseable, true);
    assert.equal(r.segments, 2);
    assert.ok(ends(r.effects[0].path, path.join("sub", "f")));
    const r2 = parseShellEffects("cd a; cd b; rm f", { cwd });
    assert.ok(ends(r2.effects[0].path, path.join("a", "b", "f")));
    assert.equal(parseShellEffects("cd", { cwd }).parseable, false);
    assert.equal(parseShellEffects("cd a b", { cwd }).parseable, false);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("wm-parse: 换行/分号/&&/|| 都是合法分段符", () => {
  const cwd = tmp();
  try {
    const r = parseShellEffects("rm a\nrm b; rm c && rm d || rm e", { cwd });
    assert.equal(r.parseable, true);
    assert.equal(r.effects.length, 5);
    assert.equal(r.segments, 5);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("wm-parse: 通配符/变量/管道/后台/子shell/反引号一律拒绝", () => {
  for (const cmd of [
    "rm -rf *",
    "rm $(pwd)/x",
    "rm $HOME/x",
    "rm a | cat",
    "rm a &",
    "rm a `whoami`",
    "rm a > out",
    "find . -delete",
    "echo x && rm a",
  ]) {
    const r = parseShellEffects(cmd, { cwd: tmp() });
    assert.equal(r.parseable, false, `${cmd} 应拒绝`);
    assert.ok(r.reason, `${cmd} 应给原因`);
  }
});

test("wm-parse: 未知命令拒绝; 纯虚拟世界拒绝相对路径", () => {
  const cwd = tmp();
  try {
    const git = parseShellEffects("git status", { cwd });
    assert.equal(git.parseable, false);
    assert.match(git.reason, /不在模拟域/);
    const rel = parseShellEffects("rm a", { cwd: null });
    assert.equal(rel.parseable, false);
    assert.match(rel.reason, /相对路径/);
    const abs = parseShellEffects(`rm ${path.join(cwd, "a")}`, { cwd: null });
    assert.equal(abs.parseable, true);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("wm-parse: 选项被过滤, -- 形式的 rm 目标仍可识别", () => {
  const cwd = tmp();
  try {
    const r = parseShellEffects("rm --force a", { cwd });
    assert.equal(r.parseable, true);
    assert.ok(ends(r.effects[0].path, "a"));
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
