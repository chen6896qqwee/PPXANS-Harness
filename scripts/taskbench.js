// scripts/taskbench.js - 任务级评测基准运行器 (2026-10-02)
// 用法:
//   node scripts/taskbench.js --limit 3        快速冒烟 (前 3 个任务)
//   node scripts/taskbench.js --only fix-logic,create-file
//   node scripts/taskbench.js --full           全量 20 任务 (真 LLM, 有成本)
//   node scripts/taskbench.js --baseline       结果写入 bench/baseline.json (作回归基线)
//   node scripts/taskbench.js --allow-fail     报告模式: 有失败也恒退出 0
//   node scripts/taskbench.js --min-pass 2     通过数 ≥N 即退出 0 (N 非有限数或 <0 → 报错退出 2)
// 退出码: 默认有未通过任务 → 1 (CI 闸门判失败), --allow-fail / --min-pass 显式豁免。
// 指标: 任务成功率 / 每任务 token / 耗时; 沙箱隔离, 不污染仓库。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { withTimeout } from "../src/utils/async.js";
import { isTransientError } from "../src/llm/retry.js";
import { TASKS, summarize } from "../bench/tasks.js";
import { triageFailure, summarizeCauses } from "../src/services/triage.js";

export const TASK_BUDGET_MS = 90000; // 单任务时限: LLM 卡死/平台抽风不让一个任务拖垮整场评测

// ---- 超时预算关系 (2026-10-05 修复 llm_stall 预算倒挂) ----
// 事故复盘 (rename-symbol, 90s 里只烧了 8459 tok): LLMClient 兜底单次超时 120s ×
// (retry_max 3+1) 最坏 480s, 而任务预算只有 90s —— 第一次尝试就超预算, 瞬态重试
// 永远够不着, harness 每次都用输掉整个任务来替一次悬挂调用买单。这正是
// src/services/triage.js「单次 LLM 超时必须小于任务级时限」处方早就写下的规则,
// 但此前只落在纸面上, 两处数字 (client.js 的 120000 与本文件的 TASK_BUDGET_MS)
// 各写各的、无人挂钩 —— 漂移本身就是这个 bug。
//
// 为什么改基准侧、不动全局默认 (client.js / DEFAULT_CONFIG 的 timeout_ms、retry_max):
// 深推理请求 (>60s) 是真实使用场景, 为迁就 90s 基准而调低进程级默认会伤害真实
// 用法 —— 该适应基准的是基准自己, 不是全进程。
//
// 数字全部由 TASK_BUDGET_MS 推导, 不许出现第二份可漂移的硬编码常量:
//   单次调用超时 timeoutMs = 预算/3 (90s → 30s; 下限 1s 防抖穿, 上限 预算/2 保重试空间)
//   重试次数 retryMax = floor(预算/timeoutMs) - 2 (90s → 1 次重试)
//   不变量: (1+retryMax)×timeoutMs ≤ 预算 - timeoutMs —— 最坏 (1+retryMax) 次慢调用
//   烧掉 2/3 预算后, 仍留 ≥1 个 timeoutMs 的窗口给工具轮次与终答; 悬挂只烧一次
//   慢调用 (重试后最多 2/3), 不再吃掉整个任务。
export function benchLlmGuard(budgetMs = TASK_BUDGET_MS) {
  const timeoutMs = Math.min(Math.max(1000, Math.floor(budgetMs / 3)), Math.max(1, Math.floor(budgetMs / 2)));
  const retryMax = Math.max(0, Math.floor(budgetMs / timeoutMs) - 2);
  return { timeoutMs, retryMax };
}

// bench 语境下的可重试错误: 瞬态 HTTP (429/5xx/网络) + 单次调用超时
// (AbortError / withTimeout 的「超时」)。v1.0.9 起 client 内部 withRetry 不重试
// AbortError (防用户主动取消后仍退避重试) —— 基准跑法是无人取消的 headless 进程,
// 这里的 AbortError 只可能来自超时, 重试是安全的, 这正是修复要打通的路径。
const benchRetryable = (e) =>
  e?.name === "AbortError" || e?.code === "ABORT_ERR" ||
  isTransientError(e) || /超时|timeout/i.test(String(e?.message || e));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(ROOT, "bench", "baseline.json");

const args = process.argv.slice(2);
const getArg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const hasFlag = (k) => args.includes(k);

