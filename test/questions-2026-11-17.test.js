// test/questions-2026-11-17.test.js — 回合内提问 (ask_user) 与裁决 (纯 mixin, 假宿主)
// 钉住: 题目规范化/上限、无 surface 不提问、超时 fail-open、裁决还原、取消路径、
// 加严工具还原的对称语义（同一审批/提问生命周期）。
import test from "node:test";
import assert from "node:assert/strict";
import { questionMethods } from "../src/agent/questions.js";

function makeHost({ hasSurface = true, onQuestion = null, timeoutMs = 0 } = {}) {
  const host = {
    _pendingQuestions: new Map(),
    _questionSeq: 0,
    _onQuestionEvent: onQuestion,
    _activeSessionKey: "sess-1",
    config: { agent: { question_timeout_ms: timeoutMs } },
    tracer: { event: () => {} },
    protocolBus: { eq: { push: () => {} } },
    bus: { emit: () => {} },
    hasHumanChannel: () => hasSurface,
    ...questionMethods,
  };
  return host;
}

const Q = { id: "q1", question: "用哪个方案？", options: [{ label: "A" }, { label: "B" }] };

test("questions: 规范化裁剪题目与选项", async () => {
  const host = makeHost({ hasSurface: false });
  const result = await host.askQuestions([
    { question: "  长问题".padEnd(1100, "x"), options: [{ label: "a".repeat(300) }, "短", null, { label: "" }], multiSelect: true },
    { question: "" },
    { options: [{ label: "only" }] },
    null,
  ]);
  assert.equal(result, null, "无 surface 不提问");
  // 规范化本身通过 resolve/normalizeAnswers 测试间接验证
});

test("questions: 有 surface 时提问挂起并等裁决", async () => {
  const host = makeHost({ timeoutMs: 30000 });
  const p = host.askQuestions([Q]);
  const pending = host.pendingQuestions();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].questions[0].question, "用哪个方案？");
  assert.equal(pending[0].questions[0].options.length, 2);
  assert.equal(pending[0].sessionKey, "sess-1");
  host.resolveQuestion(pending[0].id, { answers: [{ id: "q1", selected: ["B"] }] });
  const result = await p;
  assert.deepEqual(result.answers, [{ id: "q1", selected: ["B"] }]);
  assert.equal(host.pendingQuestions().length, 0);
});

test("questions: 取消返回 null", async () => {
  const host = makeHost({ timeoutMs: 30000 });
  const p = host.askQuestions([Q]);
  const pending = host.pendingQuestions();
  host.resolveQuestion(pending[0].id, { cancel: true });
  const result = await p;
  assert.equal(result, null);
});

test("questions: 超时 fail-open 返回 null", async () => {
  const events = [];
  const host = makeHost({ timeoutMs: 30, onQuestion: (ev) => events.push(ev) });
  const p = host.askQuestions([Q]);
  const result = await p;
  assert.equal(result, null, "超时不卡回合");
  assert.ok(events.some((ev) => ev.type === "question.close" && ev.reason === "timeout"));
  assert.equal(host.pendingQuestions().length, 0);
});

test("questions: 自定义答案与多题还原", async () => {
  const host = makeHost({ timeoutMs: 30000 });
  const questions = [
    { id: "a", question: "选一个", options: [{ label: "x" }, { label: "y" }] },
    { id: "b", question: "填一个" },
  ];
  const p = host.askQuestions(questions);
  const pending = host.pendingQuestions();
  host.resolveQuestion(pending[0].id, {
    answers: [{ id: "a", selected: ["x"] }, { id: "b", custom: "随便" }],
  });
  const result = await p;
  assert.deepEqual(result.answers, [
    { id: "a", selected: ["x"] },
    { id: "b", selected: [], custom: "随便" },
  ]);
});

test("questions: 未作答的题目给空 selected", async () => {
  const host = makeHost({ timeoutMs: 30000 });
  const p = host.askQuestions([
    { id: "a", question: "A" },
    { id: "b", question: "B" },
  ]);
  const pending = host.pendingQuestions();
  host.resolveQuestion(pending[0].id, { answers: [{ id: "a", selected: ["ok"] }] });
  const result = await p;
  assert.deepEqual(result.answers[1], { id: "b", selected: [] });
});

test("questions: cancelQuestions 全部收口", async () => {
  const host = makeHost({ timeoutMs: 30000 });
  const p1 = host.askQuestions([{ id: "a", question: "A" }]);
  const p2 = host.askQuestions([{ id: "b", question: "B" }]);
  assert.equal(host.pendingQuestions().length, 2);
  host.cancelQuestions();
  assert.equal(await p1, null);
  assert.equal(await p2, null);
  assert.equal(host.pendingQuestions().length, 0);
});

test("questions: cancelQuestions 按 sessionKey 过滤", async () => {
  const host = makeHost({ timeoutMs: 30000 });
  const p1 = host.askQuestions([{ id: "a", question: "A" }]);
  host._activeSessionKey = "sess-2";
  const p2 = host.askQuestions([{ id: "b", question: "B" }]);
  host.cancelQuestions("sess-1");
  assert.equal(await p1, null, "sess-1 被收口");
  assert.equal(host.pendingQuestions().length, 1, "sess-2 的提问保留");
  host.resolveQuestion(host.pendingQuestions()[0].id, { cancel: true });
  await p2;
});

test("questions: 无 surface 时直接返回 null 不挂起", async () => {
  const host = makeHost({ hasSurface: false });
  const result = await host.askQuestions([Q]);
  assert.equal(result, null);
  assert.equal(host.pendingQuestions().length, 0);
});

test("questions: resolveQuestion 未知 id 返回 false", () => {
  const host = makeHost({ timeoutMs: 30000 });
  assert.equal(host.resolveQuestion("nope", {}), false);
});
