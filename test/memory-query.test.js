// test/memory-query.test.js - P1: LLM 查询扩展 + RRF 融合语义记忆检索
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { MemoryTicker } from "../src/memory/memory-ticker.js";
import { FactStore } from "../src/memory/fact-store.js";

// 用临时根目录构造轻量 agent (不污染 __nonexistent__ / 生产数据)
function makeAgent() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-memq-"));
  return new PPXAgent({ root, configFile: null });
}

test("_expandQuery: LLM 改写成多个词面变体 (剥序号)", async () => {
  const a = makeAgent();
  a.llm = { chat: async () => ({ content: "1. 亏损清仓规则\n2. 无条件止损\n3. 连续亏损暂停交易" }) };
  const v = await a._expandQuery("止损 清仓");
  assert.ok(v.length >= 1, "应返回至少一个变体");
  assert.ok(v.every((s) => !/^\d/.test(s)), "应剥掉序号前缀");
});

test("_memoryQuery: 无 LLM 退化为单查询", async () => {
  const a = makeAgent();
  a.llm = null;
  a.facts.add("止损规则是亏损5%清仓");
  const res = await a._memoryQuery("止损规则", { limit: 3 });
  assert.ok(res.some((x) => x.content.includes("止损")), "无 LLM 时走单查询 BM25");
});

test("_memoryQuery: LLM 扩展补语义召回 (词面无关命中)", async () => {
  const a = makeAgent();
  a.facts.add("止损规则是亏损5%就无条件清仓");
  // 词面无交集 -> 直接 BM25 命中 0
  assert.equal(a.facts.query("风险控制 铁律", { limit: 3 }).length, 0);
  // 注入 fake LLM: 扩展出与记忆词面重叠的变体, 补语义召回
  a.llm = { chat: async () => ({ content: "无条件止损\n亏损清仓" }) };
  const res = await a._memoryQuery("风险控制 铁律", { limit: 3 });
  assert.ok(res.some((x) => x.content.includes("止损")), "LLM 扩展变体命中词面无交集的记忆");
});

// ---- v0.8.1: 语义检索接入自动上下文注入 ----

test("factsTop: 按当前问题语义检索优先 + 衰减兜底", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-ctx-"));
  const factStore = new FactStore(root);
  factStore.add("止损规则是亏损5%就无条件清仓", { importance: 20 });
  factStore.add("资金流驱动的短线策略", { importance: 10 });
  factStore.add("华泰柏瑞杯模拟交易比赛第二轮", { importance: 10 });
  const ticker = new MemoryTicker(root, factStore, null, null);
  // 语义检索: "止损" 相关问题, 止损事实应排最前 (而非纯衰减顺序)
  const top = ticker.factsTop("止损 清仓 规则");
  const lines = top.split("\n");
  assert.ok(lines[0].includes("止损"), `相关记忆应排最前, 实际: ${lines[0]}`);
  // 空查询: 衰减兜底, 仍返回事实
  const empty = ticker.factsTop("");
  assert.ok(empty.includes("止损") || empty.includes("资金流"), "空查询走衰减兜底");
  // 去重: 语义 + 衰减合并不应重复同一条
  assert.equal(new Set(lines).size, lines.length, "合并结果不应重复");
});
