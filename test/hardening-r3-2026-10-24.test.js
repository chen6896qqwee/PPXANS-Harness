// test/hardening-r3-2026-10-24.test.js - 2026-10-24 第三轮加固回归测试
// 覆盖: 斜杠命令全量接线 (11 条死命令 → 活) / move_file 工具 / PostToolUse 失败触发 /
//       agent.audit 绑定 / 命令不落库不进 LLM 语义
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-r3-${tag}-`));
}

function makeAgent(tag) {
  const root = tmpDir(tag);
  return { root, agent: new PPXAgent({ root, configFile: null }) };
}

// ---- 斜杠命令接线 ----
test("commands: /status /memory /skills /agents 直接返回结果 (不进 LLM)", async () => {
  const { agent, root } = makeAgent("cmds");
  agent.llm = { chat: async () => { throw new Error("不应调用 LLM"); } };
  const s = await agent.chat("/status", { persist: false });
  assert.ok(s.includes("模型:") && s.includes("生命周期"), `状态应组装, got: ${s.slice(0, 80)}`);
  const m = await agent.chat("/memory", { persist: false });
  assert.ok(m.includes("记忆概览"));
  const sk = await agent.chat("/skills", { persist: false });
  assert.ok(typeof sk === "string" && sk.length > 0);
  const a = await agent.chat("/agents", { persist: false });
  assert.ok(a.includes("军团"));
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("commands: /new 重置会话, /resume 重定向切换会话", async () => {
  const { agent, root } = makeAgent("cmds2");
  agent.llm = { chat: async () => ({ content: "ok" }) };
  await agent.chat("第一条", { sessionKey: "r3s", persist: true });
  assert.ok(agent.sessionStore.count("r3s") > 0);
  // new: 重置当前会话
  const n = await agent.chat("/new", { sessionKey: "r3s", persist: false });
  assert.ok(n.includes("已重置"));
  assert.equal(agent.sessionStore.count("r3s"), 0);
  // resume 无参: 列出会话
  const lst = await agent.chat("/resume", { sessionKey: "r3s", persist: false });
  assert.ok(lst.includes("最近会话") || lst.includes("暂无"), lst.slice(0, 60));
  // 造一个旧会话再 resume —— (R5) 重定向语义: 后续对话直接落到目标会话
  await agent.chat("旧会话内容", { sessionKey: "old-s", persist: true });
  const before = agent.sessionStore.count("old-s");
  const r = await agent.chat("/resume old-s", { sessionKey: "r3s", persist: false });
  assert.ok(r.includes("已切换"), r.slice(0, 80));
  await agent.chat("恢复后说的话", { sessionKey: "r3s", persist: true });
  assert.equal(agent.sessionStore.count("old-s"), before + 2, "新轮次落进目标会话 (user+assistant)");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("commands: /model 无参列出可选模型, 已知名切换", async () => {
  const { agent, root } = makeAgent("cmds3");
  const p1 = { model: "m-a", providerId: "pa", chat: async () => ({ content: "a" }) };
  const p2 = { model: "m-b", providerId: "pb", chat: async () => ({ content: "b" }) };
  agent.allProviders = [p1, p2];
  agent.llm = p1;
  const lst = await agent.chat("/model", { persist: false });
  assert.ok(lst.includes("m-a") && lst.includes("m-b") && lst.includes("(当前)"));
  const sw = await agent.chat("/model m-b", { persist: false });
  assert.ok(sw.includes("m-b"));
  assert.equal(agent.llm, p2, "会话内主模型已切换");
  const bad = await agent.chat("/model nope", { persist: false });
  assert.ok(bad.includes("未找到"));
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

test("commands: 未知命令诚实报错并给可用清单; 非斜杠输入不受影响", async () => {
  const { agent, root } = makeAgent("cmds4");
  agent.llm = { chat: async () => ({ content: "LLM-REPLY" }), apiChat: async () => ({ message: { role: "assistant", content: "LLM-REPLY" } }) };
  const unk = await agent.chat("/no-such-cmd", { persist: false });
  assert.ok(unk.includes("未知命令") && unk.includes("/status"));
  const normal = await agent.chat("普通问题 / 不是命令", { persist: false });
  assert.equal(normal, "LLM-REPLY", "含斜杠的普通文本不误判");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- move_file ----
test("move_file: 移动生效 + undo 可回退; 缺源/同路径报业务错误", async () => {
  const root = tmpDir("mv");
  const { ToolCatalog } = await import("../src/tools/catalog.js");
  const { registerBuiltinTools } = await import("../src/tools/builtin.js");
  const catalog = new ToolCatalog();
  registerBuiltinTools(catalog, { rootDir: root, facts: { add: () => {} }, memory: {} });
  fs.writeFileSync(path.join(root, "src.txt"), "内容", "utf8");

  const err = JSON.parse(await catalog.call("move_file", { path: "nope.txt", destination: "x.txt" }, {}));
  assert.ok(err.error.includes("不存在"));
  const same = JSON.parse(await catalog.call("move_file", { path: "src.txt", destination: "src.txt" }, {}));
  assert.ok(same.error.includes("相同"));

  const r = JSON.parse(await catalog.call("move_file", { path: "src.txt", destination: "sub/dst.txt" }, {}));
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(path.join(root, "src.txt")), "源已移走");
  assert.equal(fs.readFileSync(path.join(root, "sub", "dst.txt"), "utf8"), "内容");

  // undo: 撤销目标侧 (恢复目标前状态 = 目标消失) 再撤销源侧 (恢复源内容)
  await catalog.call("undo_file", { path: "sub/dst.txt" }, {});
  assert.ok(!fs.existsSync(path.join(root, "sub", "dst.txt")), "目标侧撤销");
  await catalog.call("undo_file", { path: "src.txt" }, {});
  assert.equal(fs.readFileSync(path.join(root, "src.txt"), "utf8"), "内容", "源侧撤销恢复");
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- PostToolUse 失败也触发 ----
test("hooks: PostToolUse 对失败工具也触发 (payload 带 ok=false)", async () => {
  const { agent, root } = makeAgent("hooks");
  const seen = [];
  agent.hooks.on("PostToolUse", async (p) => { seen.push(p); });
  agent.tools = {
    call: async () => "[工具错误] 故意的失败",
    getCapability: () => ({ readOnly: false, riskLevel: "medium", destructive: false }),
  };
  agent._toolIdempotent = () => true;
  await agent._runTool("write_file", { path: "x.txt", content: "y" });
  assert.equal(seen.length, 1, "失败工具也应触发 PostToolUse");
  assert.equal(seen[0].ok, false);
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- agent.audit 绑定 ----
test("audit: agent.audit 已绑定, stats() 可用 (真模型 e2e 发现的缺口)", () => {
  const root = tmpDir("audit-bind");
  const agent = new PPXAgent({ root, configFile: null });
  assert.ok(agent.audit, "audit 链已绑定到 agent");
  const s = agent.audit.stats();
  assert.ok(typeof s.total === "number" && s.ok === true);
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});
