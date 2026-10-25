// test/circuit-breaker.test.js - P0③ harness 熔断 (src/agent/index.js _llmWithTools)
// 对应 Self-Harness: Qwen3.5"探索循环熔断(连续>N次探索无产出→换策略)" + "避免重复命令"; MiniMax"过度探索→尽早交付"
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";

function makeAgent() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-cb-"));
  const a = new PPXAgent({ root, configFile: null });
  if (!a.config.agent) a.config.agent = {};
  a.config.agent.explore_break_limit = 3; // 测小
  a.config.agent.repeat_flag_limit = 2;
  a._runTool = async () => "ok (mock)"; // 探索工具都返回成功, 不触发错误重试
  a.toolsEnabled = true;
  return a;
}
function toolCall(name, args = {}) { return { id: "t", type: "function", function: { name, arguments: JSON.stringify(args) } }; }
function contentMsg() { return { role: "assistant", content: "done" }; }

test("circuit: 连续探索无产出 -> 注入'探索循环'方向盘", async () => {
  const a = makeAgent();
  let callNum = 0;
  const seen = [];
  let rot = 0;
  a.llm = { apiChat: async (messages) => {
    callNum++; seen.push(messages);
    const steered = seen.some((m) => m.some((x) => x.role === "user" && /探索循环|重复执行/.test(String(x.content || ""))));
    if (steered) return { message: contentMsg() }; // 熔断后模型收敛结束
    rot++;
    return { message: { role: "assistant", tool_calls: [toolCall("read_file", { path: "/a/" + rot })] } }; // 每轮换路径, 隔离纯探索场景
  } };
  const out = await a._llmWithTools([{ role: "user", content: "探索它" }], a.llm);
  assert.equal(out, "done");
  const steered = seen.some((m) => m.some((x) => x.role === "user" && String(x.content || "").includes("探索循环")));
  assert.equal(steered, true, "应注入探索循环熔断方向盘");
  assert.ok(callNum >= 4, "熔断后至少再来一轮让模型收敛, callNum=" + callNum);
  a.shutdown(); fs.rmSync(a.root, { recursive: true, force: true });
});

test("circuit: 重复同工具同参数 -> 注入'重复执行'方向盘", async () => {
  const a = makeAgent();
  const seen = [];
  a.llm = { apiChat: async (messages) => {
    seen.push(messages);
    if (seen.some((m) => m.some((x) => x.role === "user" && String(x.content || "").includes("重复执行")))) {
      return { message: contentMsg() };
    }
    return { message: { role: "assistant", tool_calls: [toolCall("read_file", { path: "/same" })] } };
  } };
  const out = await a._llmWithTools([{ role: "user", content: "读它" }], a.llm);
  assert.equal(out, "done");
  const steered = seen.some((m) => m.some((x) => x.role === "user" && String(x.content || "").includes("重复执行")));
  assert.equal(steered, true, "重复命令应被标记");
  a.shutdown(); fs.rmSync(a.root, { recursive: true, force: true });
});

test("circuit: 正常流 (探索穿插产出/直接作答) 不误伤", async () => {
  const a = makeAgent();
  const seen = [];
  a.llm = { apiChat: async (messages) => {
    seen.push(messages);
    // 探索一次, 然后直接产出内容 (不构成连续探索)
    if (seen.length === 1) return { message: { role: "assistant", tool_calls: [toolCall("read_file", { path: "/x" })] } };
    return { message: contentMsg() };
  } };
  const out = await a._llmWithTools([{ role: "user", content: "看看然后回答" }], a.llm);
  assert.equal(out, "done");
  const steered = seen.some((m) => m.some((x) => x.role === "user" && String(x.content || "").includes("探索循环")));
  assert.equal(steered, false, "单次探索不应触发熔断");
  a.shutdown(); fs.rmSync(a.root, { recursive: true, force: true });
});
