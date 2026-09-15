// test/custom-tools.test.js - 用户自定义工具注册
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ToolCatalog } from "../src/tools/catalog.js";
import { registerCustomTools } from "../src/tools/custom.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-custom-"));
}

test("扫描并注册 .cjs 工具", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "hello.cjs"),
    'module.exports = { name: "hello", description: "问候", parameters: { type: "object", properties: {} }, execute: async () => "你好" };');
  const catalog = new ToolCatalog();
  const n = registerCustomTools(catalog, dir);
  assert.equal(n, 1);
  assert.ok(catalog.has("hello"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("跳过无 execute 的非法定义", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "bad.cjs"), 'module.exports = { name: "bad" };');
  const catalog = new ToolCatalog();
  assert.equal(registerCustomTools(catalog, dir), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("目录不存在返回 0", () => {
  const catalog = new ToolCatalog();
  assert.equal(registerCustomTools(catalog, "/nonexistent/ppx-custom-dir"), 0);
});
