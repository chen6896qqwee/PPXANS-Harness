#!/usr/bin/env node
// scripts/start-web.js - 一条命令同时起内核(8899) + Web UI(3000)
// 用法: 先 npm run web:build 构建前端, 再 npm run web 启动
import { ensureUTF8Console } from "../src/utils/winutf8.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

ensureUTF8Console();
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");

if (!fs.existsSync(path.join(WEB, ".next"))) {
  console.log("⚠️  前端尚未构建 (web/.next 不存在)，先执行: npm run web:build");
  process.exit(1);
}

console.log("皮皮虾 Web 启动中...");
console.log("  内核:   http://127.0.0.1:8899");
console.log("  Web UI: http://localhost:3000");
console.log("  Ctrl+C 同时退出两者\n");

const children = [];
function killAll() {
  for (const c of children) {
    try { c.kill(); } catch {}
  }
}

// 内核 HTTP 服务 (8899)
const kernel = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  stdio: "inherit",
});
children.push(kernel);

// 前端 Next.js 生产服务 (3000, 代理到 8899)
// Windows: .cmd 必须 shell:true 才能 spawn（shell:false + npm.cmd 会 EINVAL）
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const web = spawn(npmCmd, ["run", "start"], {
  cwd: WEB,
  stdio: "inherit",
  shell: process.platform === "win32", // win 必须 shell 跑 .cmd；posix 保持 false
});
children.push(web);

for (const c of children) {
  c.on("exit", (code) => {
    console.log(`[进程退出 code=${code}] 正在停止另一端...`);
    killAll();
    setTimeout(() => process.exit(code ?? 0), 300);
  });
}

process.on("SIGINT", () => { killAll(); setTimeout(() => process.exit(0), 300); });
process.on("SIGTERM", () => { killAll(); setTimeout(() => process.exit(0), 300); });
