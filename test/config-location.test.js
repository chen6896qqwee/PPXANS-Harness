// test/config-location.test.js - 配置落位 (2026-10-31, npm 全局安装不能被升级冲掉配置)
// 规则: 源码目录 → <root>/config/ppx.json; root 在 node_modules 里 → <dataDir>/config.json
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configFilePath, legacyConfigFilePath, readPpxConfig, writeConfigAtomic } from "../src/utils/config-file.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-config-loc-"));
const OLD_DATA_DIR = process.env.PPX_DATA_DIR;

function withDataDir(dir) {
  process.env.PPX_DATA_DIR = dir;
  fs.mkdirSync(dir, { recursive: true });
}

test("源码目录: 配置仍在 <root>/config/ppx.json", () => {
  const root = path.join(TMP, "checkout");
  assert.equal(configFilePath(root), path.join(root, "config", "ppx.json"));
});

test("node_modules 安装: 配置写到数据目录, 不在包目录里", () => {
  const root = path.join(TMP, "node_modules", "ppxans-harness");
  const dataDir = path.join(TMP, "home-ppx");
  withDataDir(dataDir);
  assert.equal(configFilePath(root), path.join(dataDir, "config.json"));

  writeConfigAtomic(root, { providers: [{ id: "p1", model: "m" }] });
  assert.ok(fs.existsSync(path.join(dataDir, "config.json")));
  assert.ok(!fs.existsSync(path.join(root, "config", "ppx.json")), "不应再写进包目录");
  assert.deepEqual(readPpxConfig(root), { providers: [{ id: "p1", model: "m" }] });
});

test("升级前写在包目录的旧配置仍能读到 (只读兼容)", () => {
  const root = path.join(TMP, "node_modules", "ppxans-harness-old");
  const dataDir = path.join(TMP, "home-ppx-old");
  withDataDir(dataDir);
  fs.mkdirSync(path.dirname(legacyConfigFilePath(root)), { recursive: true });
  fs.writeFileSync(legacyConfigFilePath(root), JSON.stringify({ user: { name: "旧配置" } }));
  assert.deepEqual(readPpxConfig(root), { user: { name: "旧配置" } });
});

test("cleanup", () => {
  if (OLD_DATA_DIR === undefined) delete process.env.PPX_DATA_DIR;
  else process.env.PPX_DATA_DIR = OLD_DATA_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});
