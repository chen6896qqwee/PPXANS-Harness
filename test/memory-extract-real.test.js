import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";

function tmpRoot(){ return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-extract-real-")); }

function makeAgent(){
  const agent = new PPXAgent({ root: tmpRoot() });
  // 用一个可控的假 LLM 覆盖真实解析路径
  agent.llm = { chat: async () => ({ content: "" }) };
  return agent;
}

test("复审P0: _extractMemory 非空 JSON 数组能正确解析 (原正则 bug 场景)", async () => {
  const agent = makeAgent();
  agent.llm.chat = async () => ({ content: '[{"content": "用户喜欢红色"},{"content": "用户关注A股"}]' });
  const out = await agent._extractMemory("用户喜欢红色", "好的");
  assert.ok(Array.isArray(out), "应返回数组");
  assert.equal(out.length, 2, "应解析出 2 条");
  assert.ok(out.includes("用户喜欢红色"), "应包含提炼内容");
  agent.shutdown();
});

test("复审P0: _extractMemory 空数组返回 []", async () => {
  const agent = makeAgent();
  agent.llm.chat = async () => ({ content: "[]" });
  const out = await agent._extractMemory("寒暄", "在");
  assert.deepEqual(out, []);
  agent.shutdown();
});

test("复审P0: _extractMemory 无 JSON 返回 []", async () => {
  const agent = makeAgent();
  agent.llm.chat = async () => ({ content: "没有什么值得记住的。" });
  const out = await agent._extractMemory("随便聊聊", "嗯");
  assert.deepEqual(out, []);
  agent.shutdown();
});

test("复审P0: _extractMemory 容忍 markdown 代码块包裹的 JSON", async () => {
  const agent = makeAgent();
  agent.llm.chat = async () => ({ content: '`json\n[{"content": "用户偏好实时数据"}]\n`' });
  const out = await agent._extractMemory("偏好", "记住了");
  assert.ok(Array.isArray(out) && out.length === 1);
  assert.ok(out[0].includes("实时数据"));
  agent.shutdown();
});
