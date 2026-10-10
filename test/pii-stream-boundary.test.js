// PII must be masked before any user-visible delta, including identifiers split across chunks.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { HttpChannel } from "../src/channels/http.js";
import { McpServer } from "../src/mcp/server.js";
import { maskPIIOutput } from "../src/utils/pii-output.js";
import { toolOutcome } from "../src/core/tool-result.js";
import { setLevel } from "../src/utils/logger.js";

setLevel("error");

const CHUNKS = ["联系 synthetic-", "pii@", "example.invalid，手机 138", "00138000。"];
const RAW_REPLY = CHUNKS.join("");
const MASKED_REPLY = "联系 [REDACTED]，手机 [REDACTED]。";

function makeAgent(t, { mask = true, tools = false, streamError = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-pii-stream-boundary-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({
    providers: [],
    embedding: { enabled: false },
    agent: { localIntent: false, proactive: { enabled: false }, evolve: { enabled: false } },
    tools: { enabled: tools },
    security: { pii_reply_mask: mask },
  }));
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data"), globalDataDir: path.join(root, "global") });
  const llm = {
    providerId: "synthetic-pii", model: "synthetic-pii", supportsStream: true,
    supportsNativeToolCalls: true, health: async () => true,
    chat: async () => ({ content: RAW_REPLY }),
    apiChat: async () => ({ message: { role: "assistant", content: RAW_REPLY, tool_calls: null } }),
    streamChat: async (_messages, { onDelta }) => {
      for (const chunk of CHUNKS) onDelta(chunk);
      if (streamError) throw streamError;
      return RAW_REPLY;
    },
  };
  agent.llm = llm;
  agent.allProviders = [llm];
  t.after(async () => {
    await agent.shutdown();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.equal(path.basename(root).startsWith("ppx-pii-stream-boundary-"), true);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return agent;
}

function assertMasked(text) {
  assert.doesNotMatch(text, /synthetic-pii@example\.invalid|13800138000/);
  assert.match(text, /\[REDACTED\]/);
}

function parseSSE(raw) {
  return raw.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split("\n").find((line) => line.startsWith("data:"));
    return data ? [JSON.parse(data.slice(5).trim())] : [];
  });
}

for (const tools of [false, true]) {
  test(`mask before emission: ${tools ? "tool-loop reply" : "split provider chunks"}`, async (t) => {
    const agent = makeAgent(t, { tools });
    const deltas = [];
    const reply = await agent.chatStream("synthetic evaluation", { sessionKey: "pii", onDelta: (d) => deltas.push(d) });
    assert.equal(reply, MASKED_REPLY);
    assert.deepEqual(deltas, [MASKED_REPLY], "masking mode buffers the reply instead of emitting raw fragments");
    assertMasked(deltas.join(""));
  });
}

test("mask disabled preserves incremental provider chunks", async (t) => {
  const agent = makeAgent(t, { mask: false });
  const deltas = [];
  const reply = await agent.chatStream("synthetic evaluation", { onDelta: (d) => deltas.push(d) });
  assert.equal(reply, RAW_REPLY);
  assert.deepEqual(deltas, CHUNKS);
});

test("abort flushes only masked partial reply and never retries", async (t) => {
  const abort = new Error("synthetic cancellation");
  abort.name = "AbortError";
  const agent = makeAgent(t, { streamError: abort });
  let retries = 0;
  agent.chat = async () => { retries += 1; return RAW_REPLY; };
  const deltas = [];
  const reply = await agent.chatStream("synthetic evaluation", { onDelta: (d) => deltas.push(d) });
  assert.equal(retries, 0);
  assert.equal(reply, MASKED_REPLY);
  assert.deepEqual(deltas, [MASKED_REPLY]);
  assert.equal(agent._streamAborts.size, 0);
});

test("provider failure cannot emit buffered raw PII before the fallback reply", async (t) => {
  const agent = makeAgent(t, { streamError: new Error("synthetic transport failure") });
  agent.chat = async () => RAW_REPLY;
  const deltas = [];
  const reply = await agent.chatStream("synthetic evaluation", { onDelta: (d) => deltas.push(d) });
  assert.equal(reply, MASKED_REPLY);
  assert.deepEqual(deltas, [MASKED_REPLY]);
});

