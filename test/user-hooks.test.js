// test/user-hooks.test.js — 用户配置钩子 (2026-10-31, 吸收 claude-code settings.json hooks 格式)
// 钉住: 格式校验 fail-visible / matcher 语义 / stdin JSON 载荷 / 退出码契约 (0=可选JSON, 2=否决)
//       / fail_closed 钳位 / 项目级 .ppx/settings.json 白名单制 (防仓库投毒) / 事件名与元键。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHookRegistry } from "../src/hooks/index.js";
import {
  parseUserHooks,
  loadProjectHooks,
  registerUserHooks,
  mapHookExit,
  USER_HOOK_PRIORITY,
} from "../src/hooks/user-hooks.js";

// 测试用注入执行器: 记录调用, 返回预设 { code, stdout, stderr }
function fakeRunner(calls, responder) {
  return async (command, opts) => {
    calls.push({ command, input: JSON.parse(opts.input), root: opts.root, timeoutMs: opts.timeoutMs });
    return responder ? responder(command, opts) : { code: 0, stdout: "", stderr: "" };
  };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-user-hooks-"));
}

// ---- 解析与校验 ----

test("parseUserHooks: 合法配置展开为钩子描述符 (timeout 秒→毫秒)", () => {
  const { hooks, errors } = parseUserHooks({
    PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "node guard.js", timeout: 5 }] }],
  });
  assert.equal(errors.length, 0);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].event, "PreToolUse");
  assert.equal(hooks[0].timeoutMs, 5000);
  assert.equal(hooks[0].failClosed, false);
  assert.ok(hooks[0].matcherRe.test("run_command"));
  assert.ok(!hooks[0].matcherRe.test("write_file"));
});

test("parseUserHooks: 未知事件名 / 非法 type / 空 command 全部 fail-visible 不静默", () => {
  const { hooks, errors } = parseUserHooks({
    PreToolUse: [{ hooks: [{ type: "command", command: "ok.js" }] }],
    NotAnEvent: [{ hooks: [{ type: "command", command: "x.js" }] }],
    PostToolUse: [{ hooks: [{ type: "script", command: "x.js" }, { type: "command", command: "" }, { type: "command", command: "ok2.js" }] }],
  });
  assert.equal(hooks.length, 2, "合法条目仍注册");
  assert.equal(errors.length, 3, "三条无效配置都有显式报错");
  assert.ok(errors[0].includes("NotAnEvent"));
});

test("parseUserHooks: 非法正则 matcher 报错跳过; 元键 trust_project_roots 不当事件解析", () => {
  const { hooks, errors } = parseUserHooks({
    trust_project_roots: ["D:/work"],
    PreToolUse: [{ matcher: "([bad", hooks: [{ type: "command", command: "x.js" }] }],
  });
  assert.equal(hooks.length, 0);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("matcher"));
});

test("parseUserHooks: timeout 钳位 (超上限 120s) / 非法 timeout 回默认", () => {
  const { hooks } = parseUserHooks({
    PreToolUse: [{ hooks: [{ type: "command", command: "a.js", timeout: 999 }, { type: "command", command: "b.js", timeout: -1 }] }],
  });
  assert.equal(hooks[0].timeoutMs, 120000);
  assert.equal(hooks[1].timeoutMs, 10000);
});

test("loadProjectHooks: 无 .ppx/settings.json 返回 null; 有文件读 hooks 键", () => {
  const root = tmpRoot();
  try {
    assert.equal(loadProjectHooks(root), null);
    fs.mkdirSync(path.join(root, ".ppx"), { recursive: true });
    fs.writeFileSync(path.join(root, ".ppx", "settings.json"), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "notify.js" }] }] },
    }));
    const r = loadProjectHooks(root);
    assert.equal(r.hooks.length, 1);
    assert.equal(r.hooks[0].event, "SessionStart");
    assert.equal(r.hooks[0].source, "project-settings");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- 退出码/stdout 契约 ----

test("mapHookExit: exit 0 + JSON stdout → block / 改参 / additionalContext", () => {
  assert.deepEqual(mapHookExit("PreToolUse", { code: 0, stdout: '{"decision":"block","reason":"危险"}' }, 10000), { block: "危险" });
  assert.deepEqual(mapHookExit("PreToolUse", { code: 0, stdout: '{"args":{"command":"safe"}}' }, 10000), { args: { command: "safe" } });
  assert.deepEqual(mapHookExit("PostToolUse", { code: 0, stdout: '{"additionalContext":"提示"}' }, 10000), { additionalContext: "提示" });
});

