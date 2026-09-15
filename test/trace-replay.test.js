// test/trace-replay.test.js - P0②: turn/step 边界事件 + 事件源不变量断言 (model-visible = logged)
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Traces, EVT } from "../src/utils/trace.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-trace-"));
}

test("traces: turn/step 事件落盘且可重放校验通过", () => {
  const dir = tmpDir();
  const t = new Traces(dir);
  t.recordTurnStart({ reason: "user" });
  t.recordStepStart({ round: 0, context: { tool: ["read_file"], budget: 8 } });
  t.record({ tool: "read_file", args: { p: "a.txt" }, result: "data", ok: true, durationMs: 5 });
  t.recordStepEnd({ round: 0, ok: true, tool: "read_file" });
  t.recordStepStart({ round: 1, context: { tool: ["get_time"] } });
  t.record({ tool: "get_time", args: {}, result: "15:00", ok: true, durationMs: 2 });
  t.recordStepEnd({ round: 1, ok: true, tool: "get_time" });
  t.recordTurnEnd({ ok: true, rounds: 2 });

  const v = t.verifyReplay();
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.ok(v.total >= 7);
});

test("traces: 未闭合 turn 被校验发现", () => {
  const dir = tmpDir();
  const t = new Traces(dir);
  t.recordTurnStart({ reason: "user" });
  t.recordStepStart({ round: 0 });
  t.recordStepEnd({ round: 0, ok: true });
  // 不 recordTurnEnd —— 故意留未闭合 turn
  const v = t.verifyReplay();
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.kind === "turn-unclosed"));
});

test("traces: 孤儿 turn/end 被校验发现", () => {
  const dir = tmpDir();
  const t = new Traces(dir);
  t.recordTurnEnd({ ok: true });
  const v = t.verifyReplay();
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.kind === "turn-end-orphan"));
});

test("traces: 重复 step round 被校验发现", () => {
  const dir = tmpDir();
  const t = new Traces(dir);
  t.recordTurnStart();
  t.recordStepStart({ round: 0 });
  t.recordStepStart({ round: 0 }); // 重复 round
  t.recordStepEnd({ round: 0, ok: true });
  t.recordTurnEnd({ ok: true });
  const v = t.verifyReplay();
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.kind === "step-round-duplicate"));
});

test("traces: 坏行 (不可解析 JSON) 被定位且不影响后续校验", () => {
  const dir = tmpDir();
  const t = new Traces(dir);
  t.recordTurnStart();
  // 手动写一条坏行
  fs.appendFileSync(path.join(t.dir, `${t._file().split(path.sep).pop()}`), "{bad json}\n", "utf8");
  const v = t.verifyReplay();
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.kind === "parse"));
});

test("traces: 事件源不变量 —— step 上下文快照 PII 脱敏", () => {
  const dir = tmpDir();
  const t = new Traces(dir);
  t.recordStepStart({ round: 0, context: { api_key: "sk-1234567890abcdef", query: "hi" } });
  const lines = fs.readFileSync(t._file(), "utf8").trim().split("\n");
  const step = JSON.parse(lines[lines.length - 1]);
  assert.ok(!step.context.includes("sk-1234567890abcdef"), "上下文快照不含明文密钥");
  assert.ok(step.context.includes("[REDACTED]"), "密钥已脱敏");
});

test("traces: EVT 常量导出", () => {
  assert.equal(EVT.TURN_START, "turn/start");
  assert.equal(EVT.TURN_END, "turn/end");
  assert.equal(EVT.STEP_START, "step/start");
  assert.equal(EVT.STEP_END, "step/end");
});
