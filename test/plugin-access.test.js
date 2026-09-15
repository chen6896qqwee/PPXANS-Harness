// test/plugin-access.test.js - P2⑧: 插件两级权限 (restricted / full-access)
import { test } from "node:test";
import assert from "node:assert";
import { Context, PLUGIN_ACCESS } from "../src/plugin/context.js";
import { compose, pluginAccess } from "../src/plugin/index.js";

test("pa: restricted 插件注册普通服务 OK, 注册敏感服务被拒", () => {
  const ctx = new Context(null, { access: PLUGIN_ACCESS.FULL });
  // 顶层 full-access 基座
  ctx.provide("tools", {});
  // restricted 子 context
  const rCtx = ctx.withAccess(PLUGIN_ACCESS.RESTRICTED);
  rCtx.provide("memory", {}); // 普通服务 OK
  assert.ok(rCtx.consume("memory"));
  assert.throws(() => rCtx.provide("routes", {}), /full-access/);
  assert.throws(() => rCtx.provide("tools", {}), /full-access/);
  assert.throws(() => rCtx.provide("shell", {}), /full-access/);
});

test("pa: full-access 插件可注册敏感服务", () => {
  const ctx = new Context(null, { access: PLUGIN_ACCESS.FULL });
  ctx.provide("routes", {}); // 顶层 full 可注册
  assert.ok(ctx.consume("routes"));
});

test("pa: pluginAccess 默认 restricted, 显式标记 full", () => {
  const plain = () => {};
  const full = () => {};
  full.access = "full-access";
  const obj = { setup() {}, access: "full-access" };
  assert.equal(pluginAccess(plain), PLUGIN_ACCESS.RESTRICTED);
  assert.equal(pluginAccess(full), PLUGIN_ACCESS.FULL);
  assert.equal(pluginAccess(obj), PLUGIN_ACCESS.FULL);
});

test("pa: compose 里 restricted 插件注册敏感服务被隔离 (不中断)", () => {
  const ctx = new Context(null, { access: PLUGIN_ACCESS.FULL });
  const bad = () => { ctx.withAccess(PLUGIN_ACCESS.RESTRICTED).provide("routes", {}); };
  const good = () => { ctx.withAccess(PLUGIN_ACCESS.RESTRICTED).provide("memory", {}); };
  // 不应抛错, 隔离失败
  compose(ctx, [bad, good]);
  assert.ok(ctx.consume("memory"), "好插件服务注册成功");
  assert.equal(ctx.consume("routes"), undefined, "坏插件敏感服务被拒");
});

test("pa: compose full-access 插件直接注册到顶层, agent.consume 可见", () => {
  const ctx = new Context(null, { access: PLUGIN_ACCESS.FULL });
  const fullPlugin = (c) => { c.provide("tools", { name: "tools" }); };
  fullPlugin.access = "full-access";
  compose(ctx, [fullPlugin]);
  assert.deepEqual(ctx.consume("tools"), { name: "tools" }, "顶层可见");
});

test("pa: 子 context 向上查找父服务", () => {
  const ctx = new Context(null, { access: PLUGIN_ACCESS.FULL });
  ctx.provide("facts", { n: 1 });
  const child = ctx.withAccess(PLUGIN_ACCESS.RESTRICTED);
  assert.deepEqual(child.consume("facts"), { n: 1 }, "restricted 子 ctx 可消费父服务");
});

test("pa: SENSITIVE_SERVICES 覆盖关键能力", () => {
  const ctx = new Context(null, { access: PLUGIN_ACCESS.FULL });
  const r = ctx.withAccess(PLUGIN_ACCESS.RESTRICTED);
  for (const k of ["routes", "lifecycle", "tools", "shell", "pages", "providers", "extensions"]) {
    assert.throws(() => r.provide(k, {}), /full-access/, `${k} 应被拒`);
  }
});
