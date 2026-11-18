// test/unit-gaps-2026-11-16.test.js — 低覆盖纯模块的边界钉 (2026-11-16 覆盖率轮)
// 覆盖: selfcode/source-text · web/read-json · session/plan-live · tools/{plan-live,world-model,anchored-edit}
// 这些模块此前只被集成测试间接执行; 这里按行为边界补直接断言, 不用"跑一遍就算覆盖"的空测。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripComments } from "../src/selfcode/source-text.js";
import { readJson } from "../src/web/read-json.js";
import { PlanLive } from "../src/session/plan-live.js";
import { registerPlanLiveTools } from "../src/tools/plan-live.js";
import { registerWorldModelTools } from "../src/tools/world-model.js";
import { registerAnchoredEditTools } from "../src/tools/anchored-edit.js";
import { lineHash } from "../src/edit/anchors.js";
import { TOOL_ERROR_PREFIX } from "../src/tools/seam.js";

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-unit-${tag}-`));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function stubCatalog() {
  const defs = new Map();
  return {
    register(def) { defs.set(def.name, def); },
    def(name) { return defs.get(name); },
  };
}

// ---- source-text: 去注释但保留字符串 ----

test("source-text: 行注释与块注释被剥离, 换行保留", () => {
  const src = "const a = 1; // note\n/* block\ncomment */\nconst b = 2;";
  assert.equal(stripComments(src), "const a = 1; \n\nconst b = 2;");
});

test("source-text: 字符串/模板里的注释符不算注释", () => {
  const src = "const u = \"http://x/*y*/\"; const t = `a//b`;";
  assert.equal(stripComments(src), src);
});

test("source-text: 转义引号不提前结束字符串", () => {
  const src = String.raw`const s = "a\"//b"; // tail`;
  assert.equal(stripComments(src), String.raw`const s = "a\"//b"; `);
});

test("source-text: 未闭合注释与空输入", () => {
  assert.equal(stripComments("a /* never ends"), "a ");
  assert.equal(stripComments("x // no newline"), "x ");
  assert.equal(stripComments(null), "");
  assert.equal(stripComments(undefined), "");
  assert.equal(stripComments(""), "");
});

// ---- web/read-json: 四态 ----

test("read-json: null 体 / 空体 / 合法 / 非法", async () => {
  const calls = [];
  const channel = (raw) => ({
    _readBody: async () => raw,
    _json: (res, status, body) => calls.push({ res, status, body }),
  });
  assert.equal(await readJson(channel(null), {}, {}), null);
  assert.equal(calls.length, 0, "null 体由上层处理, 不应再写 400");
  assert.deepEqual(await readJson(channel(""), {}, {}), {});
  assert.deepEqual(await readJson(channel('{"a":1}'), {}, {}), { a: 1 });
  assert.equal(await readJson(channel("not-json"), {}, {}), null);
  assert.deepEqual(calls, [{ res: {}, status: 400, body: { ok: false, error: "非法 JSON" } }]);
});

// ---- session/plan-live: 规范化与持久化 ----

test("plan-live 存储: 状态纠偏/空标题过滤/持久化/渲染/清理", () => {
  const dir = tmp("plan");
  try {
    const store = new PlanLive(dir);
    const plan = store.set("s1", [
      { title: "a", status: "done" },
      { title: "b", status: "in_progress" },
      { title: "c", status: "in_progress" },
      { title: "d", status: "bogus" },
      { title: "", status: "pending" },
    ]);
    assert.equal(plan.steps.length, 4, "空标题被过滤");
    assert.equal(plan.steps[1].status, "in_progress");
    assert.equal(plan.steps[2].status, "pending", "只保留第一个进行中");
    assert.equal(plan.steps[3].status, "pending", "非法状态回落 pending");
    assert.ok(fs.existsSync(path.join(dir, "plans", "s1.json")));
    const reloaded = new PlanLive(dir).get("s1");
    assert.equal(reloaded.steps.length, 4, "新实例从磁盘读回");
    const rendered = store.render("s1");
    assert.match(rendered, /\[x\] a/);
    assert.match(rendered, /\[~\] b/);
    assert.match(rendered, /\[ \] c/);
    assert.equal(store.clear("s1"), null);
    assert.equal(fs.existsSync(path.join(dir, "plans", "s1.json")), false);
    assert.equal(store.render("s1"), "");
  } finally { cleanup(dir); }
});

