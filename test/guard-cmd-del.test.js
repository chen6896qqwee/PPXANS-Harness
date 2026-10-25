// test/guard-cmd-del.test.js - 命令守卫缺口修复回归 (2026-10-25 评估修复)
//
// 背景 (评估报告 P3): DEFAULT_DENY 只匹配 delete/erase, Windows del 命令可漏;
//   INLINE_INTERPRETERS 清单漏 cmd —— `cmd /c <任意载荷>` 因首词不在白名单时被拦,
//   但 allow_all=true 下完全放行。两处补齐后: del 带参即拒 (allow_all 也不放行),
//   cmd /c 按内联执行硬拦 (需 allow_inline_exec 显式放开)。
import { test } from "node:test";
import assert from "node:assert";
import { checkCommand, findInlineExec } from "../src/tools/command-guard.js";

test("del 带参命中 DEFAULT_DENY (allow_all 也不放行)", () => {
  for (const cmd of ["del a.txt", "del /f /q C:\\tmp\\x", "DEL file"]) {
    const r = checkCommand(cmd, { allow_all: true });
    assert.equal(r.ok, false, `应拦: ${cmd}`);
    assert.match(r.reason, /黑名单/, `拒因应为黑名单: ${cmd}`);
  }
});

test("del 不误伤文件名 (node del.js 合法路径)", () => {
  // node del.js: 不在白名单场景会被白名单拦 (argv0=node 其实在白名单), 但不应命中黑名单
  const r = checkCommand("node del.js", { allow_all: true });
  assert.ok(!/黑名单/.test(r.reason || ""), "del.js 文件名不应命中删除黑名单");
  assert.equal(r.ok, true, "node 在白名单且 allow_all, 应放行");
});

test("cmd /c 命中内联执行硬拦 (allow_all 不可放开)", () => {
  for (const cmd of ["cmd /c dir", "cmd.exe /c whoami", "cmd /k calc"]) {
    const r = checkCommand(cmd, { allow_all: true });
    assert.equal(r.ok, false, `应硬拦: ${cmd}`);
    assert.equal(r.hard, true, "应为硬拦截");
    assert.match(r.reason, /内联执行/, `拒因应为内联执行: ${cmd}`);
  }
  assert.ok(findInlineExec("cmd /c x"), "findInlineExec 应识别 cmd /c");
});

test("cmd 无执行参数不拦 (cmd /? 或裸 cmd)", () => {
  assert.equal(findInlineExec("cmd /?"), null);
  assert.equal(findInlineExec("cmd"), null);
});

test("allow_inline_exec=true 时 cmd /c 可放开 (显式选择)", () => {
  const r = checkCommand("cmd /c dir", { allow_all: true, allow_inline_exec: true });
  assert.equal(r.ok, true, "显式 opt-in 后放行");
});
