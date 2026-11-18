#!/usr/bin/env node
// scripts/ui-capture.mjs - UI 截图回合外层驱动 (2026-11-18)
//
// 与 desktop-gui-smoke.mjs 同构: 隔离端口/目录 → 拉起真实 Electron 窗口
// (PPX_UI_CAPTURE=1) → electron/ui-capture.js 逐帧截图 → 归档到 docs/bench/ui/。
// 截图为离线合成 (注入的时间线数据), 文件名与 result.json 如实标注, 不冒充生产回合。
//
// 用法: node scripts/ui-capture.mjs [标签前缀]
// 退出码: 0 = 截图完成且无错误, 1 = 启动/注入失败
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAG = String(process.argv[2] || "workbuddy").replace(/[^\w-]+/g, "");
const ARCHIVE = path.join(ROOT, "docs", "bench", "ui");
const TIMEOUT_MS = Number(process.env.PPX_UI_CAPTURE_TIMEOUT_MS) || 150000;

function log(msg) { process.stdout.write(`[ui-capture] ${msg}\n`); }

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

let electronBin = "";
try { electronBin = createRequire(import.meta.url)("electron"); } catch { /* 未安装 */ }
if (!electronBin || typeof electronBin !== "string" || !fs.existsSync(electronBin)) {
  log("SKIP: 未找到 electron");
  process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-ui-capture-"));
const capDir = path.join(work, "caps");
fs.mkdirSync(capDir, { recursive: true });
const port = await freePort();

const env = {
  ...process.env,
  PPX_UI_CAPTURE: "1",
  PPX_UI_CAPTURE_DIR: capDir,
  PPX_DESKTOP_USER_DATA: path.join(work, "userdata"),
  PPX_DATA_DIR: path.join(work, "data"),
  PPX_ROOT: ROOT,
  PPX_PORT: String(port),
  PPX_UPDATE_CHECK: "0",
  ELECTRON_ENABLE_LOGGING: "0",
};
delete env.PPX_DESKTOP_SECRET;
delete env.ELECTRON_RUN_AS_NODE; // electron.exe 退化成纯 node 会让 main.js import { app } 失败

log(`启动 Electron (port=${port}, work=${work})`);
// 与 desktop-gui-smoke.mjs 同款: 直接传 electron/main.js (仓库 package.json 的 main 指向
// src/agent/index.js, 传目录会加载错入口), cwd=ROOT。
const child = spawn(electronBin, [path.join(ROOT, "electron", "main.js")], {
  cwd: ROOT,
  env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let code = null;
const timer = setTimeout(() => {
  log("超时, 强制结束");
  try { child.kill(); } catch { /* 已退出 */ }
}, TIMEOUT_MS);
child.stdout.on("data", (d) => {
  const t = String(d);
  if (t.includes("ui-capture")) log(t.trim().split("\n").pop());
});
child.stderr.on("data", (d) => log("stderr: " + String(d).trim().slice(0, 200)));
child.on("exit", (c) => { code = c; });

while (code === null) await new Promise((r) => setTimeout(r, 500));
clearTimeout(timer);

// 归档
const resultFile = path.join(capDir, "result.json");
let result = null;
try { result = JSON.parse(fs.readFileSync(resultFile, "utf8")); } catch { /* 无结果 */ }
if (result) {
  fs.mkdirSync(ARCHIVE, { recursive: true });
  const copied = [];
  for (const s of result.shots || []) {
    const dst = path.join(ARCHIVE, `${TAG}-${path.basename(s.file)}`);
    fs.copyFileSync(s.file, dst);
    copied.push(dst);
  }
  fs.writeFileSync(path.join(ARCHIVE, `${TAG}-result.json`), JSON.stringify({ ...result, archived: copied }, null, 2));
  for (const c of copied) log(`归档: ${path.relative(ROOT, c)}`);
}
for (const e of result?.errors || []) log(`错误 [${e.step}]: ${e.message}`);
log(`退出码 ${code ?? "?"}, ${result?.shots?.length || 0} 帧, ${result?.errors?.length || 0} 错误`);
try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 清理失败不阻塞 */ }
process.exit(code === 0 && result && !(result.errors || []).length ? 0 : 1);
