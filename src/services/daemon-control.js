// src/services/daemon-control.js - 端侧 daemon 生命周期 (2026-11-01 v4.2 持久化)
//
// 定位 (设计溯源 docs/PROVENANCE.md#superagent §5 "执行环境解耦 + 端侧 daemon" 的第一步, 存算分离的诚实边界):
//   计算 = 常驻 headless 进程 (runServer, 无浏览器); 状态 = data/ 目录集中落盘;
//   UI/IM 渠道/远端客户端经 HTTP attach —— 同一台机器"关窗不停服", 或局域网另一台机器
//   打开 Web UI 连过来 (BYOM: 模型配置在服务端)。
//   完整存算分离 (无状态副本 + 外置 DB) 与单机桌面形态冲突, 需产品决策 —— 本模块只做
//   "daemon 生命周期"这一层: start (脱管后台进程 + pid/log 文件) / status (pid + /health)
//   / stop (SIGTERM 优雅 → 超时强杀) / restart。诚实记录边界, 不宣称已做云原生。
//
// Windows 兼容: detached spawn + fd 重定向日志; process.kill(pid, 0) 探活; SIGTERM 在
// Windows 上等价 terminate, 轮询退避兜底 SIGKILL (pid 复用极小概率, kill 前校验 pid 文件)。
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 2026-11-08 单一 CLI 后 bin/ppx-serve.js 已删: daemon 必须拉起 `ppx serve`,
//   否则 spawn 一个不存在的脚本 → 子进程立刻退出, daemon 永远起不来。
export const SERVE_ENTRY = path.resolve(__dirname, "..", "..", "bin", "ppx.js");
export const SERVE_ARGS = Object.freeze(["serve"]);

export function pidFileFor(root) { return path.join(root, "data", "ppx-daemon.pid"); }
function logFileFor(root) { return path.join(root, "data", "ppx-daemon.log"); }

// 探活: 进程在 && (可选) /health 返回 2xx
function httpHealthy(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPidFile(root) {
  const f = pidFileFor(root);
  try {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    return d && Number.isInteger(d.pid) ? d : null;
  } catch { return null; }
}

// status: pid 文件 + 探活 + 健康探测。stale pid 文件自动清理。
export async function daemonStatus(root) {
  const rec = readPidFile(root);
  if (!rec) return { running: false, reason: "no-pidfile" };
  if (!alive(rec.pid)) {
    try { fs.unlinkSync(pidFileFor(root)); } catch { /* 清理失败无妨 */ }
    return { running: false, reason: "stale-pidfile", pid: rec.pid };
  }
  const healthy = rec.port ? await httpHealthy(rec.port) : false;
  return {
    running: true,
    pid: rec.pid,
    port: rec.port || null,
    root: rec.root || root,
    startedAt: rec.startedAt || null,
    healthy,
    log: logFileFor(root),
  };
}

// start: 脱管启动 headless 服务 (幂等 —— 已在跑则返回现状不重复拉起)
export async function daemonStart({ root, port = null, entry = SERVE_ENTRY, args = SERVE_ARGS, nodeBin = process.execPath, env = {} } = {}) {
  const st = await daemonStatus(root);
  if (st.running) return { started: false, ...st, reason: "already-running" };
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const usePort = Number(port) || Number(process.env.PPX_PORT) || 8899;
  const logFd = fs.openSync(logFileFor(root), "a");
  const child = spawn(nodeBin, [entry, ...args], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, ...env, PPX_PORT: String(usePort) },
  });
  child.unref();
  fs.closeSync(logFd); // 子进程持有继承的 fd, 父侧即刻释放
  const rec = { pid: child.pid, port: usePort, root, startedAt: Date.now() };
  fs.writeFileSync(pidFileFor(root), JSON.stringify(rec), "utf8");
  // 健康轮询: 最多等 10s (冷启动含插件装配); 起不来也如实返回 (日志里有现场)
  let healthy = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!alive(child.pid)) break;
    healthy = await httpHealthy(usePort);
    if (healthy) break;
  }
  return { started: true, pid: child.pid, port: usePort, healthy, log: logFileFor(root) };
}

// stop: SIGTERM → 轮询 5s → SIGKILL。清 pid 文件。返回 {stopped, pid?}
export async function daemonStop(root, { timeoutMs = 5000 } = {}) {
  const rec = readPidFile(root);
  if (!rec) return { stopped: false, reason: "no-pidfile" };
  if (!alive(rec.pid)) {
    try { fs.unlinkSync(pidFileFor(root)); } catch { /* 无妨 */ }
    return { stopped: false, reason: "stale-pidfile", pid: rec.pid };
  }
  try { process.kill(rec.pid, "SIGTERM"); } catch { /* 已死走下方轮询 */ }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(rec.pid)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (alive(rec.pid)) {
    try { process.kill(rec.pid, "SIGKILL"); } catch { /* 尽力而为 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  try { fs.unlinkSync(pidFileFor(root)); } catch { /* 无妨 */ }
  return { stopped: !alive(rec.pid), pid: rec.pid };
}
