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

// --- append_file / delete_file (2026-10-02 基线暴露的工具面缺口) ---

test("append_file: 追加保留原内容 + 补换行 + 不存在则创建", async () => {
  const root = tmpRoot("append");
  const c = new ToolCatalog();
  registerBuiltinTools(c, { rootDir: root });
  fs.writeFileSync(path.join(root, "a.txt"), "第一行"); // 无换行结尾
  const r1 = JSON.parse(await c.call("append_file", { path: "a.txt", content: "第二行" }));
  assert.equal(r1.ok, true);
  const out = fs.readFileSync(path.join(root, "a.txt"), "utf8");
  assert.ok(out.includes("第一行") && out.includes("第二行"), "原内容应保留");
  assert.ok(!out.includes("第一行第二行"), "无换行结尾时应自动补 \\n");
  const r2 = JSON.parse(await c.call("append_file", { path: "new.txt", content: "x" }));
  assert.equal(r2.ok, true, "不存在时应创建");
  assert.equal(fs.readFileSync(path.join(root, "new.txt"), "utf8"), "x");
});

test("delete_file: 删除生效 + 目录拒绝 + 不存在报错 + 路径逃逸拒绝", async () => {
  const root = tmpRoot("delete");
  const c = new ToolCatalog();
  registerBuiltinTools(c, { rootDir: root });
  fs.writeFileSync(path.join(root, "gone.txt"), "x");
  const r1 = JSON.parse(await c.call("delete_file", { path: "gone.txt" }));
  assert.equal(r1.ok, true);
  assert.ok(!fs.existsSync(path.join(root, "gone.txt")), "文件应已删除");
  const r2 = JSON.parse(await c.call("delete_file", { path: "nope.txt" }));
  assert.ok(r2.error, "不存在应报错");
  fs.mkdirSync(path.join(root, "dir"));
  const r3 = JSON.parse(await c.call("delete_file", { path: "dir" }));
  assert.ok(r3.error && /目录/.test(r3.error), "目录应拒绝删除");
  const r4 = await c.call("delete_file", { path: "../../etc/passwd" });
  assert.ok(r4.startsWith("[工具错误]") || r4.includes("error"), "路径逃逸应被拒");
});

// --- 参数校验器 (2026-10-03, "想记做学评"框架: 参数要校验) ---
import { validateArgs } from "../src/tools/catalog.js";

test("validateArgs: required/type/enum 三查 + 数字宽容 + 未知键放行", () => {
  const meta = { parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "number" },
      mode: { type: "string", enum: ["fast", "slow"] },
      extra: { type: "string" },
    },
    required: ["path"],
  } };
  // 缺必填
  assert.ok(validateArgs(meta, {}).includes('缺少必填参数 "path"'));
  // 空串等于缺
  assert.ok(validateArgs(meta, { path: "   " }).includes("缺少必填"));
  // 类型错
  assert.ok(validateArgs(meta, { path: "a", limit: "abc" }).includes('应为 number'));
  // 枚举错
  assert.ok(validateArgs(meta, { path: "a", mode: "turbo" }).includes("fast / slow"));
  // 数字宽容: 字符串数字自动转换
  const a = { path: "a", limit: "42" };
  assert.equal(validateArgs(meta, a), null);
  assert.equal(a.limit, 42, "字符串数字应自动转 number");
  // 未知键放行 (LLM 冗余键不误杀)
  assert.equal(validateArgs(meta, { path: "a", rogue: true }), null);
  // 无 schema 放行
  assert.equal(validateArgs({ parameters: null }, {}), null);
});

test("工具调用实弹: 参数错误返回可行动提示且不触发执行/审批", async () => {
  const root = tmpRoot("validate");
  const c = new ToolCatalog();
  registerBuiltinTools(c, { rootDir: root });
  let executed = false;
  c.register({
    name: "probe_tool",
    parameters: { type: "object", properties: { p: { type: "string" } }, required: ["p"] },
    execute: async () => { executed = true; return "ran"; },
  });
  const bad = await c.call("probe_tool", {}, {});
  assert.ok(bad.includes("参数错误") && bad.includes("可用参数: p"), `应返回可行动提示: ${bad.slice(0, 60)}`);
  assert.equal(executed, false, "参数错误不应执行");
  assert.ok(await c.call("probe_tool", { p: "x" }, {}) === "ran", "参数正确应执行");
});
