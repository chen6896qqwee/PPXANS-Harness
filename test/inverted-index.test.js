import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { FactStore } from "../src/memory/fact-store.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-idx-"));
const store = new FactStore(dir, {});

test("倒排索引: 新增事实建立索引", async () => {
  store.add("我搞量化交易, 关注A股资金流", { source: "t" });
  store.add("喜欢实时数据胜过猜测", { source: "t" });
  store.add("国际复材是个创业板股票", { source: "t" });
  assert.ok(store._index.has("量"), "索引含字 量");
  assert.ok(store._index.has("a股") || store._index.has("a"), "索引含 a");
});

test("倒排索引: query 命中且相关优先", async () => {
  const r = store.query("量化 资金流", { limit: 3 });
  assert.ok(r.length >= 1, "有结果");
  assert.ok(r[0].content.includes("量化"), "量化相关排最前");
});

test("倒排索引: 无命中回退全量(null 查询)", async () => {
  const r = store.query("", { limit: 5 });
  assert.ok(r.length === store.count(), "空查询返回全部");
});

test("倒排索引: 中文分词命中长句", async () => {
  const r = store.query("创业板", { limit: 3 });
  assert.ok(r.some((x) => x.content.includes("创业板")), "命中创业板记忆");
});

test("倒排索引: rebuildIndex 一致性", async () => {
  const before = store.query("A股", { limit: 5 }).map((x) => x.id);
  store.rebuildIndex();
  const after = store.query("A股", { limit: 5 }).map((x) => x.id);
  assert.deepEqual(after, before, "重建后结果一致");
});
