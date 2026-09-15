// test/canvas.test.js - P2⑥: 符号画布记忆 (TencentDB 思想, 自研)
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCanvasFromEvents, toMermaid, CanvasStore, renderCanvasContext, CANVAS_DEFAULTS } from "../src/memory/canvas.js";

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-canvas-")); }

// 构造一段 trace 事件 (turn/step/tool 混合)
function sampleEvents() {
  return [
    { evt: "turn/start", seq: 1, ts: "2026-09-15T05:00:00Z" },
    { evt: "step/start", seq: 2, round: 0 },
    { evt: "tool/call", seq: 3, tool: "read_file", ok: true },
    { evt: "step/end", seq: 4, round: 0, ok: true, tool: "read_file" },
    { evt: "step/start", seq: 5, round: 1 },
    { evt: "tool/call", seq: 6, tool: "run_command", ok: false },
    { evt: "step/end", seq: 7, round: 1, ok: false, tool: "run_command" },
    { evt: "step/start", seq: 8, round: 2 },
    { evt: "tool/call", seq: 9, tool: "get_time", ok: true },
    { evt: "step/end", seq: 10, round: 2, ok: true, tool: "get_time" },
    { evt: "turn/end", seq: 11, ok: true },
  ];
}

test("canvas: 从事件流归纳状态图", () => {
  const c = buildCanvasFromEvents(sampleEvents());
  assert.ok(c.steps >= 3, "识别 3 个 step");
  assert.ok(c.nodes.length >= 6, "边界+步骤+工具节点");
  assert.ok(c.edges.length > 0, "有状态转移边");
  assert.ok(c.startedAt && c.endedAt);
  // node_id = evt-seq
  assert.ok(c.nodes.some((n) => n.id === "evt-1"));
});

test("canvas: 失败工具节点标记 fail", () => {
  const c = buildCanvasFromEvents(sampleEvents());
  const failNode = c.nodes.find((n) => n.kind === "fail");
  assert.ok(failNode, "失败步骤生成 fail 节点");
  assert.ok(failNode.label.includes("失败"));
});

test("canvas: toMermaid 渲染合法语法", () => {
  const c = buildCanvasFromEvents(sampleEvents());
  const m = toMermaid(c);
  assert.ok(m.startsWith("graph LR"));
  assert.ok(m.includes("-->"), "有边");
  assert.ok(m.includes("["), "节点用方括号");
});

test("canvas: 步骤数不足不触发 (防过度设计)", () => {
  const store = new CanvasStore(tmpDir());
  // 只 2 个 step
  const events = [
    { evt: "turn/start", seq: 1 },
    { evt: "step/start", seq: 2, round: 0 },
    { evt: "step/end", seq: 3, round: 0, ok: true },
    { evt: "turn/end", seq: 4, ok: true },
  ];
  return store.captureFromEvents(events, { minSteps: 5 }).then((r) => {
    assert.equal(r, null, "步骤不足返回 null");
  });
});

test("canvas: 步骤达标才保存画布", async () => {
  const dir = tmpDir();
  const store = new CanvasStore(dir);
  const saved = await store.captureFromEvents(sampleEvents(), { minSteps: 3 });
  assert.ok(saved, "保存成功");
  assert.ok(saved.nodes.length > 0);
  // 同一目录读回
  const store2 = new CanvasStore(dir);
  const read = store2.read();
  assert.ok(read, "可读回");
  assert.ok(read.nodes.length > 0);
});

test("canvas: renderCanvasContext 只含画布+最近节点 (省 token)", () => {
  const c = buildCanvasFromEvents(sampleEvents());
  const ctx = renderCanvasContext(c, { detailLines: 2 });
  assert.ok(ctx.includes("任务画布"));
  assert.ok(ctx.includes("graph LR"));
  assert.ok(ctx.includes("node_id"), "提示按 node_id 取细节");
  // 细节只有 2 行
  const detailLines = ctx.split("\n").filter((l) => l.startsWith("- ")).length;
  assert.equal(detailLines, 2);
});

test("canvas: 空事件返回空画布, 空画布渲染空串", () => {
  const c = buildCanvasFromEvents([]);
  assert.equal(c.nodes.length, 0);
  assert.equal(renderCanvasContext(null), "");
  assert.equal(toMermaid(c), "graph LR");
});

test("canvas: CANVAS_DEFAULTS 导出", () => {
  assert.equal(CANVAS_DEFAULTS.minSteps, 8);
  assert.equal(CANVAS_DEFAULTS.maxNodes, 30);
});
