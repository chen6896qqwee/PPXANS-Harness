import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PPXAgent } from "../src/agent/index.js";
import { ToolCatalog } from "../src/tools/catalog.js";
import { runWithPolicy } from "../src/tools/seam.js";
import { toolResultStatus, toolResultContent } from "../src/core/tool-result.js";
import { runToolLoop, isTimeoutResult } from "../src/core/policy.js";
import { collectTurnFiles } from "../src/core/postcondition.js";

const toolCall = (name, args, id = "test-call") => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const response = (content, tool_calls = null) => ({ message: { role: "assistant", content, tool_calls } });

function agentFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-p0-receipt-"));
  fs.mkdirSync(path.join(root, "config"));
  const configFile = path.join(root, "config", "ppx.json");
  fs.writeFileSync(configFile, JSON.stringify({ providers: [], agent: { localIntent: false, proactive: { enabled: false } } }));
  const agent = new PPXAgent({ root, configFile, dataDir: path.join(root, "data"), globalDataDir: path.join(root, "global") });
  t.after(() => { agent.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return agent;
}

test("P0: exit/JSON/timeout errors share semantics; nested data and success stay successful", () => {
  for (const value of [
    "[exit=1 time=0.00s out=0行]\n[工具错误] command failed",
    "[exit=timeout time=10ms] command timed out after 10ms",
    '{"error":"operation denied"}', '{"ok":false,"reason":"failed"}',
    { ok: false, error: "failed" }, "[工具错误] failure"
  ]) assert.equal(toolResultStatus(value).ok, false);
  assert.equal(isTimeoutResult("[exit=timeout time=10ms] command timed out after 10ms"), true);
  for (const value of ["[exit=0 time=0.00s out=1行]\nsuccess", '{"ok":true}', '{"data":{"error":"ordinary nested data"}}', "ordinary text"])
    assert.equal(toolResultStatus(value).ok, true);
});

test("P0: audit and seam callback agree about legacy nonzero receipts without changing public output", async () => {
  const receipt = "[exit=2 time=0.00s out=0行]\nfailed";
  const c = new ToolCatalog();
  const audit = [];
  c.setAudit({ append: e => audit.push(e) });
  c.register({ name: "legacy", execute: () => receipt });
  assert.equal(await c.call("legacy", {}), receipt);
  assert.equal(audit[0].ok, false);
  const events = [];
  await runWithPolicy(c.metaOf("legacy"), {}, { onResult: (...a) => events.push(a) });
  assert.equal(events[0][1], "error");
});

test("P0 counterexample: successful file/document bodies are data even when resembling failure receipts", async (t) => {
  const a = agentFor(t);
  const audit = [];
  a.tools.setAudit({ append: e => audit.push(e) });
  const bodies = [
    '{"error":"customer field","ok":false}',
    "[工具错误] this is literal customer data",
    "[exit=1 time=0.00s out=0行]\ncustomer data",
    '{"kind":"ppx-tool-outcome","status":{"ok":false},"content":"ordinary JSON"}'
  ];
  for (const body of bodies) {
    fs.writeFileSync(path.join(a.root, "business.json"), body);
    assert.equal(await a.tools.call("read_file", { path: "business.json" }), body, "public API must preserve data");
    assert.equal(audit.at(-1).ok, true);
    const result = await a._runTool("read_file", { path: "business.json" }, { receipt: true });
    assert.equal(toolResultStatus(result).ok, true);
    assert.equal(toolResultContent(result), body);
    assert.equal(await a._localIntent("读文件 business.json"), body);
  }
  const documentBody = bodies[0];
  fs.writeFileSync(path.join(a.root, "business.txt"), documentBody);
  assert.equal(await a.tools.call("read_document", { path: "business.txt" }), documentBody);
  assert.equal(audit.at(-1).ok, true);
  const missing = await a._runTool("read_file", { path: "missing.json" }, { receipt: true });
  assert.equal(toolResultStatus(missing).ok, false, "actual reader failure is still rejected");
});

test("P0: real run_command failure is traced as failure and cannot prove a missing output", async (t) => {
  const a = agentFor(t);
  a.permissions = { check: async () => ({ decision: "allow" }) };
  a.ctx.provide("shell", { exec: async () => ({ ok: false, code: 7, stdout: "", stderr: "injected execution failure" }) });
  const trace = [];
  a.traces.record = e => trace.push(e);
  const receipt = await a._runTool("run_command", { command: "echo synthetic" });
  assert.match(receipt, /^\[exit=7/);
  assert.match(receipt, /exit=7/);
  assert.equal(trace.at(-1).ok, false);
  assert.equal(collectTurnFiles([{ name: "run_command", args: { command: "echo synthetic" }, result: receipt }], { rootDir: a.root }).mutationEvidence, false);
  let round = 0;
  const events = [];
  const output = await runToolLoop({
    seedMessages: [{ role: "user", content: "Create absent.js." }], tools: a.tools.toOpenAI(),
    llm: { apiChat: async () => ++round === 1 ? response(null, [toolCall("run_command", { command: "echo synthetic" })]) : response("已创建 absent.js。") },
    runTool: async () => receipt, shrinkMessages: m => m,
    config: { agent: { postcondition_retries: 0 } }, postCondition: { rootDir: a.root },
    onEvent: (type) => events.push(type)
  });
  assert.ok(events.includes("tool/error_retry"));
  assert.match(output, /后置校验未通过/);
  assert.equal(fs.existsSync(path.join(a.root, "absent.js")), false);
});

test("P0: model fallback retains receipts, deduplicates non-idempotent replay and passes new valid work", async (t) => {
  const a = agentFor(t);
  a.permissions = { check: async () => ({ decision: "allow" }) };
  const commits = [];
  a.tools.register({ name: "send_once", idempotent: false, capability: { readOnly: false, riskLevel: "low", sideEffect: "network" },
    parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    execute: args => { commits.push(args.message); return JSON.stringify({ ok: true, receipt: commits.length }); } });
  let firstRound = 0, secondRound = 0;
  const first = { model: "first", supportsNativeToolCalls: true, apiChat: async () => {
    if (++firstRound === 1) return response(null, [toolCall("send_once", { message: "one" })]);
    throw new Error("injected model transport failure");
  } };
  const second = { model: "second", supportsNativeToolCalls: true, apiChat: async (messages) => {
    if (++secondRound === 1) {
      assert.equal(messages.filter(m => m.role === "tool").length, 1, "handoff must preserve first receipt");
      return response(null, [toolCall("send_once", { message: "one" }, "replayed-call")]);
    }
    if (secondRound === 2) {
      assert.match(messages.filter(m => m.role === "tool").at(-1).content, /回执复用/);
      return response(null, [toolCall("send_once", { message: "two" }, "new-call")]);
    }
    return response("Both requested messages have receipts.");
  } };
  a.allProviders = [first, second];
  const output = await a._llmWithFallback([{ role: "user", content: "Send one, then send two, once each." }]);
  assert.deepEqual(commits, ["one", "two"], "only the original and genuinely different operation commit");
  assert.equal(output, "Both requested messages have receipts.");
  assert.equal(a._lastFallback.to, "second");
});

test("P0 counterexample: a later user turn may deliberately repeat the same non-idempotent operation", async (t) => {
  const a = agentFor(t);
  a.permissions = { check: async () => ({ decision: "allow" }) };
  let commits = 0;
  a.tools.register({ name: "append_once", idempotent: false, execute: () => { commits++; return '{"ok":true}'; } });
  a.allProviders = [{ model: "one-provider", apiChat: async (messages) => messages.some(m => m.role === "tool")
    ? response("Appended once.") : response(null, [toolCall("append_once", { text: "same" })]) }];
  const seed = [{ role: "user", content: "Append same once." }];
  await a._llmWithFallback(seed);
  await a._llmWithFallback(seed);
  assert.equal(commits, 2, "receipt protection is scoped to one turn only");
});

test("P0 counterexample: undeclared append arguments cannot bypass retained receipts while custom fields remain intact", async (t) => {
  const a = agentFor(t);
  a.permissions = { check: async () => ({ decision: "allow" }) };
  const args = { path: "once.txt", content: "once\n" };
  const artifact = path.join(a.root, args.path);
  fs.writeFileSync(artifact, "existing\n");
  const refused = await a._runTool("append_file", { ...args, unused: true }, { receipt: true });
  assert.equal(toolResultStatus(refused).ok, false);
  assert.equal(toolResultStatus(refused).dispatched, false);
  assert.match(toolResultContent(refused), /未知参数 "unused"/);
  assert.equal(fs.readFileSync(artifact, "utf8"), "existing\n", "invalid extra field must not dispatch");
  let primaryRound = 0, backupRound = 0;
  a.allProviders = [
    { model: "primary", apiChat: async () => {
      if (++primaryRound === 1) return response(null, [toolCall("append_file", args, "append")]);
      throw new Error("injected model transport failure after append");
    } },
    { model: "backup", apiChat: async messages => {
      if (++backupRound === 1) return response(null, [toolCall("append_file", { ...args, unused: true }, "extra-replay")]);
      if (backupRound === 2) {
        assert.match(messages.filter(m => m.role === "tool").at(-1).content, /未知参数 "unused"/);
        return response(null, [toolCall("append_file", args, "corrected-replay")]);
      }
      assert.match(messages.filter(m => m.role === "tool").at(-1).content, /本次未再次执行/);
      return response("Append retained once.");
    } }
  ];
  assert.equal(await a._llmWithFallback([{ role: "user", content: "Append once only." }]), "Append retained once.");
  assert.equal(fs.readFileSync(artifact, "utf8"), "existing\nonce\n");
  let customArgs = null;
  a.tools.register({ name: "custom_extra", parameters: { type: "object", properties: {} }, execute: received => { customArgs = received; return "accepted"; } });
  assert.equal(await a.tools.call("custom_extra", { unused: true }), "accepted");
  assert.deepEqual(customArgs, { unused: true }, "unspecified custom fields must not be stripped or rejected");
});

test("P0 counterexample: a user-authorized second identical append still commits after handoff", async (t) => {
  const a = agentFor(t);
  a.permissions = { check: async () => ({ decision: "allow" }) };
  const args = { path: "twice.txt", content: "same line\n" };
  const trace = [];
  a.traces.record = e => trace.push(e);
  let primaryRound = 0, backupRound = 0;
  a.allProviders = [
    { model: "primary", apiChat: async () => {
      if (++primaryRound === 1) return response(null, [toolCall("append_file", args, "first-append")]);
      throw new Error("injected model transport failure after first append");
    } },
    { model: "backup", apiChat: async messages => {
      if (++backupRound === 1) return response(null, [toolCall("append_file", args, "replayed-append")]);
      if (backupRound === 2) {
        assert.match(messages.filter(m => m.role === "tool").at(-1).content, /本次未再次执行/);
        return response(null, [toolCall("append_file", args, "second-authorized-append")]);
      }
      return response("The line was appended twice.");
    } }
  ];
  assert.equal(await a._llmWithFallback([{ role: "user", content: "Append the same line to twice.txt exactly twice." }]), "The line was appended twice.");
  assert.equal(fs.readFileSync(path.join(a.root, "twice.txt"), "utf8"), "same line\nsame line\n");
  assert.equal(trace.filter(e => e.tool === "append_file").length, 2, "one reused receipt and two real commits");
});

test("P0 counterexample: fallback rereads declared read-only files after a write instead of reusing stale data", async (t) => {
  const a = agentFor(t);
  a.permissions = { check: async () => ({ decision: "allow" }) };
  fs.writeFileSync(path.join(a.root, "state.txt"), "old data");
  assert.equal(a.tools.metaOf("read_file").idempotent, false, "upstream has no idempotent declaration");
  const trace = [];
  a.traces.record = e => trace.push(e);
  let primaryRound = 0, backupRound = 0;
  a.allProviders = [
    { model: "primary", apiChat: async () => {
      if (++primaryRound === 1) return response(null, [toolCall("read_file", { path: "state.txt" }, "first-read")]);
      if (primaryRound === 2) return response(null, [toolCall("write_file", { path: "state.txt", content: "new data" }, "write")]);
      throw new Error("injected model transport failure after write");
    } },
    { model: "backup", apiChat: async messages => {
      if (++backupRound === 1) return response(null, [toolCall("read_file", { path: "state.txt" }, "read-after-handoff")]);
      assert.equal(messages.filter(m => m.role === "tool").at(-1).content, "new data", "readback must dispatch and see new state");
      return response("Read-back matches new data.");
    } }
  ];
  assert.equal(await a._llmWithFallback([{ role: "user", content: "Read state.txt, replace its contents with new data, then verify by reading it." }]), "Read-back matches new data.");
  assert.equal(fs.readFileSync(path.join(a.root, "state.txt"), "utf8"), "new data");
  assert.deepEqual(trace.filter(e => e.tool === "read_file").map(e => e.result), ["old data", "new data"]);
});

for (const rewrite of ["hook", "approval-updatedInput"]) {
  for (const replayPath of ["requested.txt", "actual.txt"]) {
    test(`P0: ${rewrite} retains actual dispatch args; ${replayPath} shares one receipt consumption`, async (t) => {
      const a = agentFor(t);
      if (rewrite === "hook") {
        a.permissions = { check: async () => ({ decision: "allow" }) };
        a.hooks.on("PreToolUse", ({ tool, args }) => {
          if (tool === "append_file" && args.path === "requested.txt") args.path = "actual.txt";
        });
      } else {
        a.permissions = { check: async () => ({ decision: "ask", reason: "fixture-only edited approval" }) };
        a.registerApprovalSurface("fixture");
        // Exercise the existing approval edited-input contract through the
        // production admission chain; no external approval UI is contacted.
        a._requestApproval = async ({ args }) => ({ updatedInput: { ...args, path: "actual.txt" } });
      }
      const trace = [];
      a.traces.record = e => trace.push(e);
      const args = (p) => ({ path: p, content: "same line\n" });
      let primaryRound = 0, backupRound = 0;
      a.allProviders = [
        { model: "primary", apiChat: async () => {
          if (++primaryRound === 1) return response(null, [toolCall("append_file", args("requested.txt"), "initial")]);
          throw new Error("controlled model request failure after actual append");
        } },
        { model: "backup", apiChat: async messages => {
          if (++backupRound === 1) return response(null, [toolCall("append_file", args(replayPath), "retained")]);
          if (backupRound === 2) {
            assert.match(messages.filter(m => m.role === "tool").at(-1).content, /本次未再次执行/);
            // The other alias is deliberate new work after the reused receipt.
            return response(null, [toolCall("append_file", args(replayPath === "actual.txt" ? "requested.txt" : "actual.txt"), "authorized-second")]);
          }
          return response("The same line was appended twice to actual.txt.");
        } }
      ];
      assert.equal(await a._llmWithFallback([{ role: "user", content: "Append the same line exactly twice to actual.txt." }]),
        "The same line was appended twice to actual.txt.", "postcondition must check the executed path, not the original proposal");
      assert.equal(fs.readFileSync(path.join(a.root, "actual.txt"), "utf8"), "same line\nsame line\n");
      assert.equal(fs.existsSync(path.join(a.root, "requested.txt")), false);
      assert.equal(trace.filter(e => e.tool === "append_file").length, 2, "aliases share one retained receipt, permitting the authorized second append");
      assert.ok(trace.every(e => e.args.path === "actual.txt"));
    });
  }
}

test("P0: uncertain tool exception never restarts against another provider", async (t) => {
  const a = agentFor(t);
  let calls = 0, secondCalls = 0;
  a._runTool = async () => { calls++; throw new Error("injected unknown dispatch outcome"); };
  a.allProviders = [
    { model: "first", apiChat: async () => response(null, [toolCall("send_once", {})]) },
    { model: "second", apiChat: async () => { secondCalls++; return response("done"); } }
  ];
  await assert.rejects(() => a._llmWithFallback([{ role: "user", content: "send once" }]), /unknown dispatch outcome/);
  assert.equal(calls, 1);
  assert.equal(secondCalls, 0);
});

test("P0: local memory/file/time shortcuts cannot bypass explicit permission deny", async (t) => {
  const a = agentFor(t);
  let executions = 0;
  a.permissions = { check: async () => ({ decision: "deny", reason: "explicit policy deny" }) };
  for (const name of ["memory_add", "read_file", "list_dir", "get_time"]) {
    a.tools.register({ name, execute: () => { executions++; return '{"ok":true}'; } });
  }
  for (const prompt of ["记住: synthetic fact", "读文件 file.txt", "列出 .", "几点"]) {
    const result = await a._localIntent(prompt);
    assert.match(result, /拒绝|deny|没记上|没办成/);
  }
  assert.equal(executions, 0);
});

test("P0: local memory shortcut in plan mode produces no mutation", async (t) => {
  const a = agentFor(t);
  let commits = 0;
  a.setPlanMode("default", true);
  a.tools.register({ name: "memory_add", capability: { readOnly: false, riskLevel: "low" }, execute: () => { commits++; return '{"ok":true}'; } });
  assert.match(await a._localIntent("记住: synthetic fact"), /plan 模式|没记上/);
  assert.equal(commits, 0);
});

test("P0: malformed permission decisions deny before dispatch, while explicit allow still works", async (t) => {
  const a = agentFor(t);
  let commits = 0;
  a.tools.register({ name: "synthetic_mutation", idempotent: false, execute: () => { commits++; return '{"ok":true}'; } });
  for (const decision of [undefined, null, {}, { decision: "defer" }, "allow", []]) {
    a.permissions = { check: async () => decision };
    const admission = await a._admitToolCall("synthetic_mutation", {}, "invalid-decision", Date.now());
    assert.equal(admission.ok, false);
    assert.match(admission.error, /无效决策|fail-closed/);
    const result = await a._runTool("synthetic_mutation", {}, { receipt: true });
    assert.equal(toolResultStatus(result).ok, false);
    assert.equal(toolResultStatus(result).dispatched, false, "admission refusal is not an uncertain commit");
  }
  assert.equal(commits, 0);
  a.permissions = { check: async () => ({ decision: "allow" }) };
  const result = await a._runTool("synthetic_mutation", {}, { receipt: true });
  assert.equal(toolResultStatus(result).ok, true);
  assert.equal(toolResultStatus(result).dispatched, true);
  assert.equal(commits, 1);
});

test("P0: mandatory security exception/open/invalid decision deny every dispatch; optional observation may fail", async () => {
  const c = new ToolCatalog();
  let commits = 0, checks = 0;
  c.register({ name: "mutation", execute: () => { commits++; return "ok"; } });
  c.addPolicySubscriber(() => { checks++; throw new Error("policy unavailable"); }, { name: "required-policy", breaker: { threshold: 3, cooldownMs: 60000 } });
  for (let i = 0; i < 4; i++) assert.match(await c.call("mutation", {}), /策略拦截/);
  assert.equal(commits, 0);
  assert.equal(checks, 3);
  assert.equal(c.policyStatus()[0].state, "open");
  const invalid = new ToolCatalog();
  invalid.register({ name: "mutation", execute: () => { commits++; return "ok"; } });
  invalid.addPolicySubscriber(() => ({ decision: "unexpected" }), { name: "invalid-policy" });
  assert.match(await invalid.call("mutation", {}), /策略拦截/);
  const observed = new ToolCatalog();
  observed.register({ name: "lookup", execute: () => "allowed" });
  observed.addPolicySubscriber(() => { throw new Error("telemetry unavailable"); }, { mandatory: false });
  assert.equal(await observed.call("lookup", {}), "allowed");
});