test("plan-live 存储: 20 条上限与 sessionKey 文件名消毒", () => {
  const dir = tmp("plan2");
  try {
    const store = new PlanLive(dir);
    const plan = store.set("a/b c", Array.from({ length: 25 }, (_, i) => ({ title: `t${i}`, status: "pending" })));
    assert.equal(plan.steps.length, 20);
    assert.deepEqual(fs.readdirSync(path.join(dir, "plans")), ["a_b_c.json"]);
  } finally { cleanup(dir); }
});

test("plan-live 存储: 坏 JSON 读取为 null, 下一次 set 覆盖", () => {
  const dir = tmp("plan3");
  try {
    fs.mkdirSync(path.join(dir, "plans"), { recursive: true });
    fs.writeFileSync(path.join(dir, "plans", "x.json"), "{bad", "utf8");
    const store = new PlanLive(dir);
    assert.equal(store.get("x"), null);
    assert.equal(store.set("x", [{ title: "ok", status: "pending" }]).steps.length, 1);
  } finally { cleanup(dir); }
});

// ---- tools/plan-live: update_plan ----

test("update_plan: 未初始化报错, 成功回执与 EQ 事件, 清除, 事件失败不阻断", async () => {
  const uninitStub = stubCatalog();
  registerPlanLiveTools(uninitStub, {});
  const uninit = await uninitStub.def("update_plan").execute({ steps: [] }, {});
  assert.ok(uninit.startsWith(TOOL_ERROR_PREFIX));
  assert.match(uninit, /计划存储未初始化/);

  const calls = [];
  const events = [];
  const planLive = {
    set(sk, steps) {
      calls.push({ sk, steps });
      return { steps: [{ title: "a", status: "done" }, { title: "b", status: "pending" }] };
    },
  };
  const stub = stubCatalog();
  registerPlanLiveTools(stub, { planLive });
  const tool = stub.def("update_plan");
  assert.deepEqual(tool.parameters.required, ["steps"]);

  const out = JSON.parse(await tool.execute({ steps: [{ title: "a" }] }, {
    agent: { _activeSessionKey: "s1", _eqPushRef: (type, payload, meta) => events.push({ type, payload, meta }) },
  }));
  assert.equal(out.ok, true);
  assert.equal(out.total, 2);
  assert.equal(out.done, 1);
  assert.equal(calls[0].sk, "s1");
  assert.equal(events[0].type, "plan_updated");
  assert.equal(events[0].payload.steps.length, 2);
  assert.equal(events[0].meta.sessionKey, "s1");

  const cleared = JSON.parse(await tool.execute({ steps: [] }, { sessionKey: "s2" }));
  assert.equal(calls[1].sk, "s2");
  assert.equal(cleared.ok, true);
  assert.equal(cleared.cleared, undefined, "fake planLive 返回了计划, 不是清除路径");

  planLive.set = () => null;
  const cleared2 = JSON.parse(await tool.execute({ steps: [] }, { sessionKey: "s3" }));
  assert.deepEqual(cleared2, { ok: true, cleared: true });

  planLive.set = () => ({ steps: [] });
  const throwing = JSON.parse(await tool.execute({ steps: [] }, {
    agent: { _activeSessionKey: "s4", _eqPushRef: () => { throw new Error("eq down"); } },
  }));
  assert.equal(throwing.ok, true, "EQ 事件失败不影响计划更新回执");

  const ctxCalls = [];
  const ctxStub = stubCatalog();
  registerPlanLiveTools(ctxStub, {
    planLive: { set: (sk) => { ctxCalls.push(sk); return { steps: [] }; } },
  });
  const noCtx = JSON.parse(await ctxStub.def("update_plan").execute({ steps: [] }, undefined));
  assert.equal(noCtx.ok, true);
  assert.deepEqual(ctxCalls, ["default"], "无上下文时落到 default 会话");
});

