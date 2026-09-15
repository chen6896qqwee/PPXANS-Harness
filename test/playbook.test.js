// test/playbook.test.js - P1④: 语境 Playbook 引擎 (ACE 思想, 自研实现)
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PlaybookStore, applyDelta, growAndRefine, renderBullets, lexicalSimilarity, createGate } from "../src/evolve/playbook.js";

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-pb-")); }

test("playbook: ADD 增量合并, 带 kind/evidence_ref", () => {
  const pb = { base: "", bullets: [], version: 1 };
  const { playbook, applied, rejected } = applyDelta(pb, [
    { op: "ADD", kind: "strategy", content: "工具失败先查轨迹再重试", evidence_ref: "trace:42" },
    { op: "ADD", kind: "pitfall", content: "不要在未验证时声称完成" },
  ]);
  assert.equal(applied.length, 2);
  assert.equal(rejected.length, 0);
  assert.equal(playbook.bullets.length, 2);
  assert.equal(playbook.bullets[0].kind, "strategy");
  assert.equal(playbook.bullets[0].evidence_ref, "trace:42");
  assert.deepEqual(playbook.bullets[0].counters, { helpful: 0, harmful: 0 });
});

test("playbook: UPDATE 改内容/计数, REMOVE 删除", () => {
  const pb = { base: "", bullets: [{ id: "b1", kind: "strategy", content: "旧内容", counters: { helpful: 0, harmful: 0 } }], version: 1 };
  const { playbook, applied } = applyDelta(pb, [
    { op: "UPDATE", id: "b1", content: "新内容", counters: { helpful: 1 } },
  ]);
  assert.equal(playbook.bullets[0].content, "新内容");
  assert.equal(playbook.bullets[0].counters.helpful, 1);

  const { playbook: pb2, applied: applied2 } = applyDelta(playbook, [{ op: "REMOVE", id: "b1" }]);
  assert.equal(pb2.bullets.length, 0);
  assert.equal(applied2.length, 1);
});

test("playbook: 语义重复 ADD 被拒收 (grow-and-refine)", () => {
  const pb = { base: "", bullets: [{ id: "b1", kind: "strategy", content: "失败后先查看审计链再重试操作", counters: { helpful: 0, harmful: 0 } }], version: 1 };
  const { applied, rejected } = applyDelta(pb, [
    { op: "ADD", content: "失败后应查看审计链再重试操作" }, // 近义
  ]);
  assert.equal(applied.length, 0);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /重复/);
});

test("playbook: 未知 op / 缺内容被拒收且不影响其他", () => {
  const pb = { base: "", bullets: [], version: 1 };
  const { applied, rejected } = applyDelta(pb, [
    { op: "BOGUS", content: "x" },
    { op: "ADD", content: "   " },
    { op: "ADD", content: "有效条目" },
  ]);
  assert.equal(applied.length, 1);
  assert.equal(rejected.length, 2);
});

test("playbook: 容量保护裁剪最弱条目", () => {
  const bullets = [];
  for (let i = 0; i < 5; i++) bullets.push({ id: "b" + i, kind: "strategy", content: "条目" + i, counters: { helpful: 0, harmful: i >= 3 ? 5 : 0 } });
  const pb = { base: "", bullets, version: 1 };
  const { playbook } = applyDelta(pb, [], { maxBullets: 3 });
  assert.equal(playbook.bullets.length, 3, "裁剪到上限");
  assert.ok(!playbook.bullets.some((b) => b.id === "b3" || b.id === "b4"), "有害条目被优先裁剪");
});

test("playbook: growAndRefine 裁剪 harmful-帮助 > 阈值", () => {
  const pb = { base: "", bullets: [
    { id: "b1", kind: "strategy", content: "好策略", counters: { helpful: 5, harmful: 0 } },
    { id: "b2", kind: "strategy", content: "坏策略", counters: { helpful: 0, harmful: 5 } },
  ], version: 1 };
  const { playbook, pruned } = growAndRefine(pb, { pruneAt: 3 });
  assert.equal(playbook.bullets.length, 1);
  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].id, "b2");
});

test("playbook: renderBullets 空 playbook 返回空串 (零 token 成本)", () => {
  assert.equal(renderBullets({ bullets: [] }), "");
  assert.equal(renderBullets(null), "");
  const pb = { bullets: [{ kind: "pitfall", content: "别瞎承诺" }] };
  assert.ok(renderBullets(pb).includes("别瞎承诺"));
  assert.ok(renderBullets(pb).includes("[pitfall]"));
});

test("playbook: 门禁 commit —— 基准不过自动回滚 (不落盘)", async () => {
  const dir = tmpDir();
  const store = new PlaybookStore(dir);
  store.save({ base: "", bullets: [{ id: "keep", kind: "strategy", content: "原有", counters: { helpful: 0, harmful: 0 } }], version: 1 });

  const gate = createGate(async (pb) => {
    // 回归基准: 禁止出现"危险"字样
    return !JSON.stringify(pb).includes("危险");
  });
  const r = await store.apply(
    [{ op: "ADD", content: "这是一条危险策略" }],
    { gate },
  );
  assert.equal(r.committed, false, "基准未过 → 拒绝");
  assert.match(r.reason, /回归基准/);
  // rollback: 磁盘仍是原 playbook
  const reloaded = new PlaybookStore(dir);
  assert.equal(reloaded.playbook.bullets.length, 1);
  assert.equal(reloaded.playbook.bullets[0].id, "keep");
});

test("playbook: 门禁 commit —— 基准通过才落盘", async () => {
  const dir = tmpDir();
  const store = new PlaybookStore(dir);
  const gate = createGate(async () => true);
  const r = await store.apply([{ op: "ADD", content: "好策略" }], { gate });
  assert.equal(r.committed, true);
  const reloaded = new PlaybookStore(dir);
  assert.equal(reloaded.playbook.bullets.length, 1);
});

test("playbook: lexicalSimilarity 词法相似度", () => {
  assert.ok(lexicalSimilarity("失败后查看审计链", "失败后查看审计链重试") > 0.5);
  assert.ok(lexicalSimilarity("买股票", "做红烧肉") < 0.2);
  assert.equal(lexicalSimilarity("", "abc"), 0);
});

test("playbook: PlaybookStore 持久化 + setBase", () => {
  const dir = tmpDir();
  const store = new PlaybookStore(dir);
  store.setBase("静态基底");
  store.apply([{ op: "ADD", content: "策略一" }]);
  const store2 = new PlaybookStore(dir);
  assert.equal(store2.playbook.base, "静态基底");
  assert.equal(store2.playbook.bullets.length, 1);
});
