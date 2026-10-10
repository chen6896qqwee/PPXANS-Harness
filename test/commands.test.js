// test/commands.test.js - 斜杠命令统一模型 单测
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  createCommandRegistry, createBuiltinRegistry, BUILTIN_COMMANDS,
  loadUserCommands, createRegistryWithUserCommands,
} from "../src/commands/index.js";

test("parse: 解析 '/name args' 结构", () => {
  const reg = createBuiltinRegistry();
  assert.deepEqual(reg.parse("/review src/api"), { cmd: "review", args: "src/api" });
  assert.deepEqual(reg.parse("/help"), { cmd: "help", args: "" });
  assert.equal(reg.parse("普通文本"), null, "非/开头返回 null");
  assert.equal(reg.parse("/"), null, "仅有/无名称返回 null");
});

test("内置命令齐全: 13 个命令全部注册", () => {
  const reg = createBuiltinRegistry();
  const names = reg.list().map((c) => c.name).sort();
  const expected = ["new", "resume", "compact", "plan", "review", "init", "model", "status",
    "memory", "skills", "agents", "goal", "help"].sort();
  assert.deepEqual(names, expected, "内置命令集合一致");
  assert.equal(BUILTIN_COMMANDS.length, 13);
  // 每个命令具备 description 与 argumentHint
  for (const c of BUILTIN_COMMANDS) {
    assert.ok(c.description, `${c.name} 有描述`);
    assert.ok("argumentHint" in c, `${c.name} 有 argumentHint`);
    assert.equal(typeof c.isEnabled, "function");
    assert.equal(typeof c.run, "function");
  }
});

test("execute: 各内置命令返回结构化意图", () => {
  const reg = createBuiltinRegistry();
  assert.deepEqual(reg.execute("/new"), { type: "intent", action: "new_session" });
  assert.deepEqual(reg.execute("/compact"), { type: "intent", action: "compact" });
  assert.deepEqual(reg.execute("/resume sid123"), { type: "intent", action: "resume_session", sessionId: "sid123" });
  const r = reg.execute("/review src");
  assert.equal(r.type, "intent");
  assert.equal(r.action, "review");
  assert.equal(r.target, "src");
  // help 返回 message 且列出命令
  const h = reg.execute("/help");
  assert.equal(h.type, "message");
  assert.ok(h.content.includes("/review"));
});

test("execute: 未知命令与解析失败返回 error", () => {
  const reg = createBuiltinRegistry();
  assert.equal(reg.execute("/nope").type, "error");
  assert.equal(reg.execute("no slash").type, "error");
});

test("register: 可扩展自定义命令", () => {
  const reg = createCommandRegistry({ commands: [] });
  reg.register({ name: "deploy", description: "部署", argumentHint: "[env]", isEnabled: () => true,
    run: (_ctx, args) => ({ type: "intent", action: "deploy", env: args }) });
  assert.equal(reg.get("deploy").name, "deploy");
  const r = reg.execute("/deploy prod");
  assert.deepEqual(r, { type: "intent", action: "deploy", env: "prod" });
});

test("loadUserCommands + 合并: 从 .ppx/commands/*.md 加载", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-cmd-"));
  const dir = path.join(root, ".ppx", "commands");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summarize.md"), [
    "---",
    "name: summarize",
    "description: 总结当前对话",
    "argumentHint: [style]",
    "---",
    "请把上面的对话用要点形式总结。",
  ].join("\n"), "utf8");

  const userCmds = loadUserCommands(root);
  assert.equal(userCmds.length, 1, "加载到 1 个用户命令");
  assert.equal(userCmds[0].name, "summarize");
  assert.equal(userCmds[0].description, "总结当前对话");
  assert.equal(typeof userCmds[0].run, "function");

  const reg = createRegistryWithUserCommands(root);
  const r = reg.execute("/summarize brief");
  assert.equal(r.type, "prompt");
  assert.equal(r.command, "summarize");
  assert.equal(r.args, "brief");
  assert.ok(r.template.includes("要点形式"));
  fs.rmSync(root, { recursive: true, force: true });
});