for (const early of ["budget", "local", "no-provider"]) {
  test(`early ${early} reply uses the same masked emission boundary`, async (t) => {
    const agent = makeAgent(t);
    if (early === "budget") agent._budgetBlocked = () => RAW_REPLY;
    if (early === "local") {
      agent.config.agent.localIntent = true;
      agent._localIntent = async () => RAW_REPLY;
    }
    if (early === "no-provider") {
      agent.llm = null;
      agent.chat = async () => RAW_REPLY;
    }
    const deltas = [];
    const reply = await agent.chatStream("synthetic evaluation", { onDelta: (d) => deltas.push(d) });
    assert.equal(reply, MASKED_REPLY);
    assert.deepEqual(deltas, [MASKED_REPLY]);
  });
}

test("local get_time stream clears only its own completed turn marker", async (t) => {
  const agent = makeAgent(t, { tools: true });
  agent.config.agent.localIntent = true;
  agent._turnsUsedTools.set("other-active-session", true);
  const deltas = [];
  const reply = await agent.chatStream("现在几点", {
    sessionKey: "local-get-time", onDelta: (d) => deltas.push(d),
  });
  assert.ok(reply.length > 0);
  assert.deepEqual(deltas, [reply]);
  assert.equal(agent._turnsUsedTools.has("local-get-time"), false);
  assert.equal(agent._turnsUsedTools.has("other-active-session"), true);
});

const functionCall = (name, args, id) => ({
  id, type: "function", function: { name, arguments: JSON.stringify(args) },
});
const modelResponse = (content, tool_calls = null) => ({ message: { role: "assistant", content, tool_calls } });

for (const providers of [1, 2]) {
  test(`stream tool failure retains committed append with ${providers} provider(s)`, async (t) => {
    const agent = makeAgent(t, { tools: true });
    agent.permissions = { check: async () => ({ decision: "allow" }) };
    fs.writeFileSync(path.join(agent.root, "append.txt"), "existing\n");
    let primaryRequests = 0, secondaryRequests = 0;
    const primary = { model: "primary", supportsNativeToolCalls: true, apiChat: async () => {
      if (++primaryRequests === 1) return modelResponse(null, [functionCall("append_file", { path: "append.txt", content: "once\n" }, "append")]);
      throw new Error("synthetic model failure after committed append");
    } };
    const secondary = { model: "secondary", supportsNativeToolCalls: true, apiChat: async (messages) => {
      if (++secondaryRequests === 1) {
        assert.equal(messages.filter((m) => m.role === "tool").length, 1);
        return modelResponse(null, [functionCall("append_file", { path: "append.txt", content: "once\n" }, "replay")]);
      }
      if (secondaryRequests === 2) return modelResponse(null, [functionCall("read_file", { path: "append.txt" }, "verify")]);
      return modelResponse("Append verified once.");
    } };
    agent.llm = primary;
    agent.allProviders = providers === 2 ? [primary, secondary] : [primary];
    const deltas = [];
    const reply = await agent.chatStream("Append once only, then verify by reading append.txt.", {
      sessionKey: "stream-append", onDelta: (d) => deltas.push(d),
    });
    assert.equal(fs.readFileSync(path.join(agent.root, "append.txt"), "utf8"), "existing\nonce\n");
    assert.equal(primaryRequests, 2, "all-provider failure must not restart the primary task");
    assert.deepEqual(deltas, [reply]);
    if (providers === 2) assert.equal(reply, "Append verified once.");
    else assert.match(reply, /失败|不可用|连不上|没有完成/);
  });
}