test("mapHookExit: 非 JSON stdout = 放行; 无输出 = 放行", () => {
  assert.deepEqual(mapHookExit("PreToolUse", { code: 0, stdout: "plain text" }, 10000), {});
  assert.deepEqual(mapHookExit("PreToolUse", { code: 0, stdout: "" }, 10000), {});
});

test("mapHookExit: exit 2 = blocking error (stderr 作理由); 非 veto 事件记错误不否决", () => {
  assert.deepEqual(mapHookExit("PreToolUse", { code: 2, stdout: "", stderr: "禁止删除" }, 10000), { block: "禁止删除" });
  const m = mapHookExit("SessionStart", { code: 2, stdout: "", stderr: "提示" }, 10000);
  assert.ok(m.error && !m.block, "SessionStart 无否决语义, 只记错误");
});

test("mapHookExit: 非零退出码 / 超时被终止 → 错误 (不否决)", () => {
  assert.ok(mapHookExit("PreToolUse", { code: 1, stdout: "", stderr: "boom" }, 10000).error.includes("exit 1"));
  const t = mapHookExit("PreToolUse", { code: null, stdout: "", stderr: "", killed: true }, 10000);
  assert.ok(t.error.includes("超时"));
  assert.equal(t.timedOut, true);
});

// ---- 注册与执行闭环 ----

test("registerUserHooks: 引擎钩子注册进 registry 并真实参与 PreToolUse 否决", async () => {
  const calls = [];
  const reg = createHookRegistry();
  const summary = registerUserHooks(reg, {
    config: { hooks: { PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "node guard.js" }] }] } },
    root: "D:/proj",
    runFn: fakeRunner(calls, () => ({ code: 0, stdout: JSON.stringify({ decision: "block", reason: "配置钩子拦截" }), stderr: "" })),
  });
  assert.equal(summary.registered, 1);
  assert.equal(summary.errors.length, 0);
  const r = await reg.emit("PreToolUse", { tool: "run_command", args: { command: "rm -rf /" } });
  assert.equal(r.blocked, true);
  assert.equal(r.reason, "配置钩子拦截");
  assert.equal(calls.length, 1);
  // claude-code 契约: stdin JSON 载荷 (模型数据不走 argv)
  assert.equal(calls[0].input.hook_event_name, "PreToolUse");
  assert.equal(calls[0].input.tool_name, "run_command");
  assert.deepEqual(calls[0].input.tool_input, { command: "rm -rf /" });
  assert.equal(calls[0].root, "D:/proj");
});

test("registerUserHooks: matcher 不匹配的工具零开销直通 (不 spawn)", async () => {
  const calls = [];
  const reg = createHookRegistry();
  registerUserHooks(reg, {
    config: { hooks: { PreToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: "x.js" }] }] } },
    root: "D:/proj",
    runFn: fakeRunner(calls),
  });
  const r = await reg.emit("PreToolUse", { tool: "run_command", args: {} });
  assert.equal(r.blocked, false);
  assert.equal(calls.length, 0, "非命中工具不执行命令");
});

test("registerUserHooks: 项目级钩子默认拒绝; 白名单内才注册", async () => {
  const root = tmpRoot();
  try {
    fs.mkdirSync(path.join(root, ".ppx"), { recursive: true });
    fs.writeFileSync(path.join(root, ".ppx", "settings.json"), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "poison.js" }] }] },
    }));
    const mk = (cfg, responder) => {
      const reg = createHookRegistry();
      const s = registerUserHooks(reg, { config: cfg, root, runFn: fakeRunner([], responder) });
      return { reg, s };
    };
    // 默认 (空白名单): 不注册, 显式告警
    const a = mk({});
    assert.equal(a.s.registered, 0);
    assert.equal(a.s.skipped.length, 1);
    assert.ok(a.s.skipped[0].includes("trust_project_roots"));
    let emitted = await a.reg.emit("PreToolUse", { tool: "run_command", args: {} });
    assert.equal(emitted.blocked, false);

    // 白名单命中: 注册 (win32 验证大小写不敏感; linux 传原路径)
    const variant = process.platform === "win32" ? root.toUpperCase() : root;
    const b = mk({ hooks: { trust_project_roots: [variant] } }, () => ({ code: 0, stdout: JSON.stringify({ decision: "block", reason: "项目钩子" }), stderr: "" }));
    assert.equal(b.s.registered, 1, "路径比较等值 (win32 大小写不敏感)");
    assert.equal(b.s.skipped.length, 0);
    emitted = await b.reg.emit("PreToolUse", { tool: "run_command", args: {} });
    assert.equal(emitted.blocked, true, "白名单内的项目钩子真实执行并否决");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("registerUserHooks: hook 崩溃 (非零退出) 不阻断链; fail_closed:true 时 PreToolUse 故障=拒绝", async () => {
  const cfg = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "flaky.js" }] }] } };
  // 默认: 失败放行
  const a = createHookRegistry();
  registerUserHooks(a, { config: cfg, root: "D:/p", runFn: async () => ({ code: 3, stdout: "", stderr: "boom" }) });
  let r = await a.emit("PreToolUse", { tool: "run_command", args: {} });
  assert.equal(r.blocked, false, "默认非 fail-closed");
  assert.ok(r.results[0].error);

  // fail_closed: 拒绝 (与安全钩子同口径)
  const cfgFc = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "flaky.js", fail_closed: true }] }] } };
  const b = createHookRegistry();
  registerUserHooks(b, { config: cfgFc, root: "D:/p", runFn: async () => ({ code: 3, stdout: "", stderr: "boom" }) });
  r = await b.emit("PreToolUse", { tool: "run_command", args: {} });
  assert.equal(r.blocked, true, "fail_closed 故障=拒绝");
  assert.ok(r.reason.includes("fail-closed"));
});

