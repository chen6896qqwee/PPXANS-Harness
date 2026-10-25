// test/audit.test.js - Auditor: 独立验证闸门 + 已验证账本 + held-out 回归 (P0① + P0②)
// 对应 LongHorizon-Harness MEA / Self-Harness 共识: 不信任模型自评, 只有验证通过的事实才写回持久状态。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Auditor, verifyLesson, heldOutSplit } from "../src/audit/verifier.js";
import { verifySkill } from "../src/skills/verify.js";
import { PPXAgent } from "../src/agent/index.js";

const GOOD = "## 流程\n1. 调用 read_file 读文件\n2. 检查路径\n## 反合理化\n偷懒=拒绝\n## 验证\n输出文件内容";

// ---------- verifyLesson: 经验确定性闸门 ----------
test("verifyLesson: 接地+可操作经验 通过", () => {
  const r = verifyLesson({
    lesson: "run_command 失败后先检查退出码再重试",
    failedTraces: [{ tool: "run_command", ok: false }, { tool: "get_time", ok: false }],
    knownTools: ["run_command", "read_file", "get_time"],
  });
  assert.equal(r.ok, true);
});

test("verifyLesson: 空经验被拦", () => {
  const r = verifyLesson({ lesson: "   ", failedTraces: [{ tool: "x", ok: false }], knownTools: ["x"] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /为空/);
});

test("verifyLesson: 无可操作动词的泛泛描述被拦", () => {
  const r = verifyLesson({
    lesson: "历经一番探索之后收获了许多值得长期沉淀的想法与认知方法",
    failedTraces: [{ tool: "run_command", ok: false, tool2: 1 }],
    knownTools: ["run_command"],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /可操作动词/);
});

test("verifyLesson: 点名未失败的工具经验被拦 (幻觉接地)", () => {
  const r = verifyLesson({
    lesson: "调用 fetch_page 前必须检查返回状态码",
    failedTraces: [{ tool: "run_command", ok: false }, { tool: "rest_api", ok: false, tool2: 1 }],
    knownTools: ["run_command", "fetch_page", "rest_api"],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /疑似幻觉|无背书/);
});

test("verifyLesson: 点名真实失败工具通过接地", () => {
  const r = verifyLesson({
    lesson: "fetch_page 超时后先降级重试再报错",
    failedTraces: [{ tool: "fetch_page", ok: false }],
    knownTools: ["fetch_page"],
  });
  assert.equal(r.ok, true);
});

// ---------- held-out 切分 ----------
test("heldOutSplit: 样本充足时按最新作 held-out, 不重叠", () => {
  const t = Array.from({ length: 10 }, (_, i) => ({ i }));
  const { train, heldOut, skipped } = heldOutSplit(t, { ratio: 0.4, minTotal: 6 });
  assert.equal(skipped, false);
  assert.equal(train.length + heldOut.length, 10);
  const ids = train.map((x) => x.i);
  assert.ok(!heldOut.some((x) => ids.includes(x.i)), "train 与 held-out 不重叠");
  assert.ok(heldOut.length >= 1);
});

test("heldOutSplit: 样本不足则跳过 held-out 强制", () => {
  const { skipped, heldOut } = heldOutSplit([{ tool: "a" }, { tool: "b" }], { minTotal: 6 });
  assert.equal(skipped, true);
  assert.equal(heldOut.length, 0);
});

// ---------- verifySkill held-out 回归 (防过拟合) ----------
test("verifySkill: held-out 里接地工具无背书 → 拒 (过拟合训练集)", () => {
  // read_file 只在旧(训练)轨迹, 最新 held-out 全是 list_dir → 拒
  const okTraces = [read_file, read_file, read_file, read_file, list, list];
  const r = verifySkill({ name: "fr", content: GOOD, hotTools: ["read_file"], okTraces, minFreq: 2, heldOutTraces: [list, list] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /held-out/);
});

test("verifySkill: held-out 里接地工具也有背书 → 过", () => {
  const r = verifySkill({ name: "fr", content: GOOD, hotTools: ["read_file"], okTraces: [read_file, read_file, read_file], minFreq: 2, heldOutTraces: [read_file] });
  assert.equal(r.ok, true);
});

// ---------- Auditor: 唯一已验证写回通道 ----------
test("Auditor: 验证通过才 commit 并记账本", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-aud-"));
  const aud = new Auditor({ ledgerPath: path.join(dir, "verified.json") });
  let wrote = 0;
  const r = await aud.gate("lesson", { lesson: "先检查再重试" }, (p) => ({ ok: true }), () => { wrote++; });
  assert.equal(r.committed, true);
  assert.equal(wrote, 1, "验证通过才写实库");
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, "verified.json"), "utf8"));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].kind, "lesson");
  assert.equal(aud.stats().byKind.lesson, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Auditor: 验证失败不写库, 记账 reject", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-aud2-"));
  const aud = new Auditor({ ledgerPath: path.join(dir, "verified.json") });
  let wrote = 0;
  const r = await aud.gate("lesson", { lesson: "" }, (p) => ({ ok: false, reason: "经验为空" }), () => { wrote++; });
  assert.equal(r.committed, false);
  assert.equal(wrote, 0, "未通过验证绝不写实库");
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, "verified.json"), "utf8"));
  assert.equal(ledger[0].kind, "reject_lesson");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- refine 集成: 经验必须过闸门 ----------
