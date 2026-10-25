// test/plugin.test.js - 插件系统 (一切皆插件)
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Context, compose, loadPlugins } from "../src/plugin/index.js";
import { PPXAgent } from "../src/agent/index.js";

function tmpRoot(n) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${n}-`)); }

test("Context provide/consume 基本功能", () => {
  const ctx = new Context();
  ctx.provide("a", 1);
  assert.equal(ctx.consume("a"), 1);
  assert.equal(ctx.consume("missing"), undefined);
  assert.ok(ctx.has("a"));
  assert.ok(!ctx.has("b"));
});

test("Context 子级向父级查找服务", () => {
  const parent = new Context();
  parent.provide("shared", "p");
  const child = new Context(parent);
  child.provide("own", "c");
  assert.equal(child.consume("shared"), "p");
  assert.equal(child.consume("own"), "c");
  assert.equal(child.consume("missing"), undefined);
});

test("Context dispose 逆序执行卸载钩子", async () => {
  const ctx = new Context();
  const order = [];
  ctx.onDispose(() => order.push("first"));
  ctx.onDispose(() => order.push("second"));
  await ctx.dispose();
  assert.deepEqual(order, ["second", "first"]);
});

test("compose 按顺序装配插件", () => {
  const ctx = new Context();
  const seen = [];
  compose(ctx, [
    (c) => { seen.push("p1"); c.provide("x", 1); },
    (c) => { seen.push("p2"); assert.equal(c.consume("x"), 1); },
  ]);
  assert.deepEqual(seen, ["p1", "p2"]);
});

test("loadPlugins 扫描目录加载 .cjs 插件", () => {
  const dir = tmpRoot("plugins");
  fs.writeFileSync(path.join(dir, "my.cjs"), "module.exports = (ctx) => { ctx.provide('custom', 42); };");
  const plugins = loadPlugins(dir);
  assert.equal(plugins.length, 1);
  const ctx = new Context();
  plugins[0](ctx);
  assert.equal(ctx.consume("custom"), 42);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadPlugins 目录不存在返回空", () => {
  assert.deepEqual(loadPlugins("/nonexistent/ppx-plugins"), []);
});

test("PPXAgent 支持自定义插件注册额外工具", () => {
  const root = tmpRoot("plugin-agent");
  const agent = new PPXAgent({
    root,
    plugins: [
      (ctx) => {
        ctx.consume("tools").register({
          name: "custom_hello",
          description: "自定义插件注入的工具",
          parameters: { type: "object", properties: {} },
          execute: async () => "hello from plugin",
        });
      },
    ],
  });
  assert.ok(agent.tools.has("custom_hello"));
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});