test("用户钩子排在系统钩子之后 (priority 200 > 默认 100, 安全闸先行)", async () => {
  const order = [];
  const reg = createHookRegistry();
  reg.on("PreToolUse", () => { order.push("system"); });
  registerUserHooks(reg, {
    config: { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "u.js" }] }] } },
    root: "D:/p",
    runFn: async () => { order.push("user"); return { code: 0, stdout: "", stderr: "" }; },
  });
  await reg.emit("PreToolUse", { tool: "run_command", args: {} });
  assert.deepEqual(order, ["system", "user"], "emit 按 priority 升序: 系统闸先走");
  assert.equal(USER_HOOK_PRIORITY, 200);
});

test("改参闭环: 钩子 JSON 返回 { args } 经 emit 带出 (agent 侧零改动消费)", async () => {
  const reg = createHookRegistry();
  registerUserHooks(reg, {
    config: { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "fix.js" }] }] } },
    root: "D:/p",
    runFn: async () => ({ code: 0, stdout: JSON.stringify({ args: { command: "git status" } }), stderr: "" }),
  });
  const r = await reg.emit("PreToolUse", { tool: "run_command", args: { command: "git push --force" } });
  assert.deepEqual(r.args, { command: "git status" });
});

test("PostToolUse: additionalContext 被 registry 收集 (既有消费点直通)", async () => {
  const reg = createHookRegistry();
  registerUserHooks(reg, {
    config: { hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "ctx.js" }] }] } },
    root: "D:/p",
    runFn: async () => ({ code: 0, stdout: JSON.stringify({ additionalContext: "记得跑测试" }), stderr: "" }),
  });
  const r = await reg.emit("PostToolUse", { tool: "run_command", args: {}, ok: true });
  assert.deepEqual(r.additionalContext, ["记得跑测试"]);
});

// ---- 真实进程端到端 (跨平台: node -e 读 stdin 回 JSON) ----

test("端到端: 真实 spawn, stdin JSON 进 → JSON stdout 出 → block", async () => {
  const reg = createHookRegistry();
  const script = "node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);if(p.tool_input.command.includes('rm'))process.stdout.write(JSON.stringify({decision:'block',reason:'e2e 拦截'}));process.exit(0)})\"";
  registerUserHooks(reg, {
    config: { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: script, timeout: 20 }] }] } },
    root: process.cwd(),
  });
  const r = await reg.emit("PreToolUse", { tool: "run_command", args: { command: "rm -rf /tmp/x" } });
  assert.equal(r.blocked, true, "真实进程 stdin/stdout 闭环");
  assert.equal(r.reason, "e2e 拦截");
});

test("端到端: 超时钩子被终止且按配置 fail-closed", async () => {
  const reg = createHookRegistry();
  const sleep = "node -e \"setTimeout(()=>{},60000)\"";
  registerUserHooks(reg, {
    config: { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: sleep, timeout: 1, fail_closed: true }] }] } },
    root: process.cwd(),
  });
  const r = await reg.emit("PreToolUse", { tool: "run_command", args: {} });
  assert.equal(r.blocked, true, "超时 + fail_closed → 拒绝");
  assert.ok(r.reason.includes("超时"));
});
