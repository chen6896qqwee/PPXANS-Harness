import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TASKS, summarize } from "../bench/tasks.js";
import { runOne, runWithMajority, main, buildReport, scoreTrajectory, verifyTaskCompletion } from "../scripts/taskbench.js";
import { FactStore } from "../src/memory/fact-store.js";
import { LegionBoard } from "../src/memory/legion-board.js";
import { ToolCatalog } from "../src/tools/catalog.js";
import { toolOutcome } from "../src/core/tool-result.js";
import { renderRepoMap } from "../src/repomap/index.js";

const task = (id) => TASKS.find((t) => t.id === id);
const noExecution = (reply) => () => ({ config: {}, chat: async () => reply, shutdown() {} });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ppx-receipt-test-"));

test("correct nonce echo without persistent memory/board is not completion", async () => {
  for (const [id, reply] of [["memory-roundtrip", "基准测试口令-蓝鲸99"], ["board-roundtrip", "军团暗号-QW7"]]) {
    const result = await runOne(task(id), { quiet: true, createAgent: noExecution(reply) });
    assert.equal(result.pass, false);
    assert.equal(result.toolCalls.length, 0);
  }
});

test("numeric contradiction is rejected rather than keyword-matched", async () => {
  for (const [id, reply] of [["count-files", "不是 6 个, 而是 7 个"], ["version-report", "版本不是 7.7.7, 而是 8.0.0"]]) {
    assert.equal((await runOne(task(id), { quiet: true, createAgent: noExecution(reply) })).pass, false);
  }
});

test("correct factual value needs an actual matching tool receipt", async () => {
  assert.equal((await runOne(task("version-report"), { quiet: true, createAgent: noExecution("7.7.7") })).pass, false);
  for (const target of ["other.json", "package.json"]) {
    const result = await runOne(task("version-report"), { quiet: true, createAgent: (sandbox) => {
      const tools = { call: async (_name, args) => args.path === "package.json" ? fs.readFileSync(path.join(sandbox, args.path), "utf8") : "unrelated" };
      return { config: {}, tools, chat: async () => { await tools.call("read_file", { path: target }); return "7.7.7"; }, async shutdown() {} };
    } });
    assert.equal(result.pass, target === "package.json");
    assert.equal(result.toolCalls[0].receipt, true);
    assert.ok(result.toolCalls[0].callId);
  }
});

test("unrelated execution or answer-only output cannot prove reading the source", async () => {
  for (const output of ["[exit=0 ms=1 lines=1]\nunrelated", "[exit=0 ms=1 lines=1]\n7.7.7", "[exit=7 ms=1 lines=1]\nunrelated"]) {
    const result = await runOne(task("version-report"), { quiet: true, createAgent: () => {
      const tools = { call: async () => output };
      return { config: {}, tools, chat: async () => { await tools.call("run_command", { command: "echo unrelated" }); return "7.7.7"; }, async shutdown() {} };
    } });
    assert.equal(result.pass, false, output);
    assert.equal(result.toolCalls[0].ok, output.startsWith("[exit=0"));
  }
  const result = await runOne(task("version-report"), { quiet: true, createAgent: (sandbox) => {
    const tools = { call: async () => `[exit=0 ms=1 lines=4]\n${fs.readFileSync(path.join(sandbox, "package.json"), "utf8")}` };
    return { config: {}, tools, chat: async () => { await tools.call("run_command", { command: "an equivalent source read" }); return "7.7.7"; }, async shutdown() {} };
  } });
  assert.equal(result.pass, true, "full observed source remains a valid equivalent strategy");
});

test("typed status is authoritative and file JSON error fields remain ordinary data", async () => {
  const definition = { id: "typed-data", task: "probe", verify: () => ({ pass: true, detail: "custom artifact" }) };
  const result = await runOne(definition, { quiet: true, createAgent: () => {
    const tools = new ToolCatalog();
    tools.register({ name: "read_file", execute: async () => toolOutcome('{"ok":false,"error":"application data"}') });
    tools.register({ name: "run_command", execute: async () => toolOutcome("[exit=7 ms=1 lines=1]\nfailed", { ok: false, timedOut: false, exitCode: 7, error: "failed" }) });
    let forwarded = 0;
    return { config: {}, tools, chat: async () => {
      await tools.call("read_file", { path: "data.json" }, { onOutcome: () => { forwarded++; } });
      await tools.call("run_command", { command: "probe" });
      assert.equal(forwarded, 1, "collector must preserve an existing outcome observer");
      return "ok";
    }, async shutdown() {} };
  } });
  assert.equal(result.toolCalls[0].ok, true);
  assert.equal(result.toolCalls[0].result, '{"ok":false,"error":"application data"}');
  assert.equal(result.toolCalls[1].ok, false);
  assert.equal(result.toolCalls[1].status.exitCode, 7);
});