function makeAgent() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-aud-agent-"));
  return new PPXAgent({ root, configFile: null });
}

test("refine 集成: 幻觉经验(点名未失败工具)被拦, 不写经验库", async () => {
  const a = makeAgent();
  a.llm = { chat: async () => ({ content: "调用 fetch_page 前必须检查状态码" }) };
  a.traces.read = () => [{ ok: false, tool: "run_command", error: "EACCES" }, { ok: false, tool: "get_time", error: "bad" }];
  let learned = false;
  a.experience.learn = () => { learned = true; };
  const r = await a.refine({ limit: 10 });
  assert.equal(r.distilled, 0);
  assert.equal(r.rejected, true, "幻觉经验应被闸门拒绝");
  assert.ok(r.reason, "应有拒绝原因");
  assert.equal(learned, false, "拒绝的经验绝不能写经验库");
  a.shutdown(); fs.rmSync(a.root, { recursive: true, force: true });
});

test("refine 集成: 接地+可操作经验 通过闸门写库", async () => {
  const a = makeAgent();
  a.llm = { chat: async () => ({ content: "run_command 失败后先检查退出码再重试" }) };
  a.traces.read = () => [{ ok: false, tool: "run_command", error: "EACCES" }, { ok: false, tool: "get_time", error: "bad" }];
  let got = null;
  a.experience.learn = (x) => { got = x; };
  const r = await a.refine({ limit: 10 });
  assert.equal(r.distilled, 1);
  assert.ok(r.lesson.includes("run_command"));
  assert.ok(got && got.lesson.includes("退出码"), "闸门通过的经验应写库");
  assert.deepEqual(got.tags, ["auto-refine"]);
  a.shutdown(); fs.rmSync(a.root, { recursive: true, force: true });
});

test("refineSkill 集成: 仅训练集接地、held-out 无背书 → 拒 (过拟合)", async () => {
  const a = makeAgent();
  a.llm = { chat: async () => ({ content: JSON.stringify({ name: "overfit-sk", description: "d", content: GOOD }) }) };
  // 6 条成功: read_file 全是旧(训练), 最新 2 条是 list_dir → held-out(最新40%≈2条) 无 read_file → 拒
  a.traces.read = () => [
    { ok: true, tool: "read_file", result: "a" }, { ok: true, tool: "read_file", result: "b" },
    { ok: true, tool: "read_file", result: "c" }, { ok: true, tool: "read_file", result: "d" },
    { ok: true, tool: "list_dir", result: "e" }, { ok: true, tool: "list_dir", result: "f" },
  ];
  const r = await a.refineSkill({ limit: 10, minFreq: 2 });
  assert.equal(r.created, 0);
  assert.equal(r.rejected, true);
  assert.match(String(r.reason), /held-out/);
  a.shutdown(); fs.rmSync(a.root, { recursive: true, force: true });
});

function mk(tool) { return ({ tool }); }
const read_file = mk("read_file");
const list = mk("list_dir");
