// src/ans/watchdog.js - Watchdog 控制回路 (2026-10-31 Super-agent 一期)
//
// 对照 DeepSeek《Super-agent 设计探索》§6: 持久在线的系统很难仅靠主系统内部逻辑保证
// 长期可靠运行, 需要在主系统之外引入独立的 Control Loop。且 Agent 系统里许多异常并非
// 进程崩溃, 而是任务陷入无效循环或偏离目标 —— 所以除了基础设施体征, 还要监控任务进展。
//
// 落地形态 (复刻 startProactiveTicker 的 interval + 防重入 + 回调广播惯例):
//   - 定时心跳: 采集体征 (工作栈卡死 / 故障病历头部 / SQ 死轮水位 / 进程内存) → 组装简报
//   - 独立会话: agent.chat(简报, {sessionKey: "ppx:cron:watchdog:dm"}) —— 完整工具能力的
//     常驻看门狗会话, 与用户会话隔离不互扰; 它可以自己调工具深挖, 也可以在线修正主系统
//   - 低打扰: 回复首行 OK/WARN/CRIT 分级, 仅 warn/crit 才触发回调广播 (ok 只落账)
//   - 留账: 每次心跳追加 data/evolve/watchdog.jsonl (evolve journal 同款 JSONL)
import fs from "node:fs";
import path from "node:path";
import { info, warn } from "../utils/logger.js";
import { sessionKeyFor } from "../utils/session-key.js";

export const WATCHDOG_SESSION_KEY = sessionKeyFor({ surface: "cron", session: "watchdog", scope: "dm" });

// ---- 体征采集: 全部防御式读取 (测试桩/裁剪装配下缺哪个都不炸) ----
export function collectSignals(agent) {
  const sig = { ts: Date.now(), heapMB: 0, uptimeMin: 0, sqPending: 0, workstack: null, failures: [], journal: null };
  try {
    const mu = process.memoryUsage();
    sig.heapMB = Math.round(mu.heapUsed / 1048576);
    sig.uptimeMin = Math.round(process.uptime() / 60);
  } catch { /* 不可能, 但保持同款防御 */ }
  try { sig.sqPending = Number(agent?.protocolStats?.().sqPending) || 0; } catch {}
  try {
    const st = agent?.workStack?.status?.();
    if (st) sig.workstack = { total: st.total, active: st.active, blocked: st.blocked, current: st.current };
  } catch {}
  try {
    // 故障病历头部: 同类病历聚集 = 系统性弱点的早期信号 (weaknessClusters 同源数据)
    const eps = (agent?.failures?.list?.(20) || []).map((e) => ({
      tool: e.tool, category: e.category, error: String(e.error || "").slice(0, 120), at: e.at || e.ts || null,
    }));
    sig.failures = eps.slice(0, 10);
  } catch {}
  try { sig.journal = agent?._evolutionLoop?.journalTail?.(3) || null; } catch {}
  return sig;
}

// ---- 简报渲染: 只给事实, 判断交给看门狗会话 (它有工具可深挖) ----
export function renderWatchdogPrompt(sig) {
  const parts = [
    "[看门狗心跳] 请检查皮皮虾当前状态并给出结论。",
    "规则: 一切正常时, 回复只写一行 OK, 不要做任何事; 发现异常才诊断/处置, 且回复首行以 WARN 或 CRIT 开头 (CRIT=影响主服务, WARN=有风险需关注), 首行之后给简短结论与已采取的行动。",
    `进程: uptime=${sig.uptimeMin}min, heap=${sig.heapMB}MB, SQ积压=${sig.sqPending} (持续>0 表示有 turn 卡死)`,
  ];
  if (sig.workstack) {
    parts.push(`工作栈: 总${sig.workstack.total} 活跃${sig.workstack.active} 阻塞${sig.workstack.blocked}`
      + (sig.workstack.current ? `, 当前: ${String(sig.workstack.current.goal).slice(0, 80)}` : ""));
  }
  if (sig.failures.length) {
    parts.push("最近故障病历:");
    for (const f of sig.failures) parts.push(`- [${f.tool}/${f.category}] ${f.error}`);
  } else {
    parts.push("最近故障病历: 无");
  }
  if (sig.journal && sig.journal.length) {
    parts.push(`进化 journal 尾部 ${sig.journal.length} 条可用 (evolution_status 可查), 无需复述。`);
  }
  parts.push("可用工具: task_stack 查工作栈详情 / evolution_status 看弱点与自改账本 / goal_board 看目标。不要主动打扰用户。");
  return parts.join("\n");
}

// ---- 回复分级: 首行 OK/WARN/CRIT (缺省视为 WARN —— 看门狗说不出结论本身就是异常) ----
export function classifyReply(reply) {
  const head = String(reply || "").trim().split("\n")[0].trim().toUpperCase();
  if (head.startsWith("OK")) return "ok";
  if (head.startsWith("CRIT")) return "crit";
  return "warn";
}

// ---- 落账: data/evolve/watchdog.jsonl (append-only, 与 evolve journal 同款) ----
function journalAppend(agent, entry) {
  try {
    const dir = path.join(agent.dataDir, "evolve");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "watchdog.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch { /* 记录失败不阻断心跳 */ }
}

/**
 * 单次心跳: 采集 → 看门狗会话判断 → 落账 → 返回 {ts, level, text, signals}。
 * 由 agent.startWatchdog 的定时器驱动 (防重入), 也可手动调一次做巡检。
 */
export async function watchdogHeartbeat(agent) {
  const sig = collectSignals(agent);
  const prompt = renderWatchdogPrompt(sig);
  let reply = "";
  try {
    reply = String(await agent.chat(prompt, { sessionKey: WATCHDOG_SESSION_KEY }) || "");
  } catch (e) {
    // 看门狗会话失败本身要可见 (LLM 余额耗尽/超时等), 但不抛 —— 心跳不能带崩主服务
    reply = `WARN 看门狗会话失败: ${e.message}`;
    warn(`[watchdog] ${reply}`);
  }
  const level = classifyReply(reply);
  journalAppend(agent, {
    ts: new Date(sig.ts).toISOString(), level,
    heapMB: sig.heapMB, uptimeMin: sig.uptimeMin, sqPending: sig.sqPending,
    workstack: sig.workstack, failures: sig.failures.length,
    reply: String(reply).slice(0, 2000),
  });
  return { ts: sig.ts, level, text: String(reply).slice(0, 4000), signals: sig };
}

/**
 * 装配 (evolution_loop / self_code 同款防御式配置读取惯例):
 * config.agent.watchdog = { enabled, interval_minutes } —— 默认关, config 显式开启。
 * onAlert: warn/crit 回调 (server.js 传 manager.broadcast 管道; CLI 可不传, 心跳仍落账)。
 */
export function installWatchdog(agent, { onAlert = null } = {}) {
  const cfg = agent?.config?.agent?.watchdog || {};
  if (!cfg?.enabled) return null;
  return agent.startWatchdog?.(onAlert) ?? null;
}
