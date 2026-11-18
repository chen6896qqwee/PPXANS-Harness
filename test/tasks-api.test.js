// test/tasks-api.test.js - 任务面板 HTTP API 端到端测试 (2026-10-07)
// 覆盖: GET /api/tasks (空/有数据) / POST create → step → complete / delete / 未知 op 报错
// 背景: 任务能力此前只活在 MCP 工具层 (ppx.task.*), Web 前端无 HTTP 入口。本次新增
//       /api/tasks 复用 createAdminTools() 里同一份 TaskBoard (src/mcp/tasks.js)。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startServer } from "../src/server.js";

function stubLLM(id = "stub") {
  return {
    providerId: id,
    backend: "stub",
    model: "stub",
    vision: false,
    supportsStream: false,
    supportsNativeToolCalls: false,
    chat: async () => ({ content: "[stub]" }),
    apiChat: async () => ({ message: { role: "assistant", content: "[stub]", tool_calls: null } }),
    streamChat: async () => "[stub]",
    health: async () => true,
  };
}

function makeTmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-tasks-"));
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "ppx.json"), JSON.stringify({ providers: [] }, null, 2), "utf8");
  return dir;
}

async function boot() {
  const root = makeTmpRoot();
  const svc = await startServer({ root, port: 0, host: "127.0.0.1", llm: stubLLM() });
  const port = svc.server.address().port;
  const headers = svc.http.authToken
    ? { "Content-Type": "application/json", "Authorization": `Bearer ${svc.http.authToken}` }
    : { "Content-Type": "application/json" };
  return { ...svc, port, headers, root };
}

async function teardown(ctx) {
  ctx.agent.shutdown();
  await new Promise((res) => ctx.server.close(res));
  fs.rmSync(ctx.root, { recursive: true, force: true });
}

const post = (ctx, body) =>
  fetch(`http://127.0.0.1:${ctx.port}/api/tasks`, { method: "POST", headers: ctx.headers, body: JSON.stringify(body) });

test("HTTP: GET /api/tasks 空列表 + counts 归零", async () => {
  const ctx = await boot();
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/tasks`, { headers: ctx.headers });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.deepEqual(j.tasks, []);
    assert.deepEqual(j.counts, { todo: 0, running: 0, done: 0, failed: 0 });
  } finally {
    await teardown(ctx);
  }
});

test("HTTP: POST /api/tasks create → step → complete 全链路", async () => {
  const ctx = await boot();
  try {
    // create
    let r = await post(ctx, { op: "create", title: "写周报", description: "本周", steps: ["收集", "润色"] });
    assert.equal(r.status, 200);
    let j = await r.json();
    assert.equal(j.ok, true);
    const id = j.task.id;
    assert.equal(j.task.title, "写周报");
    assert.equal(j.task.status, "todo");
    assert.equal(j.task.steps.length, 2);
    assert.equal(j.counts.todo, 1);

    // step 0 running → 任务 running
    r = await post(ctx, { op: "step", id, index: 0, status: "running" });
    j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.task.status, "running");

    // 剩一步 done → 任务自动 done
    r = await post(ctx, { op: "step", id, index: 0, status: "done" });
    j = await r.json();
    r = await post(ctx, { op: "step", id, index: 1, status: "done" });
    j = await r.json();
    assert.equal(j.task.status, "done");
    assert.equal(j.counts.done, 1);

    // GET 能看到
    const list = await (await fetch(`http://127.0.0.1:${ctx.port}/api/tasks`, { headers: ctx.headers })).json();
    assert.equal(list.tasks.length, 1);
    assert.equal(list.tasks[0].id, id);

    // delete
    r = await post(ctx, { op: "delete", id });
    j = await r.json();
    assert.equal(j.ok, true);
    assert.deepEqual(j.tasks, []);
  } finally {
    await teardown(ctx);
  }
});

test("HTTP: POST /api/tasks 未知 op 应报错 (4xx/5xx)", async () => {
  const ctx = await boot();
  try {
    const r = await post(ctx, { op: "explode" });
    assert.ok(r.status >= 400, "未知 op 应返回错误状态, 实际 " + r.status);
  } finally {
    await teardown(ctx);
  }
});
