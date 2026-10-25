// test/cli-gate.test.js - CLI 早退闸门 (v3.2.4)
// 回归背景: 此前 src/cli.js 无 argv 分支, `ppx --version` 全家桶启动进交互 REPL
// (实测 25s 不退出)。闸门修复后必须秒回 (npm bin 惯例)。
import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "ppx.js");

// 数据隔离 (2026-10-09): CLI 子进程启动会构造 PPXAgent, 默认往 <项目>/data 写
// 记忆/日志/调度/用量统计。execFile 默认继承父进程 env, 故这里把 PPX_DATA_DIR 指到临时目录,
// 子进程随之隔离 —— 否则每跑一次本测试就污染一次生产数据目录 (实测: 9 个文件被写出)。
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-cli-gate-"));
process.env.PPX_DATA_DIR = TMP_DATA;

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [BIN, ...args], { timeout: 15000, env: { ...process.env, PPX_DATA_DIR: TMP_DATA } },
      (err, stdout, stderr) => {
        if (err && err.killed) return reject(new Error(`超时未退出: ${args.join(" ")}`));
        resolve({ code: err ? err.code : 0, stdout, stderr });
      });
  });
}

test("ppx --version 秒回版本号 (不全家桶启动)", async () => {
  const { code, stdout } = await run(["--version"]);
  assert.equal(code, 0);
  assert.match(stdout, /PPXANS-Harness\) v\d+\.\d+\.\d+/);
});

test("ppx -v 与 --version 同义", async () => {
  const { stdout } = await run(["-v"]);
  assert.match(stdout, /v\d+\.\d+\.\d+/);
});

test("ppx --help 秒回用法, 不进 REPL", async () => {
  const { code, stdout } = await run(["--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /用法/);
  assert.match(stdout, /ppx-serve/);
});
