import test from "node:test";
import assert from "node:assert";
import { LLMClient } from "../src/llm/client.js";

// 模拟 openclaw 后端。代理模式: 首轮返回围栏, 次轮返回最终文本。
// 退化模式(无围栏注入): 直接返回纯文本。
class FakeOpenclawClient extends LLMClient {
  constructor() { super({ id: "openclaw" }); this.calls = 0; this.lastMsgs = []; }
  async _openclawChatAsync(messages) {
    this.calls++;
    this.lastMsgs.push(messages[messages.length - 1]?.content || "");
    const injected = this.lastMsgs[this.lastMsgs.length - 1].includes("⟪tool:");
    if (injected && this.calls === 1) return { content: "⟪tool:get_time│{}⟫", usage: null };
    return { content: "现在时间是 14:35:00, 任务完成。", usage: null };
  }
}

test("P0#1: openclaw 经围栏代理调用 PPX 工具", async () => {
  const client = new FakeOpenclawClient();
  const tools = [{ type: "function", function: { name: "get_time", description: "获取当前时间", parameters: { type: "object" } } }];
  const toolRunner = async (name, args) => { assert.equal(name, "get_time"); return "2026-08-16 14:35:00"; };
  const resp = await client.apiChat([{ role: "user", content: "现在几点" }], { tools, toolRunner });
  assert.equal(resp.message.content, "现在时间是 14:35:00, 任务完成。");
  assert.equal(client.calls, 2, "引擎往返两次");
  assert.ok(client.lastMsgs[0].includes("⟪tool:"), "注入围栏协议");
  assert.ok(client.lastMsgs[0].includes("现在几点"), "注入任务");
  assert.ok(client.lastMsgs[1].includes("工具"), "带工具结果");
});

test("P0#1: openclaw 无 toolRunner 退化纯 LLM", async () => {
  const client = new FakeOpenclawClient();
  const resp = await client.apiChat([{ role: "user", content: "hi" }], { tools: [] });
  assert.equal(resp.message.tool_calls, null);
  assert.equal(resp.message.content, "现在时间是 14:35:00, 任务完成。");
  assert.equal(client.calls, 1, "只调一次, 无代理循环");
});
