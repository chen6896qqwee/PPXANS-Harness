// test/amem-plugin.test.js — A-Mem 示范插件守卫 (2026-10-09)
// 验证: manifest 装配 / 插槽切换 / 建卡-链接-演化 / 检索段注入 / 默认路径零影响
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Context, compose, loadPlugins } from "../src/plugin/index.js";
import { memoryPlugin, applyMemoryBackend } from "../src/plugin/builtin.js";
import { MemoryTicker } from "../src/memory/index.js";

function makeCtx(tmp) {
  const ctx = new Context();
  ctx.provide("dataDir", tmp);
  ctx.provide("facts", { query: () => [], add: () => ({ id: "f1" }) });
  ctx.provide("sessions", null);
  ctx.provide("userName", "测试");
  ctx.provide("config", {});
  return ctx;
}

test("manifest 契约: 插件目录被 loadPlugins 装配, 注册 memoryBackend:amem 工厂", () => {
  const ctx = makeCtx(fs.mkdtempSync(path.join(os.tmpdir(), "amem-manifest-")));
  const pluginsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins");
  compose(ctx, loadPlugins(pluginsDir));
  assert.equal(typeof ctx.consume("memoryBackend:amem"), "function", "工厂必须已注册");
});

test("config.memory.backend=amem → 切换成功且仍是 MemoryTicker 同接口", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amem-switch-"));
  const ctx = makeCtx(tmp);
  compose(ctx, [memoryPlugin, ...(loadPlugins(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins")))]);
  ctx.provide("config", { memory: { backend: "amem" } });
  applyMemoryBackend(ctx, ctx.consume("config"));
  const mem = ctx.consume("memory");
  assert.ok(mem instanceof MemoryTicker, "同接口 (extends)");
  assert.equal(typeof mem.context, "function");
  assert.equal(typeof mem.recordTurn, "function");
  assert.ok(mem.amem, "具备 A-Mem 卡片库");
});

test("建卡-链接-演化: 长期归档内容被吸收为卡, 相似卡自动链接且邻居演化", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amem-absorb-"));
  const ctx = makeCtx(tmp);
  compose(ctx, [memoryPlugin, ...(loadPlugins(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins")))]);
  applyMemoryBackend(ctx, { memory: { backend: "amem" } });
  const mem = ctx.consume("memory");
  const chunk = `\n## 2026-10-09\n- 用户偏好使用 TypeScript 编写前端组件\n- 项目皮皮虾采用零依赖纯 Node 架构\n- 用户偏好使用 TypeScript 编写后端脚本\n`;
  mem._appendLongterm(chunk);
  assert.ok(mem.amem.notes.length >= 2, `应建卡 ≥2, 实际 ${mem.amem.notes.length}`);
  const tsCards = mem.amem.notes.filter((n) => /typescript/i.test(n.text));
  assert.ok(tsCards.length >= 2, "同主题卡应各自成卡");
  assert.ok(mem.amem.notes.some((n) => n.links.length > 0), "相似卡应建立链接");
  assert.ok(mem.amem.notes.some((n) => n.evolved > 0), "被链接邻居应有演化注记");
  assert.ok(fs.existsSync(path.join(tmp, "memory", "amem-notes.json")), "卡片库应落盘");
});

test("context() 注入关联记忆卡段: 查询词命中时输出含 A-Mem 段", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amem-ctx-"));
  const ctx = makeCtx(tmp);
  compose(ctx, [memoryPlugin, ...(loadPlugins(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins")))]);
  applyMemoryBackend(ctx, { memory: { backend: "amem" } });
  const mem = ctx.consume("memory");
  mem._appendLongterm(`\n## 2026-10-09\n- 用户的项目皮皮虾采用零依赖纯 Node 架构\n`);
  const out = mem.context("皮皮虾的架构是什么依赖策略");
  assert.match(out, /关联记忆卡 \(A-Mem\)/, "检索命中应注入 A-Mem 段");
  assert.match(out, /零依赖/);
});

test("默认路径零影响: 不配置 backend 时 context 无 A-Mem 段", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amem-default-"));
  const ctx = makeCtx(tmp);
  compose(ctx, [memoryPlugin]);
  applyMemoryBackend(ctx, {});
  const mem = ctx.consume("memory");
  assert.ok(!("amem" in mem), "默认实现无 A-Mem 特征");
  assert.equal(typeof mem.context, "function");
});