test("stream handoff cannot recommit append through an equivalent workspace path alias", async (t) => {
  const agent = makeAgent(t, { tools: true });
  agent.permissions = { check: async () => ({ decision: "allow" }) };
  fs.writeFileSync(path.join(agent.root, "append.txt"), "existing\n");
  let primaryRequests = 0, secondaryRequests = 0;
  const primary = { model: "primary", supportsNativeToolCalls: true, apiChat: async () => {
    if (++primaryRequests === 1) return modelResponse(null, [functionCall("append_file", { path: "append.txt", content: "once\n" }, "append")]);
    throw new Error("synthetic model failure after committed append");
  } };
  const secondary = { model: "secondary", supportsNativeToolCalls: true, apiChat: async () => {
    if (++secondaryRequests === 1) return modelResponse(null, [functionCall("append_file", { path: "./append.txt", content: "once\n" }, "alias-replay")]);
    return modelResponse("Append retained once.");
  } };
  agent.llm = primary;
  agent.allProviders = [primary, secondary];
  await agent.chatStream("Append once only.", { sessionKey: "stream-alias" });
  assert.equal(fs.readFileSync(path.join(agent.root, "append.txt"), "utf8"), "existing\nonce\n");
});

test("stream handoff retains an uncertain non-idempotent timeout after a real commit", async (t) => {
  const agent = makeAgent(t, { tools: true });
  agent.permissions = { check: async () => ({ decision: "allow" }) };
  const artifact = path.join(agent.root, "synthetic-ack.txt");
  agent.tools.register({
    name: "synthetic_commit_ack_timeout", idempotent: false,
    capability: { readOnly: false, riskLevel: "low", sideEffect: "workspace" },
    execute: () => {
      fs.appendFileSync(artifact, "committed\n");
      return toolOutcome("Remote acceptance simulated; acknowledgement timed out.", {
        ok: false, timedOut: true, exitCode: null, error: "acknowledgement timeout",
      });
    },
  });
  let primaryRequests = 0, secondaryRequests = 0;
  const primary = { model: "primary", supportsNativeToolCalls: true, apiChat: async () => {
    if (++primaryRequests === 1) return modelResponse(null, [functionCall("synthetic_commit_ack_timeout", {}, "commit")]);
    throw new Error("synthetic model failure after uncertain acknowledgement");
  } };
  const secondary = { model: "secondary", supportsNativeToolCalls: true, apiChat: async () => {
    if (++secondaryRequests === 1) return modelResponse(null, [functionCall("synthetic_commit_ack_timeout", {}, "replay")]);
    return modelResponse("The original acknowledgement remains uncertain.");
  } };
  agent.llm = primary;
  agent.allProviders = [primary, secondary];
  await agent.chatStream("Run the synthetic action once only.", { sessionKey: "stream-uncertain-ack" });
  assert.equal(fs.readFileSync(artifact, "utf8"), "committed\n", "timeout does not prove the side effect was absent");
});

test("MCP final content uses the filtered final reply rather than accumulated deltas", async () => {
  const agent = { config: {}, chatStream: async (_message, { onDelta }) => {
    onDelta("synthetic stale delta");
    return "filtered final reply";
  } };
  const mcp = new McpServer(agent);
  const result = await mcp._callTool("ppx.chat.stream", { message: "synthetic evaluation" }, {});
  assert.equal(result.content[0].text, "filtered final reply");
});

test("tool and step events mask nested outbound PII without changing tool input", async (t) => {
  const agent = makeAgent(t, { tools: true });
  let originalToolInput = null;
  agent.tools.register({
    name: "synthetic_pii_event",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    parameters: { type: "object", properties: { email: { type: "string" }, nested: { type: "object" } } },
    execute: async (args) => { originalToolInput = args; return "synthetic tool result"; },
  });
  let calls = 0;
  agent.llm.apiChat = async () => {
    calls += 1;
    if (calls === 1) {
      agent._onStepEvent?.({ round: 0, note: RAW_REPLY });
      return { message: { role: "assistant", content: null, tool_calls: [{
        id: "synthetic-call", type: "function", function: { name: "synthetic_pii_event", arguments: JSON.stringify({ email: "synthetic-pii@example.invalid", nested: { password: "synthetic-credential", values: [RAW_REPLY] } }) },
      }] } };
    }
    return { message: { role: "assistant", content: RAW_REPLY, tool_calls: null } };
  };
  const tools = [];
  const steps = [];
  await agent.chatStream("synthetic evaluation", { onTool: (e) => tools.push(e), onStep: (e) => steps.push(e) });
  assert.equal(originalToolInput.email, "synthetic-pii@example.invalid", "only the outbound event is masked");
  assert.equal(originalToolInput.nested.password, "synthetic-credential");
  assertMasked(JSON.stringify(tools));
  assert.doesNotMatch(JSON.stringify(tools), /synthetic-credential/);
  assertMasked(JSON.stringify(steps));
});

