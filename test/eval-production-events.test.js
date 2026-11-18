import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runWithTrace,
  currentTrace,
  sampleEvalTask,
} from "../src/core/trace.js";
import { Traces } from "../src/utils/trace.js";
import { logicalDay } from "../src/utils/store.js";
import { PPXAgent } from "../src/agent/index.js";
import { summarizeCalls } from "../scripts/eval-ledger-report.js";

const STRATA = {
  business: "coding",
  complexity: "medium",
  language: "zh",
  toolchain: "node",
  risk: "low",
};

function tmpDir(t, tag = "events") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-eval-${tag}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeAgent(t, tag = "agent") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-eval-${tag}-`));
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data"), globalDataDir: path.join(root, "global") });
  agent.config.agent.localIntent = false;
  t.after(() => {
    try { agent.shutdown(); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  return agent;
}

function events(agent, evt = null) {
  const file = path.join(agent.dataDir, "logs", "traces", `${logicalDay()}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line)).filter((event) => !evt || event.evt === evt);
}

function taskEvents(agent, taskId, evt = null) {
  return events(agent, evt).filter((event) => event.taskId === taskId);
}

test("任务级分层采样确定性, 5% 非全选, 边界比例与安全全留", async (t) => {
  const first = sampleEvalTask("task-deterministic", STRATA);
  assert.deepEqual(first, sampleEvalTask("task-deterministic", STRATA));
  assert.deepEqual(sampleEvalTask("task-zero", STRATA, 0), {
    sampled: false, sampleWeight: 0, sampleReason: "stratified",
  });
  assert.deepEqual(sampleEvalTask("task-all", STRATA, 1), {
    sampled: true, sampleWeight: 1, sampleReason: "stratified",
  });
  const defaultSamples = Array.from({ length: 200 }, (_, i) => sampleEvalTask(`task-${i}`, STRATA));
  const sampledCount = defaultSamples.filter((sample) => sample.sampled).length;
  assert.ok(sampledCount > 0 && sampledCount < 200, `5% 抽样不能退化成全选/全不选: ${sampledCount}`);
  assert.equal(defaultSamples.find((sample) => sample.sampled).sampleWeight, 20, "5% 样本逆概率权重必须为 20");
  assert.ok(defaultSamples.filter((sample) => !sample.sampled).every((sample) => sample.sampleWeight === 0));

  const traces = new Traces(tmpDir(t, "sampling"));
  await runWithTrace(async () => {
    traces.record({ tool: "read_file", args: {}, result: "ok", ok: true, durationMs: 1 });
    assert.equal(traces.recordEval("eval/tool", { tool: "read_file", ok: true, result: "ok" }), null);
    const safety = traces.recordEval("eval/tool", {
      tool: "write_file", ok: false, result: "denied", category: "denied_by_design",
    });
    assert.equal(safety.sampleWeight, 1);
    assert.equal(safety.sampleReason, "safety");
    assert.equal(currentTrace().taskId, "sampling-off");
    assert.ok(currentTrace().traceId.startsWith("t_"));
  }, { taskId: "sampling-off", evalSampleRate: 0, strata: STRATA, sessionKey: "s-safe" });

  const all = traces.read(logicalDay(), 100);
  assert.equal(all.filter((event) => event.evt === "tool/call").length, 1, "普通日志不受 0% 采样影响");
  assert.equal(all.filter((event) => event.evt === "eval/tool").length, 1, "未抽样普通任务仍保留安全事件");
  assert.equal(traces.stats().count, 1, "eval/tool 不进入旧 stats");
  assert.equal(traces.verifyReplay().ok, true, "eval 事件不破坏 replay 校验");
  assert.equal(traces.verifyReplay().total, 1, "eval 事件也不改变旧 replay total");
});

