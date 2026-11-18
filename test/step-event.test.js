import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { LLMClient } from "../src/llm/client.js";

function tmp(){ return fs.mkdtempSync(path.join(os.tmpdir(),"ppx-step-")); }

// http 后端 stub: 第一轮返回 tool_calls, 第二轮返回最终文本
class FakeHTTP extends LLMClient {
  constructor(){ super({ id:"http", base_url:"https://x/v1", api_key:"k", model:"m" }); this.calls=0; }
  async apiChat() {
    this.calls++;
    if (this.calls === 1) {
      return { message: { role:"assistant", content:null, tool_calls:[
        { id:"c1", type:"function", function:{ name:"get_time", arguments:"{}" } },
      ] }, usage:null };
    }
    return { message: { role:"assistant", content:"现在 15:00:00", tool_calls:null }, usage:null };
  }
}

test("turn/step: _llmWithTools 每轮触发 step 事件", async () => {
  const agent = new PPXAgent({ root: tmp() });
  const fake = new FakeHTTP();
  agent.llm = fake;
  agent.allProviders = [fake];
  const steps = [];
  agent.setStepEvent((ev) => steps.push(ev));

  const messages = [{ role:"system", content:"x" }, { role:"user", content:"查时间" }];
  const reply = await agent._llmWithTools(messages, fake);

  assert.equal(reply, "现在 15:00:00");
  assert.equal(steps.length, 2, "两轮循环 = 两个 step 事件");
  assert.equal(steps[0].type, "step");
  assert.equal(steps[0].round, 0);
  assert.equal(steps[1].round, 1);
  assert.equal(steps[0].maxRounds, steps[1].maxRounds);
  agent.shutdown();
});

test("turn/step: 未设置回调时不发事件 (无副作用)", async () => {
  const agent = new PPXAgent({ root: tmp() });
  const fake = new FakeHTTP();
  agent.llm = fake;
  agent.allProviders = [fake];
  const messages = [{ role:"system", content:"x" }, { role:"user", content:"查时间" }];
  const reply = await agent._llmWithTools(messages, fake);
  assert.equal(reply, "现在 15:00:00");
  agent.shutdown();
});