test("correct target without observed content and replacement inputs are rejected", async () => {
  for (const replace of [false, true]) {
    const result = await runOne(task("version-report"), { quiet: true, createAgent: (sandbox) => {
      const tools = { call: async () => {
        if (replace) fs.writeFileSync(path.join(sandbox, "package.json"), "unrelated");
        return "unrelated";
      } };
      return { config: {}, tools, chat: async () => { await tools.call("read_file", { path: "package.json" }); return "7.7.7"; }, async shutdown() {} };
    } });
    assert.equal(result.pass, false);
  }
});

test("file count requires observed directory entries, not an arbitrary command", async () => {
  for (const genuine of [false, true]) {
    const result = await runOne(task("count-files"), { quiet: true, createAgent: (sandbox) => {
      const tools = { call: async () => genuine ? fs.readdirSync(path.join(sandbox, "items")).map((name) => `[F] ${name}`).join("\n") : "unrelated" };
      return { config: {}, tools, chat: async () => { await tools.call("list_dir", { path: "items" }); return "6"; }, async shutdown() {} };
    } });
    assert.equal(result.pass, genuine);
  }
});

test("a symbol location requires a definition observation, not filename search alone", async () => {
  for (const genuine of [false, true]) {
    const result = await runOne(task("find-symbol"), { quiet: true, createAgent: (sandbox) => {
      const tools = { call: async () => genuine ? JSON.stringify(renderRepoMap(sandbox)) : "pricing.js\nunrelated.js" };
      return { config: {}, tools, chat: async () => {
        await tools.call(genuine ? "repo_map" : "search_files", genuine ? { root: "." } : { query: "*.js" });
        return "pricing.js";
      }, async shutdown() {} };
    } });
    assert.equal(result.pass, genuine);
  }
});

test("agent completion hooks cannot upgrade a failed execution receipt", async () => {
  const result = await runOne(task("version-report"), { quiet: true, createAgent: (sandbox) => {
    const tools = { call: async () => `[exit=7 ms=1 lines=4]\n${fs.readFileSync(path.join(sandbox, "package.json"), "utf8")}` };
    const agent = { config: {}, tools, _emitToolDone() {}, async shutdown() {} };
    agent.chat = async () => {
      const args = { command: "a failed source read" };
      const output = await tools.call("run_command", args);
      agent._emitToolDone("agent-call", "run_command", args, true, 1, output);
      return "7.7.7";
    };
    return agent;
  } });
  assert.equal(result.pass, false);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].agentCallId, "agent-call");
  assert.equal(result.toolCalls[0].ok, false);
});

