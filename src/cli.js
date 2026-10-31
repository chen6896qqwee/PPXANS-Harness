#!/usr/bin/env node
// src/cli.js - 皮皮虾 CLI 交互入口 (readline 历史 + interrupt 中断)
import { ensureUTF8Console } from "./utils/winutf8.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "./agent/index.js";
import { suggestProactive } from "./ans/proactive.js";
import { cliBanner, colors, paint } from "./utils/banner.js";
import { isUsableProvider } from "./llm/router.js";
import { commandCompleter } from "./commands/index.js";

ensureUTF8Console();
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- argv 早退闸门 (2026-10-09) ----
// 必须放在【构造 PPXAgent 之前】: 否则 `ppx --version` 会全家桶启动 (自愈扫描 + 插件装配 +
// 工具注册 + 主动任务定时器) 再进交互 REPL, 永远不退出 —— 违反 npm bin 惯例。
// test/cli-gate.test.js 锁死该行为 (此前该闸门缺失, 测试一直是红的)。
const ARGV = process.argv.slice(2);
function pkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
if (ARGV.includes("--version") || ARGV.includes("-v")) {
  console.log(`ppxans-harness (PPXANS-Harness) v${pkgVersion()}`);
  process.exit(0);
}
if (ARGV.includes("--help") || ARGV.includes("-h")) {
  console.log(`皮皮虾 (PPXANS-Harness) v${pkgVersion()}

用法: ppx [选项]
  (无参数)              进入交互式对话 REPL
  ppx --version, -v     显示版本号后退出
  ppx --help, -h        显示本用法后退出
  ppx doctor [--net]    一键体检: 配置/密钥/数据目录/技能库 (--net 额外发一条最小请求探模型连通)
  ppx update [--check]  检查并升级到最新版 (--check 只查不装; 源码装机打印手动步骤)
  ppx mcp serve         MCP stdio 宿主 (Claude Code / ZCode / Cursor 直接接入)

其他入口:
  ppx-serve             仅启动 HTTP 服务 (无 Web 界面)
  ppx-web               启动 Web UI 并自动打开浏览器
  ppx-channels          渠道 (飞书/微信) 配置与连通测试
  ppx-setup             模型配置向导

REPL 内命令:
  quit | exit | q       退出
  /stop                 中断当前任务
  /reset                清空当前会话
  /proactive            主动提醒 (扫描记忆待办)
  /<Tab>                补全命令 (15 条内置 + .ppx/commands 用户命令)
  /help                 查看全部命令 (/status /model /plan /task /memory ...)`);
  process.exit(0);
}

// `ppx doctor` —— 一键体检。必须在 positional 分支之前: 否则 "doctor" 会被当成一句提问
// 去启动全家桶再等模型回答。动态 import 保证 --version/--help 不加载配置。
if (ARGV[0] === "doctor") {
  const { runDoctor } = await import("./cli-doctor.js");
  const ok = await runDoctor({ net: ARGV.includes("--net") });
  process.exit(ok ? 0 : 1);
}

// `ppx mcp serve` —— MCP stdio 宿主 (2026-10-31): Claude Code / ZCode / Cursor 等任何
// MCP 客户端把皮皮虾作为 stdio 型 MCP 服务器直接接入 (claude mcp add ppx -- ppx mcp serve)。
// 必须在 positional 分支之前: 否则 "mcp" 会被当成一句提问。stdin 结束即退出。
if (ARGV[0] === "mcp") {
  const { runStdioHost } = await import("./mcp-stdio.js");
  await runStdioHost({ root: ROOT });
  process.exit(0);
}

// `ppx update` —— 检查并升级 (2026-10-31 队列⑤)。必须在 positional 分支之前: 否则 "update"
// 会被当成一句提问去启动全家桶。显式命令不受 PPX_UPDATE_CHECK=0 影响 (开关只管启动通知)。
if (ARGV[0] === "update") {
  const { loadConfig } = await import("./config/index.js");
  const { resolveDataDir } = await import("./utils/datadir.js");
  const {
    checkWithConfig, detectInstallMode, planApply, updateNotice, RELEASES_URL,
  } = await import("./update/index.js");
  const { spawnSync } = await import("node:child_process");
  const checkOnly = ARGV.includes("--check");
  const current = pkgVersion();
  const check = await checkWithConfig({
    config: loadConfig(ROOT),
    currentVersion: current,
    dataDir: resolveDataDir(ROOT),
    force: true, // 显式命令永远真查, 不吃 24h 缓存
  });
  if (!check.ok) {
    console.log(`无法检查更新: ${check.reason}`);
    console.log("网络受限时可配代理 (config.network.proxy) 或镜像 (PPX_UPDATE_REGISTRY=https://registry.npmmirror.com) 后重试");
    process.exit(1);
  }
  if (!check.updateAvailable) {
    console.log(`已是最新版本 v${current}`);
    process.exit(0);
  }
  console.log(updateNotice(check));
  if (checkOnly) process.exit(0);
  const mode = detectInstallMode(ROOT);
  const plan = planApply(mode, check.latest);
  if (plan.kind === "spawn") {
    console.log(`执行: ${plan.command}`);
    const r = spawnSync(plan.command, { shell: true, stdio: "inherit" });
    if (r.status === 0) {
      console.log(`已升级到 v${check.latest} — 重启 ppx 生效`);
      process.exit(0);
    }
    console.error(`升级失败 (exit ${r.status}) — 可到 ${RELEASES_URL} 手动下载`);
    process.exit(r.status || 1);
  }
  for (const line of plan.lines) console.log(line);
  process.exit(0);
}