// 前置校验: 非法 --min-pass 要在烧 API 配额前就退出 (对齐 ctx-profile.js 的坏参数退 2 约定)
const minPassRaw = getArg("--min-pass");
if (minPassRaw != null && (!Number.isFinite(Number(minPassRaw)) || Number(minPassRaw) < 0)) {
  console.error("✗ --min-pass 需要一个 ≥0 的数值");
  process.exit(2);
}

let tasks = TASKS;
if (getArg("--only")) {
  const ids = getArg("--only").split(",");
  tasks = TASKS.filter((t) => ids.includes(t.id));
} else if (!hasFlag("--full")) {
  tasks = TASKS.slice(0, Number(getArg("--limit") || 3));
}

// token 记账 + 超时预算护栏: 包装 agent 全部 provider 的 chat/apiChat (零侵入)
// guard = benchLlmGuard(budgetMs): 每次 LLM 调用按「预算/3」限时并可重试, 见文件头推导注释。
// 沿用 client.js 既有的「按调用覆盖」形状 (chat/apiChat 接受 timeoutMs/retryMax,
// 同 AUX_TIMEOUT_MS 辅助调用的用法), 不改任何进程级默认。
function makeTokenCounter(agent, guard) {
  const counter = { tokens: 0, calls: 0 };
  // 包装所有 provider 实例 (ReAct 经 _llmWithFallback→_llmWithTools→client.chat,
  // 只包 agent.llm 会漏计 fallback 链上的其他 provider)
  const clients = new Set([...(agent.allProviders || []), agent.llm].filter(Boolean));
  for (const c of clients) {
    if (c.__benchWrapped) continue;
    c.__benchWrapped = true;
    // 工具循环走 apiChat (src/core/policy.js), 纯对话走 chat —— 两者都计数 + 上护栏
    for (const meth of ["apiChat", "chat"]) {
      if (typeof c[meth] !== "function") continue;
      const orig = c[meth].bind(c);
      c[meth] = async (msgs, opts) => {
        counter.calls++;
        // 单次超时取「调用方显式值」与 bench 护栏的较小者: 辅助调用传更短的
        // AUX_TIMEOUT_MS 快速失败约定, 护栏只封上界, 不放宽也不越权缩短。
        const callerTmo = Number(opts?.timeoutMs);
        const tmo = Math.min(Number.isFinite(callerTmo) && callerTmo > 0 ? callerTmo : Infinity, guard.timeoutMs);
        // 调用方显式 retryMax:0 = 要求快速失败降级 (辅助调用约定), bench 不加试不吞;
        // 其余情况重试统一收口在本层: client 内部重试 (退避×超时) 与外层叠加会让
        // 预算算术不闭合, 故底层传 retryMax:0, 由下面这个受 budget 约束的循环负责重试。
        const retries = Number(opts?.retryMax) === 0 ? 0 : guard.retryMax;
        const callOpts = { ...(opts || {}), timeoutMs: tmo, retryMax: 0 };
        let lastErr = null;
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            // 双保险: 底层 client 的 AbortController 也按 tmo 中止 (真 HTTP 挂起时断流);
            // 这层 withTimeout 兜住一切「不守约的 client/桩」, 悬挂调用在此被放弃并计时。
            const r = await withTimeout(orig(msgs, callOpts), tmo, `LLM 调用 (第${attempt + 1}/${retries + 1}次)`);
            const u = r?.usage ?? r; // apiChat 可能直接返回文本, 有 usage 才计
            counter.tokens += (u?.total_tokens ?? (u?.prompt_tokens || 0) + (u?.completion_tokens || 0)) || 0;
            return r;
          } catch (e) {
            lastErr = e;
            // 非瞬态错误 (400/401/403) 立即上抛, 交给 _llmWithFallback 切下一个 provider
            if (attempt >= retries || !benchRetryable(e)) throw e;
          }
        }
        throw lastErr;
      };
    }
  }
  return counter;
}

