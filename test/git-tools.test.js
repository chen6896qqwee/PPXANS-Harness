// 2026-10-01 git 集成工具回归守卫 (aider/Claude Code/OpenHands 对标)
// 覆盖: status 结构化 / diff 内容 / log 历史 / commit 提交闭环 / 非仓库报错 / 无 push 能力
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { registerGitTools } from "../src/tools/git.js";
import { ToolCatalog } from "../src/tools/catalog.js";

function tmpRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-git-${tag}-`));
  const run = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  run("init", "-q");
  run("config", "user.email", "test@ppx.local");
  run("config", "user.name", "皮皮虾测试");
  return { dir, run };
}

function setup(tag) {
  const { dir, run } = tmpRepo(tag);
  const catalog = new ToolCatalog();
  registerGitTools(catalog, { rootDir: dir });
  return { dir, run, tool: (name) => catalog.metaOf(name) };
}

test("git_status: 提交前干净, 改动后结构化列出", async () => {
  const { dir, run, tool } = setup("st");
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  const clean = JSON.parse(await tool("git_status").execute({}));
  assert.equal(clean.clean, true);
  fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "new\n");
  const dirty = JSON.parse(await tool("git_status").execute({}));
  assert.equal(clean.branch, dirty.branch);
  assert.equal(dirty.clean, false);
  assert.equal(dirty.entries.length, 2);
});

test("git_diff: 显示改动内容, staged 过滤生效", async () => {
  const { dir, run, tool } = setup("df");
  fs.writeFileSync(path.join(dir, "a.txt"), "v1\n");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  fs.writeFileSync(path.join(dir, "a.txt"), "v2\n");
  const d1 = await tool("git_diff").execute({});
  assert.ok(d1.includes("v2"));
  const d2 = await tool("git_diff").execute({ staged: true });
  assert.ok(!d2.includes("v2"), "未暂存的改动不应出现在 staged diff");
});

test("git_log: 结构化历史", async () => {
  const { run, tool } = setup("lg");
  const log = JSON.parse(await tool("git_log").execute({ n: 5 }));
  assert.ok(Array.isArray(log.commits));
});

test("git_commit: add_all 提交闭环 + 空提交可读报错", async () => {
  const { dir, tool } = setup("cm");
  fs.writeFileSync(path.join(dir, "a.txt"), "内容\n");
  const r1 = JSON.parse(await tool("git_commit").execute({ message: "feat: 首次提交", add_all: true }));
  assert.equal(r1.ok, true);
  assert.ok(/^[0-9a-f]+$/.test(r1.hash));
  const r2 = JSON.parse(await tool("git_commit").execute({ message: "空提交" }));
  assert.equal(r2.ok, false);
  assert.ok(r2.error.includes("没有可提交的改动"));
});

test("git_commit: 非仓库目录返回可读错误", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-nogit-"));
  const catalog = new ToolCatalog();
  registerGitTools(catalog, { rootDir: dir });
  const out = await catalog.metaOf("git_status").execute({});
  assert.ok(out.includes("不在 git 仓库内"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("护栏: 只暴露 status/diff/log/commit 四个工具, 无 push/reset 能力", () => {
  const { tool } = setup("gr");
  for (const t of ["git_status", "git_diff", "git_log", "git_commit"]) {
    assert.ok(tool(t), `${t} 已注册`);
  }
  assert.equal(tool("git_push"), null, "不得提供 git_push");
  assert.equal(tool("git_reset"), null, "不得提供 git_reset");
});
