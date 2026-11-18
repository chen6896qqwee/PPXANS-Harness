// test/overflow-generation-guard-2026-11-16.test.js — 溢出重试的 generation 证明
// 借 DSH replaceGeneration 语义: 裁剪没改变模型可见输入 → 不重试, 原样抛出提供方错误。
import test from "node:test";
import assert from "node:assert";
import { runToolLoop } from "../src/agent/loop/tool-loop.js";

function overflowError() {
  const e = new Error("maximum context length exceeded");
  e.status = 400;
  return e;
}

test("溢出裁剪无进展 → 不重试 (只发一次请求, 原错误抛出)", async () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ];
  let calls = 0;
  const llm = {
    model: "stub",
    context_window: 8192,
    supportsNativeToolCalls: true,
    apiChat: async () => { calls += 1; throw overflowError(); },
  };
  await assert.rejects(
    runToolLoop({
      seedMessages: messages,
      llm,
      tools: { toOpenAI: () => [] },
      config: { agent: { max_tool_rounds: 1 } },
      shrinkMessages: (msgs) => msgs, // 裁剪没有任何变化
      histTokenCap: () => 100,
    }),
    /maximum context length/,
  );
  assert.equal(calls, 1, "没有 generation 变化就不该再烧第二次请求");
});

test("溢出裁剪有进展 → 重试, 成功后返回", async () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "旧的长消息 ".repeat(30) },
    { role: "user", content: "hi" },
  ];
  let calls = 0;
  const llm = {
    model: "stub",
    context_window: 8192,
    supportsNativeToolCalls: true,
    apiChat: async () => {
      calls += 1;
      if (calls === 1) throw overflowError();
      return { message: { role: "assistant", content: "恢复成功" } };
    },
  };
  const out = await runToolLoop({
    seedMessages: messages,
    llm,
    tools: { toOpenAI: () => [] },
    config: { agent: { max_tool_rounds: 3 } },
    shrinkMessages: (msgs) => msgs.slice(-2), // 有真实裁剪
    histTokenCap: () => 100,
  });
  assert.equal(calls, 2, "有进展才允许第二次请求");
  assert.equal(out, "恢复成功");
});
