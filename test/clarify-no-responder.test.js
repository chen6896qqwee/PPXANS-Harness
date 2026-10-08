// test/clarify-no-responder.test.js — clarify 无人应答不再消费轮次 (2026-10-05)
// 背景: 基准 fix-syntax / write-function 记录 sequence:["clarify", …] —— 模型用 clarify 向
// 人反问文件位置, 问题被原样转述给用户后模型停发工具调用, runToolLoop (core/policy.js)
// 见到"无 tool_calls 的 assistant 消息"即 return —— 轮次就此终结, 连工作区里点名的文件
// 都没读。修的是机制不是文案: 无人应答的进程里 clarify 根本不再经 LLM 生成问题
// (谓词 agent.hasHumanChannel() = 审批面 || CLI 人类在场), 改为返回可继续推进的指引;
// 有人的会话 (Web/CLI) 问题照旧原样送达。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { TOOL_ERROR_PREFIX } from "../src/tools/index.js";
import { runToolLoop } from "../src/core/policy.js";

const mk = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-cl-${tag}-`));

const QUESTION = "需要澄清: broken.js 的完整路径在哪里?";
const fakeLlm = (box) => ({
  chat: async () => { box.calls++; return { content: QUESTION }; },
});

test("headless (无审批面/无 CLI 标记): clarify 返回推进指引, 不经 LLM 出题, 不是工具错误", async () => {
  const root = mk("headless");
  const agent = new PPXAgent({ root, dataDir: path.join(root, ".ppx"), globalDataDir: path.join(root, ".ppx-global") });
  const box = { calls: 0 };
  try {
    assert.equal(agent.hasApprovalSurface(), false);
    assert.equal(agent.hasHumanChannel(), false, "taskbench 式进程: 没有能答话的人");
    agent.llm = fakeLlm(box); // 旧路径会拿它生成问题; 新分支必须一次都不碰
    const out = String(await agent._runTool("clarify", { task: "修复 broken.js 的语法错误" }));
    assert.ok(!out.startsWith(TOOL_ERROR_PREFIX), `指引不该是错误 (错误会触发自省拦停): ${out.slice(0, 120)}`);
    assert.equal(box.calls, 0, "无人应答时不得消费 LLM 生成问题清单");
    for (const kw of ["read_file", "search_files", "list_dir", "假设", "不要", "找不到"]) {
      assert.match(out, new RegExp(kw), `指引应含 ${kw}: ${out}`);
    }
    assert.doesNotMatch(out, /broken\.js 的完整路径/, "不得产出可被转述给用户的问题");
  } finally { agent.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("有人在场 (Web 审批面 / CLI 人类标记) 两条路: 问题原样送达, 行为与今天一致", async () => {
  const root = mk("human");
  const agent = new PPXAgent({ root, dataDir: path.join(root, ".ppx"), globalDataDir: path.join(root, ".ppx-global") });
  try {
    agent.llm = fakeLlm({ calls: 0 });
    // (a) Web: 审批面登记即视为有人
    agent.registerApprovalSurface("http");
    assert.equal(agent.hasHumanChannel(), true);
    const r1 = await agent.tools.call("clarify", { task: "改登录页" }, { agent });
    assert.equal(r1, QUESTION, "有审批面的进程问题必须原样返回 (工具的全部意义)");
    agent.unregisterApprovalSurface("http");
    // (b) CLI: 终端有人但无审批面 (审批仍走 headless 快拒, 两口径不互相污染)
    assert.equal(agent.hasApprovalSurface(), false);
    agent.markHumanChannel(true);
    assert.equal(agent.hasHumanChannel(), true);
    const r2 = await agent.tools.call("clarify", { task: "改登录页" }, { agent });
    assert.equal(r2, QUESTION, "CLI 聊天保持原样");
    agent.markHumanChannel(false);
    const r3 = await agent.tools.call("clarify", { task: "改登录页" }, { agent });
    assert.match(r3, /无人可答/, "撤掉标记后回到指引分支");
  } finally { agent.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("谓词缺席的老调用方: 走原出题路径 (拿不准是否有人时宁可照常问)", async () => {
  const box = { calls: 0 };
  const legacyAgent = { llm: fakeLlm(box) }; // 旧式 agent 桩: 没有 hasHumanChannel 方法
  const root = mk("noagent");
  const agent = new PPXAgent({ root, dataDir: path.join(root, ".ppx"), globalDataDir: path.join(root, ".ppx-global") });
  try {
    const r = await agent.tools.call("clarify", { task: "改登录页" }, { agent: legacyAgent });
    assert.equal(r, QUESTION, "谓词缺席 = 保持今天行为, 问题照出");
    assert.equal(box.calls, 1);
  } finally { agent.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("runToolLoop 级: clarify 结果不终结轮次 (终结机制=无 tool_calls 的 assistant 消息)", async () => {
  const root = mk("loop");
  const agent = new PPXAgent({ root, dataDir: path.join(root, ".ppx"), globalDataDir: path.join(root, ".ppx-global") });
  try {
    agent.llm = fakeLlm({ calls: 0 }); // 嵌套出题 LLM: 无人应答时禁止被调
    let round = 0;
    let seenMessages = null;
    const fakeApi = {
      apiChat: async (messages) => {
        round++;
        if (round === 1) {
          return { message: { role: "assistant", content: null, tool_calls: [
            { id: "t1", type: "function", function: { name: "clarify", arguments: JSON.stringify({ task: "修复 calc.js" }) } },
          ] } };
        }
        seenMessages = messages; // 第二轮: 上一轮工具结果应是指引而非可转述的问题
        return { message: { role: "assistant", content: "已 read_file 读到 calc.js, 按假设把 a-b 改为 a+b。" } };
      },
    };
    const final = await runToolLoop({
      seedMessages: [{ role: "user", content: "修复 calc.js" }],
      llm: fakeApi,
      tools: [],
      config: {},
      runTool: (name, args) => agent._runTool(name, args),
    });
    assert.equal(round, 2, "clarify 轮后循环必须继续 (轮次终结只发生在无 tool_calls 的消息上)");
    assert.match(final, /按假设/, "终结本轮的是模型随后的无工具消息, 不是 clarify 结果");
    const toolMsg = seenMessages.find((m) => m.role === "tool" && m.tool_call_id === "t1");
    assert.ok(toolMsg, "clarify 的 tool 结果要回灌给模型");
    assert.match(toolMsg.content, /无人可答/, "回灌的是推进指引");
    assert.doesNotMatch(toolMsg.content, new RegExp("完整路径"), "模型没拿到可抛给用户的问题");
    assert.equal(agent.llm.calls ?? 0, 0, "headless 分支零 LLM 消耗");
  } finally { agent.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});
