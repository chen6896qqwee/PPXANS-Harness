// test/hardening-r4-2026-10-24.test.js - 2026-10-24 第四轮加固回归测试
// 覆盖: 流式工具调用 (SSE 增量 tool_call 累积) / policy 流式回退语义 /
//       chatStream 流式端到端 / review 截断可见化 / chatStream SessionStart
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { runToolLoop } from "../src/core/policy.js";
import { LLMClient } from "../src/llm/client.js";
import { runReview, reviewGroup } from "../src/review/index.js";

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-r4-${tag}-`));
}

// SSE Response 构造器: 把字符串块变成可读流
function sseResponse(chunks) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function sseChunk(delta, { usage = null, finish = null } = {}) {
  return "data: " + JSON.stringify({ choices: [{ delta, finish_reason: finish }], ...(usage ? { usage } : {}) }) + "\n\n";
}

// ================= 1. client.apiChatStream 累积 =================
test("apiChatStream: 文本增量实时回调 + 增量 tool_call 跨帧拼接 + usage", async () => {
  const client = new LLMClient({ id: "t", base_url: "https://fake.local/v1", api_key: "k", model: "m" });
  const deltas = [];
  const chunks = [
    sseChunk({ role: "assistant", content: "我来" }),
    sseChunk({ content: "写文件" }),
    sseChunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "write_file", arguments: "" } }] }),
    sseChunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"' } }] }),
    sseChunk({ tool_calls: [{ index: 0, function: { arguments: 'a.txt"}' } }] }),
    sseChunk({ content: "" }, { usage: { total_tokens: 42 } }),
    "data: [DONE]\n\n",
  ];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse(chunks);
  try {
    const r = await client.apiChatStream([{ role: "user", content: "go" }], {
      tools: [{ type: "function", function: { name: "x" } }],
      onDelta: (t) => deltas.push(t),
    });
    assert.deepEqual(deltas, ["我来", "写文件"], "文本增量实时逐字回调");
    assert.equal(r.message.content, "我来写文件");
    assert.equal(r.message.tool_calls.length, 1);
    assert.equal(r.message.tool_calls[0].id, "c1");
    assert.equal(r.message.tool_calls[0].function.name, "write_file");
    assert.equal(r.message.tool_calls[0].function.arguments, '{"path":"a.txt"}', "arguments 分片拼接");
    assert.equal(r.usage?.total_tokens, 42);
    assert.equal(r.streamed, true);
  } finally { globalThis.fetch = origFetch; }
});

test("apiChatStream: 非流式回退判断依据 —— 无增量失败抛出 (streamed=false)", async () => {
  const client = new LLMClient({ id: "t", base_url: "https://fake.local/v1", api_key: "k", model: "m" });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("boom", { status: 500 });
  try {
    await assert.rejects(() => client.apiChatStream([{ role: "user", content: "x" }], {}));
  } finally { globalThis.fetch = origFetch; }
});

// ================= 2. policy 流式循环 + 回退语义 =================
test("policy: 流式工具循环 —— onDelta 全程可见, 工具执行, 最终回复正确", async () => {
  const deltas = [];
  const llm = {
    supportsStream: true,
    apiChatStream: async (msgs, { onDelta }) => {
      if (msgs.filter((m) => m.role === "tool").length === 0) {
        onDelta?.("先看");
        return { message: { role: "assistant", content: "先看", tool_calls: [{ id: "t1", type: "function", function: { name: "noop", arguments: "{}" } }] }, usage: null };
      }
      onDelta?.("完成");
      return { message: { role: "assistant", content: "完成了" }, usage: null };
    },
  };
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "go" }],
    llm,
    tools: [{ type: "function", function: { name: "noop", description: "d", parameters: { type: "object", properties: {} } } }],
    config: { agent: { max_tool_rounds: 4 } },
    runTool: async () => "ok",
    onDelta: (t) => deltas.push(t),
  });
  assert.deepEqual(deltas, ["先看", "完成"], "每轮文本增量都实时可见 (不再退化非流式)");
  assert.equal(out, "完成了");
});

test("policy: 流式失败且无增量 → 静默退非流式; 已有增量 → 抛给上层", async () => {
  // 桩: 第一次 (流式) 抛错, 第二次 (非流式) 成功
  let mode = "stream-fail";
  const llm = {
    supportsStream: true,
    apiChatStream: async () => { if (mode === "stream-fail") throw new Error("stream boom"); },
    apiChat: async () => ({ message: { role: "assistant", content: "非流式回复" }, usage: null }),
  };
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "go" }],
    llm,
    tools: [],
    config: { agent: { max_tool_rounds: 2 } },
    runTool: async () => "ok",
    onDelta: () => {},
  });
  assert.equal(out, "非流式回复", "无增量失败静默回退");

  // 已吐出增量后流式中断 → 抛出 (交给上层回退链, 不静默重复输出)
  mode = "stream-partial-fail";
  const llm2 = {
    supportsStream: true,
    apiChatStream: async (msgs, { onDelta }) => {
      if (mode === "stream-partial-fail") { onDelta?.("部分"); throw new Error("mid-stream boom"); }
    },
  };
  await assert.rejects(() => runToolLoop({
    seedMessages: [{ role: "user", content: "go" }],
    llm: llm2,
    tools: [],
    config: { agent: { max_tool_rounds: 2 } },
    runTool: async () => "ok",
    onDelta: () => {},
  }));
});

// ================= 3. chatStream 流式端到端 =================
test("chatStream: 工具开启时走流式循环, delta 实时推送, 回复正确落库", async () => {
  const root = tmpDir("stream");
  const agent = new PPXAgent({ root, configFile: null });
  agent.toolsEnabled = true;
  const llm = {
    supportsStream: true,
    model: "stub",
    apiChatStream: async (msgs, { onDelta }) => {
      const hasToolResult = msgs.some((m) => m.role === "tool");
      if (!hasToolResult) {
        onDelta?.("开始");
        return { message: { role: "assistant", content: "开始", tool_calls: [{ id: "t1", type: "function", function: { name: "list_dir", arguments: "{}" } }] } };
      }
      onDelta?.("好了");
      return { message: { role: "assistant", content: "好了, 目录已列出" } };
    },
  };
  agent.llm = llm;
  agent.allProviders = [llm];
  agent._installUsageTracking();
  const deltas = [];
  const reply = await agent.chatStream("列一下目录", { sessionKey: "s", onDelta: (d) => deltas.push(d) });
  assert.deepEqual(deltas, ["开始", "好了"], "工具轮次文本逐字推送");
  assert.equal(reply, "好了, 目录已列出");
  assert.equal(agent.usageStats.calls >= 1, true, "流式轮次计入 usage");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("chatStream: 新会话触发 SessionStart (与 chat 对齐)", async () => {
  const root = tmpDir("stream-ss");
  const agent = new PPXAgent({ root, configFile: null });
  const starts = [];
  agent.hooks.on("SessionStart", async (p) => { starts.push(p.sessionKey + ":" + p.source); });
  agent.llm = { supportsStream: false, apiChat: async () => ({ message: { role: "assistant", content: "ok" } }) };
  await agent.chatStream("hi", { sessionKey: "ss1" });
  await agent.chatStream("hi again", { sessionKey: "ss1" });
  assert.deepEqual(starts, ["ss1:chatStream"], "每会话一次, 来源标注 chatStream");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

// ================= 4. review 截断可见化 =================
test("review: 满 20 条截断时报告显式标注, 不再静默", () => {
  const root = tmpDir("rev");
  // 造一个含大量空 catch 的文件 (每条命中一次规则)
  const big = Array.from({ length: 40 }, (_, i) => `try { } catch (e${i}) { }`).join("\n");
  fs.writeFileSync(path.join(root, "bad.js"), big);
  const group = { files: [path.join(root, "bad.js")] };
  let truncatedHit = null;
  const issues = reviewGroup(group, { onTruncated: (f) => { truncatedHit = f; } });
  assert.equal(issues.length, 20, "上限仍为 20");
  assert.ok(truncatedHit, "截断回调被触发");
  const out = runReview({ files: [path.join(root, "bad.js")] });
  assert.equal(out.truncatedAt, true);
  assert.ok(out.report.includes("截断"), "报告含截断告警");
  fs.rmSync(root, { recursive: true, force: true });
});
