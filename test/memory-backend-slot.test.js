// test/memory-backend-slot.test.js - 记忆后端插槽 (2026-10-09, 轻内核缺口 2 第一步)
// 验证: 默认照旧 / 工厂切换 / 工厂缺失 fail-safe / 工厂抛错 fail-safe / 切换对 consume 可见
import { test } from "node:test";
import assert from "node:assert";
import { Context, compose } from "../src/plugin/index.js";
import { memoryPlugin, applyMemoryBackend } from "../src/plugin/builtin.js";
import { MemoryTicker } from "../src/memory/index.js";

function makeCtx() {
  const ctx = new Context();
  ctx.provide("dataDir", "/tmp/ppx-slot-test");
  ctx.provide("facts", {});
  ctx.provide("sessions", {});
  ctx.provide("userName", "测试");
  return ctx;
}

test("未配置 backend → 默认 MemoryTicker, 结构照旧", () => {
  const ctx = makeCtx();
  compose(ctx, [memoryPlugin]);
  applyMemoryBackend(ctx, {});
  assert.ok(ctx.consume("memory") instanceof MemoryTicker);
});

test("backend=json/sqlite/auto (FactStore 存储层既有语义) → 插槽放行不误报", () => {
  const ctx = makeCtx();
  compose(ctx, [memoryPlugin]);
  for (const b of ["json", "sqlite", "auto"]) {
    applyMemoryBackend(ctx, { memory: { backend: b } });
    assert.ok(ctx.consume("memory") instanceof MemoryTicker, `${b} 不应触发插槽`);
  }
});

test("backend=default → 显式默认, 不走插槽", () => {
  const ctx = makeCtx();
  compose(ctx, [memoryPlugin]);
  applyMemoryBackend(ctx, { memory: { backend: "default" } });
  assert.ok(ctx.consume("memory") instanceof MemoryTicker);
});

test("工厂已注册 → memory 切换为工厂实例, 服务集注入正确", () => {
  const ctx = makeCtx();
  compose(ctx, [memoryPlugin]);
  let got = null;
  ctx.provide("memoryBackend:qdrant", (services) => {
    got = services;
    return { backend: "qdrant", remember() {}, recall() {} };
  });
  applyMemoryBackend(ctx, { memory: { backend: "qdrant" } });
  assert.equal(ctx.consume("memory").backend, "qdrant");
  assert.equal(got.dataDir, "/tmp/ppx-slot-test");
  assert.ok("facts" in got && "sessions" in got && "userName" in got);
});

test("工厂缺失 → fail-safe 保留默认实现 (不抛错)", () => {
  const ctx = makeCtx();
  compose(ctx, [memoryPlugin]);
  applyMemoryBackend(ctx, { memory: { backend: "redis" } });
  assert.ok(ctx.consume("memory") instanceof MemoryTicker, "缺失工厂必须回退默认");
});

test("工厂抛错 → fail-safe 保留默认实现 (不向上传播)", () => {
  const ctx = makeCtx();
  compose(ctx, [memoryPlugin]);
  ctx.provide("memoryBackend:bad", () => { throw new Error("连接失败"); });
  applyMemoryBackend(ctx, { memory: { backend: "bad" } });
  assert.ok(ctx.consume("memory") instanceof MemoryTicker, "工厂抛错必须回退默认");
});
