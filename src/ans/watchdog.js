// src/ans/watchdog.js - Watchdog 控制回路 (2026-10-31 v4.1 平台化)
//
// 设计溯源 docs/PROVENANCE.md#superagent §6: 持久在线的系统很难仅靠主系统内部逻辑保证
// 长期可靠运行, 需要在主系统之外引入独立的 Control Loop。且 Agent 系统里许多异常并非
// 进程崩溃, 而是任务陷入无效循环或偏离目标 —— 所以除了基础设施体征, 还要监控任务进展。
//
// 落地形态 (沿用 startProactiveTicker 的 interval + 防重入 + 回调广播惯例):
//   - 定时心跳: 采集体征 (工作栈卡死 / 故障病历头部 / SQ 死轮水位 / 进程内存) → 组装简报
//   - 独立会话: agent.chat(简报, {sessionKey: "ppx:cron:watchdog:dm"}) —— 完整工具能力的
//     常驻看门狗会话, 与用户会话隔离不互扰; 它可以自己调工具深挖, 也可以在线修正主系统
//   - 低打扰: 回复首行 OK/WARN/CRIT 分级, 仅 warn/crit 才触发回调广播 (ok 只落账)
//   - 留账: 每次心跳追加 data/evolve/watchdog.jsonl (evolve journal 同款 JSONL)
import fs from "node:fs";
import path from "node:path";
import { warn } from "../utils/logger.js";
import { sessionKeyFor } from "../utils/session-key.js";
import { noteCatch } from "../utils/catch-log.js";
import { readNeedsAction } from "../llm/needs-action.js";
import { readRecentEscalation } from "../security/escalation-flag.js";

export const WATCHDOG_SESSION_KEY = sessionKeyFor({ surface: "cron", session: "watchdog", scope: "dm" });

/**
 * Worker 漂移判定 (纯函数): "还在跑"不等于"在推进"。
 *   · tool_repeat: 最近 N 次工具调用全是同一个工具 (反复读同一文件/反复重试同一命令);
 *   · round_spin: 轮次已接近工具循环上限, 却几乎没有工具步 (模型在原地打转)。
 * 只产出信号, 不决定处置 —— 中断/重跑必须由看门狗会话或人工显式触发。
 */
export function detectWorkerDrift(ticket, { repeatThreshold = 6, roundSpinRounds = 18 } = {}) {
  if (!ticket || ticket.status !== "working") return null;
  const repeat = Math.max(2, Math.trunc(Number(repeatThreshold) || 6));
  const spin = Math.max(4, Math.trunc(Number(roundSpinRounds) || 18));
  const tools = Array.isArray(ticket.tools) ? ticket.tools.map((t) => String(t)) : [];
  if (tools.length >= repeat) {
    const tail = tools.slice(-repeat);
    if (tail.every((t) => t === tail[0])) {
      return { kind: "tool_repeat", tool: tail[0], count: tail.length };
    }
  }
  const rounds = Number(ticket.rounds) || 0;
  const steps = Number(ticket.steps) || 0;
  if (rounds >= spin && steps <= 1) {
    return { kind: "round_spin", rounds, steps };
  }
  return null;
}

