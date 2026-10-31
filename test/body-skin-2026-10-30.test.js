// test/body-skin-2026-10-30.test.js
// 守卫: 身体页的「皮肤层」—— 一句话判断 / 体感文案 / 趋势 / 器官点状态
//
// 这一层最容易出的问题不是崩溃, 是**说得好听**:
//   · 用错分母把 15 句的分数说成 30 句 (样本量凭空翻倍);
//   · 把"没测过"写成"正常";
//   · 趋势只有一个点也画成线。
// 所以断言都打在"这句话能不能被数字支撑"上, 而不是"页面上有没有这个元素"。
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { buildBodyState } from "../src/web/bot-api.js";
import { appendHistory, historyPath, MAX_KEEP } from "../scripts/lib/bench-history.js";

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-skin-${n}-`));

// 造一份探针报告 (含 sets, 与真实 memory-recall.js 的输出同形)
function writeRecall(root, { acceptance, recall1, holdoutQueries = 15, devQueries = 15 } = {}) {
  const dir = path.join(root, "data", "bench");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "memory-recall-2026-10-30.json"), JSON.stringify({
    ts: new Date().toISOString(), corpus: 40, queries: holdoutQueries + devQueries, topK: 3,
    recall1, recallK: 0.5, mrr: 0.6, acceptance, embedder: "hash(256d)",
    sets: [
      { set: "dev", queries: devQueries, recall1: 0.5, recallK: 0.9, mrr: 0.7 },
      { set: "holdout", queries: holdoutQueries, recall1, recallK: acceptance, mrr: 0.8 },
    ],
    rows: [],
  }));
}

test("体感文案的分母必须是验收集的查询数, 不是 dev+holdout 总数", () => {
  const root = tmp("denom");
  const a = new PPXAgent({ root, configFile: null });
  try {
    // 30 个查询里只有 15 个属于验收集 —— 如果拿 30 当分母, 100% 就变成"30 句全对"
    writeRecall(root, { acceptance: 1, recall1: 0.6, holdoutQueries: 15, devQueries: 15 });
    const s = buildBodyState({ agent: a });
    assert.equal(s.memory.queries, 15, "queries 应是验收集的条数");
    assert.match(s.memory.feeling, /15 句/, `体感文案应说 15 句, 实得: ${s.memory.feeling}`);
    assert.ok(!/30 句/.test(s.memory.feeling), "不许把总分母说成 30");
  } finally { a.shutdown?.(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("体感文案与状态一致: 不健康时不许说得好听", () => {
  const root = tmp("tone");
  const a = new PPXAgent({ root, configFile: null });
  try {
    writeRecall(root, { acceptance: 0.47, recall1: 0.33 });
    const s = buildBodyState({ agent: a });
    assert.equal(s.memory.state, "bad");
    // 47% * 15 = 7.05 → 7 句
    assert.match(s.memory.feeling, /7 句/, `应报出具体命中句数, 实得: ${s.memory.feeling}`);
    assert.match(s.memory.feeling, /只有/, "不健康时要明说「只有」, 不能中性描述");
  } finally { a.shutdown?.(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("一句话判断: 有坏项时点名, 不许只说「需要注意」", () => {
  const root = tmp("verdict");
  const a = new PPXAgent({ root, configFile: null });
  try {
    writeRecall(root, { acceptance: 0.4, recall1: 0.3 });
    const s = buildBodyState({ agent: a });
    assert.match(s.verdict, /找不到|记不住|要修/, `判断应点出记忆问题, 实得: ${s.verdict}`);
  } finally { a.shutdown?.(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("一句话判断: 全没测过时说「没量」, 不许自称正常", () => {
  const root = tmp("verdict-unknown");
  const a = new PPXAgent({ root, configFile: null });
  try {
    const s = buildBodyState({ agent: a });
    assert.equal(s.overall, "unknown");
    assert.match(s.verdict, /没测|还没量/, `实得: ${s.verdict}`);
    assert.ok(!/正常/.test(s.verdict), "数据不全时 verdict 里不该出现「正常」");
  } finally { a.shutdown?.(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("器官状态: 四项都有 data-state 可用的值, 且 work 空栈时为 unknown", () => {
  const root = tmp("organs");
  const a = new PPXAgent({ root, configFile: null });
  try {
    const s = buildBodyState({ agent: a });
    for (const k of ["pain", "memory", "work", "load"]) {
      assert.ok(["ok", "warn", "bad", "unknown"].includes(s[k].state), `${k}.state 取值非法: ${s[k].state}`);
      assert.equal(typeof s[k].feeling, "string", `${k}.feeling 必须存在`);
    }
    assert.equal(s.work.state, "unknown", "手头没挂事时不该报 ok");
  } finally { a.shutdown?.(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("器官状态: 有卡住的事时 work 变 warn (不是 ok)", () => {
  const root = tmp("blocked");
  const a = new PPXAgent({ root, configFile: null });
  try {
    const r = a.workStack.push("等用户确认方案");
    assert.ok(r.ok, `push 应成功: ${r.error || ""}`);
    a.workStack.update(r.item.id, { status: "blocked" });
    const s = buildBodyState({ agent: a });
    assert.equal(s.work.state, "warn");
    assert.match(s.work.feeling, /卡住/);
  } finally { a.shutdown?.(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("趋势: 只有一次记录时 history 长度是 1 (前端据此不画线)", () => {
  const root = tmp("hist1");
  const a = new PPXAgent({ root, configFile: null });
  try {
    const dir = path.join(root, "data", "bench");
    appendHistory(dir, "memory-recall", { recall1: 0.3, acceptance: 0.6 });
    const s = buildBodyState({ agent: a });
    assert.deepEqual(s.history.memory, [0.6]);
    assert.equal(s.history.pain.length, 0, "没跑过痛觉探针就不该有点");
  } finally { a.shutdown?.(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("趋势: 多次记录按时间顺序保留, 超过上限截断的是最旧的", () => {
  const dir = tmp("histN");
  try {
    for (let i = 0; i < MAX_KEEP + 8; i++) {
      appendHistory(dir, "memory-recall", { acceptance: i / 100 });
    }
    const lines = fs.readFileSync(historyPath(dir, "memory-recall"), "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, MAX_KEEP, `应保留 ${MAX_KEEP} 条, 实得 ${lines.length}`);
    const first = JSON.parse(lines[0]);
    const last = JSON.parse(lines[lines.length - 1]);
    // 截断必须丢掉最旧的 (从索引 8 开始), 不是最新的一批
    assert.ok(first.acceptance <= 0.09, `首条应是被保留区段的起点, 实得 ${first.acceptance}`);
    assert.ok(last.acceptance > 0.6, `末条应是最新一次, 实得 ${last.acceptance}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("趋势: 老报告没有 acceptance 字段时退回 recallK (不显示成没数据)", () => {
  const root = tmp("legacy");
  const a = new PPXAgent({ root, configFile: null });
  try {
    const dir = path.join(root, "data", "bench");
    fs.mkdirSync(dir, { recursive: true });
    // 2026-10-30 之前的报告形状: 没有 acceptance / sets
    fs.writeFileSync(path.join(dir, "memory-recall-2026-10-29.json"), JSON.stringify({
      ts: new Date().toISOString(), corpus: 20, queries: 15, topK: 3, recall1: 0.33, recallK: 0.6, mrr: 0.478,
    }));
    const s = buildBodyState({ agent: a });
    assert.equal(s.memory.recallK, 0.6, "没有 acceptance 时应退回 recallK");
    assert.equal(s.memory.state, "bad");
  } finally { a.shutdown?.(); fs.rmSync(root, { recursive: true, force: true }); }
});
