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
import { TASKS, summarize, VERIFIER_VERSION } from "../bench/tasks.js";
import { estimateCost, usageTokens } from "../src/llm/pricing.js";
import { TOOL_ERROR_PREFIX } from "../src/tools/catalog.js";
import { toolResultStatus, toolResultContent } from "../src/core/tool-result.js";

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
  const mean = (pick) => {
    const values = scored.map(pick).filter((v) => typeof v === "number" && Number.isFinite(v));
    return values.length ? round3(values.reduce((s, v) => s + v, 0) / values.length) : null;
  };
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
    verifier_version: VERIFIER_VERSION,
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
      knownTokens: summary.knownTokens ?? null,
      totalCostUsd: summary.totalCostUsd ?? null,
      knownCostUsd: summary.knownCostUsd ?? null,
      tokensPerSuccess: summary.tokensPerSuccess ?? null,
      costUsdPerSuccess: summary.costUsdPerSuccess ?? null,
      usageCoverage: summary.usageCoverage ?? null,
      costCoverage: summary.costCoverage ?? null,
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
      costUsd: r.costUsd ?? null,
      usageKnownCalls: r.usageKnownCalls ?? null,
      usageUnknownCalls: r.usageUnknownCalls ?? null,
      costUnknownCalls: r.costUnknownCalls ?? null,
      vote: r.vote ?? null,
      selectedAttempt: r.selectedAttempt ?? null,
      // Repeat accounting is public, but replies/arguments/results remain private.
      attempts: r.attempts?.map((a) => ({ pass: a.pass, tokens: a.tokens, knownTokens: a.knownTokens, ms: a.ms, costUsd: a.costUsd, usageUnknownCalls: a.usageUnknownCalls, costUnknownCalls: a.costUnknownCalls })) ?? null,
    })),
  };
}

/* ==================== 运行器 ==================== */

// token 记账: 包装 agent.llm.chat, 汇总 OpenAI 兼容 usage (零侵入)
function makeTokenCounter(agent) {
  const counter = { tokens: 0, knownTokens: 0, calls: 0, usageKnownCalls: 0, usageUnknownCalls: 0, costUnknownCalls: 0, knownCostUsd: 0, costUsd: 0 };
  const account = (client, usage, model) => {
    const tokens = usageTokens(usage);
    const cost = estimateCost(model || client.model, usage, agent.config?.budget?.model_prices);
    if (tokens === null) counter.usageUnknownCalls++;
    else { counter.knownTokens += tokens; counter.usageKnownCalls++; }
    if (cost === null) counter.costUnknownCalls++;
    else counter.knownCostUsd += cost;
    counter.tokens = counter.usageUnknownCalls ? null : counter.knownTokens;
    counter.costUsd = counter.costUnknownCalls ? null : counter.knownCostUsd;
  };
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
        try {
          const r = await orig(msgs, opts);
          account(c, r?.usage, r?.model);
          return r;
        } catch (e) {
          account(c, e?.usage, e?.model);
          throw e;
        }
      };
    }
    if (typeof c.streamChat === "function") {
      const orig = c.streamChat.bind(c);
      c.streamChat = async (msgs, opts = {}) => {
        counter.calls++;
        let accounted = false;
        try {
          return await orig(msgs, { ...opts, onUsage: (usage, meta) => {
            if (!accounted) { account(c, usage, meta?.model); accounted = true; }
            opts.onUsage?.(usage, meta);
          } });
        } finally { if (!accounted) account(c, null); }
      };
    }
  }
  return counter;
}

