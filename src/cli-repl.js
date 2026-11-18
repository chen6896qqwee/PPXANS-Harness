// src/cli-repl.js - REPL 主循环 (从 cli.js 拆出, 2026-11-17)
// 拆出动机: 原 REPL 逻辑内联在 cli.js 顶层, 只能黑盒 spawn 测试; 提取 createRepl(agent, opts)
// 后可用 PassThrough 流进程内驱动每一条分支 (busy/stop/reset/proactive/registry/quit/SIGINT)。
// 行为与拆分前逐字一致: 输出走 output.write (生产=stdout), 退出经 onExit (生产=process.exit(0))。
import readline from "node:readline";
import { suggestProactive } from "./ans/proactive.js";
import { cliBanner, colors, paint } from "./boot/banner.js";
import { isUsableProvider } from "./llm/router.js";
import { commandCompleter } from "./agent/command-registry.js";

export const CLI_LOCAL_COMMANDS = ["stop", "reset", "proactive", "proactive-done", "quit", "exit", "q"];
const CLI_LOCAL = new Set(["/stop", "/reset", "/proactive", "/proactive-done"]);

/**
 * 组装交互式 REPL。
 * @param {object} agent        PPXAgent 或同构桩 (commands/facts/experience/llm/tools/config/chat/chatTracked/interrupt/resetSession/proactiveMarkDone/shutdown)
 * @param {object} opts
 *   input/output  readline IO 流 (默认进程标准流; 测试注入 PassThrough)
 *   version       横幅版本号
 *   updateCheck   启动更新通知开关 (生产传 PPX_UPDATE_CHECK !== "0"; 测试传 false 免网络)
 *   root          更新检查用项目根 (配合 updateCheck)
 *   onExit        退出钩子 (默认 process.exit(0); 测试注入桩)
 * @returns {readline.Interface}
 */