test("recordEval 保留任务关联/五维 strata/权重且账本按 taskId 聚合", async (t) => {
  const traces = new Traces(tmpDir(t, "fields"), currentTrace);
  await runWithTrace(async () => {
    traces.recordEval("eval/request", {
      model: "gpt-4o-mini", durationMs: 12, totalTokens: 8, costUsd: 0.001, priced: true,
    });
    traces.recordEval("eval/tool", { tool: "read_file", args: {}, result: "ok", ok: true, category: "success" });
    traces.recordEval("eval/turn", { taskOk: true, status: "closed" });
  }, {
    taskId: "task-fields", traceId: "trace-fields", sessionKey: "shared-session",
    strata: { business: "coding", complexity: "high" }, evalSampleRate: 1,
  });

  const all = traces.read(logicalDay(), 100);
  assert.equal(all.length, 3);
  for (const event of all) {
    assert.equal(event.taskId, "task-fields");
    assert.equal(event.traceId, "trace-fields");
    assert.equal(event.sessionKey, "shared-session");
    assert.equal(event.sampleWeight, 1);
    assert.deepEqual(event.strata, {
      business: "coding", complexity: "high", language: "unknown", toolchain: "unknown", risk: "unknown",
    });
  }
  const summary = summarizeCalls(all);
  assert.equal(summary.taskSuccess.total, 1);
  assert.equal(summary.taskSuccess.ok, 1);
  assert.equal(summary.successfulTaskCost.totalTokens, 8);
  assert.equal(summary.successfulTaskCost.amount, 0.001);
  assert.equal(Object.keys(summary.byStrata).length, 1);
});

test("准入早拒绝安全全留, unknown_tool 与 schema 参数幻觉均有显式类别", async (t) => {
  const agent = makeAgent(t, "early");
  agent.permissions = { check: async () => ({ decision: "deny", reason: "test deny" }) };
  await runWithTrace(
    () => agent._runTool("write_file", { path: "x", content: "y" }),
    { taskId: "early-denied", evalSampleRate: 0, strata: STRATA },
  );
  const denied = taskEvents(agent, "early-denied", "eval/tool");
  assert.equal(denied.length, 1);
  assert.equal(denied[0].category, "denied_by_design");
  assert.equal(denied[0].sampleReason, "safety");

  agent.permissions = null;
  agent._markWorkReplayUnsafe = () => true;
  agent._recordWorkCheckpoint = () => {};
  await runWithTrace(async () => {
    await agent._runTool("definitely_missing_tool", {});
    await agent._runTool("write_file", {});
  }, { taskId: "early-invalid", evalSampleRate: 1, strata: STRATA });
  const invalid = taskEvents(agent, "early-invalid", "eval/tool");
  assert.ok(invalid.some((event) => event.tool === "definitely_missing_tool" && event.category === "unknown_tool"));
  assert.ok(invalid.some((event) => event.tool === "write_file" && event.category === "parameter_hallucination"));
});

test("bad JSON 在工具执行前记录 parameter_hallucination, 仍让模型收口", async (t) => {
  const agent = makeAgent(t, "bad-json");
  let round = 0;
  const llm = {
    model: "stub",
    apiChat: async () => {
      if (round++ === 0) {
        return { message: { role: "assistant", content: null, tool_calls: [{
          id: "bad-json-1", type: "function",
          function: { name: "read_file", arguments: "{not-json" },
        }] } };
      }
      return { message: { role: "assistant", content: "done" } };
    },
  };
  const reply = await runWithTrace(
    () => agent._llmWithTools([{ role: "user", content: "read" }], llm),
    { taskId: "bad-json", evalSampleRate: 1, strata: STRATA },
  );
  assert.equal(reply, "done");
  const calls = taskEvents(agent, "bad-json", "eval/tool");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].category, "parameter_hallucination");
  assert.equal(calls[0].ok, false);
  assert.equal(calls[0].args, "{not-json");
});

test("TOOL_ENVELOPE 记录 shadow_call, 普通 closed 不冒充业务成功且最终 turn 只写一次", async (t) => {
  const agent = makeAgent(t, "shadow");
  const llm = {
    model: "stub",
    supportsNativeToolCalls: true,
    apiChat: async () => ({ message: { role: "assistant", content: "<tool_call>{\"name\":\"missing\"}</tool_call>" } }),
  };
  agent.llm = llm;
  agent.allProviders = [llm];
  await agent.chat("shadow", {
    taskId: "shadow-turn", sessionKey: "shadow", persist: false, evalSampleRate: 1, strata: STRATA,
  });
  assert.equal(taskEvents(agent, "shadow-turn", "eval/turn").length, 1);
  assert.equal(taskEvents(agent, "shadow-turn", "eval/turn")[0].taskOk, false);
  const shadows = taskEvents(agent, "shadow-turn", "eval/tool");
  assert.equal(shadows.length, 1);
  assert.equal(shadows[0].shadow_call, true);
  assert.equal(shadows[0].category, "shadow_call");

  llm.apiChat = async () => ({ message: { role: "assistant", content: "plain answer" } });
  await agent.chat("plain", {
    taskId: "plain-turn", sessionKey: "plain", persist: false, evalSampleRate: 1, strata: STRATA,
  });
  const turns = taskEvents(agent, "plain-turn", "eval/turn");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, "closed");
  assert.equal(turns[0].taskOk, null, "没有显式业务判定时必须为 null");
});

