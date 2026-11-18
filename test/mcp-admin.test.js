// test/mcp-admin.test.js - MCP 管理虚拟工具 + 任务面板 (零依赖)
// 覆盖: 会话 CRUD / 提供方 CRUD / 设置 / 任务面板 create/list/step/run
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { McpServer } from "../src/mcp/server.js";
import { createAdminTools } from "../src/mcp/admin.js";
import { TaskBoard } from "../src/mcp/tasks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function tmpRoot(n) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${n}-`)); }

function modernMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

// 构造带 admin 工具的 McpServer (模拟 channels/http.js 接线)
function makeMcpServer() {
  const agent = new PPXAgent({ root: tmpRoot("mcpadmin") });
  const admin = createAdminTools(agent);
  const srv = new McpServer(agent, { extraTools: admin.tools });
  return { agent, srv };
}

async function callTool(srv, name, args = {}) {
  const { result } = await srv.handle({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: args, _meta: modernMeta() },
  });
  return result;
}

function parseText(result) {
  return JSON.parse(result.content[0].text);
}

// ---- 会话管理 ----
test("ppx.sessions.list + history", async () => {
  const { agent, srv } = makeMcpServer();
  try {
    // 先制造一个会话
    await agent.chat("你好皮皮虾", { sessionKey: "alpha" });
    const r = await callTool(srv, "ppx.sessions.list");
    const j = parseText(r);
    assert.ok(Array.isArray(j));
    assert.ok(j.some((s) => s.key === "alpha"));
    const h = await callTool(srv, "ppx.sessions.history", { key: "alpha" });
    const hm = parseText(h);
    assert.ok(Array.isArray(hm));
    assert.ok(hm.some((m) => m.content && String(m.content).includes("你好皮皮虾")));
  } finally { agent.shutdown(); }
});

test("ppx.sessions.rename + delete", async () => {
  const { agent, srv } = makeMcpServer();
  try {
    await agent.chat("测试重命名", { sessionKey: "beta" });
    const r = await callTool(srv, "ppx.sessions.rename", { from: "beta", to: "beta2" });
    assert.equal(parseText(r), true);
    const d = await callTool(srv, "ppx.sessions.delete", { key: "beta2" });
    assert.equal(parseText(d).ok, true);
  } finally { agent.shutdown(); }
});

// ---- 提供方 ----
test("ppx.providers.list 不含明文 key", async () => {
  const { agent, srv } = makeMcpServer();
  try {
    const r = await callTool(srv, "ppx.providers.list");
    const j = parseText(r);
    assert.ok(Array.isArray(j.providers));
    for (const p of j.providers) {
      assert.ok(!("api_key" in p), "不应暴露 api_key 明文");
    }
  } finally { agent.shutdown(); }
});

test("ppx.providers.add + update + delete", async () => {
  const { agent, srv } = makeMcpServer();
  try {
    const add = await callTool(srv, "ppx.providers.add", { provider: { id: "testp", base_url: "http://127.0.0.1:9/v1", model: "m1", api_key: "sk-test" } });
    const aj = parseText(add);
    assert.equal(aj.ok, true);
    assert.equal(aj.provider.id, "testp");
    const up = await callTool(srv, "ppx.providers.update", { id: "testp", patch: { model: "m2" } });
    assert.equal(parseText(up).provider.model, "m2");
    const del = await callTool(srv, "ppx.providers.delete", { id: "testp" });
    assert.equal(parseText(del).ok, true);
  } finally { agent.shutdown(); }
});

test("ppx.providers.reorder", async () => {
  const { agent, srv } = makeMcpServer();
  try {
    await callTool(srv, "ppx.providers.add", { provider: { id: "a1", base_url: "http://127.0.0.1:9/v1", model: "m" } });
    await callTool(srv, "ppx.providers.add", { provider: { id: "a2", base_url: "http://127.0.0.1:9/v1", model: "m" } });
    const r = await callTool(srv, "ppx.providers.reorder", { order: ["a2", "a1"] });
    const j = parseText(r);
    assert.equal(j.providers[0].id, "a2");
  } finally { agent.shutdown(); }
});

// ---- 设置 ----
test("ppx.settings.get + update", async () => {
  const { agent, srv } = makeMcpServer();
  try {
    const g = await callTool(srv, "ppx.settings.get");
    const gj = parseText(g);
    assert.ok(gj.settings);
    const u = await callTool(srv, "ppx.settings.update", { patch: { user: { name: "测试用户" } } });
    const uj = parseText(u);
    assert.equal(uj.ok, true);
    assert.equal(uj.settings.user.name, "测试用户");
  } finally { agent.shutdown(); }
});