test("actual persisted memory and board require write/query receipts, not only correct artifact", () => {
  const sandbox = tmp();
  try {
    new FactStore(path.join(sandbox, ".ppx"), {}).add("基准测试口令-蓝鲸99");
    new LegionBoard(path.join(sandbox, ".ppx-global")).publish({ content: "军团暗号-QW7" });
    const memory = { reply: "基准测试口令-蓝鲸99", toolCalls: [] };
    assert.equal(task("memory-roundtrip").verify(memory, { sandbox }).pass, true);
    assert.equal(verifyTaskCompletion(task("memory-roundtrip"), memory, { sandbox }).pass, false);
    memory.toolCalls.push({ tool: "memory_add", args: { content: memory.reply }, receipt: true, ok: true });
    assert.equal(verifyTaskCompletion(task("memory-roundtrip"), memory, { sandbox }).pass, true);
    const board = { reply: "军团暗号-QW7", toolCalls: [{ tool: "board_publish", args: { content: "军团暗号-QW7" }, receipt: true, ok: true }] };
    assert.equal(verifyTaskCompletion(task("board-roundtrip"), board, { sandbox }).pass, false);
    board.toolCalls.push({ tool: "board_query", args: { q: "QW7" }, result: "军团暗号-QW7", receipt: true, ok: true });
    assert.equal(verifyTaskCompletion(task("board-roundtrip"), board, { sandbox }).pass, true);
    board.toolCalls.reverse();
    assert.equal(verifyTaskCompletion(task("board-roundtrip"), board, { sandbox }).pass, false, "query before publish is not a round trip");
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test("code verifiers reject constant-answer implementations and runtime-broken rename", () => {
  const sandbox = tmp();
  try {
    task("write-function").setup(sandbox);
    fs.writeFileSync(path.join(sandbox, "utils.js"), "export function sum(a,b){return 42;}");
    assert.equal(task("write-function").verify({}, { sandbox }).pass, false);
    fs.writeFileSync(path.join(sandbox, "rename-me.js"), "export async function loadData(){return 1;} export async function main(){return missing();}");
    assert.equal(task("rename-symbol").verify({}, { sandbox }).pass, false);
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});

test("majority picks a verdict-matching deliverable and sums every attempt's tokens/cost", async () => {
  let attempt = 0;
  const definition = { id: "repeat-accounting", category: "unit", task: "probe", verify: (r) => ({ pass: r.reply === "yes", detail: r.reply }) };
  const result = await runWithMajority(definition, { quiet: true, runs: 3, createAgent: () => {
    const index = attempt++;
    const llm = { model: "test-priced", apiChat: async () => ({ usage: { total_tokens: (index + 1) * 100 } }) };
    return { config: { budget: { model_prices: { "test-priced": { prompt: 1, completion: 2 } } } }, llm, chat: async () => { await llm.apiChat([]); return index ? "yes" : "no"; }, async shutdown() {} };
  } });
  assert.equal(result.pass, true);
  assert.equal(result.reply, "yes");
  assert.equal(result.detail, "yes");
  assert.equal(result.selectedAttempt, 1);
  assert.equal(result.tokens, 600);
  assert.ok(Math.abs(result.costUsd - 0.0012) < 1e-12);
  assert.deepEqual(result.attempts.map((a) => a.tokens), [100, 200, 300]);
  assert.equal(summarize([result]).tokensPerSuccess, 600);
  await assert.rejects(runWithMajority(definition, { runs: 0 }), /positive integer/);
});

test("missing usage, unknown price and failed provider attempts are unknown, never free", async () => {
  const definition = { id: "accounting", task: "probe", verify: () => ({ pass: false, detail: "expected failure" }) };
  for (const mode of ["missing-usage", "unknown-price", "failed"]) {
    const result = await runOne(definition, { quiet: true, createAgent: () => {
      const llm = { model: "unpriced-model", apiChat: async () => { if (mode === "failed") throw new Error("provider failed"); return mode === "missing-usage" ? {} : { usage: { total_tokens: 20 } }; } };
      return { config: {}, llm, chat: async () => { await llm.apiChat([]); return "ok"; }, async shutdown() {} };
    } });
    assert.equal(result.costUsd, null, mode);
    assert.equal(result.tokens, mode === "unknown-price" ? 20 : null, mode);
    assert.ok(result.costUnknownCalls > 0);
    if (mode === "failed") assert.equal(result.calls, 2, "both guarded attempts must count");
  }
  const summary = summarize([{ id: "success", pass: true, tokens: 100, costUsd: 0.001 }, { id: "failed", pass: false, tokens: 200, costUsd: 0.002 }]);
  assert.equal(summary.tokensPerSuccess, 300);
  assert.equal(summary.costUsdPerSuccess, 0.003);
  assert.equal(summarize([{ pass: true, tokens: null, costUsd: null }]).costUsdPerSuccess, null);
  assert.equal(summarize([{ pass: false, tokens: 10, costUsd: 0.1 }]).costUsdPerSuccess, null);
});

test("empty trajectories stay unknown in aggregate and CLI returns failure after report", async () => {
  assert.equal(buildReport({}, [{ id: "empty", score: scoreTrajectory([]) }]).summary.gpa.toolErrorRate, null);
  const sandbox = tmp();
  try {
    const reportPath = path.join(sandbox, "report.json");
    const code = await main(["--only", "version-report", "--report", reportPath], { quiet: true, createAgent: noExecution("7.7.7") });
    assert.equal(code, 1);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.summary.pass, 0);
    assert.equal(report.verifier_version, 3);
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});