test("流式降级复用 taskId/traceId, 请求成功失败成本完整且 turn 仅一条", async (t) => {
  const agent = makeAgent(t, "stream-fallback");
  const llm = {
    model: "gpt-4o-mini",
    providerId: "stub-provider",
    supportsStream: true,
    supportsNativeToolCalls: true,
    apiChatStream: async (_msgs, { onDelta }) => {
      onDelta?.("partial");
      throw new Error("stream failed");
    },
    apiChat: async () => ({
      message: { role: "assistant", content: "fallback answer" },
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }),
  };
  agent.llm = llm;
  agent.allProviders = [llm];
  agent._installUsageTracking();
  const reply = await agent.chatStream("stream", {
    taskId: "stream-task", sessionKey: "stream", evalSampleRate: 1, strata: STRATA,
    onDelta: () => {},
  });
  assert.equal(reply, "fallback answer");
  const requests = taskEvents(agent, "stream-task", "eval/request");
  assert.equal(requests.length, 2);
  assert.ok(requests.every((event) => event.taskId === "stream-task"));
  assert.equal(new Set(requests.map((event) => event.traceId)).size, 1, "降级前后使用同一 traceId");
  const failed = requests.find((event) => event.ok === false);
  const succeeded = requests.find((event) => event.ok === true);
  assert.equal(failed.model, "gpt-4o-mini");
  assert.ok(failed.latencyMs >= 0);
  assert.equal(failed.totalTokens, null);
  assert.equal(failed.costUsd, null);
  assert.equal(failed.priced, false);
  assert.equal(succeeded.totalTokens, 120);
  assert.equal(succeeded.usageSource, "provider");
  assert.equal(failed.usageSource, "none");
  assert.equal(succeeded.priced, true);
  assert.ok(succeeded.costUsd > 0);
  assert.equal(taskEvents(agent, "stream-task", "eval/turn").length, 1);
});

test("abort 与异常逃逸最终 taskOk=false", async (t) => {
  const agent = makeAgent(t, "aborted");
  const llm = {
    model: "stub",
    supportsStream: true,
    supportsNativeToolCalls: true,
    apiChatStream: async () => {
      agent.interrupt("abort-session");
      const error = new Error("cancelled");
      error.name = "AbortError";
      throw error;
    },
    apiChat: async () => ({ message: { role: "assistant", content: "must not fallback" } }),
  };
  agent.llm = llm;
  agent.allProviders = [llm];
  await agent.chatStream("abort", {
    taskId: "abort-turn", sessionKey: "abort-session", persist: false,
    evalSampleRate: 1, strata: STRATA, onDelta: () => {},
  });
  const aborted = taskEvents(agent, "abort-turn", "eval/turn");
  assert.equal(aborted.length, 1);
  assert.equal(aborted[0].status, "aborted");
  assert.equal(aborted[0].taskOk, false);

  agent._isInterrupted = () => true; // 非流式工具循环以普通文本返回中断, 不抛 AbortError
  await agent._chatCore("non-stream abort", {
    taskId: "non-stream-abort", sessionKey: "non-stream-abort", persist: false,
    evalSampleRate: 1, strata: STRATA,
  });
  const nonStreamAbort = taskEvents(agent, "non-stream-abort", "eval/turn");
  assert.equal(nonStreamAbort.length, 1);
  assert.equal(nonStreamAbort[0].status, "aborted");
  assert.equal(nonStreamAbort[0].taskOk, false);

  agent._persistTurn = async () => { throw new Error("persist failed"); };
  await assert.rejects(agent._chatCore("failure", {
    taskId: "exception-turn", sessionKey: "exception", evalSampleRate: 1, strata: STRATA,
  }), /persist failed/);
  const failed = taskEvents(agent, "exception-turn", "eval/turn");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].taskOk, false);
});
