// electron/server-proc.js — 内核子进程与端口所有权
// 拆自 main.js (2026-11-03): 端口探测/优雅退出/找端口是纯函数域, 直接导出;
//   拉起子进程与进程树回收 (startServer/waitReady/killServerTree) 要读写主进程的
//   生命周期状态 —— 状态所有权仍在 main, 这里经 ctx getter 借读, 不持有共享可变量。
// 2026-11-14 (战役遗留项 #8): 探活与优雅退出的 HTTP 协议实现迁至
//   src/services/desktop/kernel-client.js (纯 node 可测, secret 参数化) ——
//   本文件保留一次性密钥与进程管理, 协议实现单一来源。
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { log, openLog } from "./app-log.js";
import { probeKernel, gracefulShutdown } from "../src/services/desktop/kernel-client.js";

// 每次启动生成的一次性握手密钥: 只有自己拉起的子进程知道, 用来证明端口上的服务确实是本实例。
const DESKTOP_SECRET = crypto.randomBytes(32).toString("hex");
export const desktopSecret = () => DESKTOP_SECRET;

export function configPort(root) {
  try {
    const p = path.join(root, "config", "ppx.json");
    if (fs.existsSync(p)) {
      const n = Number(JSON.parse(fs.readFileSync(p, "utf8"))?.channels?.http?.port);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch { /* 配置缺失/损坏 → 默认端口 */ }
  return 8899;
}

// ---- 端口探测 ----
// 2026-10-30: 不再只看 /health.app 字符串 —— 本机任何服务都能返回同名 JSON。
//   端口上跑的是不是"我们拉起的那个内核", 用一次性密钥的 HMAC 挑战应答证明。
// 2026-11-14: 协议实现迁 kernel-client.js, 这里保留原签名委托 (调用方零改动)。
export function probe(port, timeout = 1200, secret = DESKTOP_SECRET) {
  return probeKernel({ port, timeout, secret });
}

// 请求内核优雅退出 (与 Ctrl+C 同一条 shutdown 链)。返回是否被受理。
export function requestGracefulShutdown(port, timeout = 1500) {
  return gracefulShutdown({ port, timeout, secret: DESKTOP_SECRET });
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

export async function pickPort(preferred) {
  const health = await probe(preferred);
  if (health?.app === "ppxans-harness" && health.__verified) {
    log(`端口 ${preferred} 已有本实例验证通过的服务, 直接接入`);
    return { port: preferred, owned: false };
  }
  if (health?.app === "ppxans-harness" && !health.__verified) {
    log(`端口 ${preferred} 上有同名但未通过握手验证的服务, 不复用 (避免接入伪造/旧实例)`);
  }
  if (await portFree(preferred)) return { port: preferred, owned: true };
  for (let p = preferred + 1; p <= preferred + 30; p++) {
    if (await portFree(p)) {
      log(`端口 ${preferred} 被占用, 改用 ${p}`);
      return { port: p, owned: true };
    }
  }
  throw new Error(`端口 ${preferred} 及后续 30 个端口均不可用`);
}

export function createServerProc(ctx) {
  function startServer(root, port) {
    openLog();
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PPX_ROOT: root,
      PPX_DESKTOP: "1",
      PPX_DESKTOP_SECRET: DESKTOP_SECRET,
    };
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    const child = spawn(process.execPath, [
      path.join(root, "bin", "ppx.js"), "web", "--no-open", "--root", root, "--port", String(port),
    ], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // POSIX: 独立进程组, 退出时能一次回收内核派生的工具子进程
      detached: process.platform !== "win32",
    });

    const pipe = (stream, tag) => {
      stream.setEncoding("utf8");
      let buf = "";
      stream.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trimEnd();
          buf = buf.slice(i + 1);
          if (!line) continue;
          log(`[${tag}] ${line}`);
        }
      });
    };
    pipe(child.stdout, "svc");
    pipe(child.stderr, "svc!");

    child.on("error", (e) => {
      log(`内核进程启动失败: ${e.message}`);
      if (ctx.getServerChild() === child) ctx.setServerChild(null);
      if (!ctx.isQuitting() && ctx.isOwned() && ctx.isBooted()) ctx.onGone("spawn_error");
    });
    child.on("exit", (code, sig) => {
      if (ctx.getServerChild() === child) ctx.setServerChild(null);
      if (ctx.isQuitting()) return;
      if (ctx.isOwned() && ctx.isBooted()) ctx.onGone(code ?? sig);
    });
    return child;
  }

  async function waitReady(port, timeoutMs = 60000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const h = await probe(port, 800);
      // 2026-11-02: 就绪判定必须是"本实例拉起的内核" —— 只认 app 字符串会接上端口上
      //   同名的其他服务 (旧实例/伪造服务)。HMAC 证明与 pickPort 同一把尺子。
      if (h?.app === "ppxans-harness" && h.__verified) return true;
      if (ctx.isOwned() && !ctx.getServerChild()) return false;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  // ---- 生命周期 ----
  // Windows 上 child.kill() 只结束直接子进程, 内核派生的工具子进程会变成孤儿继续跑。
  // 用 taskkill /T 结束整棵进程树; POSIX 用进程组 (spawn 时 detached) 兜底。
  function killServerTree({ graceful = false } = {}) {
    const child = ctx.getServerChild();
    if (!child || child.killed) { ctx.setServerChild(null); return; }
    const pid = child.pid;
    ctx.setServerChild(null);
    if (process.platform === "win32") {
      const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      if (r.error) { try { child.kill(); } catch { /* 已退出 */ } }
      return;
    }
    try {
      process.kill(-pid, graceful ? "SIGTERM" : "SIGKILL");
    } catch {
      try { child.kill(graceful ? "SIGTERM" : "SIGKILL"); } catch { /* 已退出 */ }
    }
  }

  return { startServer, waitReady, killServerTree };
}
