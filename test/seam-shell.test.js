import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { LocalShellProvider } from "../src/seam/shell.js";
import { PPXAgent } from "../src/agent/index.js";

function tmpRoot(n){ return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${n}-`)); }

test("LocalShellProvider.exec: 正常命令返回 stdout", async () => {
  const shell = new LocalShellProvider();
  const r = await shell.exec("echo hello-ppx");
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("hello-ppx"), `stdout 应含 hello-ppx, got: ${r.stdout}`);
});

test("LocalShellProvider.exec: 命令不存在返回 ok=false 不 throw", async () => {
  const shell = new LocalShellProvider();
  const r = await shell.exec("ppx_nonexistent_cmd_xyz_123");
  assert.equal(r.ok, false, "失败命令应 ok=false");
  assert.notEqual(r.code, 0, "退出码非 0");
});

test("LocalShellProvider.exec: 超时命令被中止", async () => {
  const shell = new LocalShellProvider();
  // sleep 超时: 平台无关地挂起超过 timeoutMs
  const cmd = process.platform === "win32"
    ? "ping -n 10 127.0.0.1 >nul"
    : "sleep 10";
  const r = await shell.exec(cmd, { cwd: os.tmpdir(), timeoutMs: 1000 });
  assert.equal(r.ok, false, "超时命令应失败");
  assert.ok(/timeout|ETIMEDOUT|killed|timed/i.test(r.stderr) || r.ok === false, "超时信息或失败态");
});

test("run_command 通过 shell seam 可替换 provider", async () => {
  const root = tmpRoot("seam");
  const agent = new PPXAgent({ root });
  // 注入 fake shell: 不真正执行, 返回固定结果
  let called = 0;
  const fake = { exec: async (cmd) => { called++; return { stdout: "fake-shell-输出:" + cmd, stderr: "", code: 0, ok: true }; } };
  agent.ctx.provide("shell", fake);
  const res = await agent.tools.call("run_command", { command: "echo hi" }, { agent });
  assert.ok(res.includes("fake-shell-输出"), "run_command 走了注入的 fake shell 而非本地执行");
  assert.equal(called, 1, "fake shell 被调用一次");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("run_command 无 seam 注入时回退本地默认 shell", async () => {
  const root = tmpRoot("seam2");
  const agent = new PPXAgent({ root });
  const res = await agent.tools.call("run_command", { command: "echo fallback-ok" }, { agent });
  assert.ok(res.includes("fallback-ok"), "默认本地 shell 正常执行");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});
