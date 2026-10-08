#!/usr/bin/env node
// src/cli.js - 皮皮虾 CLI 交互入口 (readline 历史 + interrupt 中断)
import { ensureUTF8Console } from "./utils/winutf8.js";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "./agent/index.js";
import { suggestProactive } from "./ans/proactive.js";
import { installCrashGuard } from "./utils/crashguard.js";

ensureUTF8Console();
// v3.0.1 (P1#6): CLI 直跑入口装全局异常兜底 —— 此前只有 server 入口装了, chat 直跑时
// 任何未捕获 rejection (调度器/proactive ticker/流式回调) 会按 Node>=15 默认行为直接杀进程
installCrashGuard({ tag: "ppx-cli" });
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = new PPXAgent({ root: ROOT });
// 2026-10-05: 终端聊天有人在场 (能接住 clarify 的反问), 但没有 Web 审批面 —— 单独标记,
// 让 clarify 在 CLI 保持原行为; 审批链路不受此标记影响 (仍按 hasApprovalSurface 走)。
agent.markHumanChannel(true);

console.log("======================================");
console.log("  皮皮虾 (PPX) - 自我修复·自我学习 Agent");
console.log(`  记忆:${agent.facts.count()}条 | 经验:${agent.experience.lessons.length}条`);
console.log(`  模型: ${agent.llm ? "已配置" : "未配置(离线记忆模式)"}`);
console.log("  命令: quit/exit 退出 | /stop 中断当前任务 | /reset 清空会话");
console.log("        /plan 进入计划模式(只读) | /do 退出计划模式恢复执行");
console.log("        /proactive 主动提醒(扫描记忆待办) | /proactive-done <id> 标记待办完成 | ↑↓ 浏览历史 | Ctrl+C 中断(再按一次退出)");
console.log("======================================");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "皮皮虾> ",
  terminal: true,
});

// 模式可见 (2026-10-05 /plan 修复): 提示符实时显示当前计划模式, 用户不会"不知不觉卡在 plan 里"。
// 状态在 agent 侧按会话存 (CLI 单会话 = "default"), 这里只读展示, 不改判定口径。
function refreshPrompt() {
  try { rl.setPrompt(agent.isPlanMode("default") ? "皮皮虾[plan]> " : "皮皮虾> "); } catch { /* 提示符刷新失败不影响对话 */ }
}
refreshPrompt();

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
    // 2026-10-03 修复: 原 silently 忽略, 用户以为输入丢失。改为可判读提示。
    console.log("  (任务执行中, 输入已忽略; /stop 可中断当前任务)");
    return rl.prompt();
  }

  // 退出
  if (["quit", "exit", "q"].includes(text.toLowerCase())) {
    await agent.shutdown(); // 军团子进程回收是异步的, 不 await 就是紧随其后的 exit 的孤儿
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
    refreshPrompt(); // 全新会话: 计划态一并清零, 提示符同步
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
    refreshPrompt(); // /plan /do 都经由这里落到 agent.chat, 提示符随之反映模式
  }
  rl.prompt();
});

// Ctrl+C: 第一次中断任务, 第二次退出
let ctrlC = 0;
rl.on("SIGINT", async () => {
  ctrlC += 1;
  if (ctrlC >= 2) {
    await agent.shutdown();
    console.log("\n皮皮虾 收工。");
    process.exit(0);
  }
  agent.interrupt();
  console.log("\n(已中断, 再按一次 Ctrl+C 退出)");
  rl.prompt();
  // 重置计数 (若任务继续则允许再次单次中断)
  setTimeout(() => { ctrlC = 0; }, 1000);
});

rl.prompt();
