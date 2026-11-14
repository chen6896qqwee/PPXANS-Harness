#!/usr/bin/env node
// scripts/desktop-gui-smoke.mjs - Electron 真实窗口 GUI 冒烟 (2026-11-02)
//
// 与 test/*.test.js 的分工: 单测只覆盖 HTTP/会话/协议, 不启动 Chromium。本脚本拉起
// 真实 Electron 窗口 (SMOKE=1, 不显示), 由 electron/main.js 在渲染进程内断言关键 DOM、
// bootstrap token 与 /health, 截图并写 JSON; 本脚本负责:
//   1) 检测 electron 是否安装 (未安装 → SKIP 退出 0, 不阻塞离线环境)
//   2) 选空闲端口 + 临时 userData/data 目录 (绝不碰生产 8899 与真实数据)
//   3) 超时兜底、汇总子进程日志、把截图/结果/日志归档到 .ppxtest/desktop-smoke/latest
//
// 用法: npm run desktop:smoke
// 退出码: 0 = 通过/跳过, 1 = 断言失败/启动失败/超时
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".ppxtest", "desktop-smoke", "latest");
const TIMEOUT_MS = Number(process.env.PPX_DESKTOP_SMOKE_TIMEOUT_MS) || 120000;

function log(msg) { process.stdout.write(`[desktop-smoke] ${msg}\n`); }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function readResult(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function copyIfExists(from, to) {
  try {
    if (!fs.existsSync(from)) return false;
    fs.copyFileSync(from, to);
    return true;
  } catch { return false; }
}

let electronBin = "";
try { electronBin = createRequire(import.meta.url)("electron"); } catch { /* 未安装 */ }
if (!electronBin || typeof electronBin !== "string" || !fs.existsSync(electronBin)) {
  log("SKIP: 未找到 electron (npm install 后再跑; 离线环境不阻塞)");
  process.exit(0);
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-desktop-smoke-"));
const shot = path.join(work, "smoke.png");
const resultFile = path.join(work, "result.json");
const childLog = path.join(work, "child.log");
const port = await freePort();

const env = {
  ...process.env,
  PPX_DESKTOP_SMOKE: "1",
  PPX_DESKTOP_SMOKE_OUT: shot,
  PPX_DESKTOP_SMOKE_RESULT: resultFile,
  PPX_DESKTOP_USER_DATA: path.join(work, "userdata"),
  PPX_DATA_DIR: path.join(work, "data"),
  PPX_ROOT: ROOT,
  PPX_PORT: String(port),
  PPX_UPDATE_CHECK: "0",
  ELECTRON_ENABLE_LOGGING: "0",
};
// 父进程若在桌面端里运行, 不能把真实握手密钥/端口带进子实例
delete env.PPX_DESKTOP_SECRET;
// 2026-11-09: 父 shell 若继承 ELECTRON_RUN_AS_NODE (如在 Electron 宿主的终端里跑本脚本),
//   electron.exe 会退化成纯 node, main.js 的 import { app } 直接失败 —— 必须清掉。
//   与 启动皮皮虾.bat / docs/DESKTOP.md 故障表是同一个坑; 2026-11-08 实测注入该变量
//   100% 复现 "does not provide an export named 'app'" (exit=1, 无 result.json)。
delete env.ELECTRON_RUN_AS_NODE;

log(`electron=${electronBin}`);
log(`port=${port} root=${ROOT}`);
log(`隔离目录=${work}`);

const child = spawn(electronBin, [path.join(ROOT, "electron", "main.js")], {
  cwd: ROOT,
  env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
const chunks = [];
const keep = (s) => { chunks.push(s); if (chunks.length > 400) chunks.shift(); };
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (c) => { keep(c); process.stdout.write(c); });
child.stderr.on("data", (c) => { keep(c); process.stderr.write(c); });

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  log(`超时 ${TIMEOUT_MS}ms, 结束 Electron`);
  try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
}, TIMEOUT_MS);
if (typeof timer.unref === "function") timer.unref();

const code = await new Promise((resolve) => {
  child.once("error", (e) => { keep(`spawn error: ${e.message}\n`); resolve(127); });
  child.once("exit", (c) => resolve(c == null ? 1 : c));
});
clearTimeout(timer);

fs.writeFileSync(childLog, chunks.join(""), "utf8");
const result = readResult(resultFile);
const pass = !timedOut && code === 0 && !!result?.ok;
if (result) {
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify(result, null, 2));
}
copyIfExists(shot, path.join(OUT_DIR, "smoke.png"));
copyIfExists(childLog, path.join(OUT_DIR, "child.log"));

if (result) {
  log(`结果: ${result.ok ? "PASS" : "FAIL"} (${result.durationMs}ms, port=${result.port})`);
  log(`截图: ${result.screenshot || "-"}`);
  if (result.missing?.length) log(`缺少节点/状态: ${result.missing.join(", ")}`);
  if (result.error) log(`错误: ${result.error}`);
  const fatal = (result.consoleErrors || []).filter((e) => e.level >= 3);
  if (fatal.length) log(`渲染错误 ${fatal.length} 条: ${fatal.map((e) => e.message).slice(0, 3).join(" | ")}`);
} else {
  log(`未读到结果 JSON (exit=${code}${timedOut ? ", timeout" : ""})`);
}
log(`归档: ${OUT_DIR}`);

try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* Windows 句柄未释放: 留在 temp 亦可 */ }
process.exit(pass ? 0 : 1);
