// test/protocol-eq-tools.test.js - EQ 事件面补全回归 (2026-10-25)
//
// 背景 (评估报告 P2): EventType 定义 16 种, 实际仅 TURN_*/APPROVAL_* 4 种有生产者;
//   工具事件只走 _onToolEvent 回调旁路, /events SSE 的外部消费者看不到工具轨迹。
// 本轮: TOOL_CALLED (准入通过后) + TOOL_OUTPUT (经 _emitToolDone 统一收口, 覆盖
//   成功/失败/钩子否决/权限拒绝全部出口), 两者经 callId 配对, payload 紧凑截断。
import test from "node:test";
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";
import { EventType } from "../src/protocol/index.js";

function tmpRoot(tag = "eqtool") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${tag}-`));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), "{}");
  return root;
}

function mkAgent(tag) {
  const root = tmpRoot(tag);
  return new PPXAgent({ root, dataDir: path.join(root, "data") });
}

test("工具调用产出 TOOL_CALLED + TOOL_OUTPUT 事件对 (callId 配对)", { timeout: 20000 }, async () => {
  const agent = mkAgent("pair");
  try {
    const eq = agent.protocolBus.eq;
    const before = eq.history().length;
    const out = await agent._runTool("get_time", {});
    assert.ok(!String(out).startsWith("[工具错误]"), "get_time 应成功: " + out);
    const evs = eq.history().slice(before);
    const called = evs.find((e) => e.type === EventType.TOOL_CALLED);
    const output = evs.find((e) => e.type === EventType.TOOL_OUTPUT);
    assert.ok(called, "应有 TOOL_CALLED 事件");
    assert.ok(output, "应有 TOOL_OUTPUT 事件");
    assert.equal(called.payload.tool, "get_time");
    assert.equal(output.payload.tool, "get_time");
    assert.equal(called.payload.callId, output.payload.callId, "callId 应配对");
    assert.equal(output.payload.ok, true);
  } finally {
    agent.shutdown();
  }
});

test("工具失败也产出 TOOL_OUTPUT (ok=false)", { timeout: 20000 }, async () => {
  const agent = mkAgent("fail");
  try {
    const eq = agent.protocolBus.eq;
    const before = eq.history().length;
    const out = await agent._runTool("read_file", { path: "Z:/no/such/file-xyz.txt" });
    assert.ok(String(out).startsWith("[工具错误]"), "应失败");
    const output = eq.history().slice(before).find((e) => e.type === EventType.TOOL_OUTPUT);
    assert.ok(output, "失败也应有 TOOL_OUTPUT");
    assert.equal(output.payload.ok, false);
  } finally {
    agent.shutdown();
  }
});

test("EQ payload 紧凑: 大结果截断到 200 字符 (WAL 落盘防膨胀)", { timeout: 20000 }, async () => {
  const agent = mkAgent("trunc");
  try {
    const big = "x".repeat(5000);
    const eq = agent.protocolBus.eq;
    const before = eq.history().length;
    agent._eqPush(EventType.TOOL_OUTPUT, { tool: "t", callId: "c1", ok: true, resultPreview: agent._eqPreview(big) });
    const ev = eq.history().slice(before).find((e) => e.type === EventType.TOOL_OUTPUT);
    assert.ok(ev.payload.resultPreview.length <= 200, "预览应截断");
  } finally {
    agent.shutdown();
  }
});

test("/events SSE 桥可见工具事件 (EQ 订阅即达)", { timeout: 20000 }, async () => {
  const agent = mkAgent("sse");
  try {
    const seen = [];
    const unsub = agent.protocolBus.eq.subscribe((ev) => seen.push(ev.type));
    await agent._runTool("get_time", {});
    unsub();
    assert.ok(seen.includes(EventType.TOOL_CALLED), "订阅者应收 TOOL_CALLED, 实收: " + seen.join(","));
    assert.ok(seen.includes(EventType.TOOL_OUTPUT), "订阅者应收 TOOL_OUTPUT");
  } finally {
    agent.shutdown();
  }
});
