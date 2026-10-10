import test from "node:test";
import assert from "node:assert/strict";
import { LLMClient } from "../src/llm/client.js";
import { estimateCost, usageTokens } from "../src/llm/pricing.js";

test("pricing distinguishes unknown usage/price from a documented free response", () => {
  assert.equal(usageTokens({}), null);
  assert.equal(usageTokens({ prompt_tokens: 10 }), null);
  assert.equal(estimateCost("glm-4-flash", {}), null);
  assert.equal(estimateCost("glm-4-flash", { total_tokens: 10 }), 0);
  assert.equal(estimateCost("unknown", { total_tokens: 10 }), null);
  assert.equal(estimateCost("gpt-4o", { prompt_tokens: -1, completion_tokens: 2 }), null);
});

test("stream keeps text return and emits terminal usage/model exactly once", async () => {
  const oldFetch = globalThis.fetch;
  let body;
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response('data: {"model":"returned-model","choices":[{"delta":{"content":"hi"}}]}\n\ndata: ' + JSON.stringify({ model: "returned-model", choices: [], usage }) + '\n\ndata: [DONE]\n\n');
  };
  try {
    const received = [];
    const client = new LLMClient({ id: "test", base_url: "http://unused", api_key: "test", model: "configured-model" });
    const text = await client.streamChat([], { onUsage: (...args) => received.push(args) });
    assert.equal(text, "hi");
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], [usage, { model: "returned-model", providerId: "test" }]);
  } finally { globalThis.fetch = oldFetch; }
});

test("stream provider without usage explicitly reports unknown and can disable usage option", async () => {
  const oldFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'); };
  try {
    let usage = "unreported";
    const client = new LLMClient({ base_url: "http://unused", api_key: "test", stream_usage: false });
    assert.equal(await client.streamChat([], { onUsage: (u) => { usage = u; } }), "ok");
    assert.equal(usage, null);
    assert.equal(body.stream_options, undefined);
  } finally { globalThis.fetch = oldFetch; }
});
