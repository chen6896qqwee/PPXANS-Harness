// test/workgraph-runid-2026-11-16.test.js — 架构优化 ②: runId 贯通工单账本
// 背景: run-context 已把 trace/审计/工具轨迹/委派串到一条 runId, 但工单账本没记 ——
//   排查"这次为什么失败"时, 工单事实无法与审计链/工具轨迹按同一 id 归组。
// 契约: ① submit 在 trace 上下文内创建 → ticket.runId = 当前 runId;
//       ② begin 的指派继承工单 runId (可显式覆盖);
//       ③ 事件 payload 带 runId; ④ 旧账本无该字段仍可读 (undefined, 不猜测)。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkStore } from "../src/workgraph/store.js";
import { createWorkService } from "../src/workgraph/service.js";
import { runWithTrace } from "../src/core/trace.js";
import { currentRunId } from "../src/core/run-context.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-wk-runid-")); }

function makeService(dir, events = []) {
  const store = createWorkStore({ dir });
  const service = createWorkService({
    store,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  return { store, service, events };
}

const trigger = (text) => ({ source: "test", from: "u1", messageId: `m-${text}`, text });

test("runId 贯通: trace 上下文内 submit → 工单/指派/事件同一条 runId", async () => {
  const dir = tmp();
  try {
    const { service, events } = makeService(dir);
    let runId = null;
    let ticket = null;
    await runWithTrace(async () => {
      runId = currentRunId();
      ticket = service.submit(trigger("hello"));
      service.begin(ticket.id, { worker: "router", sessionKey: "s" });
      return null;
    }, { sessionKey: "s", runKind: "turn" });
    assert.ok(runId, "trace 内应有 runId");
    assert.equal(ticket.runId, runId, "工单必须记录创建时的 runId");
    const assignment = service.get(ticket.id)?.assignments?.[0];
    assert.equal(assignment?.runId, runId, "指派继承工单 runId");
    const created = events.find((e) => e.type === "ticket_created");
    assert.equal(created?.payload?.runId, runId, "事件 payload 带 runId (订阅方可直接归组)");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("runId 贯通: 无 trace 上下文 → null, 不编造 id", () => {
  const dir = tmp();
  try {
    const { service } = makeService(dir);
    const ticket = service.submit(trigger("no-trace"));
    assert.equal(ticket.runId, null, "没有 trace 就不该有血缘");
    const a = service.begin(ticket.id, { worker: "router" });
    assert.equal(a.runId, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("runId 贯通: 显式传入覆盖 trace (跨进程重投/重跑场景)", () => {
  const dir = tmp();
  try {
    const { service } = makeService(dir);
    const ticket = service.submit(trigger("explicit"), { runId: "run_parent_123" });
    assert.equal(ticket.runId, "run_parent_123");
    const a = service.begin(ticket.id, { worker: "router", runId: "run_assignment_9" });
    assert.equal(a.runId, "run_assignment_9", "指派可显式覆盖 (重跑换轮次)");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("runId 贯通: 旧账本 (无 runId 字段) 可读, 显示为 null 而不是报错", () => {
  const dir = tmp();
  try {
    const legacy = {
      v: 1, kind: "ticket_created", at: Date.now(), instance: "old",
      ticket: { id: "wk_old", status: "admitted", sessionKey: "default", createdAt: Date.now() },
    };
    fs.writeFileSync(path.join(dir, "tickets.jsonl"), JSON.stringify(legacy) + "\n");
    const store = createWorkStore({ dir });
    const t = store.get("wk_old");
    assert.ok(t, "旧记录必须可读");
    assert.equal(t.runId ?? null, null, "未记录血缘 → null (不推测)");
    assert.equal(t.id, "wk_old");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
