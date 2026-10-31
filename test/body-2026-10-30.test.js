// test/body-2026-10-30.test.js
// 「身体」三件套的守卫 (P0 痛觉 / P1 工作内存 / P3 面板数据):
//   ① WorkStack: 跨轮任务栈 —— 增改勾选、自动完成、上限淘汰、重开还在、渲染契约
//   ② buildBodyState: 体征聚合 —— **没跑过就是 unknown, 不编数** (一个会撒谎的仪表盘比没有更糟)
//   ③ task_stack 工具 + prompt 注入: 模型看得到"手头的事", 且它不进静态前缀区
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { WorkStack } from "../src/session/workstack.js";
import { buildBodyState } from "../src/web/bot-api.js";

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${n}-`));

// ---- ① WorkStack ----
test("任务栈: push 幂等 (同目标复用), 不同目标各一条", () => {
  const dir = tmp("ws-push");
  try {
    const s = new WorkStack(dir);
    const a = s.push("修并发问题", { steps: ["读代码", "定位"] });
    const b = s.push("修并发问题");
    assert.equal(a.ok, true);
    assert.equal(b.reused, true, "同目标应复用, 不制造重复条目");
    assert.equal(b.item.id, a.item.id);
    s.push("写文档");
    assert.equal(s.status().total, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("任务栈: 勾完所有步骤自动转 done (省一次显式调用)", () => {
  const dir = tmp("ws-steps");
  try {
    const s = new WorkStack(dir);
    const { item } = s.push("改三个文件", { steps: ["a.js", "b.js"] });
    s.update(item.id, { step: { index: 0, done: true } });
    assert.equal(s.list()[0].status, "active", "还有一步没做完");
    s.update(item.id, { step: { index: 1, done: true } });
    assert.equal(s.list()[0].status, "done", "全做完应自动转 done");
    assert.equal(s.active(), null, "完成的条目不再占着「当前」");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("任务栈: 超上限淘汰最久没动过的 (手头 ≠ 档案)", () => {
  const dir = tmp("ws-cap");
  try {
    const s = new WorkStack(dir);
    for (let i = 0; i < 12; i++) s.push(`任务 ${i}`);
    assert.equal(s.status().total, 8, "上限 8 条");
    const goals = s.list().map((x) => x.goal);
    assert.ok(goals.includes("任务 11"), "最新的必须在");
    assert.equal(goals.includes("任务 0"), false, "最旧的应被淘汰");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("任务栈: 重开还在 (跨轮/跨进程持久化)", () => {
  const dir = tmp("ws-persist");
  try {
    const a = new WorkStack(dir);
    const { item } = a.push("跨轮的事", { steps: ["第一步"] });
    a.update(item.id, { note: "等用户确认" });
    const b = new WorkStack(dir); // 模拟重启
    const it = b.list().find((x) => x.id === item.id);
    assert.ok(it, "重启后条目还在");
    assert.equal(it.note, "等用户确认");
    assert.equal(it.steps.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("任务栈: 无未完成项时 render 返回空串 (零 token)", () => {
  const dir = tmp("ws-render");
  try {
    const s = new WorkStack(dir);
    assert.equal(s.render(), "");
    const { item } = s.push("做完的事");
    assert.ok(s.render().includes("做完的事"));
    s.complete(item.id);
    assert.equal(s.render(), "", "全部完成后不再占 prompt");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("任务栈: render 不含时间戳 (逐字节稳定, 不破坏前缀缓存)", () => {
  const dir = tmp("ws-stable");
  try {
    const s = new WorkStack(dir);
    s.push("稳定的事");
    const r1 = s.render();
    const r2 = s.render();
    assert.equal(r1, r2);
    assert.equal(/\[\d{4}-\d{2}-\d{2}/.test(r1), false, "不得出现日期");
    assert.equal(/\d{1,2}:\d{2}/.test(r1), false, "不得出现时刻");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- ② buildBodyState ----
test("体征: 没跑过探针时必须是 unknown + 给怎么跑, 不编健康值", () => {
  const root = tmp("body-unknown");
  const a = new PPXAgent({ root, configFile: null });
  try {
    const s = buildBodyState({ agent: a });
    assert.equal(s.pain.state, "unknown");
    assert.equal(s.pain.rate, null);
    assert.match(s.pain.hint, /taskbench-offline/, "要告诉人怎么产出这个数");
    assert.equal(s.memory.state, "unknown");
    assert.match(s.memory.hint, /memory-recall/);
    assert.equal(s.overall, "unknown", "数据不全不能自称健康");
  } finally { a.shutdown?.(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("体征: 读到真实报告后给出数值与三态评级", () => {
  const root = tmp("body-report");
  const a = new PPXAgent({ root, configFile: null });
  try {
    const dir = path.join(root, "data", "bench");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "taskbench-offline-2026-10-30.json"),
      JSON.stringify({ ts: new Date().toISOString(), total: 20, passed: 20, rate: 1, ms: 3700, results: [] }));
    fs.writeFileSync(path.join(dir, "memory-recall-2026-10-30.json"),
      JSON.stringify({ ts: new Date().toISOString(), corpus: 20, queries: 15, topK: 3, recall1: 0.33, recallK: 0.6, mrr: 0.478, embedder: "hash(256d)", rows: [] }));
    const s = buildBodyState({ agent: a });
    assert.equal(s.pain.state, "ok", "20/20 = ok");
    assert.equal(s.pain.passed, 20);
    // 60% 的 recall@3 在本项目语境下算「不健康」而不是「注意」—— 阈值 0.8, 别为了好看放宽
    assert.equal(s.memory.state, "bad", "recall@3 60% 偏低");
    assert.equal(s.memory.recallK, 0.6);
    assert.notEqual(s.overall, "ok");
  } finally { a.shutdown?.(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("体征: 任务栈为空时 work 卡片不装作有内容", () => {
  const root = tmp("body-empty");
  const a = new PPXAgent({ root, configFile: null });
  try {
    const s = buildBodyState({ agent: a });
    assert.equal(s.work.total, 0);
    assert.equal(s.work.current, null);
  } finally { a.shutdown?.(); fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- ③ 工具 + prompt 注入 ----
test("task_stack 工具: push 后 prompt 段出现, 且落在动态区 (静态区逐字节不变)", async () => {
  const root = tmp("body-tool");
  const a = new PPXAgent({ root, configFile: null });
  try {
    const before = a._context("同一个问题");
    await a.tools.call("task_stack", { action: "push", goal: "部署到线上", steps: ["打包", "上传"] }, { agent: a });
    const after = a._context("同一个问题");
    assert.ok(after.includes("部署到线上"), "任务栈应注入上下文");
    // 静态区 (人格/边界/价值) 必须一字节不变: 只允许动态段变长
    assert.ok(after.startsWith(before.slice(0, 200)), "静态前缀不得因任务栈改动而位移");
    const listed = JSON.parse(await a.tools.call("task_stack", { action: "list" }, { agent: a }));
    assert.equal(listed.stack.current.goal, "部署到线上");
  } finally { a.shutdown?.(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("task_stack 工具: 未知 action / 缺 goal 给可行动错误, 不静默成功", async () => {
  const root = tmp("body-tool-err");
  const a = new PPXAgent({ root, configFile: null });
  try {
    // enum 校验在工具执行之前拦下 (catalog.validateArgs) —— 早失败比进到执行层再判更好
    const bad = await a.tools.call("task_stack", { action: "nope" }, { agent: a });
    assert.ok(String(bad).startsWith("[工具错误]"), `未知 action 应被参数校验拦下, 实际: ${String(bad).slice(0, 60)}`);
    assert.match(String(bad), /action/);
    const noGoal = JSON.parse(await a.tools.call("task_stack", { action: "push" }, { agent: a }));
    assert.equal(noGoal.ok, false);
    assert.match(noGoal.error, /goal/);
  } finally { a.shutdown?.(); fs.rmSync(root, { recursive: true, force: true }); }
});
