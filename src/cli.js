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

其他入口:
  ppx-serve             仅启动 HTTP 服务 (无 Web 界面)
  ppx-web               启动 Web UI 并自动打开浏览器
  ppx-channels          渠道 (飞书/微信) 配置与连通测试
  ppx-setup             模型配置向导

REPL 内命令:
  quit | exit | q       退出
  /stop                 中断当前任务
  /reset                清空当前会话
  /proactive            主动提醒 (扫描记忆待办)`);
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

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "皮皮虾> ",
  terminal: true,
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
  if (busy) return rl.prompt(); // 上一轮任务未结束, 忽略输入 (可用 /stop 或 Ctrl+C 打断)

  // 退出
  if (["quit", "exit", "q"].includes(text.toLowerCase())) {
    // 2026-10-10 (L2): shutdown 已异步化, await 确保军团子进程回收完成再退出, 不留孤儿进程
    await agent.shutdown();
    console.log("皮皮虾 收工, 已保存记忆。");
    process.exit(0);
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
