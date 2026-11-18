// test/worktree-isolation-2026-11-16.test.js — 子 agent 的 git worktree 隔离执行
// 零 LLM: 真 git 仓库 + 真实 spawn cwd + 桩 Legion。验证:
//   ① 建/收/删 worktree (含未跟踪新文件的补丁); ② 非 git 仓库明确报错不降级;
//   ③ worker 以隔离目录为 cwd; ④ spawn_agent 回执带变更统计 + 补丁且目录被清理。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  isGitRepo, createWorktree, collectWorktreeChanges, removeWorktree,
} from "../src/orchestrator/worktree.js";
import { Legion } from "../src/orchestrator/legion.js";
import { PPXAgent } from "../src/agent/index.js";

function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-wt-${tag}-`)); }

function git(dir, ...args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(tag) {
  const dir = tmp(tag);
  git(dir, "init");
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  git(dir, "add", ".");
  git(dir, "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-m", "init");
  return dir;
}

function waitForFile(file, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (fs.existsSync(file)) return resolve(fs.readFileSync(file, "utf8"));
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`等待文件超时: ${file}`));
      setTimeout(tick, 40);
    };
    tick();
  });
}

test("worktree: 建目录 → 新文件进补丁 → 删除目录 (主工作区不受影响)", () => {
  const root = makeRepo("basic");
  const wt = createWorktree(root, { id: "wt-a" });
  try {
    assert.ok(isGitRepo(wt), "worktree 本身也是 git 工作区");
    assert.equal(fs.readFileSync(path.join(wt, "base.txt"), "utf8").trim(), "base");
    fs.writeFileSync(path.join(wt, "worker-new.txt"), "子 agent 的产物\n");
    const ch = collectWorktreeChanges(root, wt);
    assert.equal(ch.files.length, 1);
    assert.match(ch.stat, /1 file changed/);
    assert.ok(ch.patchPath, "有变更就必须有补丁路径");
    const patch = fs.readFileSync(ch.patchPath, "utf8");
    assert.match(patch, /worker-new\.txt/, "未跟踪新文件也进补丁");
    assert.match(patch, /子 agent 的产物/);
    assert.equal(fs.readFileSync(path.join(root, "base.txt"), "utf8").trim(), "base");
  } finally {
    removeWorktree(root, wt);
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.ok(!fs.existsSync(wt), "worktree 已清理");
});

test("worktree: 非 git 仓库给可行动错误 (不静默退回共享目录)", () => {
  const dir = tmp("nogit");
  try {
    assert.equal(isGitRepo(dir), false);
    assert.throws(() => createWorktree(dir, { id: "x" }), /git 仓库/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("legion: worker 以隔离目录为 cwd (热池不接管)", async () => {
  const root = makeRepo("legion");
  const wt = createWorktree(root, { id: "wt-legion" });
  const out = path.join(root, "cwd.txt");
  const l = new Legion({ workerPath: path.resolve("test/fixtures/cwd-worker.js") });
  try {
    l.spawnAgent("probe", { cwd: wt, env: { PPX_TEST_CWD_OUT: out } });
    const cwd = await waitForFile(out);
    assert.equal(path.resolve(cwd), path.resolve(wt), "worker 的工作区必须是隔离目录");
  } finally {
    try { if (l.agents.has("probe")) await l.killAgent("probe"); } catch { /* 已退出 */ }
    removeWorktree(root, wt);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("spawn_agent isolation=worktree: 回执带变更统计 + 补丁, 隔离目录被清理", async () => {
  const root = makeRepo("delegate");
  const agent = new PPXAgent({ root, configFile: null });
  agent.llm = { model: "stub", backend: "http", vision: false, supportsNativeToolCalls: true };
  const specs = [];
  agent._legion = {
    spawnAgents: async (input) => {
      specs.push(...input);
      return input.map((s) => ({ ok: true, name: s.name }));
    },
    send: async (name) => {
      const spec = specs.find((s) => s.name === name);
      fs.writeFileSync(path.join(spec.opts.cwd, "worker-change.txt"), "changed\n");
      return { reply: "done" };
    },
    killAgent: async () => {},
  };
  try {
    const out = await agent.tools.call("spawn_agent", { task: "改一个文件", isolation: "worktree" }, { agent });
    assert.equal(specs.length, 1, "应派生一个隔离 worker");
    assert.ok(specs[0].opts.cwd, "worker 收到隔离 cwd");
    assert.match(out, /\[worktree 隔离\]/);
    assert.match(out, /1 file changed/);
    assert.match(out, /git apply --3way/);
    const patchFiles = fs.readdirSync(path.join(root, "data", "worktrees")).filter((f) => f.endsWith(".patch"));
    assert.equal(patchFiles.length, 1, "补丁留档");
    assert.match(fs.readFileSync(path.join(root, "data", "worktrees", patchFiles[0]), "utf8"), /worker-change\.txt/);
    assert.ok(!fs.existsSync(specs[0].opts.cwd), "隔离目录用完即删");
  } finally {
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("spawn_agent isolation=worktree: 非 git 仓库 → 工具错误, 不派生进程", async () => {
  const root = tmp("delegate-nogit");
  const agent = new PPXAgent({ root, configFile: null });
  agent.llm = { model: "stub", backend: "http", vision: false, supportsNativeToolCalls: true };
  let spawned = 0;
  agent._legion = { spawnAgents: async () => { spawned += 1; return []; }, killAgent: async () => {} };
  try {
    const out = await agent.tools.call("spawn_agent", { task: "x", isolation: "worktree" }, { agent });
    assert.match(out, /\[工具错误\] spawn_agent: worktree 隔离需要主工作区是一个 git 仓库/);
    assert.equal(spawned, 0, "不可用时不得静默降级为共享目录执行");
  } finally {
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
