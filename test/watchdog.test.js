// test/watchdog.test.js - Watchdog 控制回路 (2026-10-31 Super-agent 一期)
// 覆盖: 体征采集防御式 (残缺 agent 不炸); 回复分级; 心跳全链 (会话调用/落账/分级);
//       startWatchdog 配置门与防重入定时器启停 (真 PPXAgent + 临时根目录)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectSignals, renderWatchdogPrompt, classifyReply, watchdogHeartbeat, WATCHDOG_SESSION_KEY } from "../src/ans/watchdog.js";
import { PPXAgent } from "../src/agent/index.js";

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-watchdog-"));
}

// mkFakeAgent 惯例 (同 evolution-loop.test.js): 纯对象桩, 手写闭包
function mkFakeAgent({ dataDir, reply = "OK", chatThrows = false } = {}) {
  const chatCalls = [];
  return {
    chatCalls,
    agent: {
      dataDir,
      config: { agent: { watchdog: { enabled: true, interval_minutes: 30 } } },
      protocolStats: () => ({ sqPending: 0, eqSeq: 5 }),
      workStack: { status: () => ({ total: 2, active: 1, blocked: 1, current: { id: "w1", goal: "修复登录超时" } }) },
      failures: { list: () => [{ tool: "http_request", category: "network", error: "ETIMEDOUT", at: 1 }] },
      _evolutionLoop: { journalTail: () => [{ ts: "2026-10-31T00:00:00Z", fixed: 1 }] },
      chat: async (prompt, opts) => {
        chatCalls.push({ prompt, opts });
        if (chatThrows) throw new Error("LLM HTTP 429: 余额不足");
        return reply;
      },
    },
  };
}

test("collectSignals: 残缺 agent 全部防御式回落, 不炸", () => {
  const sig = collectSignals({});
  assert.equal(sig.sqPending, 0);
  assert.equal(sig.workstack, null);
  assert.deepEqual(sig.failures, []);
  assert.equal(sig.journal, null);
  assert.ok(sig.heapMB >= 0 && sig.uptimeMin >= 0);
  const sig2 = collectSignals(null);
  assert.equal(sig2.sqPending, 0, "连 agent 本身都没有也不炸");
});

test("renderWatchdogPrompt: 带上体征事实与分级规则, OK 时要求只回一行", () => {
  const sig = collectSignals(mkFakeAgent().agent);
  const p = renderWatchdogPrompt(sig);
  assert.match(p, /\[看门狗心跳\]/);
  assert.match(p, /SQ积压=0/);
  assert.match(p, /阻塞1/);
  assert.match(p, /http_request\/network/);
  assert.match(p, /OK/);
});

test("classifyReply: 首行 OK/WARN/CRIT 分级; 说不出结论视为 WARN", () => {
  assert.equal(classifyReply("OK 一切正常"), "ok");
  assert.equal(classifyReply("ok"), "ok");
  assert.equal(classifyReply("CRIT 主服务挂了\n详情…"), "crit");
  assert.equal(classifyReply("WARN 工作栈阻塞\n已介入"), "warn");
  assert.equal(classifyReply("我看看啊…"), "warn", "非结论开头 = warn");
  assert.equal(classifyReply(""), "warn");
});

test("watchdogHeartbeat: OK 心跳 → level ok, 落账, 独立会话键, 不需广播", async () => {
  const dir = mkTmpDir();
  try {
    const { agent, chatCalls } = mkFakeAgent({ dataDir: dir, reply: "OK 一切正常" });
    const r = await watchdogHeartbeat(agent);
    assert.equal(r.level, "ok");
    assert.equal(chatCalls.length, 1);
    assert.equal(chatCalls[0].opts.sessionKey, WATCHDOG_SESSION_KEY, "看门狗走独立 cron:watchdog 会话");
    assert.equal(chatCalls[0].opts.sessionKey, "ppx:cron:watchdog:dm");
    const lines = fs.readFileSync(path.join(dir, "evolve", "watchdog.jsonl"), "utf8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.equal(entry.level, "ok");
    assert.equal(entry.failures, 1);
    assert.ok(entry.reply.startsWith("OK"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("watchdogHeartbeat: WARN 回复 → level warn (startWatchdog 只对非 ok 回调)", async () => {
  const dir = mkTmpDir();
  try {
    const { agent } = mkFakeAgent({ dataDir: dir, reply: "WARN 工作栈有阻塞项, 已用 task_stack 查看" });
    const r = await watchdogHeartbeat(agent);
    assert.equal(r.level, "warn");
    const lines = fs.readFileSync(path.join(dir, "evolve", "watchdog.jsonl"), "utf8").trim().split("\n");
    assert.equal(JSON.parse(lines[lines.length - 1]).level, "warn");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("watchdogHeartbeat: 会话失败 (LLM 429) 不抛, 降级为 WARN 留账", async () => {
  const dir = mkTmpDir();
  try {
    const { agent } = mkFakeAgent({ dataDir: dir, chatThrows: true });
    const r = await watchdogHeartbeat(agent);
    assert.equal(r.level, "warn");
    assert.match(r.text, /看门狗会话失败/);
    assert.match(r.text, /429/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("startWatchdog: 配置门 + 定时器启停 (真 PPXAgent, 临时根目录)", async () => {
  const root = mkTmpDir();
  let agent = null;
  try {
    agent = new PPXAgent({ root, configFile: null });
    assert.equal(agent.startWatchdog(null), null, "默认 enabled:false → 不启动");
    agent.config.agent.watchdog = { enabled: true, interval_minutes: 30 };
    const timer = agent.startWatchdog(null);
    assert.ok(timer, "开启后返回定时器句柄");
    assert.equal(agent.startWatchdog(null), timer, "重复调用幂等 (不叠定时器)");
    agent.stopWatchdog();
    assert.equal(agent.startWatchdog(null) === null, false, "stop 后可再启");
    agent.stopWatchdog();
  } finally {
    try { await agent?.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
