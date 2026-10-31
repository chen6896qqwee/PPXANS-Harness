#!/usr/bin/env node
// bin/ppx-desktop.js — 把皮皮虾 Web 面板包成"桌面应用" (Edge App Mode, 零依赖)
//
// 思路: 网页内核本来就是同源单端口服务, 这里只补一层"外壳"——
//   1) 端口若已被占用(已有服务) → 直接开 App 窗口, 不重复拉服务
//   2) 端口空闲 → 拉起 Web 服务(子进程), 等就绪后再开 App 窗口
//   3) App 窗口关闭 → 关闭本次拉起的服务(若本次拉的)
//
// 用 Edge 的 --app 无边框模式: 独立的任务栏入口、无浏览器地址栏/书签栏,
// 观感等同桌面 App。不需要 Electron/Tauri, 不动零依赖底线。
//
// 用法:
//   node bin/ppx-desktop.js                # 起服务并以桌面窗口打开
//   node bin/ppx-desktop.js --port 9000    # 指定端口
//   node bin/ppx-desktop.js --root D:/x    # 指定项目根 (数据/配置目录)
//   PPX_DESKTOP_NO_OPEN=1 node bin/ppx-desktop.js   # 只起服务不开窗口(排查用)
//
// 环境变量: PPX_PORT / PPX_ROOT / PPX_DESKTOP_NO_OPEN=1
import { ensureUTF8Console } from "../src/utils/winutf8.js";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readPpxConfig } from "../src/utils/config-file.js";

ensureUTF8Console();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.join(HERE, "..");

// ---- 极简参数解析 (与 ppx-web.js 同源逻辑, 零依赖) ----
const argv = process.argv.slice(2);
const hasFlag = (n) => argv.includes(n);
const argOf = (n, f = "") => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : f;
};

const root = path.resolve(argOf("--root", process.env.PPX_ROOT || DEFAULT_ROOT));

function configPort(r) {
  try {
    const cfg = readPpxConfig(r, {});
    const n = Number(cfg?.channels?.http?.port);
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* 配置缺失/损坏 → 默认端口 */ }
  return 8899;
}
const port = Number(argOf("--port", process.env.PPX_PORT || "")) || configPort(root);
const host = "127.0.0.1";
const url = `http://${host}:${port}/`;

const noOpen = hasFlag("--no-open") || process.env.PPX_DESKTOP_NO_OPEN === "1";

// ---- 定位 Edge (Windows 优先), 其他平台回退到系统默认浏览器 ----
function findEdge() {
  const candidates = [
    process.env.PPX_EDGE_BIN,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ---- 端口是否已被占用 (健康检查) ----
function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/", timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode > 0);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function waitReady(timeoutMs = 20000) {
  const t0 = Date.now();
  // 先快速探一次: 若已有人占用则直接返回
  if (await ping()) return true;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 300));
    if (await ping()) return true;
  }
  return false;
}

// ---- 拉起 Web 服务子进程 ----
function spawnServer() {
  const child = spawn(
    process.execPath,
    [path.join(HERE, "ppx-web.js"), "--no-open", "--port", String(port), "--root", root],
    { stdio: "ignore", windowsHide: true }
  );
  child.on("exit", (code, sig) => {
    if (!serverManaged) return;
    // 服务意外退出 → 整个桌面外壳退出, 避免留下打不开的窗口
    console.error(`[ppx-desktop] Web 服务意外退出 (code=${code ?? sig}), 关闭桌面外壳。`);
    shutdown(1);
  });
  return child;
}

// ---- 打开桌面 App 窗口 ----
function openApp() {
  const edge = findEdge();
  // 用 --guest 临时隔离会话: 零配置、不弹首次运行引导(OOBE)、不污染主 Edge profile。
  // 这是 --app 模式下避开白屏最稳的做法 —— 独立 user-data-dir 在真实 GUI 下仍会卡 OOBE。
  edgeUd = null;
  if (edge) {
    const args = [
      `--app=${url}`,
      "--window-size=1280,860",
      "--no-first-run",
      "--no-default-browser-check",
      "--guest",
      "--disable-background-mode",
    ];
    const child = spawn(edge, args, { stdio: "ignore", windowsHide: true, detached: false });
    return child;
  }
  // 非 Windows / 无 Edge: 退而求其次用系统默认浏览器打开 (仍是无地址栏的最好情况)
  const opener = process.platform === "darwin" ? "open" : "cmd";
  const oargs = process.platform === "darwin" ? [url] : ["/c", "start", "", url];
  return spawn(opener, oargs, { stdio: "ignore", windowsHide: true, shell: process.platform !== "darwin" });
}

let serverChild = null;
let serverManaged = false;
let edgeChild = null;
let edgeUd = null;       // 本次启动的临时 user-data-dir, 退出时清理
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (edgeChild && !edgeChild.killed) { try { edgeChild.kill("SIGTERM"); } catch {} }
  if (serverManaged && serverChild && !serverChild.killed) {
    try { serverChild.kill("SIGTERM"); } catch {}
  }
  // 清理本次的临时 user-data-dir (窗口已关, 无锁)
  if (edgeUd) { try { fs.rmSync(edgeUd, { recursive: true, force: true }); } catch {} }
  // 给子进程一点时间优雅退出
  setTimeout(() => process.exit(code), 300);
}

async function main() {
  const alreadyUp = await ping();
  if (!alreadyUp) {
    console.log(`[ppx-desktop] 启动 Web 服务 (端口 ${port})…`);
    serverChild = spawnServer();
    serverManaged = true;
    const ok = await waitReady();
    if (!ok) {
      console.error(`[ppx-desktop] 服务在 ${port} 未就绪, 放弃。`);
      shutdown(1);
      return;
    }
    console.log(`[ppx-desktop] 服务就绪: ${url}`);
  } else {
    console.log(`[ppx-desktop] 端口 ${port} 已有服务, 直接接入: ${url}`);
  }

  if (noOpen) {
    console.log("[ppx-desktop] PPX_DESKTOP_NO_OPEN=1 → 仅起服务, 不打开窗口。Ctrl+C 退出。");
    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));
    return;
  }

  console.log("[ppx-desktop] 打开桌面窗口… (关闭窗口即退出)");
  edgeChild = openApp();
  edgeChild.on("exit", () => {
    // App 窗口关闭 → 收掉本次拉起的服务
    console.log("[ppx-desktop] 窗口已关闭, 退出。");
    shutdown(0);
  });

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

main();