// ---- 一发即走模式 (2026-10-24, 对齐 DSH 的"一条命令出答案"): ppx "今天几号" ----
// 首个位置参数 = 问题, 直答后退出, 不进 REPL。无可用模型时给出 1 分钟配置指引。
const positional = ARGV.filter((a) => !a.startsWith("--"));
if (positional.length) {
  const q = positional.join(" ");
  const agent = new PPXAgent({ root: ROOT });
  const usable = (agent.config.providers || []).some((p) => {
    try { return isUsableProvider(p); } catch { return false; }
  });
  if (!usable) {
    console.log("\n还没有可用的模型 — 配置只要 1 分钟:");
    console.log("  ① 交互式向导:  npm run setup      (选厂商 → 粘贴 Key → 自动探活)");
    console.log("  ② 一条命令:    ppx-setup --provider deepseek --key sk-xxx   (ppx-setup --list 看厂商)\n");
    await agent.shutdown();
    process.exit(1);
  }
  try {
    const r = await agent.chat(q);
    console.log("\n" + r + "\n");
  } catch (e) {
    console.error("\n[错误] " + e.message + "\n");
  } finally {
    await agent.shutdown();
    process.exit(0);
  }
}

const agent = new PPXAgent({ root: ROOT });

// 2026-10-31: Tab 补全 —— registry 名单 (15 内置 + 隐藏别名 + .ppx/commands 用户命令)
//   + CLI 本地命令, 一次合并去重传给纯函数补全器
const CLI_LOCAL_COMMANDS = ["stop", "reset", "proactive", "proactive-done", "quit", "exit", "q"];
const REG_NAMES = (agent.commands && typeof agent.commands.list === "function")
  ? agent.commands.list().map((c) => c.name)
  : [];

// 2026-10-24 (UI 轮): 启动横幅统一设计 (box-drawing 面板 + codex 橙 + NO_COLOR 降级)
console.log("\n" + cliBanner({
  version: pkgVersion(),
  memory: agent.facts.count(),
  experience: agent.experience.lessons.length,
  modelReady: !!agent.llm,
  tools: agent.tools.list().length,
}));

// 2026-10-24 (S 轮): 无模型时给"1 分钟上手"路标 —— 替代开发者黑话警告
const hasUsable = (agent.config.providers || []).some((p) => {
  try { return isUsableProvider(p); } catch { return false; }
});
if (!hasUsable) {
  console.log(paint(colors.accent, "  ⚡ 还没有可用模型 — 运行 npm run setup, 1 分钟配好 (选厂商 → 粘贴 Key → 自动探活)"));
  console.log(paint(colors.dim, "    也可以在 Web 界面首页点「配置模型」; 本地 LM Studio / Ollama 启动后重启会自动识别\n"));
}

// 2026-10-31 (队列⑤): 启动更新通知 —— fire-and-forget 非阻塞, 24h TTL 缓存 (dataDir/update-check.json),
//   网络失败静默不打扰对话; PPX_UPDATE_CHECK=0 关闭。`ppx update` 显式升级不受开关影响。
if (process.env.PPX_UPDATE_CHECK !== "0") {
  Promise.all([import("./update/index.js"), import("./config/index.js"), import("./utils/datadir.js")])
    .then(async ([u, { loadConfig }, { resolveDataDir }]) => {
      const check = await u.checkWithConfig({
        config: loadConfig(ROOT),
        currentVersion: pkgVersion(),
        dataDir: resolveDataDir(ROOT),
      });
      const line = u.updateNotice(check);
      if (line) console.log(paint(colors.dim, `  ↑ ${line}`));
    })
    .catch(() => { /* 检查失败静默: 通知是增强信号, 不是主链 */ });
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "皮皮虾> ",
  terminal: true,
  completer: commandCompleter([...REG_NAMES, ...CLI_LOCAL_COMMANDS]),
});

let busy = false; // 防止任务执行中重复输入

