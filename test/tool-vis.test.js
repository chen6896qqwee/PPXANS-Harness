import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { LLMClient } from "../src/llm/client.js";

function tmp(){ return fs.mkdtempSync(path.join(os.tmpdir(),"ppx-toolvis-")); }

// mock openclaw 后端: 围栏请求 get_time -> 收到结果后回复最终文本
class FakeOC extends LLMClient {
  constructor(){ super({id:"openclaw"}); this.calls=0; }
  async _openclawChatAsync(messages){
    this.calls++;
    const lu = messages[messages.length-1]?.content||"";
    if(this.calls===1) return { content:"⟪tool:get_time│{}⟫", usage:null };
    assert.ok(lu.includes("工具"), "第2轮应带工具结果");
    return { content:"现在 14:50:00", usage:null };
  }
}

test("P1#7: chatStream 走工具循环并触发 onTool 事件", async () => {
  const agent = new PPXAgent({ root: tmp() });
  // 注入 mock client
  const fake = new FakeOC();
  agent.llm = fake;
  agent.allProviders = [fake];
  const events = [];
  const reply = await agent.chatStream("帮我查一下当前系统时间状态", {
    sessionKey: "t1",
    onDelta: () => {},
    onTool: (ev) => events.push(ev),
  });
  assert.equal(reply, "现在 14:50:00");
  assert.equal(events.length, 2, "start + done 两个事件");
  assert.equal(events[0].type, "start");
  assert.equal(events[0].tool, "get_time");
  assert.equal(events[1].type, "done");
  assert.equal(events[1].ok, true);
  agent.shutdown();
});

test("P1#7: 无工具时 chatStream 也返回最终文本", async () => {
  const agent = new PPXAgent({ root: tmp() });
  const fake = new (class extends LLMClient {
    constructor(){ super({id:"openclaw"}); this.calls=0; }
    async _openclawChatAsync(){ this.calls++; return { content:"你好兄弟", usage:null }; }
  })();
  agent.llm = fake; agent.allProviders = [fake];
  const events = [];
  const reply = await agent.chatStream("分析一下当前市场情绪", { sessionKey:"t2", onTool:(ev)=>events.push(ev) });
  assert.equal(reply, "你好兄弟");
  assert.equal(events.length, 0, "无工具时无 onTool 事件");
  // 本地意图可能拦截"在吗" -> 返回问候, 不调LLM
  agent.shutdown();
});
