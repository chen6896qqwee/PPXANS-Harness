// src/entry-daemon.js - `ppx daemon` 子命令实现 (2026-11-08 自 bin/ppx-daemon.js 并入单一 CLI)
//   ppx daemon start    脱管启动 headless 服务 (无浏览器, 常驻, 日志落 data/ppx-daemon.log)
//   ppx daemon status   查看进程/健康状态
//   ppx daemon stop     优雅停止 (SIGTERM → 超时强杀)
//   ppx daemon restart  = stop + start
// 存算分离第一步: 计算常驻本机, UI/IM/远端客户端经 HTTP attach; 状态集中在 data/。
import { daemonStart, daemonStatus, daemonStop } from "./services/daemon-control.js";

const root = process.cwd();
const cmd = String(process.argv[3] || process.argv[2] || "status").toLowerCase();
const portArg = (() => {
  const i = process.argv.indexOf("--port");
  return i >= 0 ? Number(process.argv[i + 1]) : null;
})();

try {
  if (cmd === "start") {
    const r = await daemonStart({ root, port: portArg });
    if (r.started) {
      console.log(`[daemon] 已启动 (pid=${r.pid}, port=${r.port}, healthy=${r.healthy})`);
      console.log(`  日志: ${r.log}`);
      console.log(`  Web:  http://127.0.0.1:${r.port}`);
      if (!r.healthy) console.log("  ⚠ 10s 内健康探测未通过 —— 查看日志定位 (可能仍在冷启动或端口被占)");
    } else {
      console.log(`[daemon] 未重复启动: ${r.reason} (pid=${r.pid}, port=${r.port}, healthy=${r.healthy})`);
    }
  } else if (cmd === "stop") {
    const r = await daemonStop(root);
    console.log(r.stopped ? `[daemon] 已停止 (pid=${r.pid})` : `[daemon] 未停止: ${r.reason}`);
  } else if (cmd === "restart") {
    await daemonStop(root);
    const r = await daemonStart({ root, port: portArg });
    console.log(`[daemon] 重启完成 (pid=${r.pid}, port=${r.port}, healthy=${r.healthy})`);
  } else if (cmd === "status") {
    const r = await daemonStatus(root);
    if (r.running) {
      console.log(`[daemon] 运行中: pid=${r.pid}, port=${r.port}, /health=${r.healthy ? "ok" : "不通"}`);
      console.log(`  日志: ${r.log}`);
      console.log(`  Web:  http://127.0.0.1:${r.port}`);
    } else {
      console.log(`[daemon] 未运行 (${r.reason})`);
    }
  } else {
    console.error(`未知命令: ${cmd} (可用: start | stop | status | restart)`);
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`[daemon] ${cmd} 失败: ${e.message}`);
  process.exitCode = 1;
}
