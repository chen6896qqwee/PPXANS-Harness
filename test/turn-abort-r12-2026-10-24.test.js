// test/turn-abort-r12-2026-10-24.test.js - 第十二轮回归: 用户中断语义 (真模型探测 P6-3 的确定性固化)
// 缺陷背景 (R12 探测实锤): 中断落在"流式开始之前"或"非流式路径"时被静默吞掉——
//   ① 已 aborted 的外部 signal 上 addEventListener 永不触发 (缺前置检查);
//   ② policy 对"流式失败→非流式兜底"不区分用户中断, 换非流式把整轮重跑 (二次计费);
//   ③ _llmWithFallback 的 catch 把 AbortError 当 provider 故障切下一个 provider;
//   ④ apiChat/_request 根本不收 signal, chatStream 无 onDelta 时 (policy 走 apiChat)
//      整条路不可中断 (真模型实测: 60ms 叫停, 17.8s 后散文照样全文返回)。
import test from "node:test";
import assert from "node:assert";
import { runToolLoop } from "../src/core/policy.js";

// 假 LLM: apiChat 忽略 signal 但遵守约定——被 abort 后下一拍抛 AbortError (模拟 fetch 中断)
function makeAbortingLLM() {
  return {
    model: "fake-slow",
    supportsStream: false,
    async apiChat(messages, { signal } = {}) {
      if (signal?.aborted) throw abortErr();
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 5000);
        signal?.addEventListener("abort", () => { clearTimeout(t); reject(abortErr()); }, { once: true });
      });
      return { message: { role: "assistant", content: "不应看到的完整回答" }, usage: {} };
    },
  };
}
function abortErr() {
  const e = new Error("This operation was aborted");
  e.name = "AbortError";
  return e;
}

test("R12: runToolLoop 非流式路径响应 signal 中断 (不吞不重跑)", async () => {
  const ac = new AbortController();
  const llm = makeAbortingLLM();
  const p = runToolLoop({
    seedMessages: [{ role: "user", content: "写一篇长文" }],
    llm,
    tools: [],
    config: {},
    isInterrupted: () => ac.signal.aborted,
    signal: ac.signal,
  });
  setTimeout(() => ac.abort(), 50); // 飞行中叫停
  await assert.rejects(p, (e) => e?.name === "AbortError", "AbortError 应上抛而非被兜底吞掉");
});

test("R12: 已中止的 signal 进入 apiChatStream/streamChat 前置即抛 (不发起请求)", async () => {
  // 直接用真 client 的入口检查逻辑: 构造一个已中止的 signal
  const ac = new AbortController();
  ac.abort();
  // 真 client: 用最小构造绕开 key 检查 (只测入口守卫)
  const { LLMClient } = await import("../src/llm/client.js");
  const client = Object.create(LLMClient.prototype);
  client.apiKey = "fake";
  client.baseUrl = "http://127.0.0.1:1"; // 不会真的连上
  client.model = "fake";
  client.timeoutMs = 1000;
  await assert.rejects(
    () => client.apiChatStream([{ role: "user", content: "x" }], { signal: ac.signal }),
    (e) => e?.name === "AbortError",
    "入口应立即抛 AbortError, 不发起请求",
  );
  await assert.rejects(
    () => client.apiChat([{ role: "user", content: "x" }], { signal: ac.signal }),
    (e) => e?.name === "AbortError",
    "apiChat 入口同样前置即抛",
  );
});

test("R12: policy 流式失败遇用户中断 → 不退非流式重发 (原样上抛)", async () => {
  let nonStreamCalls = 0;
  const ac = new AbortController();
  const llm = {
    model: "fake-stream",
    supportsStream: true,
    async apiChatStream(messages, { onDelta, signal } = {}) {
      // 模拟: 流式请求进行中用户叫停 (未吐任何增量)
      ac.abort();
      throw abortErr();
    },
    async apiChat() {
      nonStreamCalls += 1; // 若兜底被错误触发, 这里会 +1
      return { message: { role: "assistant", content: "不该出现的重跑结果" }, usage: {} };
    },
  };
  await assert.rejects(
    runToolLoop({
      seedMessages: [{ role: "user", content: "x" }],
      llm,
      tools: [],
      config: {},
      isInterrupted: () => ac.signal.aborted, // 轮 0 未中止才进得了 LLM 调用
      onDelta: () => {}, // 流式能力可用 (streamCapable) 才会走到"失败退非流式"的分叉
      signal: ac.signal, // userAborted 守卫应拦住兜底
    }),
    (e) => e?.name === "AbortError",
  );
  assert.equal(nonStreamCalls, 0, "用户中断不得触发非流式重跑");
});
