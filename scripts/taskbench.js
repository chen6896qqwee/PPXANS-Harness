// scripts/taskbench.js - 任务级评测基准运行器 + 公开口径报告 (2026-10-02, v2 补 2026-10-09)
// 用法:
//   node scripts/taskbench.js --limit 3        快速冒烟 (前 3 个任务)
//   node scripts/taskbench.js --only fix-logic,create-file
//   node scripts/taskbench.js --full           全量 20 任务 (真 LLM, 有成本)
//   node scripts/taskbench.js --baseline       结果写入 bench/baseline.json (作回归基线)
// 指标: 任务成功率 / 每任务 token / 耗时; 沙箱隔离, 不污染仓库。
//
// 2026-10-09 v2 补全 (本轮): 本文件此前只导出 runOne/runAll, 而 4 个测试文件
// (taskbench-report / taskbench-timeout-guard / trajectory-score / majority-verdict)
// 依赖的公开面一直缺失。本轮补齐并**保持纯函数可离线验证**:
//   - TASK_BUDGET_MS / benchLlmGuard   : 单次 LLM 超时护栏 (预算/3 + 重试封顶, 防预算倒挂)
//   - scoreTrajectory / TASK_PLANS     : GPA 过程级指标 (计划遵循/错误率/冗余) + 20 任务 oracle 计划表
//   - majorityVerdict                  : 多数投票判定 (平局保守判负)
//   - buildReport                      : 公开口径报告 (schema v2; 模型自由文本绝不外泄)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { withTimeout } from "../src/utils/async.js";
import { triageFailure } from "../src/services/triage.js";
import { TASKS, summarize } from "../bench/tasks.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(ROOT, "bench", "baseline.json");

/* ==================== 预算与单次调用护栏 ==================== */

// 单任务墙钟预算。所有护栏数字都由它推导, 关系不许各自硬编码漂移。
export const TASK_BUDGET_MS = 90000;

/**
 * 由任务预算推导「单次 LLM 调用」护栏。
 * 背景: 真跑 rename-symbol 曾因预算倒挂挂死 —— 底层兜底单次超时 120s > 任务预算 90s,
 * 重试永远够不着, 一次悬挂就输掉整个任务。
 * 不变量: (1 + retryMax) × timeoutMs ≤ budgetMs − timeoutMs
 *   → 最坏情况烧完重试后, 仍给工具轮次/终答留 ≥1 个完整超时窗口。
 * retryMax 收口在 bench 层 (底层传 retryMax: 0), 否则两层重试叠加会让算术不闭合。
 * @param {number} budgetMs 任务预算
 * @returns {{timeoutMs:number, retryMax:number}}
 */
export function benchLlmGuard(budgetMs = TASK_BUDGET_MS) {
  const timeoutMs = Math.floor(budgetMs / 3);
  return { timeoutMs, retryMax: 1 };
}

// 把护栏装到 agent 的所有 LLM 客户端上 (按调用覆盖, 不动全局默认)。
// 形状对齐 LLMClient 既有的 per-call 覆盖约定 (同 AUX_TIMEOUT_MS): opts.timeoutMs / opts.retryMax。
// 基准 agent 统一审批策略 (2026-10-09): 基准跑在无人环境 (没有审批面), 权限引擎判 ask 时必须
//   自动放行 —— 否则 delete-file 这类题永远卡在"等待审批"直至超时, 判负含义失真。
//   **两条 agent 构造路径都要注入**: 内置构造 与 调用方注入的 createAgent 产物。
//   只在一条注入 = 桩注入路径下所有题恒判负, 基准结果不可比。
function installApprovalPolicy(agent) {
  try {
    if (!agent) return;
    agent.config = agent.config || {};
    agent.config.agent = agent.config.agent || {};
    agent.config.agent.approval_headless = "auto-approve";
  } catch { /* 配置不可写则跳过, 不阻断基准 */ }
}

