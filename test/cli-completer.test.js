// test/cli-completer.test.js — CLI Tab 补全 (2026-10-31)
// CLI 此前只认 4 条硬编码命令且无补全; 本文件钉住 commandCompleter 纯函数的匹配语义。
import test from "node:test";
import assert from "node:assert";
import { commandCompleter, createBuiltinRegistry } from "../src/commands/index.js";

const NAMES = [
  ...createBuiltinRegistry().list().map((c) => c.name), // 15 内置 (隐藏别名 /do 不在名册)
  "stop", "reset", "proactive", "proactive-done", "quit", "exit", "q",  // CLI 本地
];

test("输入 / 前缀: 返回以该前缀开头的全部命令 (带 / 前缀)", () => {
  const complete = commandCompleter(NAMES);
  const [hits, line] = complete("/re");
  assert.ok(hits.includes("/reset"));
  assert.ok(hits.includes("/resume"));
  assert.ok(hits.includes("/review"));
  assert.ok(hits.every((h) => h.startsWith("/re")));
  assert.equal(line, "/re");
});

test("空输入 / 非 / 开头: 不弹候选 (普通问题免打扰)", () => {
  const complete = commandCompleter(NAMES);
  assert.deepEqual(complete("")[0], []);
  assert.deepEqual(complete("帮我看看这个仓库")[0], []);
  assert.deepEqual(complete("rm -rf /")[0], []);
});

test("输入已带空格 (正在敲参数): 不再补命令名", () => {
  const complete = commandCompleter(NAMES);
  assert.deepEqual(complete("/model deep")[0], []);
});

test("精确匹配也返回自身 (readline 期望完整候选列表)", () => {
  const complete = commandCompleter(NAMES);
  const [hits] = complete("/stop");
  assert.deepEqual(hits, ["/stop"]);
});

test("名单去重: 同名命令只出现一次", () => {
  const complete = commandCompleter(["stop", "stop", "status", "status"]);
  const [hits] = complete("/s");
  const uniq = new Set(hits);
  assert.equal(hits.length, uniq.size);
});

test("隐藏别名 /do 不进名册 (名册契约恒 15 条), 但可通过 registry 执行", () => {
  const reg = createBuiltinRegistry();
  assert.equal(reg.list().length, 15);
  assert.equal(reg.execute("/do").action, "exit_plan_mode");
});