test("masking exceptions hide output instead of returning the raw value", () => {
  const unmaskable = {};
  Object.defineProperty(unmaskable, "content", { enumerable: true, get() { throw new Error("synthetic masking failure"); } });
  assert.equal(maskPIIOutput(unmaskable), "[REDACTED]");
  const cycle = { text: RAW_REPLY };
  cycle.self = cycle;
  assert.equal(maskPIIOutput(cycle), "[REDACTED]");
  assert.equal(PPXAgent.prototype._maskReplyPII.call({ config: { security: { pii_reply_mask: true } } }, unmaskable), "[REDACTED]");
});

test("HTTP and MCP SSE error messages are masked after a downstream failure", { timeout: 20000 }, async (t) => {
  const agent = makeAgent(t);
  agent._persistTurn = async () => { throw new Error(RAW_REPLY); };
  const channel = new HttpChannel(agent, { host: "127.0.0.1", port: 0 });
  channel.authToken = "synthetic-test-token";
  await channel.connect();
  t.after(() => channel.disconnect());
  const base = `http://127.0.0.1:${channel.server.address().port}`;
  for (const route of ["/message/stream", "/mcp"]) {
    const body = route === "/mcp"
      ? { jsonrpc: "2.0", id: 72, method: "tools/call", params: { name: "ppx.chat.stream", arguments: { message: "synthetic evaluation" } } }
      : { message: "synthetic evaluation" };
    const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: "Bearer synthetic-test-token" }, body: JSON.stringify(body) });
    const raw = await response.text();
    assertMasked(raw);
    const events = parseSSE(raw);
    const error = route === "/mcp" ? events.find((e) => e.id === 72).error.message : events.find((e) => e.type === "error").error;
    assert.equal(error, MASKED_REPLY);
  }
});

for (const tools of [false, true]) {
  test(`HTTP and MCP SSE never expose raw PII (${tools ? "tool loop" : "split chunks"})`, { timeout: 20000 }, async (t) => {
    const agent = makeAgent(t, { tools });
    const channel = new HttpChannel(agent, { host: "127.0.0.1", port: 0 });
    channel.authToken = "synthetic-test-token";
    await channel.connect();
    t.after(() => channel.disconnect());
    const base = `http://127.0.0.1:${channel.server.address().port}`;
    for (const route of ["/message/stream", "/mcp"]) {
      const body = route === "/mcp"
        ? { jsonrpc: "2.0", id: 71, method: "tools/call", params: { name: "ppx.chat.stream", arguments: { message: "synthetic evaluation", sessionId: "mcp-pii" } } }
        : { message: "synthetic evaluation", sessionId: "http-pii" };
      const response = await fetch(base + route, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: "Bearer synthetic-test-token" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      const raw = await response.text();
      assertMasked(raw);
      const events = parseSSE(raw);
      if (route === "/mcp") {
        const progress = events.filter((e) => e.method === "notifications/progress").map((e) => e.params.message).join("");
        const final = events.find((e) => e.id === 71).result.content[0].text;
        assert.equal(progress, MASKED_REPLY);
        assert.equal(final, MASKED_REPLY);
      } else {
        const delta = events.filter((e) => e.type === "delta").map((e) => e.content).join("");
        const final = events.find((e) => e.type === "done").content;
        assert.equal(delta, MASKED_REPLY);
        assert.equal(final, MASKED_REPLY);
      }
    }
  });
}
