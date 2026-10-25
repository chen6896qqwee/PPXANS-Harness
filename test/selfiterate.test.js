// test/selfiterate.test.js - 自主迭代进化引擎回归 (2026-10-25)
//
// 用临时夹具工程 (坏源码 + 测试) + 假 LLM 验证闭环的四个关键行为:
//   1) 修复成功: 补丁落盘 → 重跑绿 → 保留 + 审计 ok=true
//   2) 修复无效: 补丁落盘但重跑仍红 → 快照回滚, 原文复原 + 审计 ok=false
//   3) propose 模式: 只出补丁不动盘 (默认安全)
//   4) TAP 解析 + 路径安全 (拒绝测试文件/越界路径)
// 全程不依赖真模型、不碰主工程文件。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SelfIterationEngine, parseTap, relatedSources } from "../src/evolve/selfiterate.js";
import { registerSelfIterateTools } from "../src/tools/selfiterate.js";
import { ToolCatalog } from "../src/tools/catalog.js";

const BROKEN_SRC = "export function add(a, b) { return a - b; }\n";
// 夹具 import 行拆两段写: depcheck 的 SPEC_RE 会扫描源码文本里的相对路径字面量,
// 拼接后它只看到 ../src/ (解析为存在的 src 目录), 运行时落盘的夹具才是完整路径。
const FIXTURE_IMPORT = 'import { add } from "../src/' + 'math.js";';
const TEST_JS = [
  'import { test } from "node:test";',
  'import assert from "node:assert";',
  FIXTURE_IMPORT,
  'test("add(1,2) 应为 3", () => { assert.equal(add(1, 2), 3); });',
  "",
].join("\n");

function mkFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-selfit-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "math.js"), BROKEN_SRC);
  fs.writeFileSync(path.join(root, "test", "math.test.js"), TEST_JS);
  return root;
}

const GOOD_PATCH = [
  "诊断: add 把 + 写成了 -。",
  "<<<<<<< SEARCH",
  "src/math.js",
  "export function add(a, b) { return a - b; }",
  "=======",
  "export function add(a, b) { return a + b; }",
  ">>>>>>> REPLACE",
].join("\n");

// 补丁能应用但不修复问题 (改成 *0 仍错) → 应触发回滚
const BAD_PATCH = GOOD_PATCH.replace("a + b;", "a + b * 0;");

function mkAgent(root, patchText) {
  const auditCalls = [];
  return {
    root,
    dataDir: path.join(root, "data"),
    config: {},
    llm: { chat: async () => ({ content: patchText }) },
    audit: { append: (e) => auditCalls.push(e) },
    tracer: { event: () => {} },
    _auditCalls: auditCalls,
  };
}

test("parseTap: 从 TAP 文本提取失败数与用例名", () => {
  const tap = [
    "TAP version 13",
    "ok 1 - a",
    "not ok 2 - add(1,2) 应为 3",
    "  ---",
    "  error: boom",
    "  ...",
    "# tests 2",
    "# pass 1",
    "# fail 1",
  ].join("\n");
  const r = parseTap(tap);
  assert.equal(r.ok, false);
  assert.equal(r.fail, 1);
  assert.equal(r.failed[0], "add(1,2) 应为 3");
  assert.equal(parseTap("ok 1 - x\n# tests 1\n# pass 1\n# fail 0").ok, true);
});

test("relatedSources: 从测试文件解析源码引用", () => {
  const root = mkFixture();
  try {
    const rel = relatedSources(path.join(root, "test", "math.test.js"), root);
    assert.equal(rel.length, 1);
    assert.ok(rel[0].endsWith(path.join("src", "math.js")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("apply 模式: 补丁修复成功 → 落盘保留 + 审计 ok", { timeout: 60000 }, async () => {
  const root = mkFixture();
  const agent = mkAgent(root, GOOD_PATCH);
  try {
    const engine = new SelfIterationEngine(agent, { mode: "apply", root });
    const summary = await engine.run({ targetFiles: [path.join(root, "test", "math.test.js")] });
    assert.equal(summary.ran, true);
    assert.equal(summary.fixed, 1, "应报告修复 1 个文件: " + JSON.stringify(summary));
    const after = fs.readFileSync(path.join(root, "src", "math.js"), "utf8");
    assert.ok(after.includes("a + b"), "源码应已被修复");
    assert.ok(agent._auditCalls.some((c) => c.ok === true), "审计链应有 ok=true 记录");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("apply 模式: 补丁无效 → 快照回滚原文复原 + 审计 ok=false", { timeout: 60000 }, async () => {
  const root = mkFixture();
  const agent = mkAgent(root, BAD_PATCH);
  try {
    const engine = new SelfIterationEngine(agent, { mode: "apply", root });
    const summary = await engine.run({ targetFiles: [path.join(root, "test", "math.test.js")] });
    assert.equal(summary.rolledBack >= 1 || summary.skipped >= 1, true, "未修复: " + JSON.stringify(summary));
    const after = fs.readFileSync(path.join(root, "src", "math.js"), "utf8");
    assert.equal(after, BROKEN_SRC, "回滚后源码应与原文件完全一致");
    assert.ok(agent._auditCalls.some((c) => c.ok === false), "审计链应有失败留痕");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("propose 模式 (默认): 只出补丁, 绝不动盘", { timeout: 60000 }, async () => {
  const root = mkFixture();
  const agent = mkAgent(root, GOOD_PATCH);
  try {
    const engine = new SelfIterationEngine(agent, { root }); // 不传 mode = 默认 propose
    const summary = await engine.run({ targetFiles: [path.join(root, "test", "math.test.js")] });
    assert.equal(summary.proposed, 1, "应报告 proposed: " + JSON.stringify(summary));
    const after = fs.readFileSync(path.join(root, "src", "math.js"), "utf8");
    assert.equal(after, BROKEN_SRC, "propose 模式不得写文件");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("无 LLM: 安全跳过 (离线语义)", { timeout: 30000 }, async () => {
  const root = mkFixture();
  try {
    const engine = new SelfIterationEngine({ root, dataDir: path.join(root, "data") }, { root });
    const summary = await engine.run({ targetFiles: [path.join(root, "test", "math.test.js")] });
    assert.equal(summary.ran, false);
    assert.match(summary.reason, /无 LLM/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("self_improve 工具: apply 需 config 双重确认, 否则拒绝", async () => {
  const catalog = new ToolCatalog();
  const agent = { root: "/tmp/x", config: {}, llm: null };
  registerSelfIterateTools(catalog, { agent });
  assert.ok(catalog.list().includes("self_improve"));
  const out = await catalog.call("self_improve", { test_files: ["test/x.test.js"], mode: "apply" }, {});
  assert.match(String(out), /双重确认/, "config 未开 apply 时应拒绝");
});

test("self_improve 工具: schema 声明 riskLevel=high (权限引擎按高风险处理)", () => {
  const catalog = new ToolCatalog();
  registerSelfIterateTools(catalog, { agent: { root: "/tmp/x", config: {} } });
  const cap = catalog.getCapability("self_improve");
  assert.equal(cap?.riskLevel, "high", "自改代码必须是 high 风险等级");
});
