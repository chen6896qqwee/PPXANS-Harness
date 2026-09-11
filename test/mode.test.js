// test/mode.test.js - 模式注册表 (编排策略可插拔)
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ModeRegistry, registerDefaultModes } from "../src/mode/index.js";
import { PPXAgent } from "../src/agent/index.js";

function tmpRoot(n) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${n}-`)); }

test("ModeRegistry 注册与执行", async () => {
  const r = new ModeRegistry();
  r.register("echo", async (agent, msg) => `echo:${msg}`);
  assert.equal(await r.run("echo", null, "hi"), "echo:hi");
  assert.deepEqual(r.list(), ["echo"]);
  assert.ok(r.has("echo"));
});

test("ModeRegistry 未知模式抛错", async () => {
  const r = new ModeRegistry();
  await assert.rejects(() => r.run("nope", null, "x"), /未知模式/);
});

test("registerDefaultModes 注册 react 和 single", () => {
  const r = new ModeRegistry();
  registerDefaultModes(r);
  assert.ok(r.has("react"));
  assert.ok(r.has("single"));
});

test("PPXAgent 支持 opts.mode 切换 single 模式", async () => {
  const root = tmpRoot("mode-agent");
  const agent = new PPXAgent({ root });
  // 无 LLM 时 single 模式应返回配置缺失提示
  const reply = await agent.chat("你好皮皮虾", { mode: "single" });
  assert.ok(typeof reply === "string");
  assert.ok(reply.length > 0);
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("PPXAgent 默认走 react 模式 (未指定 mode)", async () => {
  const root = tmpRoot("mode-agent2");
  const agent = new PPXAgent({ root });
  assert.ok(agent.ctx.consume("modes").has("react"));
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});
