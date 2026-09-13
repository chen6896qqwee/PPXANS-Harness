import test from "node:test";
import assert from "node:assert/strict";
import { Context, compose } from "../src/plugin/index.js";
import { llmPlugin } from "../src/plugin/builtin.js";
import { LLMClient } from "../src/llm/client.js";

test("llmPlugin registers the configured local provider during composition", () => {
  const ctx = new Context();
  ctx.provide("config", {
    providers: [{ id: "local-test", base_url: "http://127.0.0.1:1234/v1", model: "test-model" }],
  });

  compose(ctx, [llmPlugin]);

  assert.ok(ctx.consume("llm") instanceof LLMClient);
  assert.equal(ctx.consume("llm").providerId, "local-test");
  assert.equal(ctx.consume("llm").model, "test-model");
  const providers = ctx.consume("allProviders");
  assert.equal(providers.length, 1);
  assert.ok(providers[0] instanceof LLMClient);
  assert.equal(providers[0].providerId, "local-test");
});

test("llmPlugin registers explicit offline state when no providers are configured", () => {
  const ctx = new Context();
  ctx.provide("config", { providers: [] });

  compose(ctx, [llmPlugin]);

  assert.ok(ctx.has("llm"));
  assert.equal(ctx.consume("llm"), null);
  assert.ok(ctx.has("allProviders"));
  assert.deepEqual(ctx.consume("allProviders"), []);
});
