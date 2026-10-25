import test from "node:test";
import assert from "node:assert";
import { ToolCatalog, TOOL_ERROR_PREFIX } from "../src/tools/index.js";
import { LLMClient } from "../src/llm/client.js";

test("before 钩子短路: 返回字符串直接作为结果, 不执行 execute", async () => {
  const c = new ToolCatalog();
  let executed = false;
  c.register({
    name: "guarded",
    description: "test",
    execute: async () => { executed = true; return "executed"; },
    before: async () => "blocked-by-before",
  });
  const res = await c.call("guarded", {});
  assert.equal(res, "blocked-by-before");
  assert.equal(executed, false, "execute 未被执行");
});

test("before 钩子 throw 拒绝", async () => {
  const c = new ToolCatalog();
  c.register({
    name: "g2",
    description: "test",
    execute: async () => "executed",
    before: async () => { throw new Error("权限拒绝"); },
  });
  const res = await c.call("g2", {});
  assert.ok(res.includes(TOOL_ERROR_PREFIX), "带错误前缀");
  assert.ok(res.includes("权限拒绝"));
});

test("after 钩子在 execute 后被调用, 拿到结果", async () => {
  const c = new ToolCatalog();
  let afterCalled = false;
  let afterResult = null;
  c.register({
    name: "g3",
    description: "test",
    execute: async () => "done",
    after: async (args, result) => { afterCalled = true; afterResult = result; },
  });
  const res = await c.call("g3", {});
  assert.equal(res, "done");
  assert.equal(afterCalled, true);
  assert.equal(afterResult, "done");
});

test("after 钩子抛错不阻塞结果", async () => {
  const c = new ToolCatalog();
  c.register({
    name: "g4",
    description: "test",
    execute: async () => "ok",
    after: async () => { throw new Error("after 崩了"); },
  });
  const res = await c.call("g4", {});
  assert.equal(res, "ok");
});

test("工具调用修复: 文本围栏恢复为原生 tool_calls", async () => {
  const c = new LLMClient({ id: "http", base_url: "https://x/v1", api_key: "k", model: "m" });
  // mock _request: 返回含围栏文本(⟪tool:get_time│{}⟫)、无原生 tool_calls 的 message
  c._request = async () => ({
    choices: [{ message: { role: "assistant", content: "\u27eatool:get_time\u2502{}\u27eb" } }],
  });
  const tools = [{ type: "function", function: { name: "get_time", description: "时间" } }];
  const r = await c.apiChat([{ role: "user", content: "几点" }], { tools });
  assert.ok(Array.isArray(r.message.tool_calls), "恢复出 tool_calls");
  assert.equal(r.message.tool_calls[0].function.name, "get_time");
});

test("工具调用修复: 无工具意图的普通文本不被误判", async () => {
  const c = new LLMClient({ id: "http", base_url: "https://x/v1", api_key: "k", model: "m" });
  c._request = async () => ({ choices: [{ message: { role: "assistant", content: "现在是下午三点" } }] });
  const tools = [{ type: "function", function: { name: "get_time", description: "时间" } }];
  const r = await c.apiChat([{ role: "user", content: "几点" }], { tools });
  assert.equal(r.message.tool_calls, null, "普通文本不误判为工具调用");
  assert.equal(r.message.content, "现在是下午三点");
});