// ---- 体征采集: 全部防御式读取 (测试桩/裁剪装配下缺哪个都不炸) ----
export function collectSignals(agent) {
  const sig = { ts: Date.now(), heapMB: 0, uptimeMin: 0, sqPending: 0, workstack: null, tickets: null, workers: null, failures: [], journal: null, llmNeedsAction: null, permEscalation: null };
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
    // 工单账本 (2026-11-05 调度闭环收口 ④): Watchdog 从"只看体征"升级到"看任务进展" ——
    //   working/waiting 工单计数 + 停滞工单 (working 且 updatedAt 超过 stall_minutes 无推进)。
    //   只报告不自动取消/重跑: 纠正动作留给看门狗会话现有工具与人工 /work (不做静默重放)。
    const list = agent?.work?.list?.({ limit: 200 });
    if (list && Array.isArray(list.tickets)) {
      const wcfg = agent?.config?.agent?.watchdog || {};
      const stallMin = Math.max(1, Number(wcfg.stall_minutes) || 15);
      const repeatThreshold = Math.max(2, Number(wcfg.drift_repeat) || 6);
      const roundSpinRounds = Math.max(4, Number(wcfg.drift_rounds) || 18);
      const live = list.tickets.filter((t) => t?.status === "working" || t?.status === "waiting");
      const working = live.filter((t) => t.status === "working");
      const stalled = working
        .map((t) => {
          const ref = Math.max(Number(t.updatedAt) || 0, Number(t.startedAt) || 0, Number(t.createdAt) || 0);
          return {
            id: t.id,
            worker: t.worker || null,
            text: String(t.textPreview || t.text || "").slice(0, 60),
            idleMin: Math.max(0, Math.round((sig.ts - ref) / 60000)),
            rounds: Number(t.rounds) || 0,
            steps: Number(t.steps) || 0,
            lastTool: t.lastTool || null,
          };
        })
        .filter((t) => t.idleMin >= stallMin)
        .sort((a, b) => b.idleMin - a.idleMin)
        .slice(0, 3);
      // Worker 漂移 (Super-agent 自愈外部化): 停滞看"多久没动", 漂移看"动了但没进展"。
      //   与停滞并列报告, 处置仍只交给看门狗会话/人工 —— 不静默中断或重跑。
      const drift = working
        .map((t) => {
          const d = detectWorkerDrift(t, { repeatThreshold, roundSpinRounds });
          return d ? {
            id: t.id,
            worker: t.worker || null,
            kind: d.kind,
            detail: d.kind === "tool_repeat" ? `${d.tool}×${d.count}` : `轮次${d.rounds}/步数${d.steps}`,
            rounds: Number(t.rounds) || 0,
            steps: Number(t.steps) || 0,
          } : null;
        })
        .filter(Boolean)
        .slice(0, 3);
      sig.tickets = {
        working: working.length,
        waiting: live.filter((t) => t.status === "waiting").length,
        stallMinutes: stallMin,
        stalled,
      };
      sig.workers = { running: working.length, drifting: drift.length, drift };
    }
  } catch {}
  try {
    // 故障病历头部: 同类病历聚集 = 系统性弱点的早期信号 (weaknessClusters 同源数据)
    const eps = (agent?.failures?.list?.(20) || []).map((e) => ({
      tool: e.tool, category: e.category, error: String(e.error || "").slice(0, 120), at: e.at || e.ts || null,
    }));
    sig.failures = eps.slice(0, 10);
  } catch {}
  try { sig.journal = agent?._evolutionLoop?.journalTail?.(3) || null; } catch {}
  try {
    // 2026-11-14 (评测 P1-2): LLM 通道 needsUserAction 标志 (auth/balance/404) ——
    //   这种失败重试无意义, 静默就是停摆 (2026-11-13 deepseek 401 实测无感半天多)。
    //   只报告, 不做自动换 Key; 用户动作 (改配置/充值) 才能解除。
    sig.llmNeedsAction = readNeedsAction();
  } catch {}
  try {
    // 2026-11-14 (评测 P1-1): 近 24h 内的权限提升 (recordEscalation 第四通道持久标志) ——
    //   "非本人提权"是影响安全边界的事件, 心跳必须可感知 (生产 11-03 十次提权心跳恒 ok)。
    sig.permEscalation = readRecentEscalation();
  } catch {}
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
  if (sig.tickets) {
    // 工单行 (收口 ④): 停滞工单点名到 id —— "跑偏了能纠正"的观测地基; 纠正只报告建议,
    //   不做自动取消/重跑 (工单重放必须显式 /work requeue, 不静默重放副作用)。
    const stalled = sig.tickets.stalled.length
      ? `, 停滞≥${sig.tickets.stallMinutes}min: ` + sig.tickets.stalled
        .map((t) => `${t.id}(闲置${t.idleMin}min: ${t.text || "无预览"})`).join("; ")
      : ", 无停滞";
    parts.push(`工单账本: 在跑 ${sig.tickets.working} / 等待 ${sig.tickets.waiting}${stalled}。工单停滞只报告与建议, 不自动取消/重跑 (人工 /work requeue)。`);
  }
  if (sig.workers) {
    const drift = sig.workers.drift.length
      ? ", 漂移: " + sig.workers.drift
        .map((d) => `${d.id}(${d.worker || "worker"}: ${d.kind}/${d.detail})`).join("; ")
      : ", 无漂移";
    parts.push(`Worker 进展: 在跑 ${sig.workers.running}${drift}。漂移与停滞只报告, 不自动中断/重跑。`);
  }
  if (sig.failures.length) {
    parts.push("最近故障病历:");
    for (const f of sig.failures) parts.push(`- [${f.tool}/${f.category}] ${f.error}`);
  } else {
    parts.push("最近故障病历: 无");
  }
  if (sig.llmNeedsAction) {
    // 需要用户处理的 LLM 通道故障: 属于"影响主服务" —— 看门狗首行应当 CRIT。
    const e = sig.llmNeedsAction.entries || [];
    parts.push("!! LLM 通道需要用户处理 (无法自动恢复, 首行应 CRIT):");
    for (const x of e.slice(0, 5)) {
      parts.push(`- ${x.provider}/${x.model} [${x.reason}] ${x.userHint || ""} (自 ${x.firstAt}, 累计 ${x.count} 次)`);
    }
    parts.push("处置: 提醒用户更新 API Key / 充值 / 修正 base_url; 不要静默重试, 也不要自行改配置。");
  }
  if (sig.permEscalation) {
    // 2026-11-14 (评测 P1-1): 近期权限提升 —— 影响安全边界的决定点, 首行应 CRIT。
    const p = sig.permEscalation;
    parts.push(`!! 权限被提升 (via ${p.via}, 近 24h 累计 ${p.count} 次, 最近 ${p.lastAt}): ${(p.changes || []).join("; ")}`);
    parts.push("处置: 首行应 CRIT。若非本人操作, 立即检查 channels.http.auth_token 是否泄漏并重启还原 (提权只动内存, 重启即失效); 不要静默确认。");
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
  } catch (e) { noteCatch(e); /* 记录失败不阻断心跳 */ }
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
    llmNeedsAction: sig.llmNeedsAction ? sig.llmNeedsAction.entries.map((x) => `${x.key}×${x.count}`) : null,
    permEscalation: sig.permEscalation ? { count: sig.permEscalation.count, via: sig.permEscalation.via, lastAt: sig.permEscalation.lastAt } : null,
    workstack: sig.workstack,
    tickets: sig.tickets ? { working: sig.tickets.working, waiting: sig.tickets.waiting, stalled: sig.tickets.stalled.length } : null,
    workers: sig.workers ? {
      running: sig.workers.running,
      drifting: sig.workers.drifting,
      drift: sig.workers.drift.map((d) => ({ id: d.id, worker: d.worker, kind: d.kind })),
    } : null,
    failures: sig.failures.length,
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