export async function runOne(taskDef, { quiet = false, budgetMs = TASK_BUDGET_MS, createAgent = null } = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-bench-"));
  taskDef.setup?.(sandbox);
  // createAgent 仅供离线测试注入桩 LLM (零 API 配额验证超时护栏); 正式跑法走真实配置。
  const agent = createAgent ? createAgent(sandbox) : new PPXAgent({
    root: sandbox,
    configFile: path.join(ROOT, "config", "ppx.json"), // 复用仓库 Key 配置, 沙箱内干活
    dataDir: path.join(sandbox, ".ppx"),
    globalDataDir: path.join(sandbox, ".ppx-global"),
  });
  const counter = makeTokenCounter(agent, benchLlmGuard(budgetMs));
  // 轨迹采集 (2026-10-03, 增强框架第 1 条): 归因需要"怎么失败的", 不只是"失败了"。
  // 从 setToolEvent 收集工具调用序列 —— 这是 llm_stall / loop / tool_use 三类根的判据来源。
  const toolCalls = [];
  const inflight = new Map();
  if (typeof agent.setToolEvent === "function") {
    agent.setToolEvent((ev) => {
      try {
        if (ev.type === "start") inflight.set(ev.id, { tool: ev.tool, args: ev.args });
        else if (ev.type === "done") {
          const st = inflight.get(ev.id) || {};
          toolCalls.push({
            tool: ev.tool || st.tool,
            args: st.args,
            ok: ev.ok !== false,
            durationMs: ev.durationMs,
            error: ev.ok === false ? String(ev.result || "").slice(0, 120) : null,
          });
          inflight.delete(ev.id);
        }
      } catch { /* 轨迹采集不影响评测 */ }
    });
  }
  const t0 = Date.now();
  let reply = "";
  try {
    // 单任务护栏: LLM 卡死/平台抽风不让一个任务拖垮整场评测。
    // 单次 LLM 调用另有更小的护栏 (benchLlmGuard: 预算/3 + 重试), 悬挂在这里
    // 只应作为「重试也烧完」的最后手段出现, 而不是第一选择。
    reply = String(await withTimeout(agent.chat(taskDef.task), budgetMs, `任务 ${taskDef.id} 超时`) ?? "");
  } catch (e) {
    reply = `[异常] ${e.message}`;
  }
  const ms = Date.now() - t0;
  let verdict;
  try {
    verdict = taskDef.verify({ reply, tokens: counter.tokens, ms }, { sandbox });
  } catch (e) {
    verdict = { pass: false, detail: `判分异常: ${e.message}` };
  }
  // 失败归因 (确定性, 零 LLM): 把"为什么失败"从人工看日志变成结构化结论
  let triage = null;
  if (!verdict.pass) {
    try {
      triage = triageFailure({
        reply,
        toolCalls,
        ms,
        budgetMs,
        maxRounds: Number(agent.config?.agent?.max_tool_rounds) || 8,
        detail: verdict.detail,
      });
    } catch { /* 归因失败不影响评测结果 */ }
  }
  agent.shutdown();
  fs.rmSync(sandbox, { recursive: true, force: true });
  if (!quiet) {
    console.log(`${verdict.pass ? "✓" : "✗"} ${taskDef.id} (${Math.round(ms / 100) / 10}s, ${counter.tokens} tok)${verdict.pass ? "" : " ← " + verdict.detail}`);
    if (triage) console.log(`    ↳ 归因[${triage.cause}] ${(triage.confidence * 100) | 0}% — ${triage.evidence.join(" / ")}`);
  }
  return {
    id: taskDef.id,
    category: taskDef.category,
    pass: !!verdict.pass,
    detail: verdict.detail,
    reply,
    tokens: counter.tokens,
    ms,
    trace: {
      calls: toolCalls.length,
      errors: toolCalls.filter((c) => !c.ok).length,
      sequence: toolCalls.map((c) => c.tool),
    },
    triage: triage ? { cause: triage.cause, confidence: triage.confidence, evidence: triage.evidence, action: triage.action } : null,
  };
}

export async function runAll(list, opts = {}) {
  const results = [];
  for (const t of list) {
    try {
      results.push(await runOne(t, opts));
    } catch (e) {
      results.push({ id: t.id, category: t.category, pass: false, detail: `运行器异常: ${e.message}`, tokens: 0, ms: 0 });
      if (!opts.quiet) console.log(`✗ ${t.id} (运行器异常: ${e.message})`);
    }
  }
  return results;
}

