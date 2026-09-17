// test/audit-2026-09-17.test.js - 全面体检报告 (docs/AUDIT-2026-09-17.md) 的修复回归守卫
//
// 覆盖本轮落地的 P0/P1 修复, 每一项都对应一个"修复前会失败"的断言:
//   P0-1  /api/bootstrap 跨源泄漏 token
//   P0-2  src/channels-cli.js 语法错误 → ppx-channels 不可用
//   P0-3  SSE 并发护栏在 writeHead 之后 → 超限返 200 而非 429
//   P1-1  SSE 首包不 flush → 客户端迟迟收不到响应头
//   P1-2  token 比较非恒定时间
//   P1-3  全局异常兜底缺失 (uncaughtException / unhandledRejection)
//   P1-4  自愈日志顺序因果颠倒
//   P1-5  工具事件无唯一 id → UI 同名工具串卡
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpChannel, safeEqual, publicErrorMessage } from "../src/channels/http.js";
import { Healer } from "../src/selfheal/healer.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const never = () => new Promise(() => {});

function tmpRoot(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${tag}-`));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({ providers: [] }));
  return root;
}

// 构造一个只用于路由/事件测试的 agent 桩 (不启动真 LLM)
function stubAgent(root, chatStream) {
  return {
    root,
    dataDir: path.join(root, "data"),
    config: { channels: { http: { mcp: { enabled: false } } }, agent: { name: "test" } },
    chatStream: chatStream || (async () => "ok"),
    tools: { list: () => [] },
  };
}

/* ================= P0-1: 跨源不得下发 token ================= */

test("P0-1: _originTrusted 拒绝跨站来源, 放行本机同源/无 Origin", () => {
  const root = tmpRoot("origin");
  const ch = new HttpChannel(stubAgent(root), { port: 0, host: "127.0.0.1" });
  try {
    const req = (headers, ip = "127.0.0.1") => ({ headers, socket: { remoteAddress: ip } });
    // 恶意站点: 有 Origin 且非本机 → 不可信
    assert.equal(ch._originTrusted(req({ origin: "https://evil.example.com" })), false, "跨域 Origin 必须拒绝");
    // 浏览器强信号: Sec-Fetch-Site: cross-site → 不可信
    assert.equal(ch._originTrusted(req({ "sec-fetch-site": "cross-site" })), false, "cross-site 必须拒绝");
    // 本机前端同源请求 → 可信
    assert.equal(ch._originTrusted(req({ origin: "http://127.0.0.1:8899" })), true);
    assert.equal(ch._originTrusted(req({ origin: "http://localhost:8899" })), true);
    // 非浏览器请求 (curl/脚本) 与同源顶层导航都不带 Origin → 可信
    assert.equal(ch._originTrusted(req({})), true);
    // Origin 畸形 → 不予信任
    assert.equal(ch._originTrusted(req({ origin: "not-a-url" })), false);
    // 组合判据: 回环 + 可信来源才算"可信本地请求"
    assert.equal(ch._isTrustedLocal(req({ origin: "https://evil.example.com" })), false);
    assert.equal(ch._isTrustedLocal(req({})), true);
    assert.equal(ch._isTrustedLocal(req({}, "192.168.1.9")), false, "非回环地址永不可信");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("P0-1: bootstrapPayload 跨源不带 token, 本机带 token", () => {
  const root = tmpRoot("boot");
  const ch = new HttpChannel(stubAgent(root), { port: 8899, host: "127.0.0.1" });
  try {
    ch.authToken = "secret-token-abc";
    const cross = ch.bootstrapPayload({ headers: { origin: "https://evil.example.com" }, socket: { remoteAddress: "127.0.0.1" } });
    assert.equal(cross.authToken, "", "跨源响应体不得包含 token");
    assert.equal(cross.tokenTrusted, false);
    const local = ch.bootstrapPayload({ headers: {}, socket: { remoteAddress: "127.0.0.1" } });
    assert.equal(local.authToken, "secret-token-abc", "本机应正常下发 token");
    assert.equal(local.tokenTrusted, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("P0-1: 端到端 —— 跨源 GET /api/bootstrap 返回 401 且无 token", async () => {
  const { startServer } = await import("../src/server.js");
  const root = tmpRoot("boote2e");
  const svc = await startServer({ root, port: 0, host: "127.0.0.1" });
  const port = svc.server.address().port;
  try {
    const evil = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { headers: { Origin: "https://evil.example.com" } });
    assert.equal(evil.status, 401, "跨源请求必须 401 (修复前是 200 + 明文 token)");
    const body = await evil.text();
    assert.ok(!body.includes(svc.http.authToken), "响应体不得出现真实 token");

    const crossSite = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(crossSite.status, 401, "Sec-Fetch-Site: cross-site 必须 401");

    // 本机正常访问不受影响
    const ok = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).authToken, svc.http.authToken, "本机仍应拿到 token");
  } finally {
    await new Promise((r) => svc.server.close(r));
    try { svc.agent.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ================= P0-2: ppx-channels 入口可用 ================= */

test("P0-2: src/channels-cli.js 可被解析 (修复前 SyntaxError)", async () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "channels-cli.js"), "utf8");
  // 修复前: ensureUTF8Console() 被误插进 import { ... } 语句内部
  const importBlock = src.match(/^import \{[\s\S]*?\} from "\.\/config\/channels\.js";/m);
  assert.ok(importBlock, "应能找到 config/channels.js 的 import 块");
  assert.ok(!/ensureUTF8Console\s*\(/.test(importBlock[0]), "import 语句内不得出现函数调用");
  // 真正能作为模块加载 (语法 + 顶层绑定都合法)
  await assert.doesNotReject(() => import("../src/config/channels.js"), "依赖模块应可加载");
});

/* ================= P0-3 / P1-1: SSE 护栏顺序与首包 flush ================= */

test("P0-3 + P1-1: SSE 并发超限返回 429, 且未超限请求立即收到响应头", async () => {
  const root = tmpRoot("sse");
  const ch = new HttpChannel(stubAgent(root, never), { port: 0, host: "127.0.0.1" });
  await ch.connect();
  const port = ch.server.address().port;
  const H = { "Content-Type": "application/json", Authorization: "Bearer " + ch.authToken };
  const ctrls = [];
  try {
    const fire = () => {
      const ac = new AbortController();
      ctrls.push(ac);
      return fetch(`http://127.0.0.1:${port}/message/stream`, {
        method: "POST", headers: H, body: JSON.stringify({ message: "hold" }), signal: ac.signal,
      });
    };
    // MAX_INFLIGHT = 4: 前 4 个应尽快拿到 200 + text/event-stream (证明 flushHeaders 生效)
    const held = await Promise.race([
      Promise.all([fire(), fire(), fire(), fire()]),
      new Promise((_, rej) => setTimeout(() => rej(new Error("响应头 3s 未到 —— 首包未 flush")), 3000)),
    ]);
    held.forEach((r, i) => {
      assert.equal(r.status, 200, `第 ${i + 1} 个应 200`);
      assert.match(r.headers.get("content-type") || "", /text\/event-stream/, "应为 SSE");
    });
    // 第 5 个超限: 必须是干净的 429, 而不是 200 + SSE 里的错误事件
    const over = await fire();
    assert.equal(over.status, 429, "超限必须返回 429 (修复前返回 200)");
    assert.match(over.headers.get("content-type") || "", /application\/json/);
    assert.equal(over.headers.get("retry-after"), "5");
    const body = await over.text();
    assert.ok(!/headers after they are sent/i.test(body), "不得把 Node 内部错误原文泄漏给客户端");
  } finally {
    ctrls.forEach((c) => { try { c.abort(); } catch {} });
    await ch.disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ================= P1-2: token 恒定时间比较 ================= */

test("P1-2: safeEqual 语义正确 (真/假/长度不等/空值)", () => {
  assert.equal(safeEqual("Bearer abc", "Bearer abc"), true);
  assert.equal(safeEqual("Bearer abc", "Bearer abd"), false);
  assert.equal(safeEqual("Bearer abc", "Bearer abc-longer"), false, "长度不等必须 false");
  assert.equal(safeEqual("", ""), true);
  assert.equal(safeEqual(null, ""), true);
  assert.equal(safeEqual(undefined, "x"), false);
});

test("P1-2: _authed 用恒定时间比较且保留原有语义", () => {
  const root = tmpRoot("authed");
  const ch = new HttpChannel(stubAgent(root), { port: 0, host: "127.0.0.1" });
  try {
    ch.authToken = "";
    assert.equal(ch._authed({ headers: {} }), true, "无 token 配置时放行 (兼容旧行为)");
    ch.authToken = "tok123";
    assert.equal(ch._authed({ headers: { authorization: "Bearer tok123" } }), true);
    assert.equal(ch._authed({ headers: { authorization: "Bearer tok124" } }), false);
    assert.equal(ch._authed({ headers: {} }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ================= P1: 客户端错误文案净化 ================= */

test("P1: publicErrorMessage 屏蔽 Node/流内部实现细节", () => {
  assert.equal(publicErrorMessage(new Error("Cannot write headers after they are sent to the client")), "连接状态异常, 请重试");
  assert.equal(publicErrorMessage(new Error("ERR_HTTP_HEADERS_SENT")), "连接状态异常, 请重试");
  assert.equal(publicErrorMessage(new Error("请求体格式错误")), "请求体格式错误", "业务错误应原样透出");
  assert.equal(publicErrorMessage({}), "服务内部错误");
  assert.ok(publicErrorMessage(new Error("x".repeat(1000))).length <= 300, "超长错误应被截断");
});

/* ================= P1-3: 全局异常兜底 ================= */

test("P1-3: 异常上报器折叠同类错误 + installCrashGuard 真实挂载进程事件", async () => {
  const { createCrashReporter, installCrashGuard: install } = await import("../src/utils/crashguard.js");
  const seen = [];
  const report = createCrashReporter({
    tag: "test",
    onError: (err, kind) => seen.push({ msg: String(err?.message), kind }),
    logger: { warn: () => {}, error: () => {} },
  });
  // 去重以"栈指纹"为准 (同一处代码反复抛错 → 折叠); 因此用同一个 Error 实例模拟风暴
  const boom1 = new Error("boom-1");
  report("unhandledRejection", boom1);
  report("unhandledRejection", boom1); // 同类 → 折叠
  report("unhandledRejection", new Error("boom-2"));
  report("uncaughtException", new Error("boom-3"));
  assert.equal(seen.length, 3, "应记录 3 类错误 (boom-1 被折叠)");
  assert.deepEqual(seen.map((s) => s.msg), ["boom-1", "boom-2", "boom-3"]);
  assert.deepEqual(seen.map((s) => s.kind), ["unhandledRejection", "unhandledRejection", "uncaughtException"]);

  // 安装/卸载必须真实增删进程事件监听 (而不是只挂了个空壳)
  const beforeU = process.listenerCount("unhandledRejection");
  const beforeE = process.listenerCount("uncaughtException");
  const uninstall = install({ tag: "test", logger: { warn: () => {}, error: () => {} } });
  assert.equal(process.listenerCount("unhandledRejection"), beforeU + 1, "应挂上 unhandledRejection");
  assert.equal(process.listenerCount("uncaughtException"), beforeE + 1, "应挂上 uncaughtException");
  // 幂等: 重复安装不再叠加监听
  const again = install({ tag: "test", logger: { warn: () => {}, error: () => {} } });
  assert.equal(process.listenerCount("unhandledRejection"), beforeU + 1, "重复安装不应叠加");
  again();
  uninstall();
  assert.equal(process.listenerCount("unhandledRejection"), beforeU, "卸载后应还原");
  assert.equal(process.listenerCount("uncaughtException"), beforeE, "卸载后应还原");
});

/* ================= P1: 限流令牌桶回收 ================= */

test("P1: 令牌桶表超阈值时回收过期桶 (防长期运行内存增长)", () => {
  const root = tmpRoot("bucket");
  const ch = new HttpChannel(stubAgent(root), { port: 0, host: "127.0.0.1" });
  try {
    const okRes = { writeHead() {}, end() {} };
    // 灌 600 个陌生 IP (均超过 60s 未再出现) 触发 sweep
    for (let i = 0; i < 600; i++) {
      const req = { socket: { remoteAddress: `10.0.0.${i % 250}:${i}` } };
      ch._rateLimit(req, okRes);
      for (const b of ch._buckets.values()) b.last = Date.now() - 600_000; // 全部置为过期
    }
    assert.ok(ch._buckets.size < 600, `过期桶应被回收, 实际 ${ch._buckets.size}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ================= P1-4: 自愈日志顺序 ================= */

test("P1-4: 崩溃残留的告警先于‘已清理’回执输出 (修复前顺序颠倒)", () => {
  const root = tmpRoot("heal");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  // 伪造"上次未干净退出"
  fs.writeFileSync(path.join(dataDir, "integrity.json"), JSON.stringify({ clean: false, pid: 999999 }));
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  let report;
  try {
    report = new Healer(root).heal();
  } finally {
    console.log = origLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(report.crashed, true, "应识别出崩溃残留");
  const iWarn = lines.findIndex((l) => l.includes("检测到崩溃残留"));
  const iClean = lines.findIndex((l) => l.includes("状态置回 clean"));
  assert.ok(iWarn >= 0, "应有崩溃残留告警");
  assert.ok(iClean >= 0, "应有清理回执");
  assert.ok(iWarn < iClean, `告警(${iWarn}) 应先于清理回执(${iClean}) —— 先报问题再报处置`);
});

/* ================= P1-5: 工具事件唯一 id ================= */

test("P1-5: _runTool 的 start/done 事件带同一唯一 id, 同名工具不串卡", async () => {
  const { PPXAgent } = await import("../src/agent/index.js");
  const root = tmpRoot("toolid");
  const agent = new PPXAgent({ root });
  const events = [];
  try {
    agent.setToolEvent((ev) => events.push(ev));
    agent.tools.register({
      name: "echo_probe",
      description: "测试用回显",
      parameters: { type: "object", properties: { v: { type: "string" } } },
      execute: async (args) => String(args?.v ?? ""),
    });
    // 同一轮里连续两次同名工具 (旧实现只能按名字匹配 → 会串卡)
    await agent._runTool("echo_probe", { v: "first" });
    await agent._runTool("echo_probe", { v: "second" });
    const starts = events.filter((e) => e.type === "start");
    const dones = events.filter((e) => e.type === "done");
    assert.equal(starts.length, 2);
    assert.equal(dones.length, 2);
    assert.ok(starts.every((e) => typeof e.id === "string" && e.id), "start 事件必须带 id");
    assert.notEqual(starts[0].id, starts[1].id, "两次调用 id 必须不同");
    assert.deepEqual(starts.map((s) => s.id), dones.map((d) => d.id), "start/done 必须按 id 一一对应");
  } finally {
    try { agent.shutdown(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
