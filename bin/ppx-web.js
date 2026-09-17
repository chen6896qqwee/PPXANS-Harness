#!/usr/bin/env node
// bin/ppx-web.js - 一键启动 Web 应用 (对齐 dsh 的启动体验)
//
// 一个进程 / 一个端口搞定内核 + 界面: 内核服务静态界面, 前端与后端同源,
// 免 token 配置 (服务端把回环 token 注入首页)。启动就绪后自动打开浏览器。
//
// 用法:
//   node bin/ppx-web.js                # 起服务并打开浏览器 (默认 http://127.0.0.1:8899)
//   node bin/ppx-web.js --no-open      # 只起服务, 不开浏览器
//   node bin/ppx-web.js --port 9000    # 指定端口
//   node bin/ppx-web.js --host 0.0.0.0 # 监听所有网卡 (此时非本机访问需手填 token)
//   node bin/ppx-web.js --root D:/x    # 指定项目根 (数据/配置目录)
//
// 环境变量: PPX_PORT / PPX_HOST / PPX_NO_OPEN=1
import { ensureUTF8Console } from "../src/utils/winutf8.js";
import { installCrashGuard } from "../src/utils/crashguard.js";
import { startServer } from "../src/server.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

ensureUTF8Console();

// 全局异常兜底: 桌面形态下"带伤继续"优于"窗口里服务静默消失"
// (需要传统行为可设 PPX_EXIT_ON_UNCAUGHT=1)
installCrashGuard({ tag: "ppx-web", logger: { warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) } });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.join(HERE, "..");

// ---- 极简参数解析 (零依赖, 不用外部库) ----
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
function argOf(name, fallback = "") {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}

const root = path.resolve(argOf("--root", process.env.PPX_ROOT || DEFAULT_ROOT));

// ---- 端口解析 (--port > PPX_PORT > config/ppx.json > 8899) ----
function configPort() {
  try {
    const p = path.join(root, "config", "ppx.json");
    if (fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      const n = Number(cfg?.channels?.http?.port);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch { /* 配置缺失/损坏 → 用默认端口 */ }
  return 8899;
}
const port = Number(argOf("--port", process.env.PPX_PORT || "")) || configPort();

// --print-port: 供 .bat 启动器读取端口后自行清理旧监听 (纯查询, 不启服务)
// 必须在 startServer 之前退出, 否则会真的把服务拉起来
if (hasFlag("--print-port")) {
  process.stdout.write(String(port));
  process.exit(0);
}

const host = argOf("--host", process.env.PPX_HOST || "127.0.0.1");
const noOpen = hasFlag("--no-open") || String(process.env.PPX_NO_OPEN || "") === "1";

// ---- 打开浏览器 (三平台: win 用 cmd start, mac 用 open, linux 用 xdg-open) ----
function openBrowser(url) {
  let bin;
  let args;
  if (process.platform === "win32") { bin = "cmd"; args = ["/c", "start", "", url]; }
  else if (process.platform === "darwin") { bin = "open"; args = [url]; }
  else { bin = "xdg-open"; args = [url]; }
  try {
    const child = spawn(bin, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {}); // 无浏览器环境不致命
    child.unref();
    return true;
  } catch { return false; }
}

function banner(url) {
  const line = "─".repeat(46);
  console.log("");
  console.log(`  ${line}`);
  console.log("   皮皮虾 PPXANS-Harness · Web 应用已就绪");
  console.log(`  ${line}`);
  console.log(`   界面   ${url}`);
  console.log(`   接口   ${url}/health     健康检查`);
  console.log(`   协议   ${url}/mcp        MCP 端点 (Streamable HTTP)`);
  console.log(`   根目录 ${root}`);
  console.log("  Ctrl+C 退出");
  console.log(`  ${line}`);
  console.log("");
}

// ---- 启动 ----
let started;
try {
  started = await startServer({ root, port, host });
} catch (e) {
  const msg = String(e?.message || e);
  if (e?.code === "EADDRINUSE" || msg.includes("EADDRINUSE")) {
    console.error(`\n  [启动失败] 端口 ${port} 已被占用。`);
    console.error("  先在旧窗口按 Ctrl+C, 或用 --port 换端口, 或执行 停止皮皮虾.bat 清理。\n");
  } else {
    console.error(`\n  [启动失败] ${msg}\n`);
  }
  process.exit(1);
}

const { agent, manager } = started;
const url = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}`;
banner(url);

if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
  console.log("  ℹ 已监听非回环地址: 局域网访问不会自动获得 token, 需在界面右上角手填 (后端启动日志可见)\n");
}

if (!noOpen) {
  const ok = openBrowser(url);
  console.log(ok ? "  已打开浏览器" : "  未检测到浏览器, 请手动访问上面的地址");
} else {
  console.log("  --no-open: 已跳过打开浏览器");
}
console.log("");

// ---- 优雅退出: 关通道 + 落盘记忆 ----
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n  [PPX] 收到 ${signal}, 正在停止...`);
  Promise.resolve()
    .then(() => manager?.stop?.())
    .catch(() => {})
    .then(() => { try { agent.shutdown(); } catch {} })
    .finally(() => setTimeout(() => process.exit(0), 150));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