// 直跑才开评 (2026-10-05): 本文件顶部原先是无条件 IIFE —— import 即烧真 LLM 配额,
// 超时护栏无法离线测试。参照 scripts/mcp-smoke.js / memory-benchmark.js 的 main()
// 惯例把运行器收进 main(), 仅在 `node scripts/taskbench.js ...` 直跑时执行;
// runOne/runAll/benchLlmGuard 供 test/taskbench-timeout-guard.test.js 注入桩 LLM 验证。
async function main() {
  if (tasks.length === 0) { console.error("没有匹配的任务"); process.exit(1); }
  console.log(`→ 任务级评测: ${tasks.length} 个任务 (真 LLM, 沙箱隔离)\n`);
  const t0 = Date.now();
  const results = await runAll(tasks);
  const s = summarize(results);
  console.log(`\n===== 汇总 (${Math.round((Date.now() - t0) / 1000)}s) =====`);
  console.log(`成功率: ${s.pass}/${s.total} = ${(s.passRate * 100).toFixed(1)}%`);
  console.log(`token 总耗: ${s.totalTokens} | 平均耗时: ${s.avgMs}ms/任务`);
  if (s.costEfficiency != null) console.log(`单位成本成功率: ${s.costEfficiency} 通过任务/10万tok`);

  // 失败归因 (框架第 1 条「对失败归因」): 给出根因分布 + 主因处方, 让"下一步改什么"不靠猜
  const causes = summarizeCauses(results.map((r) => r.triage).filter(Boolean));
  if (causes.total) {
    console.log(`\n----- 失败归因 (${causes.total} 项) -----`);
    for (const [c, n] of Object.entries(causes.byCause).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${c.padEnd(16)} × ${n}`);
    }
    console.log(`  主因处方: ${causes.dominantAction}`);
  }
  for (const [cat, v] of Object.entries(s.byCategory)) {
    console.log(`  ${cat}: ${v.pass}/${v.total} (${v.tokens} tok)`);
  }
  if (s.failures.length) {
    console.log(`\n失败明细:`);
    for (const f of s.failures) console.log(`  ✗ ${f.id}: ${f.detail} | 回复片段: ${f.reply.slice(0, 80)}`);
  }
  if (getArg("--out") || hasFlag("--baseline")) {
    const raw = results.map(({ reply, ...r }) => r);
    const outFile = getArg("--out");
    if (outFile) {
      fs.writeFileSync(outFile, JSON.stringify({ date: new Date().toISOString(), summary: s, results: raw }, null, 2));
      console.log(`\n→ 原始结果已写入 ${outFile}`);
    }
  }
  if (hasFlag("--baseline")) {
    // 增量合并: 已有基线时按 id 替换/追加 (平台不稳定时可分批跑, 进度不丢)
    let prev = { results: [] };
    try { prev = JSON.parse(fs.readFileSync(BASELINE, "utf8")); } catch {}
    const map = new Map(prev.results.map((r) => [r.id, r]));
    for (const r of results.map(({ reply, ...r }) => r)) map.set(r.id, r);
    const merged = [...map.values()];
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify({ date: new Date().toISOString(), coverage: `${map.size}/${TASKS.length}`, results: merged }, null, 2));
    console.log(`\n→ 基线已合并写入 bench/baseline.json (覆盖 ${map.size}/${TASKS.length} 任务)`);
  }
  // 失败案例库联动 ("想记做学评"闭环: 评估失败 → 写入经验库 → 学习服务检索复用)
  if (hasFlag("--learn")) {
    const { FailureEpisodeStore } = await import("../src/memory/failure-episode.js");
    const store = new FailureEpisodeStore(path.join(ROOT, "data"));
    const failures = results.filter((r) => !r.pass);
    for (const f of failures) {
      store.record({
        tool: `taskbench:${f.id}`,
        error: f.detail || "任务判分失败",
        category: "unknown",
        rootCause: `基准任务失败 (分类: ${f.category}); 回复片段: ${String(f.reply || "").slice(0, 120)}`,
        confidence: 0.5,
      });
    }
    console.log(`→ ${failures.length} 个失败已写入失败案例库 (data/failure-episodes), 供学习循环反思`);
  }
  // CI 闸门需要真实退出码, 不能恒 0
  const gateFail = !hasFlag("--allow-fail") &&
    (minPassRaw != null ? s.pass < Number(minPassRaw) : s.pass < s.total);
  if (gateFail) console.log(`→ CI 闸门: ${s.pass}/${s.total} 通过，判失败 (可用 --allow-fail 或 --min-pass 显式豁免)`);
  process.exit(gateFail ? 1 : 0);
}

// 判断"是否被直接运行" (node scripts/taskbench.js / CI 冒烟): 被 import 时不触发评测,
// 超时护栏才能零配额离线验证 (test/taskbench-timeout-guard.test.js 注入桩 LLM)。
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const a = path.resolve(entry);
  const b = fileURLToPath(import.meta.url);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
})();

if (invokedDirectly) main();