// ---- 任务面板 ----
test("ppx.task.create + list + step 状态派生", async () => {
  const { agent, srv } = makeMcpServer();
  try {
    const c = await callTool(srv, "ppx.task.create", { title: "技能评估", steps: ["读 README", "精读 SKILL.md", "检查目录"] });
    const cj = parseText(c);
    assert.equal(cj.status, "todo");
    assert.equal(cj.steps.length, 3);
    assert.ok(cj.id);
    // step 0 -> running: 任务自动 running
    const s0 = await callTool(srv, "ppx.task.step", { id: cj.id, index: 0, status: "running", detail: "开始读" });
    const s0j = parseText(s0);
    assert.equal(s0j.status, "running");
    assert.equal(s0j.steps[0].status, "running");
    // 全部 done -> 任务自动 done
    await callTool(srv, "ppx.task.step", { id: cj.id, index: 0, status: "done" });
    await callTool(srv, "ppx.task.step", { id: cj.id, index: 1, status: "done" });
    const s2 = await callTool(srv, "ppx.task.step", { id: cj.id, index: 2, status: "done" });
    assert.equal(parseText(s2).status, "done");
    const l = await callTool(srv, "ppx.task.list");
    const lj = parseText(l);
    assert.ok(lj.counts.done >= 1);
    assert.equal(lj.tasks[0].id, cj.id);
  } finally { agent.shutdown(); }
});

test("ppx.task.complete 回填 result + 持久化", async () => {
  const { agent, srv } = makeMcpServer();
  try {
    const c = await callTool(srv, "ppx.task.create", { title: "审查任务", steps: ["审查"] });
    const cj = parseText(c);
    const done = await callTool(srv, "ppx.task.run", { id: cj.id, prompt: "这个任务是审查技能, 请简单执行" });
    const dj = parseText(done);
    assert.equal(dj.ok, true);
    // run 走 agent.chat (离线也有回复), 任务应 done
    const l = await callTool(srv, "ppx.task.list");
    const lj = parseText(l);
    const t = lj.tasks.find((x) => x.id === cj.id);
    assert.equal(t.status, "done");
    assert.ok(t.result.length > 0);
  } finally { agent.shutdown(); }
});

test("ppx.task.templates 列出模板 + create 用 template_id", async () => {
  const { agent, srv } = makeMcpServer();
  try {
    const r = await callTool(srv, "ppx.task.templates");
    const j = parseText(r);
    assert.ok(Array.isArray(j));
    const apt = j.find((t) => t.id === "apt");
    assert.ok(apt, "应有 apt 模板");
    assert.ok(apt.steps.length >= 3);
    // 用模板创建
    const c = await callTool(srv, "ppx.task.create", { title: "用模板", template_id: "apt" });
    const cj = parseText(c);
    assert.equal(cj.steps.length, apt.steps.length);
    assert.equal(cj.steps[0].title, apt.steps[0]);
  } finally { agent.shutdown(); }
});

test("ppx.task.delete", async () => {
  const { agent, srv } = makeMcpServer();
  try {
    const c = await callTool(srv, "ppx.task.create", { title: "待删" });
    const cj = parseText(c);
    const d = await callTool(srv, "ppx.task.delete", { id: cj.id });
    assert.equal(parseText(d).ok, true);
    const l = await callTool(srv, "ppx.task.list");
    assert.ok(!parseText(l).tasks.some((x) => x.id === cj.id));
  } finally { agent.shutdown(); }
});

// ---- TaskBoard 独立单测 ----
test("TaskBoard 持久化: 重建后任务仍在", () => {
  const root = tmpRoot("taskboard");
  const b1 = new TaskBoard(root);
  const t = b1.create({ title: "持久化测试", steps: ["a", "b"] });
  b1.step({ id: t.id, index: 0, status: "done" });
  const b2 = new TaskBoard(root); // 重新加载
  const t2 = b2.get(t.id);
  assert.ok(t2);
  assert.equal(t2.steps[0].status, "done");
});

test("TaskBoard 非法状态拒绝", () => {
  const root = tmpRoot("taskboard");
  const b = new TaskBoard(root);
  const t = b.create({ title: "x" });
  assert.throws(() => b.update({ id: t.id, status: "bogus" }), /非法/);
  assert.throws(() => b.step({ id: t.id, index: 99, status: "done" }), /越界/);
  assert.throws(() => b.update({ id: "none", status: "done" }), /不存在/);
});
