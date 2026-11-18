// test/permission-confirm.test.js — 权限热更新契约 (2026-11-03 用户拍板后重写)
// 历史: 2026-10-31 曾引入"放宽需控制台确认码"双门; 2026-11-03 用户明确拆除 ——
//   单人本机工具, 确认码挡住的多数时候是主人自己。新契约:
//   ① 所有变更校验后即时生效; ② 提权必须留痕 (tracer + 哈希链 + 通知 + 持久标志);
//   ③ 值非法 fail-closed (400); ④ 生效只动内存引擎, 不写配置文件 (重启还原)。
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

function auditEvents(agent) {
  try {
    const file = agent.audit?.file;
    if (!file || !fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

async function boot(tag) {
  const root = tmp(tag);
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  ch.authToken = "tok";
  await ch.connect();
  const port = ch.server.address().port;
  const post = async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/permissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const cleanup = async () => {
    await ch.disconnect();
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { agent, root, post, cleanup };
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

test("放宽类变更即时生效 + 哈希链留痕 (2026-11-03 契约: 不拦截, 但必须可追责)", async () => {
  const { agent, post, cleanup } = await boot("escalate");
  try {
    const before = auditEvents(agent).filter((e) => e.tool === "security_permission_escalated").length;
    const r = await post({ sandbox: "danger-full-access" });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true, "放宽即时生效 (确认码双门已拆除)");
    assert.equal(r.json.sandbox, "danger-full-access");
    assert.equal(agent.permissions.sandbox, "danger-full-access", "引擎已落地新档位");
    const esc = auditEvents(agent).filter((e) => e.tool === "security_permission_escalated");
    assert.equal(esc.length, before + 1, "提权必须写入哈希链 (一次变更一条)");
    assert.ok(JSON.stringify(esc.at(-1).args || {}).includes("danger-full-access"), "留痕要写明放宽到哪一档");
    assert.equal(esc.at(-1).args?.via, "http", "留痕要标明来源入口");
  } finally { await cleanup(); }
});

test("networkAccess 打开同样即时生效并留痕 (收紧不产生提权事件)", async () => {
  const { agent, post, cleanup } = await boot("net");
  try {
    agent.permissions.networkAccess = false;
    const before = auditEvents(agent).filter((e) => e.tool === "security_permission_escalated").length;
    const r = await post({ networkAccess: true });
    assert.equal(r.json.ok, true, "打开网络即时生效");
    assert.equal(agent.permissions.networkAccess, true);
    const after = auditEvents(agent).filter((e) => e.tool === "security_permission_escalated").length;
    assert.equal(after, before + 1, "打开网络是提权, 必须留痕");
    const back = await post({ networkAccess: false });
    assert.equal(back.json.ok, true, "关网络 (收紧) 即时生效");
    assert.equal(agent.permissions.networkAccess, false);
    const finalCount = auditEvents(agent).filter((e) => e.tool === "security_permission_escalated").length;
    assert.equal(finalCount, after, "收紧不是提权, 不应新增提权记录");
  } finally { await cleanup(); }
});

test("非法 approvalMode / sandbox 值 → 400 (任意字符串直写引擎已封堵)", async () => {
  const { agent, post, cleanup } = await boot("badvalue");
  try {
    const r1 = await post({ approvalMode: "yolo" });
    assert.equal(r1.status, 400);
    const r2 = await post({ sandbox: "no-sandbox" });
    assert.equal(r2.status, 400);
    assert.equal(agent.permissions.approvalMode, "on-request", "引擎未被写入脏值 (默认 on-request)");
  } finally { await cleanup(); }
});

test("plan 会话态切换不受权限闸门影响 (回归 plan-mode 契约)", async () => {
  const { agent, post, cleanup } = await boot("plan-regression");
  try {
    const r = await post({ planEnabled: true, sessionKey: "web1" });
    assert.equal(r.json.ok, true);
    assert.ok(agent.isPlanMode("web1"));
  } finally {
    await cleanup();
  }
});

test("bot.manage 与 /api/permissions 同一实现: 放宽即时生效 + 来源留痕", async () => {
  const { agent, root, cleanup } = await boot("botmanage");
  try {
    const { handleBotApi } = await import("../src/web/bot-api.js");
    const http = await import("node:http");
    // 直调 bot-api 的 action=permission 分支需要 channel 形状; 用真实 HttpChannel 即可
    const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
    ch.authToken = "tok2";
    await ch.connect();
    const port = ch.server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/bot.manage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok2" },
        body: JSON.stringify({ action: "permission", approvalMode: "never" }),
      });
      assert.equal(res.status, 200);
      assert.equal(agent.permissions.approvalMode, "never", "bot.manage 放宽同样即时生效");
      const esc = auditEvents(agent).filter((e) => e.tool === "security_permission_escalated");
      assert.ok(esc.some((e) => e.args?.via === "bot.manage"), "留痕要标明来源为 bot.manage");
    } finally {
      await ch.disconnect();
    }
    void handleBotApi; void root; void http;
  } finally { await cleanup(); }
});
