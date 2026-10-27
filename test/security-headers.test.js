// test/security-headers.test.js - 统一安全响应头回归 (2026-10-25 安全加固)
//
// 背景 (评估报告 P1): HTTP 通道此前只有 CORS 头, 无任何浏览器安全基线。
// Web UI 有 70+ innerHTML 拼接点, XSS 防护只有前端编码纪律没有护栏 ——
// 现在服务器侧统一下发 CSP/nosniff/X-Frame-Options/Referrer-Policy。
//
// 本测试钉住三件事:
//   1) 所有响应 (静态页/API/SSE 前的 401) 都带齐四个安全头
//   2) CSP 是严格模式: script-src 无 'unsafe-inline', 内联脚本只允许 sha256 白名单
//   3) CSP 里的 sha256 哈希与 public/index.html 实际内联脚本一致
//      (改内联脚本不同步哈希 → 首屏主题脚本被 CSP 拦 → 本测试红)
import test from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";
import { HttpChannel, SECURITY_CSP } from "../src/channels/http.js";
import { fileURLToPath } from "node:url";

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-sechdr-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "config", "ppx.json"),
    JSON.stringify({ channels: { http: { mcp: { enabled: false } } } }),
  );
  return root;
}

async function withChannel(fn) {
  const root = tmpRoot();
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  ch.authToken = "tok";
  await ch.connect();
  const port = ch.server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await ch.disconnect();
    agent.shutdown();
  }
}

test("安全响应头: 静态首页与 API 响应均带 CSP/nosniff/X-Frame/Referrer-Policy", { timeout: 20000 }, async () => {
  await withChannel(async (base) => {
    // 静态页
    const home = await fetch(base + "/");
    assert.equal(home.status, 200);
    assert.equal(home.headers.get("x-content-type-options"), "nosniff");
    assert.equal(home.headers.get("x-frame-options"), "DENY");
    assert.equal(home.headers.get("referrer-policy"), "no-referrer");
    const csp = home.headers.get("content-security-policy") || "";
    assert.ok(csp.includes("default-src 'self'"), "CSP 应有 default-src 'self'");
    assert.ok(csp.includes("frame-ancestors 'none'"), "CSP 应禁止被 iframe");
    // API (未鉴权的 401 也应带安全头)
    const denied = await fetch(base + "/sessions");
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("x-content-type-options"), "nosniff");
    assert.ok((denied.headers.get("content-security-policy") || "").length > 0, "401 也应带 CSP");
  });
});

test("CSP 严格性: script-src 无 unsafe-inline/unsafe-eval, 外域一律拒绝", () => {
  const scriptSrc = /script-src ([^;]+)/.exec(SECURITY_CSP)?.[1] || "";
  assert.ok(scriptSrc.includes("'self'"), "script-src 应含 'self'");
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), "script-src 不得放行任意内联脚本");
  assert.ok(!scriptSrc.includes("'unsafe-eval'"), "script-src 不得放行 eval");
  const hash = /'sha256-([A-Za-z0-9+/=]+)'/.exec(scriptSrc)?.[1];
  assert.ok(hash, "script-src 应有内联脚本 sha256 白名单");
  // connect-src 只允许同源: 拦截注入脚本外传数据
  assert.ok(/connect-src 'self'/.test(SECURITY_CSP), "connect-src 应仅 'self'");
});

test("CSP 哈希与 index.html 内联脚本一致 (改脚本必须同步 SECURITY_CSP)", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "index.html 应有内联主题脚本");
  const actual = crypto.createHash("sha256").update(m[1], "utf8").digest("base64");
  const pinned = /'sha256-([A-Za-z0-9+/=]+)'/.exec(SECURITY_CSP)?.[1];
  assert.equal(actual, pinned, "SECURITY_CSP 里的 sha256 与实际内联脚本不符 —— 首屏主题脚本会被 CSP 拦截");
});

// 2026-10-27: 首页原先由服务端注入 `<script>window.__PPX_BOOTSTRAP__={...}</script>`。
// 那是页面上第二个可执行内联脚本, 内容含时间戳 → 哈希每次都变 → 必然被 script-src 白名单拦掉。
// 症状极隐蔽: window.__PPX_BOOTSTRAP__ 恒为 undefined, 首屏所有 /api/* 先吃一次 401,
// 靠 app.js 的 401 兜底再取一遍才恢复 —— 看起来「能用」, 实际上每次都多绕一圈。
// 现在改成 type="application/json" 的数据节点 (不可执行, 不受 script-src 约束)。这条钉住它。
test("首页引导数据是不可执行的 JSON 节点, 页面只剩一个内联脚本", { timeout: 20000 }, async () => {
  // 临时 root 里没有 public/, 这里把 publicDir 指回仓库真实的 public —— 与部署时一致
  const projectPublic = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
  const root = tmpRoot();
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  ch.authToken = "tok";
  ch.publicDir = projectPublic;
  await ch.connect();
  const port = ch.server.address().port;
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.ok(html.includes('id="ppx-boot"'), "首页应注入 #ppx-boot 引导数据节点");
    assert.ok(/<script type="application\/json" id="ppx-boot">/.test(html), "引导数据节点必须是 application/json");
    assert.ok(!/window\.__PPX_BOOTSTRAP__\s*=/.test(html), "不应再注入赋值式内联脚本");
    const inline = html.match(/<script>/g) || [];
    assert.equal(inline.length, 1, `可执行内联脚本只应有首屏主题脚本一个, 实际 ${inline.length} 个`);
  } finally {
    await ch.disconnect();
    agent.shutdown();
  }
});