// ---- tools/world-model: 未配置/参数/成功/截断/HTTP 错误/异常/超时 ----

test("world_model_simulate: 未配置与缺参数", async () => {
  const stub = stubCatalog();
  registerWorldModelTools(stub, { config: null });
  const un = await stub.def("world_model_simulate").execute({ steps: [{ type: "read", path: "a" }] });
  assert.ok(un.startsWith(TOOL_ERROR_PREFIX));
  assert.match(un, /endpoint 未配置/);

  const stub2 = stubCatalog();
  registerWorldModelTools(stub2, { config: { agent: { world_model: { endpoint: "http://wm.local/sim" } } } });
  const missing = await stub2.def("world_model_simulate").execute({});
  assert.ok(missing.startsWith(TOOL_ERROR_PREFIX));
  assert.match(missing, /需要 steps/);
});

test("world_model_simulate: 成功/动作兼容/截断/HTTP 错误/异常/超时", async (t) => {
  const stub = stubCatalog();
  registerWorldModelTools(stub, { config: { agent: { world_model: { endpoint: "http://wm.local/sim" } } } });
  const tool = stub.def("world_model_simulate");
  const origFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = origFetch; });

  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return new Response("observed", { status: 200 });
  };
  const ok = await tool.execute({ steps: [{ type: "write", path: "a" }], context: "ctx" });
  assert.match(ok, /世界模型推演/);
  assert.match(ok, /observed/);
  assert.equal(captured.url, "http://wm.local/sim");
  assert.equal(captured.opts.method, "POST");
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.op, "simulate");
  assert.deepEqual(body.steps, [{ type: "write", path: "a" }]);
  assert.equal(body.context, "ctx");

  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return new Response("ok", { status: 200 });
  };
  const actionOut = await tool.execute({ action: "rm -rf x" });
  assert.match(actionOut, /ok/);
  const actionBody = JSON.parse(captured.opts.body);
  assert.equal(actionBody.action, "rm -rf x");
  assert.equal(actionBody.steps, undefined);

  globalThis.fetch = async () => new Response("x".repeat(3000), { status: 200 });
  const truncated = await tool.execute({ steps: [{ type: "read", path: "a" }] });
  assert.ok(truncated.includes("x".repeat(2000)));
  assert.ok(!truncated.includes("x".repeat(2001)));

  globalThis.fetch = async () => new Response("nope", { status: 500 });
  const httpErr = await tool.execute({ steps: [{ type: "read", path: "a" }] });
  assert.match(httpErr, /返回 500/);

  globalThis.fetch = async () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  };
  const timeout = await tool.execute({ steps: [{ type: "read", path: "a" }] });
  assert.match(timeout, /超时 \(8000ms\)/);

  globalThis.fetch = async () => { throw new Error("boom"); };
  const err = await tool.execute({ steps: [{ type: "read", path: "a" }] });
  assert.match(err, /boom/);
});

// ---- tools/anchored-edit: 拒绝路径与成功路径 ----

