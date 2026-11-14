#!/usr/bin/env node
// src/server.js - 皮皮虾 HTTP 服务入口
// 提供: /health, /message (HTTP通道), /feishu/webhook, /wechat/webhook
// (2026-11-08 精简: TUI 终端网关随 bin/ppx-bot 一并退役, dsh 走 HTTP/MCP 接入)
// 通道统一走 ChannelManager 注册表: connect + webhook 挂载由各通道 mount() 完成
import { ensureUTF8Console } from "./boot/winutf8.js";
import { installCrashGuard } from "./boot/crashguard.js";
import { PPXAgent } from "./agent/index.js";
import { ChannelManager } from "./channels/index.js";
import { createAnsLane } from "./channels/ans-lane.js";

ensureUTF8Console();
export async function startServer({ root = process.cwd(), port = 8899, host = "127.0.0.1", config = {}, llm = null } = {}) {
    const agent = new PPXAgent({ root });
  if (llm) {
    // 测试注入 stub LLM, 避免依赖真实网络; 同步把 allProviders 替换为同源 stub,
    // 让 /api/providers/test 等"按 id 取客户端"的路径也能命中 stub
    agent.llm = llm;
    if (Array.isArray(agent.allProviders)) agent.allProviders = [llm];
  }

  // 统一走注册表: HTTP 通道始终启动 (port/host 参数覆盖配置), 其余按 config.channels
  // 基础配置来自 agent.config (config/ppx.json 加载的), 调用方传入的 config.channels 只做覆盖
  const baseChannels = agent.config.channels || {};
  const channelsCfg = { ...baseChannels, ...((config.channels) || {}) };
  channelsCfg.http = { ...(channelsCfg.http || {}), enabled: true, port, host }; // port/host 参数最高优先级
  const manager = new ChannelManager(agent, channelsCfg);
  await manager.start();

  // 安全自动恢复 (2026-11-02 / Step 6): 重跑上个实例遗留的 admitted (从未 begin)
  //   与 replaySafe=true 的 working 工单。放在通道启动之后: 结果要回投原话题。
  //   两个开关都默认关 (resume_unstarted / resume_started); 失败不阻断启动。
  const wgCfg = agent.config.agent?.work_graph || {};
  if (wgCfg.resume_unstarted === true || wgCfg.resume_started === true) {
    try {
      const resumed = agent.resumeUnstartedTickets();
      if (resumed.resumed > 0) {
        const replay = resumed.tickets.filter((t) => t.kind === "replay").length;
        console.log(`  [workgraph] 已自动恢复 ${resumed.resumed} 个工单 (未开跑 ${resumed.resumed - replay} / 无副作用重放 ${replay})`);
      }
    } catch (e) {
      console.warn(`  [workgraph] 自动恢复失败 (服务继续启动): ${e?.message || e}`);
    }
  }

  // ANS 车道 (Step 5b): enabled=false (默认) 时 handles() 恒 false, 全部继续旧 broadcast。
  const ansLane = createAnsLane({ lane: agent.config.ans_lane, manager, agent });
  const dispatchAns = (source, text, key = null) => {
    if (!ansLane.handles(source)) return manager.broadcast(text);
    const p = ansLane.notify({ source, text, key });
    if (p && typeof p.catch === "function") {
      p.catch((e) => console.warn(`[ans-lane] ${source} 投递失败: ${e?.message || e}`));
    }
    return p;
  };

  // 主动提醒 → 走 ANS 车道或旧广播 (agent.proactive.enabled 才接; 默认关不打扰)
  if (agent.config.agent?.proactive?.enabled) {
    agent.startProactiveTicker((payload) => dispatchAns("proactive", payload.text, payload?.key || null));
  }

  // Watchdog 控制回路 (2026-10-31 v4.1 平台化): 独立定时心跳会话监控体征与任务进展,
  //   低打扰 —— 仅 warn/crit 才广播; ok 心跳只落 data/evolve/watchdog.jsonl
  if (agent.config.agent?.watchdog?.enabled) {
    agent.startWatchdog((r) => dispatchAns("watchdog", `[watchdog:${r.level}] ${r.text}`, r?.key || null));
  }

  const server = manager.httpServer;
  return {
    agent,
    server,
    http: manager.get("http"),
    feishu: manager.get("feishu"),
    wechat: manager.get("wechat"),
    manager,
    ansLane,
  };
}

// 2026-11-12 优雅退出收口 (ppx serve / daemon): 此前 runServer 只挂 SIGINT, 而
//   services/daemon-control.js 的 daemonStop 发的是 SIGTERM —— 收到即被系统直接终止:
//   通道监听不关、军团子进程不回收、记忆不落盘。这里收敛成单一幂等 shutdown:
//   ① manager.stop() (关通道) → agent.shutdown() (落盘/回收), 顺序与 web-entry 一致;
//   ② 超时兜底 (默认 4s) 强制退出, 赶在 daemonStop 的 SIGKILL (5s) 之前;
//   ③ 重复信号 (Ctrl+C 连按) 只跑一次收尾。
export function createGracefulShutdown({
  agent,
  manager,
  timeoutMs = 4000,
  exitDelayMs = 150,
  exit = (code) => process.exit(code),
  log = (...args) => console.log(...args),
} = {}) {
  let closing = false;
  return function shutdown(signal = "shutdown") {
    if (closing) return;
    closing = true;
    log(`\n  [PPX] 收到 ${signal}, 正在停止...`);
    const timer = setTimeout(() => {
      log("  [PPX] 优雅退出超时, 强制结束");
      try { exit(1); } catch { /* 已退出 */ }
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    Promise.resolve()
      .then(() => manager?.stop?.())
      .catch(() => {})
      .then(() => Promise.resolve(agent?.shutdown?.()).catch(() => {}))
      .finally(() => {
        clearTimeout(timer);
        setTimeout(() => { try { exit(0); } catch { /* 已退出 */ } }, exitDelayMs);
      });
  };
}

// CLI 启动公共逻辑: 供 `ppx serve` 与 src/server.js 直接运行共用
export async function runServer({ root = process.cwd(), port = Number(process.env.PPX_PORT || 8899) } = {}) {
  // 全局异常兜底 (P1): 工具/通道里的意外异常不应让整个服务消失
  installCrashGuard({ tag: "ppx-serve" });
  const started = await startServer({ root, port });
  const { agent, manager } = started;
  console.log(`皮皮虾 服务已启动: http://127.0.0.1:${port}`);
  console.log(`  /health   健康检查`);
  console.log(`  /message  HTTP 对话通道 (POST {message})`);
  console.log(`  通道: ${manager.list().filter((c) => c.enabled).map((c) => c.name).join(", ") || "(无)"}`);
  console.log(`  工具: ${agent.tools.list().join(", ")}`);
  console.log("  Ctrl+C / SIGTERM 退出");
  // 2026-10-10 (L2): await 军团子进程回收完成再退出 (shutdown 已异步化)
  const shutdown = createGracefulShutdown({ agent, manager });
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return { ...started, shutdown };
}

// 直接运行 (node src/server.js, scripts/start-web.js)
const _entry = (process.argv[1] || "").replace(/\\/g, "/");
if (_entry.endsWith("src/server.js")) {
  await runServer({ root: process.cwd() });
}
