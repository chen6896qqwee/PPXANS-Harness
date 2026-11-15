// electron/app-log.js — 桌面端日志 (主进程统一出口)
// 拆自 main.js (2026-11-03): seed/server-proc/smoke 等域模块都要写日志,
//   logStream 的所有权跟着 log() 一起搬走, 域模块直接 import 而不是层层传参。
import { app } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let logStream = null;

export function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
  if (!app.isPackaged) console.log(line);
  try { logStream?.write(line + os.EOL); } catch { /* 日志失败不致命 */ }
}

export function openLog() {
  try {
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `server-${new Date().toISOString().slice(0, 10)}.log`);
    if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.truncateSync(file, 0);
    logStream = fs.createWriteStream(file, { flags: "a" });
  } catch { /* 日志不可写不阻塞启动 */ }
}
