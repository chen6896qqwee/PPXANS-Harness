import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";

function tmp(n){ return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-dd-${n}-`)); }

test("数据目录: 源码运行默认 root/data", () => {
  const root = tmp("src");
  const a = new PPXAgent({ root });
  assert.equal(a.dataDir, path.join(root, "data"));
  a.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("数据目录: 显式 dataDir 参数优先", () => {
  const root = tmp("explicit");
  const custom = tmp("custom");
  const a = new PPXAgent({ root, dataDir: custom });
  assert.equal(a.dataDir, custom);
  a.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(custom, { recursive: true, force: true });
});

test("数据目录: PPX_DATA_DIR 环境变量覆盖默认", () => {
  const root = tmp("env");
  const custom = tmp("envdata");
  process.env.PPX_DATA_DIR = custom;
  const a = new PPXAgent({ root });
  assert.equal(a.dataDir, custom);
  delete process.env.PPX_DATA_DIR;
  a.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(custom, { recursive: true, force: true });
});
