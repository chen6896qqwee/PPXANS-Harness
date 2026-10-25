// test/plugin-manifest.test.js - 目录式插件 manifest 契约 (2026-10-08, 轻内核路线图缺口 3)
// 验证: manifest 发现/entry 解析/access 注入/穿越防线/非法 access fail-closed/无 manifest 目录不受影响
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlugins, pluginAccess } from "../src/plugin/index.js";

function tmpPlugins() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-plug-"));
  process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

test("manifest: 目录式插件被发现, access 从清单注入", () => {
  const dir = tmpPlugins();
  fs.mkdirSync(path.join(dir, "my-plugin"));
  fs.writeFileSync(path.join(dir, "my-plugin", "ppx.plugin.json"),
    JSON.stringify({ name: "my-plugin", entry: "index.cjs", access: "full-access", description: "测试插件" }));
  fs.writeFileSync(path.join(dir, "my-plugin", "index.cjs"),
    "module.exports = function setup(ctx) { ctx.loaded = true; };");
  const plugins = loadPlugins(dir);
  assert.equal(plugins.length, 1);
  assert.equal(pluginAccess(plugins[0]), "full-access", "manifest 的 access 应注入到插件上");
});

test("manifest: access 缺省时按 restricted, setup 对象形式兼容", () => {
  const dir = tmpPlugins();
  fs.mkdirSync(path.join(dir, "obj-plugin"));
  fs.writeFileSync(path.join(dir, "obj-plugin", "ppx.plugin.json"), JSON.stringify({ name: "obj" }));
  fs.writeFileSync(path.join(dir, "obj-plugin", "index.cjs"),
    "module.exports = { setup(ctx) {} };");
  const plugins = loadPlugins(dir);
  assert.equal(plugins.length, 1);
  assert.equal(pluginAccess(plugins[0]), "restricted", "缺省 access = restricted");
});

test("manifest: entry 越出插件目录 → 拒绝加载 (穿越防线)", () => {
  const dir = tmpPlugins();
  // 真正要拉进来的代码放在插件目录之外
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-outside-"));
  const evil = path.join(outside, "evil.cjs");
  fs.writeFileSync(evil, "module.exports = function (ctx) { ctx.evil = true; };");
  fs.mkdirSync(path.join(dir, "traversal"));
  fs.writeFileSync(path.join(dir, "traversal", "ppx.plugin.json"),
    JSON.stringify({ name: "traversal", entry: "../../evil.cjs", access: "full-access" }));
  const plugins = loadPlugins(dir);
  assert.equal(plugins.length, 0, "越界 entry 必须被拒绝");
  assert.ok(!fs.existsSync(path.join(dir, "traversal", "loaded")));
  fs.rmSync(outside, { recursive: true, force: true });
});

test("manifest: 非法 access → fail-closed 跳过整个插件", () => {
  const dir = tmpPlugins();
  fs.mkdirSync(path.join(dir, "bad-access"));
  fs.writeFileSync(path.join(dir, "bad-access", "ppx.plugin.json"),
    JSON.stringify({ name: "bad", entry: "index.cjs", access: "sudo" }));
  fs.writeFileSync(path.join(dir, "bad-access", "index.cjs"),
    "module.exports = function (ctx) {};");
  assert.equal(loadPlugins(dir).length, 0, "非法 access 必须整插件跳过");
});

test("无 manifest 的目录与散文件行为不变 (向后兼容)", () => {
  const dir = tmpPlugins();
  fs.mkdirSync(path.join(dir, "plain-dir")); // 无 manifest → 不加载
  fs.writeFileSync(path.join(dir, "loose.cjs"), "module.exports = function (ctx) {};");
  const plugins = loadPlugins(dir);
  assert.equal(plugins.length, 1, "散文件加载行为保持");
});
