#!/usr/bin/env node
// src/cli.js - 皮皮虾 CLI 交互入口 (readline 历史 + interrupt 中断)
// REPL 主循环拆在 cli-repl.js (createRepl) —— 本文件只做 argv 闸门与一次性装配。
import { ensureUTF8Console } from "./boot/winutf8.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "./agent/index.js";
import { isUsableProvider } from "./llm/router.js";
import { createRepl } from "./cli-repl.js";

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

服务与配置子命令 (2026-11-08 起 8 个 bin 收敛为单一 CLI):
  ppx serve             仅启动 HTTP 服务 (无 Web 界面)
  ppx web               启动 Web UI 并自动打开浏览器 (--no-open / --port / --host / --root)
  ppx channels          渠道 (飞书/微信) 配置与连通测试 (list/add/test/enable/disable/remove)
  ppx daemon            端侧守护进程控制台 (start/stop/status/restart)
  ppx setup             模型配置向导 (--list / --provider deepseek --key sk-xxx)

REPL 内命令:
  quit | exit | q       退出
  /stop                 中断当前任务
  /reset                清空当前会话
  /proactive            主动提醒 (扫描记忆待办)
  /<Tab>                补全命令 (15 条内置 + .ppx/commands 用户命令)
  /help                 查看全部命令 (/status /model /plan /task /memory ...)`);
  process.exit(0);
}

// ---- 子命令分派 (2026-11-08: bin/ppx-serve|web|channels|daemon|setup|mcp 六个薄壳并入) ----
// 必须在 positional 分支之前: 否则 "serve"/"web" 等会被当成一句提问去启动全家桶。
if (ARGV[0] === "serve") {
  const { runServer } = await import("./server.js");
  await runServer({ root: process.cwd() });
  // 常驻 (2026-11-08 修复): runServer 启动完成即返回 —— 原始 bin/ppx-serve.js 没有
  //   process.exit, 进程靠事件循环句柄 (HTTP 监听/定时器) 维持。bin 合一时误加的
  //   exit 让内核"就绪即退", 桌面端 waitReady 探到子进程消失, 误报"60 秒未就绪"。
  //   这里停驻等待, 退出走信号 / /desktop/shutdown 优雅链。
  await new Promise(() => {});
}
if (ARGV[0] === "web") {
  await import("./web-entry.js");             // 启动完成后返回 (常驻语义同上, 靠句柄不靠 pending promise)
  await new Promise(() => {});
}
if (ARGV[0] === "channels") {
  await import("./channels-cli.js");
  process.exit(0);
}
if (ARGV[0] === "daemon") {
  await import("./entry-daemon.js");
  process.exit(0);
}
if (ARGV[0] === "setup") {
  await import("./entry-setup.js");
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
  } = await import("./services/update.js");
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
    console.log("  ② 一条命令:    ppx setup --provider deepseek --key sk-xxx   (ppx setup --list 看厂商)\n");
    await agent.shutdown();
    process.exit(1);
  }
  try {
    const r = await agent.chatTracked(q, {
      source: "cli", from: "local", sessionKey: "default", run: () => agent.chat(q),
    }).then((x) => x.reply);
    console.log("\n" + r + "\n");
  } catch (e) {
    console.error("\n[错误] " + e.message + "\n");
  } finally {
    await agent.shutdown();
    process.exit(0);
  }
}

const agent = new PPXAgent({ root: ROOT });

// REPL 主循环 (横幅/补全/命令分派/中断) 在 cli-repl.js —— 可注入 IO 进程内测试
createRepl(agent, {
  root: ROOT,
  version: pkgVersion(),
  updateCheck: process.env.PPX_UPDATE_CHECK !== "0",
});
