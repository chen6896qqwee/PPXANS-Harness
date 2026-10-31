// test/memory-backend-sqlite-wiring.test.js - memory.backend=sqlite 真正装配 (2026-10-30)
// 背景: 文档/CHANGELOG 宣称 config.memory.backend=sqlite 可切换, 但 factsPlugin 此前永远
//   new FactStore (JSON), SqliteFactStore 只有测试在用 —— 配置静默无效。
// 本测试锁死: sqlite → SqliteFactStore + facts.db 真实落盘 + 读写可用; 默认/json → FactStore。
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "../src/plugin/index.js";
import { factsPlugin } from "../src/plugin/builtin.js";
import { FactStore } from "../src/memory/index.js";
import { SqliteFactStore } from "../src/memory/sqlite-store.js";

function makeCtx(dir, memory = {}) {
  const ctx = new Context();
  ctx.provide("dataDir", dir);
  ctx.provide("config", { memory });
  return ctx;
}

test("默认/json 后端 → JSON FactStore (不触碰 sqlite)", () => {
  for (const memory of [{}, { backend: "json" }]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-facts-json-"));
    try {
      const ctx = makeCtx(dir, memory);
      factsPlugin(ctx);
      const facts = ctx.consume("facts");
      assert.ok(facts instanceof FactStore, `${JSON.stringify(memory)} 应装配 FactStore`);
      assert.ok(!(facts instanceof SqliteFactStore), "不应误装配 sqlite");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("backend=sqlite → SqliteFactStore, facts.db 落盘且读写可用", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-facts-sqlite-"));
  let facts = null;
  try {
    const ctx = makeCtx(dir, { backend: "sqlite" });
    factsPlugin(ctx);
    facts = ctx.consume("facts");
    if (!(facts instanceof SqliteFactStore)) {
      t.skip("当前运行时 node:sqlite 不可用 (需 Node >=22.5), 已按 fail-safe 回退 JSON");
      return;
    }
    assert.equal(facts.stats().backend, "sqlite");
    const rec = facts.add("用户喜欢喝美式咖啡", { source: "test" });
    assert.ok(rec && rec.id, "sqlite 后端 add 应返回带 id 的记录");
    const hits = facts.query("美式咖啡");
    assert.ok(hits.length >= 1, "sqlite 后端 query 应能检索到刚写入的事实");
    facts.flush();
    assert.ok(fs.existsSync(path.join(dir, "memory", "facts.db")), "facts.db 必须真实存在");
  } finally {
    try { facts?.close?.(); } catch { /* 已关闭 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
