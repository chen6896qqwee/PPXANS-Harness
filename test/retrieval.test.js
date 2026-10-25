// test/retrieval.test.js - 检索质量回归 (BM25 + bigram 精排)
// 固化 benchmark: 老版 Jaccard/长段分词 在这些查询上必挂, 本测试防回退
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { FactStore, rrfFuse } from "../src/memory/fact-store.js";

function seed() {
  const f = new FactStore(fs.mkdtempSync(path.join(os.tmpdir(), "ppx-retr-")));
  f.add("皮皮虾是零依赖纯Node的智能体内核，护城河是四层记忆加自愈", { source: "t" });
  f.add("兄弟主要做A股量化交易，关注资金流驱动的短线策略", { source: "t" });
  f.add("止损规则是亏损5%就无条件清仓，连续亏损2次暂停交易", { source: "t" });
  f.add("不做科创板688和ST股票，只做主板加创业板", { source: "t" });
  f.add("华泰柏瑞杯模拟交易比赛第二轮，2026年7月21日开始", { source: "t" });
  f.add("当前持仓国际复材，发现创业板违规已经修复排除规则", { source: "t" });
  return f;
}

test("检索: BM25+bigram 命中相关事实 (老版必挂项)", () => {
  const f = seed();
  const cases = [
    ["止损 清仓", "止损"],      // 长段分词老版必挂
    ["量化 资金流", "量化"],    // 术语重叠, 老版易错
    ["模拟交易 比赛", "模拟交易"],
    ["科创板 ST", "科创板"],
    ["零依赖 内核", "零依赖"],
    ["持仓 国际复材", "国际复材"],
  ];
  for (const [q, exp] of cases) {
    const r = f.query(q, { limit: 1 });
    assert.ok(r.length >= 1, `"${q}" 应有结果`);
    assert.ok(r[0].content.includes(exp), `"${q}" 应命中 "${exp}", 实际: ${r[0].content.slice(0, 30)}`);
  }
});

test("检索: 空查询返回全部 (按衰减分)", () => {
  const f = seed();
  const r = f.query("", { limit: 10 });
  assert.equal(r.length, f.count(), "空查询应返回全部");
});

test("检索: 无匹配查询返回空 (过滤噪声)", () => {
  const f = seed();
  const r = f.query("飞书 沟通", { limit: 5 });
  assert.equal(r.length, 0, "无交集应返回空, 不塞无关结果");
});

test("检索: 相关优先于弱相关 (排序正确)", () => {
  const f = seed();
  const r = f.query("止损 清仓", { limit: 5 });
  assert.ok(r[0].content.includes("止损"), "止损相关应排最前");
});

test("检索: 英文+数字 token 命中", () => {
  const f = seed();
  const r = f.query("ST 688", { limit: 3 });
  assert.ok(r.some((x) => x.content.includes("ST")), "应命中 ST 记忆");
});

test("检索: scope 隔离 (AML 契约, 防回退)", () => {
  const f = seed();
  f.add("兄弟做A股量化交易", { source: "t", scope: "sA" });
  f.add("散户只关注资金流不看量化", { source: "t", scope: "sB" });
  // sA 查询"量化": 命中自己的, 不混 sB
  const a = f.query("量化 交易", { limit: 5, scope: "sA" });
  assert.ok(a.some((x) => x.content.includes("A股量化")), "sA 命中自己的数据");
  assert.ok(!a.some((x) => x.content.includes("散户")), "sA 不混入 sB");
  // sB 查询"资金流": 命中自己的, 不混 sA
  const b = f.query("资金流", { limit: 5, scope: "sB" });
  assert.ok(b.some((x) => x.content.includes("散户")), "sB 命中自己的数据");
  assert.ok(!b.some((x) => x.content.includes("A股量化")), "sB 不混入 sA");
});

// ---- v0.8.1: importance 入排序 + RRF 融合 (P0/P1) ----

test("检索: importance 入排序 (高重要性优先)", () => {
  const f = seed();
  f.add("止损规则是亏损3%就减仓观察", { importance: 1, source: "t" });
  f.add("止损规则是亏损5%就无条件清仓", { importance: 20, source: "t" });
  // 两条都命中"止损规则", 高 importance(20) 的应排前
  const r = f.query("止损规则", { limit: 2 });
  assert.ok(r.length >= 2, "两条止损记忆都应命中");
  assert.ok(r[0].content.includes("5%"), `高 importance 应排前, 实际首位: ${r[0].content.slice(0, 30)}`);
});

test("rrfFuse 融合多个排序列表 (rank 倒数加权)", () => {
  const a = [{ id: "x", content: "xa" }, { id: "y", content: "ya" }];
  const b = [{ id: "y", content: "ya" }, { id: "z", content: "za" }];
  const fused = rrfFuse([a, b]);
  // x: 1/61, y: 1/62 + 1/61, z: 1/62 -> y 分数最高, 应排最前
  assert.equal(fused.length, 3);
  assert.equal(fused[0].id, "y", "y 在两个列表都靠前, 融合分最高");
  // 无 id 的项被忽略
  assert.equal(rrfFuse([[{ a: 1 }]]).length, 0);
});

test("queryMulti 多查询变体 RRF 融合命中", () => {
  const f = seed();
  const r = f.queryMulti(["止损 规则", "清仓 亏损"], { limit: 3 });
  assert.ok(r.length >= 1, "多查询融合应有结果");
  assert.ok(r[0].content.includes("止损") || r.some((x) => x.content.includes("止损")), "命中止损记忆");
});

// ---- v0.8.2: 可插拔 embedder (dense 语义检索) ----

// 伪 embedder: 基于字符 hash 生成归一化向量 (同字符越多越相似), 仅测 plumbing 不测语义质量
function fakeEmbedder(text) {
  const v = new Array(8).fill(0);
  for (const c of String(text)) v[c.charCodeAt(0) % 8] += 1;
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

test("embedder: _cosine 相似度正确", () => {
  const f = seed();
  assert.equal(f._cosine([1, 0], [1, 0]), 1);
  assert.equal(f._cosine([1, 0], [0, 1]), 0);
  assert.equal(f._cosine(null, [1, 0]), 0);
});

test("embedder: querySemantic 注入 embedder 后 dense 检索", async () => {
  const f = seed();
  f.setEmbedder(fakeEmbedder);
  const r = await f.querySemantic("止损 清仓", { limit: 3 });
  assert.ok(r.length >= 1, "dense 检索应有结果");
  f.setEmbedder(null);
  // 移除后应退化为 BM25
  const r2 = await f.querySemantic("止损 清仓", { limit: 3 });
  assert.ok(r2[0].content.includes("止损"), "无 embedder 退化为 BM25");
});