export function createRepl(agent, {
  input = process.stdin,
  output = process.stdout,
  version = "0.0.0",
  updateCheck = true,
  root = null,
  onExit = () => process.exit(0),
} = {}) {
  const say = (s = "") => output.write(s + "\n");

  const REG_NAMES = (agent.commands && typeof agent.commands.list === "function")
    ? agent.commands.list().map((c) => c.name)
    : [];

  say("\n" + cliBanner({
    version,
    memory: agent.facts.count(),
    experience: agent.experience.lessons.length,
    modelReady: !!agent.llm,
    tools: agent.tools.list().length,
  }));

  const hasUsable = (agent.config.providers || []).some((p) => {
    try { return isUsableProvider(p); } catch { return false; }
  });
  if (!hasUsable) {
    say(paint(colors.accent, "  ⚡ 还没有可用模型 — 运行 npm run setup, 1 分钟配好 (选厂商 → 粘贴 Key → 自动探活)"));
    say(paint(colors.dim, "    也可以在 Web 界面首页点「配置模型」; 本地 LM Studio / Ollama 启动后重启会自动识别\n"));
  }

  // 启动更新通知 —— fire-and-forget 非阻塞, 24h TTL 缓存; 网络失败静默不打扰对话
  if (updateCheck && root) {
    Promise.all([import("./services/update.js"), import("./config/index.js"), import("./utils/datadir.js")])
      .then(async ([u, { loadConfig }, { resolveDataDir }]) => {
        const check = await u.checkWithConfig({
          config: loadConfig(root),
          currentVersion: version,
          dataDir: resolveDataDir(root),
        });
        const line = u.updateNotice(check);
        if (line) say(paint(colors.dim, `  ↑ ${line}`));
      })
      .catch(() => { /* 检查失败静默: 通知是增强信号, 不是主链 */ });
  }

  const rl = readline.createInterface({
    input,
    output,
    prompt: "皮皮虾> ",
    terminal: true,
    completer: commandCompleter([...REG_NAMES, ...CLI_LOCAL_COMMANDS]),
  });

  let busy = false; // 防止任务执行中重复输入

  // 主动任务生成定时器 (ANS 自主性): config.agent.proactive.enabled 时启动
  if (agent.config.agent?.proactive?.enabled) {
    agent.startProactiveTicker((payload) => {
      say("\n[主动提醒] " + payload.text);
      rl.prompt();
    });
    const proactiveMs = Number(agent.config.agent.proactive.interval_ms) || 3600000;
    say(`  (主动提醒已开启: 每 ${Math.round(proactiveMs / 60000)} 分钟扫描记忆待办)`);
  }

  rl.on("line", async (line) => {
    const text = String(line ?? "").trim();
    if (!text) return rl.prompt();
    if (busy) {
      // busy 中 /stop 仍然可用; 其余输入显式告知 (不再静默丢弃)
      if (text === "/stop") {
        agent.interrupt();
        say("\n(已发送中断信号, 当前任务将尽快停下)");
        return rl.prompt();
      }
      say("\n(任务执行中, 本次输入已忽略 — /stop 中断任务, Ctrl+C 两次退出)");
      return rl.prompt();
    }

    // 退出
    if (["quit", "exit", "q"].includes(text.toLowerCase())) {
      await agent.shutdown();
      say("皮皮虾 收工, 已保存记忆。");
      onExit();
      return;
    }
    // 斜杠命令接入统一注册表: CLI 本地实现 4 条, 其余交 registry (chat 内有落地层)
    const first = text.split(/\s/)[0];
    if (first.startsWith("/") && !CLI_LOCAL.has(first)) {
      busy = true;
      try {
        const out = await agent.chat(text);
        say("\n" + out + "\n");
      } catch (e) {
        say("\n[错误] " + e.message + "\n");
      } finally {
        busy = false;
      }
      return rl.prompt();
    }
    // 中断当前任务 (Human-in-the-loop)
    if (text === "/stop") {
      agent.interrupt();
      say("(已发送中断信号, 当前任务将尽快停下)");
      return rl.prompt();
    }
    // 清空会话
    if (text === "/reset") {
      agent.resetSession("default");
      say("(会话已清空)");
      return rl.prompt();
    }
    // 主动任务生成: 扫描记忆里的待办/偏好 (ANS 自主性); /proactive-done <id> 标记完成
    if (text === "/proactive") {
      busy = true;
      try {
        const out = await suggestProactive(agent);
        if (out) {
          say("\n" + out.text + "\n");
          for (const it of out.items) say(`  [${it.id}] ${it.content}`);
          say("\n(用 /proactive-done <id> 标记完成, 之后不再提醒)\n");
        } else {
          say("\n(暂时没有需要提醒的事项)\n");
        }
      } catch (e) {
        say("\n[错误] " + e.message + "\n");
      } finally {
        busy = false;
      }
      return rl.prompt();
    }
    if (text.startsWith("/proactive-done")) {
      const id = text.replace("/proactive-done", "").trim();
      const ok = agent.proactiveMarkDone(id);
      say(ok ? "(已标记完成, 之后不再提醒)" : "(待办不存在: " + id + ")");
      return rl.prompt();
    }

    busy = true;
    try {
      const r = await agent.chatTracked(text, {
        source: "cli", from: "local", sessionKey: "default", run: () => agent.chat(text),
      }).then((x) => x.reply);
      say("\n" + r + "\n");
    } catch (e) {
      say("\n[错误] " + e.message + "\n");
    } finally {
      busy = false;
    }
    rl.prompt();
  });

  // Ctrl+C: 第一次中断任务, 第二次退出
  let ctrlC = 0;
  rl.on("SIGINT", () => {
    ctrlC += 1;
    if (ctrlC >= 2) {
      agent.shutdown().finally(() => { say("\n皮皮虾 收工。"); onExit(); });
      return;
    }
    agent.interrupt();
    say("\n(已中断, 再按一次 Ctrl+C 退出)");
    rl.prompt();
    // 重置计数 (若任务继续则允许再次单次中断)
    setTimeout(() => { ctrlC = 0; }, 1000);
  });

  rl.prompt();
  return rl;
}
