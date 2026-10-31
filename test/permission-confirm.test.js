// test/permission-confirm.test.js — 权限放宽二次确认 (2026-10-31)
// 修复: POST /api/permissions 拿到 bearer token 就能热切 danger-full-access —— 提权出口
// 软得像纸。现在放宽类变更需要服务端控制台出一次性确认码; 收紧类与 plan 态不受影响。
// 另钉: approvalMode/sandbox 非法值 400 (此前任意字符串直写引擎)。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { HttpChannel } from "../src/channels/http.js";

function tmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-permconfirm-${tag}-`));
  fs.mkdirSync(path.join(d, "config"), { recursive: true });
  fs.writeFileSync(path.join(d, "config", "ppx.json"), JSON.stringify({ providers: [] }));
  return d;
}

async function boot(tag) {
  const root = tmp(tag);
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  ch.authToken = "tok";
  await ch.connect();
  const port = ch.server.address().port;
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.join(" ")); }; // 捕获控制台确认码输出
  const post = async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/permissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const cleanup = async () => {
    console.log = origLog;
    await ch.disconnect();
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { agent, post, logs, cleanup };
}

test("收紧类变更立即生效 (降档不需要确认)", async () => {
  const { agent, post, cleanup } = await boot("tighten");
  try {
    agent.permissions.sandbox = "danger-full-access"; // 从最宽起步
    const r = await post({ sandbox: "workspace-write" });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true, "收紧立即生效");
    assert.equal(agent.permissions.sandbox, "workspace-write");
    // 审批模式收紧 (never → unless-trusted) 同样即时
    agent.permissions.approvalMode = "never";
    const r2 = await post({ approvalMode: "unless-trusted" });
    assert.equal(r2.json.ok, true);
    assert.equal(agent.permissions.approvalMode, "unless-trusted");
  } finally { await cleanup(); }
});

test("放宽类变更需要二次确认: 首次返回 need_confirm, 确认码只进控制台", async () => {
  const { agent, post, logs, cleanup } = await boot("escalate");
  try {
    const r = await post({ sandbox: "danger-full-access" });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.need_confirm, true, "要求二次确认");
    assert.ok(Array.isArray(r.json.escalations) && /danger-full-access/.test(r.json.escalations.join("")));
    assert.equal(agent.permissions.sandbox, "workspace-write", "确认前引擎未变");
    // 确认码绝不进 HTTP 响应 (防自动化角色自行闭环), 只进服务端控制台
    assert.ok(!JSON.stringify(r.json).match(/confirm_token/), "响应体无确认码");
    const printed = logs.join("\n");
    assert.match(printed, /权限放宽确认/);
    assert.match(printed, /确认码: ([0-9a-f]{6})/, "控制台有 6 位确认码");
  } finally { await cleanup(); }
});

test("放宽 + 正确确认码 → 生效 (一次性, 不写配置文件)", async () => {
  const { agent, post, logs, cleanup } = await boot("confirm-ok");
  try {
    await post({ sandbox: "danger-full-access", approvalMode: "never" });
    const m = logs.join("\n").match(/确认码: ([0-9a-f]{6})/);
    assert.ok(m, "确认码已打印");
    const r = await post({ sandbox: "read-only", approvalMode: "unless-trusted", confirm_token: m[1] });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true, "凭码生效");
    assert.equal(agent.permissions.sandbox, "danger-full-access", "落地的是**发起时**确认的变更, 不是重放请求里的新值");
    assert.equal(agent.permissions.approvalMode, "never");
    // 不落盘: config 文件里没有这个值 (重启还原语义)
    const onDisk = JSON.parse(fs.readFileSync(path.join(agent.root, "config", "ppx.json"), "utf8"));
    assert.ok(!onDisk.security?.sandbox, "配置文件未写入 sandbox");
    // 一次性: 同码重放被拒
    const replay = await post({ sandbox: "danger-full-access", confirm_token: m[1] });
    assert.equal(replay.status, 403, "确认码用后即焚");
  } finally { await cleanup(); }
});

test("放宽 + 错误确认码 → 403, 引擎不变", async () => {
  const { agent, post, cleanup } = await boot("confirm-bad");
  try {
    await post({ sandbox: "danger-full-access" });
    const r = await post({ sandbox: "danger-full-access", confirm_token: "000000" });
    assert.equal(r.status, 403);
    assert.equal(agent.permissions.sandbox, "workspace-write", "错误码不生效");
  } finally { await cleanup(); }
});

test("approvalMode 放宽 (never) 与 networkAccess 开启同样要确认", async () => {
  const { agent, post, logs, cleanup } = await boot("escalate-more");
  try {
    agent.permissions.networkAccess = false;
    const r1 = await post({ approvalMode: "never" });
    assert.equal(r1.json.need_confirm, true, "审批放宽要确认");
    const r2 = await post({ networkAccess: true });
    assert.equal(r2.json.need_confirm, true, "打开网络要确认");
    const r3 = await post({ networkAccess: false });
    assert.equal(r3.json.ok, true, "关网络 (收紧) 即时生效");
  } finally { await cleanup(); }
});

test("非法 approvalMode / sandbox 值 → 400 (此前任意字符串直写引擎)", async () => {
  const { agent, post, cleanup } = await boot("badvalue");
  try {
    const r1 = await post({ approvalMode: "yolo" });
    assert.equal(r1.status, 400);
    const r2 = await post({ sandbox: "no-sandbox" });
    assert.equal(r2.status, 400);
    assert.equal(agent.permissions.approvalMode, "on-request", "引擎未被写入脏值 (默认 on-request)");
  } finally { await cleanup(); }
});

test("plan 会话态切换不受确认闸门影响 (回归 plan-mode 契约)", async () => {
  const { agent, post, cleanup } = await boot("plan-regression");
  try {
    const r = await post({ planEnabled: true, sessionKey: "web1" });
    assert.equal(r.json.ok, true);
    assert.ok(agent.isPlanMode("web1"));
  } finally { await cleanup(); }
});
