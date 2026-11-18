// test/cli-repl-2026-11-17.test.js — REPL 主循环进程内测试 (src/cli-repl.js createRepl)
// PassThrough 注入 IO, stub agent 计数每个交互分支; 无网络无子进程。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createRepl, CLI_LOCAL_COMMANDS } from "../src/cli-repl.js";

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-repl-${tag}-`));
}

function makeAgent(overrides = {}) {
  const calls = {
    chat: [], tracked: [], interrupts: 0, resets: 0,
    marks: [], shutdowns: 0, exit: [], ticker: null,
  };
  const agent = {
    commands: { list: () => [{ name: "/status" }, { name: "/model" }] },
    config: { providers: [], agent: {} },
    dataDir: tmpdir("state"),
    facts: { count: () => 3, list: () => [] },
    experience: { lessons: [] },
    llm: null,
    tools: { list: () => [] },
    interrupt() { calls.interrupts += 1; },
    resetSession(key) { calls.resets += 1; assert.equal(key, "default"); },
    proactiveMarkDone(id) { calls.marks.push(id); return true; },
    shutdown: async () => { calls.shutdowns += 1; },
    chat: async (t) => { calls.chat.push(t); return `echo:${t}`; },
    chatTracked: async (t, opts) => { calls.tracked.push(t); return { reply: await opts.run() }; },
    calls,
    ...overrides,
  };
  return agent;
}

async function withRepl(agent, { onExit = () => {} } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (d) => chunks.push(d.toString()));
  const rl = createRepl(agent, { input, output, updateCheck: false, onExit });
  const type = (line) => new Promise((r) => input.write(line + "\n", r));
  const flush = () => new Promise((r) => setTimeout(r, 30));
  const text = () => chunks.join("");
  return { rl, input, type, flush, text };
}

test("createRepl: 启动静默 (updateCheck=false); CLI 本地命令表导出稳定", async () => {
  const agent = makeAgent();
  const { rl, text } = await withRepl(agent);
  await new Promise((r) => setTimeout(r, 20));
  assert.match(text(), /皮皮虾>/, "初始 prompt");
  assert.match(text(), /皮皮虾/, "横幅");
  assert.match(text(), /还没有可用模型/, "无 provider 时给路标");
  assert.deepEqual(CLI_LOCAL_COMMANDS, ["stop", "reset", "proactive", "proactive-done", "quit", "exit", "q"]);
  rl.close();
});

test("createRepl: 空 prompt 只回显提示符, 不触发 chat", async () => {
  const agent = makeAgent();
  const { rl, type, flush, text } = await withRepl(agent);
  await type("   ");
  await flush();
  assert.equal(agent.calls.chat.length, 0);
  assert.equal(agent.calls.tracked.length, 0);
  assert.ok((text().match(/皮皮虾> /g) || []).length >= 2, "空行后再次提示");
  rl.close();
});

test("createRepl: 普通提问走 chatTracked, 回答回显, busy 释放可连续对话", async () => {
  const agent = makeAgent();
  const { rl, type, flush } = await withRepl(agent);
  await type("你好");
  await flush();
  assert.deepEqual(agent.calls.tracked, ["你好"]);
  assert.deepEqual(agent.calls.chat, ["你好"]);
  await type("第二条");
  await flush();
  assert.equal(agent.calls.tracked.length, 2, "busy 已释放");
  rl.close();
});

test("createRepl: busy 中普通输入被显式忽略, /stop 仍可中断", async () => {
  let release = null;
  const agent = makeAgent();
  agent.chatTracked = (t) => {
    agent.calls.tracked.push(t);
    return new Promise((r) => { release = r; });
  };
  const { rl, type, flush, text } = await withRepl(agent);
  await type("长任务");
  await flush();
  await type("插队消息");
  await flush();
  assert.match(text(), /任务执行中, 本次输入已忽略/);
  await type("/stop");
  await flush();
  assert.equal(agent.calls.interrupts, 1);
  assert.match(text(), /已发送中断信号/);
  release({ reply: "终于完成" });
  await flush();
  assert.match(text(), /终于完成/);
  await type("后续消息");
  await flush();
  assert.equal(agent.calls.tracked.length, 2, "busy 释放后恢复对话");
  rl.close();
});

test("createRepl: quit/exit/q 触发 shutdown + onExit", async () => {
  for (const word of ["quit", "exit", "q"]) {
    const exits = [];
    const agent = makeAgent();
    const { rl, type, flush, text } = await withRepl(agent, { onExit: () => exits.push(word) });
    await type(word);
    await flush();
    assert.equal(agent.calls.shutdowns, 1, `${word} 应触发 shutdown`);
    assert.deepEqual(exits, [word]);
    assert.match(text(), /收工, 已保存记忆/);
    rl.close();
  }
});

test("createRepl: /stop /reset /proactive-done 为 CLI 本地实现", async () => {
  const agent = makeAgent();
  const { rl, type, flush, text } = await withRepl(agent);
  await type("/stop");
  await flush();
  assert.equal(agent.calls.interrupts, 1);
  await type("/reset");
  await flush();
  assert.equal(agent.calls.resets, 1);
  await type("/proactive-done todo-1");
  await flush();
  assert.deepEqual(agent.calls.marks, ["todo-1"]);
  assert.match(text(), /已标记完成/);
  assert.equal(agent.calls.chat.length, 0, "本地命令不进 LLM");
  rl.close();
});

test("createRepl: /proactive 无待办时静默提示; 有待办时列出条目", async () => {
  const agent = makeAgent();
  const { rl: rl1, type: t1, flush: f1, text: x1 } = await withRepl(agent);
  await t1("/proactive");
  await f1();
  assert.match(x1(), /暂时没有需要提醒的事项/);
  rl1.close();

  const withTodo = makeAgent({
    facts: {
      count: () => 1,
      list: () => [{ id: "todo-9", content: "记得明天交周报" }],
    },
  });
  const { rl: rl2, type: t2, flush: f2, text: x2 } = await withRepl(withTodo);
  await t2("/proactive");
  await f2();
  assert.match(x2(), /【主动提醒】你之前提到过/, "无 LLM 走启发式拼接");
  assert.match(x2(), /\[todo-9\] 记得明天交周报/);
  rl2.close();
});

test("createRepl: registry 斜杠命令直通 agent.chat", async () => {
  const agent = makeAgent();
  const { rl, type, flush, text } = await withRepl(agent);
  await type("/status");
  await flush();
  assert.deepEqual(agent.calls.chat, ["/status"], "非本地命令交 registry/chat");
  assert.deepEqual(agent.calls.tracked, []);
  assert.match(text(), /echo:\/status/);
  rl.close();
});

test("createRepl: chat 抛错回显 [错误] 且不中断 REPL", async () => {
  const agent = makeAgent({ chat: async () => { throw new Error("模型离线"); } });
  const { rl, type, flush, text } = await withRepl(agent);
  await type("问一句");
  await flush();
  assert.match(text(), /\[错误\] 模型离线/);
  await type("/reset");
  await flush();
  assert.equal(agent.calls.resets, 1, "出错后 REPL 仍活着");
  rl.close();
});

test("createRepl: SIGINT 一次中断任务, 两次 shutdown+onExit", async () => {
  const exits = [];
  const agent = makeAgent();
  const { rl, flush, text } = await withRepl(agent, { onExit: () => exits.push("sigint") });
  rl.emit("SIGINT");
  await flush();
  assert.equal(agent.calls.interrupts, 1);
  assert.match(text(), /已中断, 再按一次 Ctrl\+C 退出/);
  rl.emit("SIGINT");
  await flush();
  assert.equal(agent.calls.shutdowns, 1);
  assert.deepEqual(exits, ["sigint"]);
  assert.match(text(), /皮皮虾 收工。/);
  rl.close();
});

test("createRepl: proactive.enabled 启动 ticker 并打印扫描间隔", async () => {
  let pushed = null;
  const agent = makeAgent({
    config: { providers: [], agent: { proactive: { enabled: true, interval_ms: 60000 } } },
    startProactiveTicker: (cb) => { pushed = cb; },
  });
  const { rl, text } = await withRepl(agent);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(pushed, "ticker 已注册");
  assert.match(text(), /主动提醒已开启: 每 1 分钟扫描记忆待办/);
  rl.close();
});