// 工具调用轨迹采集: 挂 agent 的工具完成钩子 (零侵入, 只读取上报参数)
function installTraceCollector(agent, sink) {
  let receiptSeq = 0;
  // Catalog calls also cover local-intent paths that bypass _runTool. An
  // executed receipt must originate here, not from a final-text claim.
  if (typeof agent.tools?.call === "function") {
    const origCall = agent.tools.call.bind(agent.tools);
    agent.tools.call = async (name, args, ctx = {}) => {
      const callId = `bench-${++receiptSeq}`;
      const t0 = Date.now();
      try {
        let status = null;
        const result = await origCall(name, args, { ...ctx, onOutcome: (outcome) => {
          status = outcome;
          ctx.onOutcome?.(outcome);
        } });
        // Typed provider status is authoritative. Successful read_file content
        // may itself be JSON containing error/ok fields; never interpret that
        // data as a second status protocol.
        status ||= name === "read_file" && typeof result === "string"
          ? { ok: !result.startsWith(TOOL_ERROR_PREFIX), error: null }
          : toolResultStatus(result);
        const ok = status.ok === true;
        sink.push({ callId, tool: name, args, ok, status, durationMs: Date.now() - t0, result: String(toolResultContent(result) ?? ""), error: ok ? null : (status.error || String(toolResultContent(result) ?? "")), receipt: true });
        return result;
      } catch (e) {
        sink.push({ callId, tool: name, args, ok: false, durationMs: Date.now() - t0, result: null, error: String(e?.message || e), receipt: true });
        throw e;
      }
    };
  }
  if (typeof agent._emitToolDone !== "function") return;
  const orig = agent._emitToolDone.bind(agent);
  agent._emitToolDone = (callId, name, args, ok, durationMs, result) => {
    try {
      const receipt = sink.findLast((call) => call.tool === name && call.args === args && !call.agentCallId);
      if (receipt) {
        receipt.agentCallId = callId;
        // A failed agent-level outcome may further restrict, never upgrade,
        // the provider's recorded status.
        if (ok !== true) { receipt.ok = false; receipt.error ||= String(result ?? ""); }
      }
      else sink.push({ callId, tool: name, args, ok: ok === true, durationMs, result: String(result ?? ""), error: ok === true ? null : String(result ?? ""), receipt: false });
    } catch {}
    return orig(callId, name, args, ok, durationMs, result);
  };
}

