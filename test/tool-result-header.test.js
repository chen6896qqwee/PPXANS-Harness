// test/tool-result-header.test.js - B1 工具结果标准化
// 吸收 codex format_exec_output_for_model: 命令类工具返回统一元数据头
//   [exit=0 time=0.42s out=3行] <内容>   — 成功
//   [exit=1 time=1.02s out=0行][stderr]  — 失败编码进结果
//   [exit=timeout time=30000ms] command timed out after 30000ms — 超时前置
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatToolResultHeader, countLines } from "../src/tools/seam.js";
import { registerBuiltinTools } from "../src/tools/builtin.js";
import { ToolCatalog } from "../src/tools/catalog.js";

// ---- 纯函数层 ----

test("formatToolResultHeader: 成功头含 exit/time/out", () => {
  const h = formatToolResultHeader({ ms: 420, lineCount: 3, exitCode: 0 });
  assert.match(h, /^\[exit=0 time=0\.42s out=3行\]$/);
});

test("formatToolResultHeader: 失败头带非零 exit 码", () => {
  const h = formatToolResultHeader({ ms: 1020, lineCount: 0, exitCode: 1 });
  assert.match(h, /^\[exit=1 time=1\.02s out=0行\]$/);
});

test("formatToolResultHeader: 超时前置 timeout 标记", () => {
  const h = formatToolResultHeader({ ms: 30000, timedOut: true, timedOutMs: 30000 });
  assert.match(h, /^\[exit=timeout time=30000ms\] command timed out after 30000ms$/);
});

test("formatToolResultHeader: 缺省 exitCode 用 ? 兜底 (未知成败不应伪装成 0)", () => {
  const h = formatToolResultHeader({ ms: 10, lineCount: 1 });
  assert.match(h, /\[exit=\? time=0\.01s out=1行\]/);
});

test("countLines: 空/纯空白算 0 行", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("   \n\t\n"), 0);
});

test("countLines: 多行文本统计", () => {
  assert.equal(countLines("a\nb\nc"), 3);
  assert.equal(countLines("a\r\nb\r\nc\r\n"), 3);
});

// ---- 工具层接入 ----

function makeCatalog() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-b1-"));
  const catalog = new ToolCatalog();
  registerBuiltinTools(catalog, { rootDir: root, facts: null, memory: null });
  return { root, catalog };
}

test("run_command: 成功输出带标准头 + 原内容", async () => {
  const { catalog } = makeCatalog();
  const res = await catalog.call("run_command", { command: "echo abc" }, {
    agent: { config: { security: { allow_all: true } } },
  });
  assert.match(res, /^\[exit=0 time=[\d.]+s out=1行\]\n/);
  assert.ok(res.includes("abc"), `应含输出 abc, 实际: ${res}`);
});

test("run_command: 黑名单命令仍被拒绝 (头不掩盖拒绝)", async () => {
  const { catalog } = makeCatalog();
  const res = await catalog.call("run_command", { command: "rm -rf /" }, {
    agent: { config: { security: { allow_all: true } } },
  });
  // 命令守卫在工具执行前拦截, 不走标准头 (无真实执行, 不应伪造 exit 元数据), 保持原拦截错误语义
  assert.ok(/拦截|拒绝|deny|危险/i.test(res), `实际: ${res}`);
  assert.ok(!res.startsWith("[exit="), "拦截不应伪造 exit 标准头");
});

test("run_command: code_act 空/关闭分支不受标准头影响", async () => {
  const { catalog } = makeCatalog();
  const res = await catalog.call("code_act", { language: "node", code: "console.log(1)" }, {
    agent: { config: { security: {} } },
  });
  assert.ok(res.includes("未开启"), `实际: ${res}`);
});