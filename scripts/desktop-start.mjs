#!/usr/bin/env node
// scripts/desktop-start.mjs - 桌面端启动包装器 (2026-11-09)
//
// 动机: node_modules/electron/cli.js 把父进程环境原样透传给 electron.exe, 本机若继承
//   ELECTRON_RUN_AS_NODE (常见于在 Electron 宿主应用的内嵌终端里跑 npm start),
//   electron.exe 会退化成纯 node, main.js 的 import { app } 直接报
//   "does not provide an export named 'app'" —— 与 启动皮皮虾.bat / docs/DESKTOP.md
//   排障表是同一个坑, 2026-11-09 修 desktop:smoke 时实测注入该变量 100% 复现。
// npm start / desktop / desktop:dev 统一走这里, 启动前清掉该变量。
//
// 用法: npm start [electron 附加参数...]  (等价: node scripts/desktop-start.mjs ...)
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let electronBin = "";
try { electronBin = createRequire(import.meta.url)("electron"); } catch { /* 未安装 */ }
if (!electronBin || typeof electronBin !== "string") {
  console.error("[desktop-start] 未找到 electron, 请先 npm install");
  process.exit(1);
}

const env = { ...process.env };
// 残留该变量会让 electron.exe 退化成 node (见文件头注释); 官方 cli.js 不清洗, 这里必须自己清
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [path.join(ROOT, "electron", "main.js"), ...process.argv.slice(2)], {
  cwd: ROOT,
  env,
  stdio: "inherit",
  windowsHide: false,
});
child.on("error", (e) => {
  console.error(`[desktop-start] 启动失败: ${e.message}`);
  process.exit(1);
});
child.on("close", (code) => { process.exitCode = code == null ? 1 : code; });

// 与官方 cli.js 同款信号转发, Ctrl+C 时把信号带给子进程
const forward = (sig) => { try { child.kill(sig); } catch { /* 已退出 */ } };
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
process.on("SIGUSR2", () => forward("SIGUSR2"));