const EXEC_TOOLS = ["run_command", "code_act"];
const READ_TARGETS = { "version-report": "package.json", "sum-numbers": "numbers.txt", "read-secret": "config.ini", "extract-field": "users.json" };
const WRITE_TARGETS = { "create-file": "notes/todo.txt", "append-file": "log.txt", "json-edit": "config.json", "delete-file": "obsolete.txt", "json-create": "person.json", "fix-syntax": "broken.js", "fix-logic": "calc.js", "write-function": "utils.js", "rename-symbol": "rename-me.js", "analyze-and-report": "report.txt", "conditional-write": "enabled.txt", "src-listing": "lib-list.txt" };
function targetMatches(call, target, sandbox) {
  if (typeof call.args?.path !== "string") return false;
  const normalize = (p) => process.platform === "win32" ? p.toLowerCase() : p;
  return normalize(path.resolve(sandbox, call.args.path)) === normalize(path.resolve(sandbox, target));
}
function receiptText(call) {
  const text = String(call.result ?? "").replace(/\r\n/g, "\n");
  // Execute tools render an out-of-band status header before stdout. Remove
  // only that documented header, not arbitrary file contents or JSON fields.
  return (EXEC_TOOLS.includes(call.tool) ? text.replace(/^\[exit=[^\n]*\]\n/, "") : text).trim();
}
function observedSource(call, target, ctx) {
  if (call.tool !== "read_file" && !EXEC_TOOLS.includes(call.tool)) return false;
  if (call.tool === "read_file" && !targetMatches(call, target, ctx.sandbox)) return false;
  try {
    const source = ctx.sourceContents?.[target] ?? fs.readFileSync(path.join(ctx.sandbox, target), "utf8");
    return receiptText(call) === String(source).replace(/\r\n/g, "\n").trim();
  } catch { return false; }
}
function observedItems(call, ctx) {
  if (call.tool !== "list_dir" && !EXEC_TOOLS.includes(call.tool)) return false;
  if (call.tool === "list_dir" && !targetMatches(call, "items", ctx.sandbox)) return false;
  try {
    const expected = ctx.sourceItems ?? fs.readdirSync(path.join(ctx.sandbox, "items")).sort();
    const actual = receiptText(call).split("\n").map((line) => path.posix.basename(line.replace(/^\[F\] /, "").trim().replace(/\\/g, "/"))).sort();
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch { return false; }
}

// Objective artifacts and actual execution evidence are separate checks. The
// offline oracle evaluates artifact validity; runOne additionally requires the
// receipt. An equivalent command/patch strategy may produce the same artifact.
export function verifyTaskCompletion(taskDef, result, ctx) {
  const artifact = taskDef.verify(result, ctx);
  if (!artifact?.pass || result.executionError) return result.executionError ? { pass: false, detail: result.executionError } : artifact;
  if (!TASKS.some((t) => t.id === taskDef.id)) return artifact;
  const calls = (result.toolCalls || []).filter((call) => call.receipt === true && call.ok === true);
  const executable = (call) => EXEC_TOOLS.includes(call.tool);
  let evidenced = false;
  if (READ_TARGETS[taskDef.id]) evidenced = calls.some((call) => observedSource(call, READ_TARGETS[taskDef.id], ctx));
  else if (WRITE_TARGETS[taskDef.id]) evidenced = calls.some((call) => executable(call) || call.tool === "apply_patch" || (["write_file", "append_file", "delete_file"].includes(call.tool) && targetMatches(call, WRITE_TARGETS[taskDef.id], ctx.sandbox)));
  else if (taskDef.id === "count-files") evidenced = calls.some((call) => observedItems(call, ctx));
  else if (taskDef.id === "find-symbol") evidenced = calls.some((call) => {
    if (observedSource(call, "pricing.js", ctx)) return true;
    // search_files lists names only, which cannot establish a symbol definition.
    // repo_map returns an actual code skeleton tying the symbol to its file.
    if (call.tool !== "repo_map") return false;
    try {
      const map = JSON.parse(String(call.result ?? ""));
      return typeof map.text === "string" && map.text.split(/\r?\n/).some((line) => /\bcalcDiscount\b/.test(line) && /\/\/ pricing\.js:\d+\s*$/.test(line));
    } catch { return false; }
  });
  else if (taskDef.id === "memory-roundtrip") evidenced = calls.some((call) => call.tool === "memory_add" && String(call.args?.content ?? "").includes("基准测试口令-蓝鲸99"));
  else if (taskDef.id === "board-roundtrip") {
    const published = calls.findIndex((call) => call.tool === "board_publish" && call.args?.content === "军团暗号-QW7");
    evidenced = published >= 0 && calls.some((call, index) => index > published && call.tool === "board_query" && String(call.result ?? "").includes("军团暗号-QW7"));
  }
  return evidenced ? artifact : { pass: false, detail: "产物/答案正确, 但缺少与任务匹配的真实成功执行回执" };
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
  // Freeze read-task sources before the agent runs, so changing a fixture and
  // reading the replacement cannot count as observing the original input.
  const sourceContents = {};
  const sourceTarget = READ_TARGETS[taskDef.id] || (taskDef.id === "find-symbol" ? "pricing.js" : null);
  if (sourceTarget) sourceContents[sourceTarget] = fs.readFileSync(path.join(sandbox, sourceTarget), "utf8");
  const sourceItems = taskDef.id === "count-files" ? fs.readdirSync(path.join(sandbox, "items")).sort() : null;
  const agent = typeof createAgent === "function"
    ? createAgent(sandbox)
    : new PPXAgent({
        root: sandbox,
        configFile: path.join(ROOT, "config", "ppx.json"), // 复用仓库 Key 配置, 沙箱内干活
        dataDir: path.join(sandbox, ".ppx"),
        globalDataDir: path.join(sandbox, ".ppx-global"),
      });
  installApprovalPolicy(agent);
  const counter = makeTokenCounter(agent);
  // Count every guarded retry, including failed/abandoned attempts.
  installLlmGuard(agent, guard);
  const toolCalls = [];
  installTraceCollector(agent, toolCalls);
  const t0 = Date.now();
  let reply = "";
  let executionError = null;
  try {
    reply = String(await withTimeout(agent.chat(taskDef.task), budgetMs, `任务 ${taskDef.id} `) ?? "");
  } catch (e) {
    reply = `[异常] ${e.message}`;
    executionError = `运行异常: ${e.message}`;
  }
  const ms = Date.now() - t0;
  let verdict;
  try {
    verdict = verifyTaskCompletion(taskDef, { reply, tokens: counter.tokens, ms, toolCalls, executionError }, { sandbox, sourceContents, sourceItems, dataDir: agent.dataDir || path.join(sandbox, ".ppx"), globalDataDir: agent.globalDataDir || path.join(sandbox, ".ppx-global") });
  } catch (e) {
    verdict = { pass: false, detail: `判分异常: ${e.message}` };
  }
  const score = scoreTrajectory(toolCalls, { plan: TASK_PLANS[taskDef.id] || null });
  // 归因只在失败时算, 且必须带真实轨迹 —— 否则会把"没查就答"误判成别的原因
  const triage = verdict.pass
    ? null
    : triageFailure({ reply, toolCalls, ms, budgetMs, detail: verdict.detail });
  await agent.shutdown();
  fs.rmSync(sandbox, { recursive: true, force: true });
  if (!quiet) {
    console.log(`${verdict.pass ? "✓" : "✗"} ${taskDef.id} (${Math.round(ms / 100) / 10}s, ${counter.tokens} tok)${verdict.pass ? "" : " ← " + verdict.detail}`);
    if (!verdict.pass && triage) console.log(`   归因: ${triage.cause} (${triage.confidence}) → ${triage.action}`);
  }
  const pending = Math.max(0, counter.calls - counter.usageKnownCalls - counter.usageUnknownCalls);
  const accounting = { ...counter, usageUnknownCalls: counter.usageUnknownCalls + pending, costUnknownCalls: counter.costUnknownCalls + pending };
  if (pending) { accounting.tokens = null; accounting.costUsd = null; }
  return {
    id: taskDef.id, category: taskDef.category, pass: !!verdict.pass, detail: verdict.detail,
    reply, ...accounting, ms, toolCalls, score, triage,
  };
}

export async function runAll(list, opts = {}) {
  const results = [];
  for (const t of list) {
    try {
      results.push(await runOne(t, opts));
    } catch (e) {
      results.push({ id: t.id, category: t.category, pass: false, detail: `运行器异常: ${e.message}`, tokens: null, costUsd: null, ms: 0 });
      if (!opts.quiet) console.log(`✗ ${t.id} (运行器异常: ${e.message})`);
    }
  }
  return results;
}

// 多数投票跑法: 同一任务跑 N 次取多数 (吸收计数类任务的单次方差)
export async function runWithMajority(taskDef, { runs = 3, ...opts } = {}) {
  if (!Number.isSafeInteger(runs) || runs < 1) throw new RangeError("runs must be a positive integer");
  const attempts = [];
  for (let i = 0; i < runs; i++) attempts.push(await runOne(taskDef, opts));
  const verdict = majorityVerdict(attempts.map((a) => a.pass));
  const selectedAttempt = Math.max(0, attempts.findIndex((a) => a.pass === verdict.pass));
  const sum = (key) => attempts.reduce((s, a) => s + (Number(a[key]) || 0), 0);
  const completeSum = (key) => attempts.every((a) => typeof a[key] === "number" && Number.isFinite(a[key])) ? sum(key) : null;
  return { ...attempts[selectedAttempt], pass: verdict.pass, selectedAttempt, vote: verdict, attempts,
    tokens: completeSum("tokens"), knownTokens: sum("knownTokens"), costUsd: completeSum("costUsd"), knownCostUsd: sum("knownCostUsd"),
    calls: sum("calls"), usageKnownCalls: sum("usageKnownCalls"), usageUnknownCalls: sum("usageUnknownCalls"), costUnknownCalls: sum("costUnknownCalls"), ms: sum("ms") };
}

/* ==================== CLI (仅在作为主模块运行时执行) ==================== */

export function exitCodeForResults(results) { return results.length > 0 && results.every((r) => r.pass === true) ? 0 : 1; }
export async function main(args = process.argv.slice(2), opts = {}) {
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
  const results = await runAll(tasks, opts);
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
  return exitCodeForResults(results);
}

// 仅当被直接执行时才跑 CLI —— 测试会 import 本模块取纯函数, 不能顺手把 20 个真任务跑掉。
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(`评测运行器失败: ${e.message}`); process.exitCode = 1; });
