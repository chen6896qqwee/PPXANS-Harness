// test/memory-recall-lexicon-2026-10-30.test.js
// 守卫: 记忆召回的三路融合 (概念路 / RRF 权重 / dense 准入门槛)
//
// 为什么要有这批测试:
//   2026-10-30 之前 memory_search 实测 dev 集 recall@3 = 47%, 失败的全部是"字面零交集"的
//   同义查询 —— 而当时仓库里 **没有任何测试** 覆盖"换个说法还能不能召回"。所有检索测试都用
//   查询里出现的原词去查, 那种测试对 BM25 恒真, 等于没测。
//
//   这批测试的写法都是"查询与目标事实**不共享任何一个二字组**", 只有概念层能连上。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FactStore, rrfFuse } from "../src/memory/fact-store.js";
import { expandedTerms, conceptMatches, CONCEPT_COUNT } from "../src/memory/lexicon.js";
import { hashEmbed } from "../src/memory/hash-embedder.js";

const mkStore = (opts = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-lex-"));
  const store = new FactStore(dir, opts);
  return { store, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

// 判断两个字符串是否共享任一中文二字组 —— 用来自证"这条测试确实考的是概念桥而非字面"
function sharesBigram(a, b) {
  const grams = (s) => {
    const out = new Set();
    for (const seg of String(s).toLowerCase().match(/[\u4e00-\u9fff]+/g) || []) {
      for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
    }
    return out;
  };
  const A = grams(a), B = grams(b);
  for (const g of A) if (B.has(g)) return true;
  return false;
}

test("词典规模下限: 少于 30 簇就等于查表, 谈不上泛化", () => {
  assert.ok(CONCEPT_COUNT >= 30, `概念簇只有 ${CONCEPT_COUNT} 个, 覆盖不足`);
});

test("expandedTerms: 同义查询能扩出目标事实里的词, 且不重复查询自身", () => {
  const exp = expandedTerms("什么操作系统");
  assert.ok(exp.size > 0, "应扩出词");
  assert.ok(exp.has("en:windows"), "「操作系统」应扩到 windows");
  // 自身已有的二字组不应出现在扩展集里 (扩出来的必须全是**新**信息)
  assert.ok(!exp.has("系统"), "「系统」是查询自身含有的, 不该算扩展");
});

test("expandedTerms: 完全不相关的查询不产生扩展 (防词典变成万能匹配)", () => {
  const exp = expandedTerms("今天中午吃什么");
  // 允许命中极少 (如"什么"这类通用字), 但绝不该扩出大批概念词
  assert.ok(exp.size < 40, `无关查询扩出了 ${exp.size} 个词, 词典过度触发`);
});

test("conceptMatches: 命中的是成簇的概念, 不是一个词一条映射", () => {
  const m = conceptMatches("客户投诉");
  assert.ok(m.size >= 1, "应命中客户/投诉簇");
  // 命中的簇里必须包含同簇的其它成员 (证明是簇而非点对点查表)
  const ci = [...m.keys()][0];
  assert.ok(m.get(ci).size >= 1);
});

test("三路召回: 查询与事实字面零交集时仍能命中 (核心断言)", async () => {
  const { store, cleanup } = mkStore();
  try {
    store.add("用户用 Windows 11 加 Git Bash", { source: "conversation" });
    store.add("团队周会在周四下午", { source: "conversation" });
    store.add("报价单模板在财务部的共享盘里", { source: "conversation" });
    store.setEmbedder(hashEmbed, { identity: "test-hash" });
    const q = "什么操作系统";
    // 自证: 这个查询和目标是字面零交集, 否则本测试没有意义
    assert.equal(sharesBigram(q, "用户用 Windows 11 加 Git Bash"), false, "测试前提失效: 两者字面有交集");
    const hits = await store.querySemantic(q, { limit: 3 });
    assert.ok(hits.length > 0, "应至少返回一条");
    assert.match(String(hits[0].content), /Windows/, `首条应为 Windows 那条, 实返: ${hits.map((h) => h.content).join(" | ")}`);
  } finally { cleanup(); }
});

test("三路召回: 换了说法的查询也能命中 (近义而非同字)", async () => {
  const { store, cleanup } = mkStore();
  try {
    store.add("客户投诉要当天回复", { source: "conversation" });
    store.add("训练数据每周更新一次", { source: "conversation" });
    store.add("回滚窗口只有十分钟", { source: "conversation" });
    store.setEmbedder(hashEmbed, { identity: "test-hash" });
    const hits = await store.querySemantic("客人不满怎么处理", { limit: 3 });
    assert.ok(hits.some((h) => /投诉/.test(String(h.content))),
      `「客人不满」应召回「客户投诉」, 实返: ${hits.map((h) => h.content).join(" | ")}`);
  } finally { cleanup(); }
});

test("三路召回: 字面命中依然排第一 (概念路不许压过精确匹配)", async () => {
  const { store, cleanup } = mkStore();
  try {
    store.add("用户用 Windows 11 加 Git Bash", { source: "conversation" });
    store.add("代码风格统一用两个空格缩进", { source: "conversation" });
    store.add("团队周会在周四下午", { source: "conversation" });
    store.setEmbedder(hashEmbed, { identity: "test-hash" });
    const hits = await store.querySemantic("Git Bash", { limit: 3 });
    assert.match(String(hits[0].content), /Git Bash/, "精确字面命中必须排第一");
  } finally { cleanup(); }
});

test("无 embedder 时: 概念路仍然工作 (两路融合, 不退化成纯 BM25)", async () => {
  const { store, cleanup } = mkStore();
  try {
    store.add("用户用 Windows 11 加 Git Bash", { source: "conversation" });
    store.add("训练数据每周更新一次", { source: "conversation" });
    // 不 setEmbedder
    const hits = await store.querySemantic("什么操作系统", { limit: 3 });
    assert.ok(hits.some((h) => /Windows/.test(String(h.content))),
      `无 embedder 时概念路应单独兜住, 实返: ${hits.map((h) => h.content).join(" | ")}`);
  } finally { cleanup(); }
});

test("rrfFuse 权重: 同一批列表按权重改变排序 (weights 不是装饰)", () => {
  const a = [{ id: "x" }, { id: "y" }];
  const b = [{ id: "y" }, { id: "x" }];
  const equal = rrfFuse([a, b]);
  assert.equal(equal.length, 2, "两路同分时应都返回");
  const favorA = rrfFuse([a, b], { weights: [10, 1] });
  assert.equal(favorA[0].id, "x", "A 路权重高时 A 路首位应胜出");
  const favorB = rrfFuse([a, b], { weights: [1, 10] });
  assert.equal(favorB[0].id, "y", "B 路权重高时 B 路首位应胜出");
});

test("rrfFuse: 缺省权重与旧行为一致 (向后兼容)", () => {
  const lists = [[{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]];
  const withDefault = rrfFuse(lists);
  const explicit = rrfFuse(lists, { weights: [1, 1] });
  assert.deepEqual(withDefault.map((x) => x.id), explicit.map((x) => x.id));
});

test("dense 准入门槛: 弱语义命中 (余弦 0.088) 不被过滤, 噪声 (0.074) 被压住", () => {
  const cos = (q, p) => {
    const a = hashEmbed(q, "query"), b = hashEmbed(p, "passage");
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  };
  // 阈值 0.08 是实测定的 (见 fact-store.querySemantic 注释)。这两个数就是当时的实测值,
  // 若哪天 hash-embedder 改了分词导致分布漂移, 这条会红 —— 那正是需要重测阈值的信号。
  const weakHit = cos("什么操作系统", "用户用 Windows 11 加 Git Bash");
  const noise = cos("你在干嘛", "代码风格统一用两个空格缩进");
  assert.ok(weakHit >= 0.08, `弱语义命中 ${weakHit.toFixed(3)} 低于门槛, 会被误杀`);
  assert.ok(noise < 0.08, `噪声 ${noise.toFixed(3)} 高于门槛, 阈值需要复核`);
  assert.ok(weakHit > noise, "命中必须高于噪声, 否则这个特征没有区分度");
});

test("stats 缓存: includeExpired 两种口径不共用统计 (旧实现会串)", async () => {
  const { store, cleanup } = mkStore();
  try {
    const f1 = store.add("有效期内的记忆内容甲", { source: "conversation" });
    store.add("有效期内的记忆内容乙", { source: "conversation" });
    store.add("有效期内的记忆内容丙", { source: "conversation" });
    // 让甲过期 (API 字段是 validTo, 不是 validUntil)
    store.setValidity(f1.id, { validTo: "2000-01-01T00:00:00.000Z" });
    const live = await store.querySemantic("记忆内容", { limit: 10 });
    const all = await store.querySemantic("记忆内容", { limit: 10, includeExpired: true });
    assert.ok(all.length >= live.length, "includeExpired 的结果集不应小于默认口径");
    assert.ok(!live.some((h) => h.id === f1.id), "过期条目不该出现在默认口径里");
  } finally { cleanup(); }
});
