// test/ans-api.test.js - ANS 新能力的 HTTP 通道接入 (主动提醒 + 生命周期)
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { startServer } from "../src/server.js";
import { LLMClient } from "../src/llm/client.js";

function tmpRoot(n) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-ansapi-${n}-`));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({ channels: {} }));
  return root;
}

class StubLLM extends LLMClient {
  constructor() { super({ id: "http", base_url: "https://x/v1", api_key: "k", model: "m" }); }
  async chat() { return { content: "提醒: 记得研究 A 股策略", usage: null }; }
}

async function serve(root, llm = null) {
  const s = await startServer({ root, port: 0, llm });
  const port = s.http.server.address().port;
  return { ...s, port, token: s.http.authToken || "" };
}

async function stop(s) {
  s.server.closeAllConnections?.(); // 强制断开 keep-alive, 避免 close 挂起
  await new Promise((r) => s.server.close(r));
}

async function request(port, p, token = "") {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return r.json();
}

test("/api/proactive 有待办记忆时返回主动提醒", async () => {
  const root = tmpRoot("pa");
  const s = await serve(root, new StubLLM());
  s.agent.facts.add("记得下周要研究 A 股策略", { importance: 15 });
  const j = await request(s.port, "/api/proactive", s.token);
  assert.ok(j.message, "返回提醒文本");
  assert.ok(j.message.includes("A 股策略") || j.message.length > 0);
  s.agent.shutdown();
  await stop(s);
  fs.rmSync(root, { recursive: true, force: true });
});

test("/api/proactive 无待办时返回 message: null (不打扰)", async () => {
  const root = tmpRoot("pb");
  const s = await serve(root, new StubLLM());
  const j = await request(s.port, "/api/proactive", s.token);
  assert.equal(j.message, null, "无待办不打扰");
  s.agent.shutdown();
  await stop(s);
  fs.rmSync(root, { recursive: true, force: true });
});

test("/api/lifecycle 返回生命周期摘要", async () => {
  const root = tmpRoot("lc");
  const s = await serve(root, new StubLLM());
  const j = await request(s.port, "/api/lifecycle", s.token);
  assert.equal(j.stage, "born", "刚构造是 born");
  assert.ok(j.bornAt, "有诞生时间");
  assert.ok(Array.isArray(j.recent), "有阶段日志");
  s.agent.shutdown();
  await stop(s);
  fs.rmSync(root, { recursive: true, force: true });
});
