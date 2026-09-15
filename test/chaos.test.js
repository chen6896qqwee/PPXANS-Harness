// test/chaos.test.js - 混沌测试 (韧性: 三引擎回退 / 健康探测 / 工具错误重试 / 轮次上限)
// 用 mock LLM 注入失败, 把「生产级韧性」固化成可重复的测试, 无需真实 API key
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-chaos-")); }

function makeAgent() {
  return new PPXAgent({ root: tmpRoot(), configFile: null });
}

// mock LLM client (鸭子类型, 满足 _llmWithFallback / _llmWithTools 所需接口)
function fakeLLM({ name, fail = false, failHealth = false, onCall = null } = {}) {
  const c = {
    model: name,
    backend: "http",
    vision: false,
    supportsNativeToolCalls: true,
    calls: 0,
    apiChat: async (messages, opts) => {
      c.calls++;
      if (fail) throw new Error(name + " boom");
      if (onCall) return onCall(messages, opts);
      return { message: { role: "assistant", content: name + " ok", tool_calls: null } };
    },
    health: async () => !failHealth,
  };
  return c;
}

test("混沌: 三引擎回退 (前两个失败自动降级到第三个)", async () => {
  const a = makeAgent();
  const c1 = fakeLLM({ name: "openclaw", fail: true });
  const c2 = fakeLLM({ name: "dsh", fail: true });
  const c3 = fakeLLM({ name: "http" });
  a.allProviders = [c1, c2, c3];
  const r = await a._llmWithFallback([{ role: "user", content: "hi" }]);
  assert.equal(r, "http ok", "最终用第三个 provider 成功");
  assert.equal(c1.calls, 1, "openclaw 被尝试");
  assert.equal(c2.calls, 1, "dsh 被尝试");
  assert.equal(c3.calls, 1, "http 最终成功");
  a.shutdown();
  fs.rmSync(a.root, { recursive: true, force: true });
});

test("混沌: 健康探测失败的 provider 被跳过", async () => {
  const a = makeAgent();
  const c1 = fakeLLM({ name: "unhealthy", failHealth: true });
  const c2 = fakeLLM({ name: "healthy" });
  a.allProviders = [c1, c2];
  const r = await a._llmWithFallback([{ role: "user", content: "hi" }]);
  assert.equal(r, "healthy ok");
  assert.equal(c1.calls, 0, "不健康的 provider 不应被尝试");
  a.shutdown();
  fs.rmSync(a.root, { recursive: true, force: true });
});

test("混沌: 全部 provider 失败抛错", async () => {
  const a = makeAgent();
  a.allProviders = [fakeLLM({ name: "a", fail: true }), fakeLLM({ name: "b", fail: true })];
  // 全挂时抛出最后一个 provider 的错误 (lastErr)
  await assert.rejects(() => a._llmWithFallback([{ role: "user", content: "hi" }]), /boom/);
  a.shutdown();
  fs.rmSync(a.root, { recursive: true, force: true });
});

test("混沌: 工具错误喂回模型重试后成功", async () => {
  const a = makeAgent();
  let round = 0;
  const client = fakeLLM({
    name: "mock",
    onCall: () => {
      round++;
      if (round === 1) {
        // 首轮: 调用一个不存在的工具 -> 触发错误重试
        return { message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "no_such_tool", arguments: "{}" } }] } };
      }
      return { message: { role: "assistant", content: "修正后的回复", tool_calls: null } };
    },
  });
  const r = await a._llmWithTools([{ role: "user", content: "x" }], client);
  assert.equal(r, "修正后的回复", "工具错误后模型修正成功");
  assert.equal(round, 2, "错误喂回模型重试一次");
  a.shutdown();
  fs.rmSync(a.root, { recursive: true, force: true });
});

test("混沌: 工具轮次上限 (8 轮后停止)", async () => {
  const a = makeAgent();
  const client = fakeLLM({
    name: "loop",
    onCall: () => ({ message: { role: "assistant", content: null, tool_calls: [{ id: "t", type: "function", function: { name: "get_time", arguments: "{}" } }] } }),
  });
  const r = await a._llmWithTools([{ role: "user", content: "x" }], client);
  assert.equal(r, "[皮皮虾] 工具调用轮次过多, 已停止。");
  assert.equal(client.calls, 8, "达到 8 轮上限即停止");
  a.shutdown();
  fs.rmSync(a.root, { recursive: true, force: true });
});
