// test/api-expansion-2026-10-07.test.js - 本轮 Web 能力补齐的 HTTP 端到端测试
// 覆盖 (后端新增, 前端接线):
//   · POST /api/workspace/write + GET /api/workspace/read   (文件可写, 此前只读)
//   · GET  /api/workspace/search                            (文件名/内容搜索)
//   · POST /api/goalboard add/update + GET                  (目标看板可写)
//   · POST /api/review/run                                  (审查按钮打真 API)
// 审批 "always" (P2-14) 为 agent 内存态, 单测见文末。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startServer } from "../src/server.js";

function stubLLM(id = "stub") {
  return {
    providerId: id, backend: "stub", model: "stub", vision: false,
    supportsStream: false, supportsNativeToolCalls: false,
    chat: async () => ({ content: "[stub]" }),
    apiChat: async () => ({ message: { role: "assistant", content: "[stub]", tool_calls: null } }),
    streamChat: async () => "[stub]",
    health: async () => true,
  };
}

async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-api-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({ providers: [] }, null, 2), "utf8");
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
const base = (ctx) => `http://127.0.0.1:${ctx.port}`;
const postJson = (ctx, p, body) => fetch(base(ctx) + p, { method: "POST", headers: ctx.headers, body: JSON.stringify(body) });

test("HTTP: /api/workspace write→read 回环 + search", async () => {
  const ctx = await boot();
  try {
    const w = await postJson(ctx, "/api/workspace/write", { path: "notes/hello.txt", content: "阿里巴巴与四十大盗" });
    assert.equal(w.status, 200);
    const wj = await w.json();
    assert.equal(wj.ok, true);
    assert.equal(wj.path, "notes/hello.txt");
    assert.ok(fs.existsSync(path.join(ctx.root, "notes", "hello.txt")), "文件应落盘");

    const r = await fetch(base(ctx) + "/api/workspace/read?path=" + encodeURIComponent("notes/hello.txt"), { headers: ctx.headers });
    const rj = await r.json();
    assert.equal(rj.ok, true);
    assert.match(rj.content, /阿里巴巴/);

    // 搜索: 文件名命中
    const s1 = await (await fetch(base(ctx) + "/api/workspace/search?q=hello", { headers: ctx.headers })).json();
    assert.ok(s1.results.some((x) => x.path === "notes/hello.txt"), "文件名应命中");

    // 搜索: 内容命中
    const s2 = await (await fetch(base(ctx) + "/api/workspace/search?q=" + encodeURIComponent("四十大盗"), { headers: ctx.headers })).json();
    assert.ok(s2.results.some((x) => x.path === "notes/hello.txt" && x.match === "content"), "内容应命中");
  } finally {
    await teardown(ctx);
  }
});

test("HTTP: /api/workspace/write 越界应报错", async () => {
  const ctx = await boot();
  try {
    const w = await postJson(ctx, "/api/workspace/write", { path: "../../evil.txt", content: "x" });
    assert.ok(w.status >= 400, "越界写入应被拒, 实际 " + w.status);
  } finally {
    await teardown(ctx);
  }
});

test("HTTP: /api/goalboard add → update → 列表可见", async () => {
  const ctx = await boot();
  try {
    const a = await postJson(ctx, "/api/goalboard", { op: "add", title: "上线新版本", priority: "p0" });
    assert.equal(a.status, 200);
    const aj = await a.json();
    assert.equal(aj.ok, true);
    const id = aj.goal.id;
    assert.equal(aj.goal.priority, "P0"); // 归一为大写
    assert.equal(aj.goal.status, "pending");

    const u = await postJson(ctx, "/api/goalboard", { op: "update", id, status: "done" });
    const uj = await u.json();
    assert.equal(uj.ok, true);
    assert.equal(uj.goal.status, "done");

    const list = await (await fetch(base(ctx) + "/api/goalboard", { headers: ctx.headers })).json();
    assert.ok(list.goals.some((g) => g.id === id && g.status === "done"));

    // 非法优先级 → 400 (归一/校验在 store 层)
    const bad = await postJson(ctx, "/api/goalboard", { op: "add", title: "x", priority: "P9" });
    assert.ok(bad.status >= 400, "非法优先级应报错, 实际 " + bad.status);
  } finally {
    await teardown(ctx);
  }
});

test("HTTP: /api/review/run 返回结构化结果并写入 /api/review/latest", async () => {
  const ctx = await boot();
  try {
    const r = await postJson(ctx, "/api/review/run", { diff: "+ const apiKey = \"sk-abcdef0123456789\";" });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(Array.isArray(j.issues));
    const latest = await (await fetch(base(ctx) + "/api/review/latest", { headers: ctx.headers })).json();
    assert.ok(Array.isArray(latest.issues), "latest 应可读");
  } finally {
    await teardown(ctx);
  }
});

test("approval: decision=always 批准并把命令写入审批缓存 (P2-14)", async () => {
  const ctx = await boot();
  try {
    const ag = ctx.agent;
    let resolved = "UNSET";
    // 手工注入一个待审批条目 (与 _requestApproval 内部结构一致)
    ag._pendingApprovals.set("ap_test_1", {
      req: { id: "ap_test_1", kind: "bash", tool: "run_command", args: { command: "npm run build" }, reason: "测试" },
      resolve: (v) => { resolved = v; },
      timer: null,
    });
    const ok = ag.resolveApproval("ap_test_1", "always");
    assert.equal(ok, true);
    assert.deepEqual(resolved, {}, "always 应视为批准");
    const key = ag._approvalCacheKey("run_command", { command: "npm run build" });
    assert.ok(key, "命令类工具应能算出缓存 key");
    assert.ok(ag._approvalCache.has(key), "always 应把命令写入审批缓存 (同类不再询问)");

    // 对照: deny 不入缓存
    ag._pendingApprovals.set("ap_test_2", {
      req: { id: "ap_test_2", kind: "bash", tool: "run_command", args: { command: "rm -rf /" } },
      resolve: () => {}, timer: null,
    });
    ag.resolveApproval("ap_test_2", "deny");
    const key2 = ag._approvalCacheKey("run_command", { command: "rm -rf /" });
    assert.ok(!ag._approvalCache.has(key2), "拒绝不得入缓存");
  } finally {
    await teardown(ctx);
  }
});
