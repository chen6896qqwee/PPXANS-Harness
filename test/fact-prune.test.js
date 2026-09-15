// test/fact-prune.test.js - L1 事实总量裁剪 (防记忆膨胀)
// 补齐「衰减只在查询层生效、不删数据」的缺口: 这里验证存储层硬清理
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { FactStore } from "../src/memory/fact-store.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-prune-")); }

test("fact-prune: 超 maxFacts 裁剪最弱事实 (高 importance 保留)", () => {
  const f = new FactStore(tmp(), { maxFacts: 5 });
  f.add("重要记忆: 兄弟的生日是1月1日", { importance: 20 });
  for (let i = 0; i < 6; i++) f.add(`普通记忆 ${i}`, { importance: 5 });
  assert.ok(f.count() <= 5, `裁剪后应 <= 5, 实际 ${f.count()}`);
  const contents = f.list().map((x) => x.content);
  assert.ok(contents.some((c) => c.includes("生日")), "高 importance 事实不应被裁掉");
});

test("fact-prune: 裁剪后倒排索引仍可检索", () => {
  const f = new FactStore(tmp(), { maxFacts: 3 });
  f.add("止损规则是亏损5%清仓", { importance: 20 });
  for (let i = 0; i < 5; i++) f.add(`噪声记忆 ${i}`, { importance: 1 });
  const r = f.query("止损", { limit: 1 });
  assert.equal(r.length, 1, "裁剪后检索仍命中");
  assert.ok(r[0].content.includes("止损"), "保留的事实可检索");
});

test("fact-prune: maxFacts=0 不裁剪 (禁用)", () => {
  const f = new FactStore(tmp(), { maxFacts: 0 });
  for (let i = 0; i < 10; i++) f.add(`记忆 ${i}`);
  assert.equal(f.count(), 10, "maxFacts=0 应不裁剪");
});

test("fact-prune: 默认上限 1000 (小规模不裁剪)", () => {
  const f = new FactStore(tmp());
  for (let i = 0; i < 50; i++) f.add(`记忆 ${i}`);
  assert.equal(f.count(), 50, "未达默认上限不应裁剪");
});