test("edit_lines: 参数/路径/类型/二进制/敏感路径都拒绝", async () => {
  const dir = tmp("edit");
  try {
    const undo = [];
    const stub = stubCatalog();
    registerAnchoredEditTools(stub, { rootDir: dir, rememberUndo: (p) => undo.push(p) });
    const tool = stub.def("edit_lines");

    assert.match(JSON.parse(await tool.execute({ path: "", edits: [] })).error, /path 不能为空/);
    assert.match(JSON.parse(await tool.execute({ path: "missing.txt", edits: [] })).error, /文件不存在/);
    fs.mkdirSync(path.join(dir, "sub"));
    assert.match(JSON.parse(await tool.execute({ path: "sub", edits: [] })).error, /目标是目录/);
    fs.writeFileSync(path.join(dir, "a.docx"), "x");
    assert.match(JSON.parse(await tool.execute({ path: "a.docx", edits: [] })).error, /二进制容器/);
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "config"), "x");
    const gitErr = JSON.parse(await tool.execute({ path: ".git/config", edits: [{ anchor: "zzzz", content: "y" }] }));
    assert.match(gitErr.error, /\.git 目录拒绝写入/);
    assert.equal(undo.length, 0);
  } finally { cleanup(dir); }
});

test("edit_lines: 过期/重复锚点拒绝, 文件不变", async () => {
  const dir = tmp("edit2");
  try {
    const stub = stubCatalog();
    registerAnchoredEditTools(stub, { rootDir: dir });
    const tool = stub.def("edit_lines");

    fs.writeFileSync(path.join(dir, "f.txt"), "a\nb\n");
    const stale = JSON.parse(await tool.execute({ path: "f.txt", edits: [{ anchor: "zzzz", content: "x" }] }));
    assert.match(stale.error, /编辑未应用/);
    assert.equal(fs.readFileSync(path.join(dir, "f.txt"), "utf8"), "a\nb\n");

    fs.writeFileSync(path.join(dir, "dup.txt"), "same\nsame\n");
    const dup = JSON.parse(await tool.execute({ path: "dup.txt", edits: [{ anchor: lineHash("same"), content: "x" }] }));
    assert.match(dup.error, /编辑未应用/);
    assert.ok(dup.errors.some((e) => /命中 2 行/.test(e)), "重复锚点原因应回传给模型");
    assert.equal(fs.readFileSync(path.join(dir, "dup.txt"), "utf8"), "same\nsame\n");
  } finally { cleanup(dir); }
});

test("edit_lines: 无变化不写盘, 单行/区间/删除成功且撤销入栈", async () => {
  const dir = tmp("edit3");
  try {
    const undo = [];
    const stub = stubCatalog();
    registerAnchoredEditTools(stub, { rootDir: dir, rememberUndo: (p) => undo.push(p) });
    const tool = stub.def("edit_lines");

    fs.writeFileSync(path.join(dir, "same.txt"), "a\n");
    const same = JSON.parse(await tool.execute({ path: "same.txt", edits: [{ anchor: lineHash("a"), content: "a" }] }));
    assert.equal(same.changed, false);
    assert.equal(undo.length, 0, "无变化不应产生撤销快照");

    fs.writeFileSync(path.join(dir, "one.txt"), "a\nb\n");
    const one = JSON.parse(await tool.execute({ path: "one.txt", edits: [{ anchor: lineHash("b"), content: "B" }] }));
    assert.equal(one.ok, true);
    assert.equal(one.changed, true);
    assert.equal(fs.readFileSync(path.join(dir, "one.txt"), "utf8"), "a\nB\n");
    assert.equal(undo.length, 1);

    fs.writeFileSync(path.join(dir, "range.txt"), "a\nb\nc\n");
    const range = JSON.parse(await tool.execute({ path: "range.txt", edits: [{ from: lineHash("a"), to: lineHash("c"), content: "X" }] }));
    assert.equal(range.ok, true);
    assert.equal(fs.readFileSync(path.join(dir, "range.txt"), "utf8"), "X\n");
    assert.equal(range.applied[0].lines, 1);

    fs.writeFileSync(path.join(dir, "del.txt"), "a\nb\n");
    const del = JSON.parse(await tool.execute({ path: "del.txt", edits: [{ anchor: lineHash("a"), content: "" }] }));
    assert.equal(del.ok, true);
    assert.equal(fs.readFileSync(path.join(dir, "del.txt"), "utf8"), "b\n");
    assert.equal(undo.length, 3);
  } finally { cleanup(dir); }
});