function installLlmGuard(agent, guard) {  const clients = new Set([...(agent.allProviders || []), agent.llm].filter(Boolean));
  for (const c of clients) {
    if (typeof c.apiChat !== "function" || c.__benchGuarded) continue;
    c.__benchGuarded = true;
    const orig = c.apiChat.bind(c);
    c.apiChat = async (msgs, opts) => {
      let lastErr = null;
      // 1 + retryMax 次尝试: 每次都在单次超时处放弃, 而不是等任务级护栏
      for (let attempt = 0; attempt <= guard.retryMax; attempt++) {
        try {
          return await withTimeout(
            orig(msgs, { ...(opts || {}), timeoutMs: guard.timeoutMs, retryMax: 0 }),
            guard.timeoutMs,
            "LLM 单次调用",
          );
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error("LLM 单次调用失败");
    };
  }
}

/* ==================== GPA 过程级指标 ==================== */

// 20 个基准任务各自的 oracle 工具计划 (计划遵循度的判据)。
// 只声明「这件事必须用到」的工具, 不追求穷举 —— 漏调即判不遵循。
export const TASK_PLANS = {
  "version-report": ["read_file"],
  "count-files": ["list_dir"],
  "find-symbol": ["grep"],
  "sum-numbers": ["read_file"],
  "read-secret": ["read_file"],
  "create-file": ["write_file"],
  "append-file": ["append_file"],
  "json-edit": ["read_file", "write_file"],
  "delete-file": ["delete_file"],
  "json-create": ["write_file"],
  "fix-syntax": ["read_file", "apply_patch", "run_command"],
  "fix-logic": ["read_file", "apply_patch"],
  "write-function": ["write_file"],
  "rename-symbol": ["read_file", "apply_patch"],
  "memory-roundtrip": ["memory_add"],
  "board-roundtrip": ["board_publish", "board_query"],
  "analyze-and-report": ["read_file", "write_file"],
  "conditional-write": ["read_file", "write_file"],
  "src-listing": ["list_dir", "write_file"],
  "extract-field": ["read_file"],
};

const round3 = (x) => Math.round(x * 1000) / 1000;
function sigOf(call) {
  try {
    return `${call?.tool}::${JSON.stringify(call?.args || {}).slice(0, 200)}`;
  } catch {
    return String(call?.tool);
  }
}

/**
 * 轨迹评分 (GPA 过程级指标, 纯确定性, 零配额可测)。
 * @param {Array<{tool:string,args?:object,ok?:boolean}>} calls
 * @param {{plan?:string[]|null}} [opts]
 * @returns {{totalCalls:number, failedCalls:number, toolErrorRate:number|null,
 *            redundancy:number|null, uniqueTools:number, planFollowed:boolean|null}}
 */
export function scoreTrajectory(calls = [], { plan = null } = {}) {
  const list = Array.isArray(calls) ? calls.filter(Boolean) : [];
  const totalCalls = list.length;
  const failedCalls = list.filter((c) => c.ok === false).length;

  // 冗余: 完全相同的 tool+args 重复调用 (不同参数不算冗余)
  const seen = new Set();
  let dup = 0;
  for (const c of list) {
    const k = sigOf(c);
    if (seen.has(k)) dup++;
    else seen.add(k);
  }

  let planFollowed = null;
  if (Array.isArray(plan) && plan.length) {
    const called = new Set(list.map((c) => c && c.tool).filter(Boolean));
    planFollowed = plan.every((t) => called.has(t));
  }

  return {
    totalCalls,
    failedCalls,
    // 空轨迹的指标是 null 而不是 NaN —— 不硬造数字
    toolErrorRate: totalCalls ? round3(failedCalls / totalCalls) : null,
    redundancy: totalCalls ? round3(dup / totalCalls) : null,
    uniqueTools: new Set(list.map((c) => c && c.tool).filter(Boolean)).size,
    planFollowed,
  };
}

/* ==================== 多数投票 ==================== */

/**
 * 多数投票判定 (吸收单次方差)。
 * 规则: 严格多数才算过; 平局保守判负。passRate 作为元数据保留可观测性。
 * @param {boolean[]} votes
 * @returns {{pass:boolean, passRate:number, votes:number, yes:number}}
 */
export function majorityVerdict(votes = []) {
  const list = Array.isArray(votes) ? votes : [];
  const yes = list.filter(Boolean).length;
  const n = list.length;
  return {
    pass: n > 0 && yes * 2 > n,
    // 精确比值, 不做四舍五入 —— 单次方差元数据要保留原始精度
    passRate: n ? yes / n : 0,
    votes: n,
    yes,
  };
}

/* ==================== 公开口径报告 ==================== */

/**
 * 生成对外可发布的评测报告 (schema v2)。
 * 硬约束: 模型自由文本 (reply) 与失败明细一律不进公开口径 —— 只留可复核的判分事实。
 * @param {object} summary   runAll 的汇总 (pass/total/passRate/totalTokens/avgMs/costEfficiency)
 * @param {Array}  results   逐任务结果 [{id,category,pass,tokens,ms,triage,score}]
 * @param {object} [meta]    {version, gitCommit, totalTasks}
 */
export function buildReport(summary = {}, results = [], meta = {}) {
  const rows = Array.isArray(results) ? results : [];

  // GPA 聚合: 只统计带 score 的任务; planFollowed 为 null 的(未声明计划)不计入遵循率分母
  const scored = rows.filter((r) => r && r.score);
  const planned = scored.filter((r) => r.score.planFollowed !== null && r.score.planFollowed !== undefined);
  const mean = (pick) => (scored.length ? round3(scored.reduce((s, r) => s + (Number(pick(r)) || 0), 0) / scored.length) : null);
  const gpa = {
    plannedTasks: planned.length,
    planFollowedRate: planned.length
      ? round3(planned.filter((r) => r.score.planFollowed === true).length / planned.length)
      : null,
    toolErrorRate: mean((r) => r.score.toolErrorRate),
    redundancy: mean((r) => r.score.redundancy),
  };

  const totalTasks = Number.isFinite(meta.totalTasks) ? meta.totalTasks : rows.length;

  return {
    report_schema: 2, // v2 (2026-10-09): summary.gpa + 逐任务 score
    suite: "taskbench",
    generated_at: new Date().toISOString(),
    coverage: `${rows.length}/${totalTasks}`,
    env: {
      version: meta.version ?? null,
      git_commit: meta.gitCommit ?? null,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
    },
    summary: {
      total: summary.total ?? rows.length,
      pass: summary.pass ?? null,
      // 公开口径的比率保留 1 位小数 (0.6667 → 66.7)
      passRate: summary.passRate != null ? Math.round(summary.passRate * 1000) / 10 : null,
      totalTokens: summary.totalTokens ?? null,
      avgMs: summary.avgMs ?? null,
      costEfficiency: summary.costEfficiency ?? null,
      gpa,
    },
    // 只保留判分事实: 无 reply / 无 detail / 无 failures
    results: rows.map((r) => ({
      id: r.id,
      category: r.category ?? null,
      pass: !!r.pass, // 严格布尔化, truthy 非布尔不外漏
      tokens: r.tokens ?? null,
      ms: r.ms ?? null,
      cause: r.triage?.cause ?? null,
      score: r.score ?? null,
    })),
  };
}

/* ==================== 运行器 ==================== */

// token 记账: 包装 agent.llm.chat, 汇总 OpenAI 兼容 usage (零侵入)
function makeTokenCounter(agent) {
  const counter = { tokens: 0, calls: 0 };
  // 包装所有 provider 实例 (ReAct 经 _llmWithFallback→_llmWithTools→client.chat,
  // 只包 agent.llm 会漏计 fallback 链上的其他 provider)
  const clients = new Set([...(agent.allProviders || []), agent.llm].filter(Boolean));
  for (const c of clients) {
    if (c.__benchWrapped) continue;
    c.__benchWrapped = true;
    // 工具循环走 apiChat (src/core/policy.js), 纯对话走 chat —— 两者都计数
    for (const meth of ["apiChat", "chat"]) {
      if (typeof c[meth] !== "function") continue;
      const orig = c[meth].bind(c);
      c[meth] = async (msgs, opts) => {
        counter.calls++;
        const r = await orig(msgs, opts);
        const u = r?.usage ?? r; // apiChat 可能直接返回文本, 有 usage 才计
        counter.tokens += (u?.total_tokens ?? (u?.prompt_tokens || 0) + (u?.completion_tokens || 0)) || 0;
        return r;
      };
    }
  }
  return counter;
}

// 工具调用轨迹采集: 挂 agent 的工具完成钩子 (零侵入, 只读取上报参数)
function installTraceCollector(agent, sink) {
  if (typeof agent._emitToolDone !== "function") return;
  const orig = agent._emitToolDone.bind(agent);
  agent._emitToolDone = (callId, name, args, ok, durationMs, result) => {
    try { sink.push({ tool: name, args, ok: ok !== false, durationMs }); } catch {}
    return orig(callId, name, args, ok, durationMs, result);
  };
}

/**
 * 跑单个基准任务。
 * @param {object} taskDef   {id, category, task, setup?, verify}
 * @param {object} [opts]
 * @param {boolean} [opts.quiet]
 * @param {number}  [opts.budgetMs]     任务墙钟预算 (默认 TASK_BUDGET_MS)
 * @param {Function}[opts.createAgent]  自定义 agent 工厂 (sandbox) => agent, 测试注入桩用
 */
export async function runOne(taskDef, { quiet = false, budgetMs = TASK_BUDGET_MS, createAgent = null } = {}) {
  const guard = benchLlmGuard(budgetMs);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-bench-"));
  taskDef.setup?.(sandbox);
  const agent = typeof createAgent === "function"
    ? createAgent(sandbox)
    : new PPXAgent({
        root: sandbox,
        configFile: path.join(ROOT, "config", "ppx.json"), // 复用仓库 Key 配置, 沙箱内干活
        dataDir: path.join(sandbox, ".ppx"),
        globalDataDir: path.join(sandbox, ".ppx-global"),
      });
  installLlmGuard(agent, guard);
  installApprovalPolicy(agent);
  const counter = makeTokenCounter(agent);
  const toolCalls = [];
  installTraceCollector(agent, toolCalls);
  const t0 = Date.now();
  let reply = "";
  try {
    reply = String(await withTimeout(agent.chat(taskDef.task), budgetMs, `任务 ${taskDef.id} `) ?? "");
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
  const score = scoreTrajectory(toolCalls, { plan: TASK_PLANS[taskDef.id] || null });
  // 归因只在失败时算, 且必须带真实轨迹 —— 否则会把"没查就答"误判成别的原因
  const triage = verdict.pass
    ? null
    : triageFailure({ reply, toolCalls, ms, budgetMs, detail: verdict.detail });
  agent.shutdown();
  fs.rmSync(sandbox, { recursive: true, force: true });
  if (!quiet) {
    console.log(`${verdict.pass ? "✓" : "✗"} ${taskDef.id} (${Math.round(ms / 100) / 10}s, ${counter.tokens} tok)${verdict.pass ? "" : " ← " + verdict.detail}`);
    if (!verdict.pass && triage) console.log(`   归因: ${triage.cause} (${triage.confidence}) → ${triage.action}`);
  }
  return {
    id: taskDef.id, category: taskDef.category, pass: !!verdict.pass, detail: verdict.detail,
    reply, tokens: counter.tokens, ms, toolCalls, score, triage,
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

// 多数投票跑法: 同一任务跑 N 次取多数 (吸收计数类任务的单次方差)
export async function runWithMajority(taskDef, { runs = 3, ...opts } = {}) {
  const attempts = [];
  for (let i = 0; i < runs; i++) attempts.push(await runOne(taskDef, opts));
  const verdict = majorityVerdict(attempts.map((a) => a.pass));
  const first = attempts[0];
  return { ...first, pass: verdict.pass, vote: verdict, attempts: attempts.map((a) => ({ pass: a.pass, ms: a.ms })) };
}

/* ==================== CLI (仅在作为主模块运行时执行) ==================== */

async function main() {
  const args = process.argv.slice(2);
  const getArg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const hasFlag = (k) => args.includes(k);

  let tasks = TASKS;
  if (getArg("--only")) {
    const ids = getArg("--only").split(",");
    tasks = TASKS.filter((t) => ids.includes(t.id));
  } else if (!hasFlag("--full")) {
    tasks = TASKS.slice(0, Number(getArg("--limit") || 3));
  }
  if (tasks.length === 0) { console.error("没有匹配的任务"); process.exit(1); }

  console.log(`→ 任务级评测: ${tasks.length} 个任务 (真 LLM, 沙箱隔离)\n`);
  const t0 = Date.now();
  const results = await runAll(tasks);
  const s = summarize(results);
  console.log(`\n===== 汇总 (${Math.round((Date.now() - t0) / 1000)}s) =====`);
  console.log(`成功率: ${s.pass}/${s.total} = ${(s.passRate * 100).toFixed(1)}%`);
  console.log(`token 总耗: ${s.totalTokens} | 平均耗时: ${s.avgMs}ms/任务`);
  if (s.costEfficiency != null) console.log(`单位成本成功率: ${s.costEfficiency} 通过任务/10万tok`);
  for (const [cat, v] of Object.entries(s.byCategory)) {
    console.log(`  ${cat}: ${v.pass}/${v.total} (${v.tokens} tok)`);
  }
  if (s.failures.length) {
    console.log(`\n失败明细:`);
    for (const f of s.failures) console.log(`  ✗ ${f.id}: ${f.detail} | 回复片段: ${f.reply.slice(0, 80)}`);
  }

  // 公开口径报告 (本地放明细, 对外只放判分事实)
  const report = buildReport(s, results, {
    version: (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version; } catch { return null; } })(),
    gitCommit: (() => { try { return fs.readFileSync(path.join(ROOT, ".git", "HEAD"), "utf8").trim().slice(0, 7); } catch { return null; } })(),
    totalTasks: TASKS.length,
  });
  const reportPath = getArg("--report") || path.join(ROOT, "bench", "report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n→ 公开口径报告 (schema v${report.report_schema}) 已写入 ${reportPath} (覆盖 ${report.coverage})`);

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
        rootCause: `基准任务失败 (分类: ${f.category}); 归因: ${f.triage?.cause || "unknown"}; 回复片段: ${String(f.reply || "").slice(0, 120)}`,
        confidence: f.triage?.confidence ?? 0.5,
      });
    }
    console.log(`→ ${failures.length} 个失败已写入失败案例库 (data/failure-episodes), 供学习循环反思`);
  }
  process.exit(0);
}

// 仅当被直接执行时才跑 CLI —— 测试会 import 本模块取纯函数, 不能顺手把 20 个真任务跑掉。
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) main();