// 主动任务生成定时器 (ANS 自主性): config.agent.proactive.enabled 时启动
// 有待办信号才推送 (suggestProactive 无信号返回 null 不打扰), 输出到 stdout
if (agent.config.agent?.proactive?.enabled) {
  agent.startProactiveTicker((payload) => {
    console.log("\n[主动提醒] " + payload.text);
    rl.prompt();
  });
  const proactiveMs = Number(agent.config.agent.proactive.interval_ms) || 3600000;
  console.log(`  (主动提醒已开启: 每 ${Math.round(proactiveMs / 60000)} 分钟扫描记忆待办)`);
}

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  if (busy) {
    // 2026-10-31 修复: busy 检查此前在最前面, /stop 也被静默吞掉 —— 帮助文案写着
    //   "可用 /stop 打断" 但根本到不了处理分支。现在 busy 中 /stop 仍然可用;
    //   其余输入显式告知 (不再静默丢弃)。
    if (text === "/stop") {
      agent.interrupt();
      console.log("\n(已发送中断信号, 当前任务将尽快停下)");
      return rl.prompt();
    }
    console.log("\n(任务执行中, 本次输入已忽略 — /stop 中断任务, Ctrl+C 两次退出)");
    return rl.prompt();
  }

  // 退出
  if (["quit", "exit", "q"].includes(text.toLowerCase())) {
    // 2026-10-10 (L2): shutdown 已异步化, await 确保军团子进程回收完成再退出, 不留孤儿进程
    await agent.shutdown();
    console.log("皮皮虾 收工, 已保存记忆。");
    process.exit(0);
  }
  // 2026-10-31: 斜杠命令接入统一注册表 —— 此前 CLI 只认 4 条硬编码命令,
  //   registry 的 15 条内置 + .ppx/commands 用户命令在 CLI 全部不可用 (chat 内有落地层,
  //   控制面结果不落库不进 LLM)。/stop /reset /proactive /proactive-done 保持 CLI 本地
  //   实现 (/stop 不在 registry; /reset 与 registry /new 等价, 保留旧习惯)。
  const first = text.split(/\s/)[0];
  const CLI_LOCAL = new Set(["/stop", "/reset", "/proactive", "/proactive-done"]);
  if (first.startsWith("/") && !CLI_LOCAL.has(first)) {
    busy = true;
    try {
      const out = await agent.chat(text);
      console.log("\n" + out + "\n");
    } catch (e) {
      console.log("\n[错误] " + e.message + "\n");
    } finally {
      busy = false;
    }
    return rl.prompt();
  }
  // 中断当前任务 (Human-in-the-loop)
  if (text === "/stop") {
    agent.interrupt();
    console.log("(已发送中断信号, 当前任务将尽快停下)");
    return rl.prompt();
  }
  // 清空会话
  if (text === "/reset") {
    agent.resetSession("default");
    console.log("(会话已清空)");
    return rl.prompt();
  }
  // 主动任务生成: 扫描记忆里的待办/偏好, 给出主动提醒 (ANS 自主性)
  // 输出含 id, 可用 /proactive-done <id> 标记完成 (窗口去重, 24h 内不重复提醒)
  if (text === "/proactive") {
    busy = true;
    try {
      const out = await suggestProactive(agent);
      if (out) {
        console.log("\n" + out.text + "\n");
        for (const it of out.items) console.log(`  [${it.id}] ${it.content}`);
        console.log("\n(用 /proactive-done <id> 标记完成, 之后不再提醒)\n");
      } else {
        console.log("\n(暂时没有需要提醒的事项)\n");
      }
    } catch (e) {
      console.log("\n[错误] " + e.message + "\n");
    } finally {
      busy = false;
    }
    return rl.prompt();
  }
  // 标记待办完成: /proactive-done <factId>
  if (text.startsWith("/proactive-done")) {
    const id = text.replace("/proactive-done", "").trim();
    const ok = agent.proactiveMarkDone(id);
    console.log(ok ? "(已标记完成, 之后不再提醒)" : "(待办不存在: " + id + ")");
    return rl.prompt();
  }

  busy = true;
  try {
    const r = await agent.chat(text);
    console.log("\n" + r + "\n");
  } catch (e) {
    console.log("\n[错误] " + e.message + "\n");
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
    // 2026-10-10 (L2): await 军团回收后再退出 (shutdown 已异步化)
    agent.shutdown().finally(() => { console.log("\n皮皮虾 收工。"); process.exit(0); });
    return;
  }
  agent.interrupt();
  console.log("\n(已中断, 再按一次 Ctrl+C 退出)");
  rl.prompt();
  // 重置计数 (若任务继续则允许再次单次中断)
  setTimeout(() => { ctrlC = 0; }, 1000);
});

rl.prompt();
