// test/tools.test.js - 工具系统测试
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { ToolCatalog, registerBuiltinTools } from "../src/tools/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
function tmpRoot(n){ const r = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${n}-`)); fs.copyFileSync(path.join(ROOT, "README.md"), path.join(r, "README.md")); return r; }

test("工具注册表注册+列表", () => {
  const c = new ToolCatalog();
  registerBuiltinTools(c, { rootDir: tmpRoot("tools") });
  const names = c.list();
  assert.ok(names.length >= 7, "至少7个内置工具");
  assert.ok(c.has("read_file"));
  assert.ok(c.has("write_file"));
  assert.ok(c.has("run_command"));
});

test("OpenAI 格式 schema", () => {
  const c = new ToolCatalog();
  registerBuiltinTools(c, { rootDir: tmpRoot("tools") });
  const openai = c.toOpenAI();
  assert.ok(Array.isArray(openai));
  const rf = openai.find((t) => t.function.name === "read_file");
  assert.ok(rf, "read_file 在 schema 里");
  assert.equal(rf.type, "function");
});

test("read_file 执行", async () => {
  const c = new ToolCatalog();
  registerBuiltinTools(c, { rootDir: tmpRoot("tools") });
  const res = await c.call("read_file", { path: "README.md" });
  assert.ok(res.includes("皮皮虾"));
});

test("write_file + read_file 往返", async () => {
  const c = new ToolCatalog();
  registerBuiltinTools(c, { rootDir: tmpRoot("tools") });
  await c.call("write_file", { path: "data/tmp-test.txt", content: "hello ppx" });
  const res = await c.call("read_file", { path: "data/tmp-test.txt" });
  assert.ok(res.includes("hello ppx"));
});

test("路径穿越被拒绝", async () => {
  const c = new ToolCatalog();
  registerBuiltinTools(c, { rootDir: tmpRoot("tools") });
  const res = await c.call("read_file", { path: "../../etc/passwd" });
  assert.ok(res.includes("越界") || res.includes("error"), "路径越界应被拒绝");
});

test("get_time 返回时间", async () => {
  const c = new ToolCatalog();
  registerBuiltinTools(c, { rootDir: tmpRoot("tools") });
  const res = await c.call("get_time", {});
  assert.ok(typeof res === "string" && res.length > 0);
});

test("agent 集成工具系统", () => {
  const agent = new PPXAgent({ root: tmpRoot("tools") });
  assert.ok(agent.tools, "agent 有工具");
  assert.ok(agent.tools.has("read_file"), "内置工具已注册到 agent");
  agent.shutdown();
});
