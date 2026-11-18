// test/plugin-dx.test.js — 插件契约 DX 深度修复守卫 (2026-10-09)
// 背景: manifest 契约错误 (非法 access / ESM 误判 / entry 缺失) 此前静默或含混,
//   插件作者只能靠猜 (A-Mem 落地时实测踩坑两条)。本守卫锁定可操作报错语义。
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadPlugins } from "../src/plugin/index.js";
import { ratelimitError } from "../src/skills/importer.js";

function tmpPlugins() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-pdx-")); }

test("entry 文件缺失 → 显式跳过且不抛含混 MODULE_NOT_FOUND", () => {
  const dir = tmpPlugins();
  const d = path.join(dir, "ghost");
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, "ppx.plugin.json"), JSON.stringify({ name: "ghost", entry: "nope.cjs" }));
  const plugins = loadPlugins(dir);
  assert.equal(plugins.length, 0);
  assert.ok(!fs.existsSync(path.join(d, "nope.cjs")), "前置条件: 入口确实不存在");
});

test("ESM 误判 (空导出入口) → 识别为空导出并提示 .cjs 修复路径", () => {
  const dir = tmpPlugins();
  const d = path.join(dir, "esmvictim");
  fs.mkdirSync(d);
  // .mjs 强制 ESM 语义 (等价于 type:module 包内 .js 的 require(esm) 空导出形状)
  fs.writeFileSync(path.join(d, "ppx.plugin.json"), JSON.stringify({ name: "esmvictim", entry: "index.mjs" }));
  fs.writeFileSync(path.join(d, "index.mjs"), "export default {};\n");
  const plugins = loadPlugins(dir); // ESM namespace {default:{}} → default 是空对象 → 非函数 → skip + 提示改 .cjs
  assert.equal(plugins.length, 0, "空对象插件必须被跳过, 不得污染注册表");
});

test("非法 access 与合法 access 混合目录 → 只装合法插件 (fail-open 到可用子集)", () => {
  const dir = tmpPlugins();
  const bad = path.join(dir, "bad-access");
  fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, "ppx.plugin.json"), JSON.stringify({ name: "bad", entry: "p.cjs", access: "full" }));
  fs.writeFileSync(path.join(bad, "p.cjs"), "module.exports = function(ctx){};");
  const good = path.join(dir, "good-access");
  fs.mkdirSync(good);
  fs.writeFileSync(path.join(good, "ppx.plugin.json"), JSON.stringify({ name: "good", entry: "p.cjs", access: "restricted" }));
  fs.writeFileSync(path.join(good, "p.cjs"), "module.exports = function(ctx){};");
  const plugins = loadPlugins(dir);
  assert.equal(plugins.length, 1, "非法 access 跳过, 合法的照常装配");
  assert.equal(plugins[0].access, "restricted");
});

test("ratelimitError: 403 文案含三条出路与等待时间 (锁可操作语义)", () => {
  const reset = Math.floor(Date.now() / 1000) + 1200; // 20 分钟后重置
  const e = ratelimitError(403, String(reset), "https://api.github.com/repos/x/y");
  assert.match(e.message, /GitHub API 403 限流/);
  assert.match(e.message, /token/);
  assert.match(e.message, /tarball/);
  assert.match(e.message, /分钟后重置/);
  const noReset = ratelimitError(429, null, "https://api.github.com/repos/x/y");
  assert.match(noReset.message, /GitHub API 429 限流/);
});
