// test/approval-loop-r13-2026-10-24.test.js - 第十三轮回归: 审批双向闭环 (真浏览器 E2E 的确定性固化)
// 缺陷背景 (R13 真浏览器 E2E 实锤):
//   ① /message/stream 只挂 onDelta/onTool/onStep, agent._onApprovalEvent 无人设置 ——
//      正在等待审批的那条流自己从不发 approval 事件; 轮询兜底只在流结束后才跑。
//      → UI 审批卡片在等待期内不出现, 用户只能干等 120s 超时被拒。
//   ② updCtxBar/updTokPill 无 null 守卫 + setBusy 用 textContent 覆写 footNote 销毁
//      ctxBar —— 前端 JS 异常被当对话错误渲染 (已修, UI 侧行为)。
// 本文件锁服务端契约: 审批请求必须实时到达活跃流 + REST 裁决回程 + 超时拒绝语义。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { HttpChannel } from "../src/channels/http.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-approval-r13-")); }

function makeAgent(root, llm) {
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({
    channels: { http: { mcp: { enabled: false } } },
    agent: { approval_timeout_ms: 300 },
  }));
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  if (llm) agent.llm = llm;
  return agent;
}

test("R13: 审批生命周期 —— pending 可见 / approve 放行 / deny 拒绝 / 超时视为拒绝", async () => {
  const agent = makeAgent(tmp());
  try {
    const p1 = agent._requestApproval({ tool: "run_command", args: { command: "echo a" }, reason: "t" });
    assert.equal(agent.pendingApprovals().length, 1, "pending 清单应有 1 条");
    const id1 = agent.pendingApprovals()[0].id;
    assert.ok(agent.resolveApproval(id1, "approve"), "裁决应命中");
    assert.deepEqual(await p1, {}, "approve 应放行 (truthy)");
    assert.equal(agent.pendingApprovals().length, 0);

    const p2 = agent._requestApproval({ tool: "run_command", args: { command: "echo b" } });
    const id2 = agent.pendingApprovals()[0].id;
    agent.resolveApproval(id2, "deny");
    assert.equal(await p2, null, "deny 应拒绝 (null)");
    assert.equal(agent.resolveApproval("ap_nonexist", "approve"), false, "未知 id 裁决应返回 false");

    const p3 = agent._requestApproval({ tool: "run_command", args: { command: "echo c" } }); // 300ms 超时
    const r3 = await p3;
    assert.equal(r3, null, "超时应视为拒绝 (codex 语义, 不静默放行)");
  } finally {
    agent.shutdown();
  }
});

test("R13: 审批请求实时到达活跃 /message/stream (approval 事件 + REST 裁决回程)", async () => {
  const root = tmp();
  // 桩 LLM: 第一次回 tool_call, 审批放行后第二次回最终文本
  let calls = 0;
  const llm = {
    model: "stub-approval",
    supportsStream: true,
    async apiChatStream() {
      calls += 1;
      if (calls === 1) {
        return { message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "echo r13-ok" }) } }] }, usage: {} };
      }
      return { message: { role: "assistant", content: "工具输出已确认" }, usage: {} };
    },
  };
  const agent = makeAgent(root, llm);
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  ch.authToken = "tok";
  await ch.connect();
  const port = ch.server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/message/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({ message: "运行 echo r13-ok", sessionId: "r13-a" }),
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let approvalEv = null;
    let done = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !approvalEv) {
      const { value, done: fin } = await reader.read();
      if (fin) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
        buf = buf.slice(i + 2);
        if (!line) continue;
        let j; try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (j.type === "approval" && !approvalEv) approvalEv = j;
        if (j.type === "done") done = j;
      }
    }
    assert.ok(approvalEv, "SSE 流应实时收到 approval 事件 (等待期内, 非流结束后)");
    assert.equal(approvalEv.tool, "run_command");
    assert.equal(approvalEv.kind, "bash");
    assert.equal(approvalEv.summary, "echo r13-ok");
    assert.ok(approvalEv.id, "approval 事件应带 id 供 REST 裁决");
    // REST 裁决回程 (Web UI 同款)
    const ruling = await fetch(`http://127.0.0.1:${port}/api/approvals/${approvalEv.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({ decision: "approve" }),
    });
    assert.equal((await ruling.json()).ok, true, "审批裁决应成功");
    // 等流收口
    while (Date.now() < deadline && !done) {
      const { value, done: fin } = await reader.read();
      if (fin) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
        buf = buf.slice(i + 2);
        if (!line) continue;
        try { const j = JSON.parse(line.slice(5).trim()); if (j.type === "done") done = j; } catch {}
      }
    }
    assert.ok(done, "放行后流应正常收口");
    assert.ok(String(done.content).length > 0, "应有最终回复");
  } finally {
    await ch.disconnect(); agent.shutdown();
  }
});
