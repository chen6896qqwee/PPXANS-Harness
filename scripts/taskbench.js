// scripts/taskbench.js - 任务级评测基准运行器 + 公开口径报告 (2026-10-02, v2 补 2026-10-09)
// 用法:
//   node scripts/taskbench.js --limit 3        快速冒烟 (前 3 个任务)
//   node scripts/taskbench.js --only fix-logic,create-file
//   node scripts/taskbench.js --full           全量 20 任务 (真 LLM, 有成本)
//   node scripts/taskbench.js --repeat 3       每任务独立重复 3 次 (默认 1, 不增加默认成本)
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
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { withTimeout } from "../src/utils/async.js";
import { stableJson } from "../src/utils/canonical.js";
import { TASKS, summarize } from "../bench/tasks.js";

// ---- 失败归因 (2026-11-08 自 src/services/triage.js 内联, 该模块已删除) ----
// triage.js 全仓唯一消费方就是本文件; 作为评测器的私有逻辑内联, 免得 src/ 里养一个无主模块。
// 输入一次任务的执行轨迹 (最终回复 + 工具调用序列 + 耗时 + 判分结果),
// 输出 { cause, confidence, evidence[], action } —— action 对应"按症状下药"表。
const TRIAGE_CAUSE = {
  LLM_STALL: "llm_stall", LOOP: "loop", TIMEOUT_UNKNOWN: "timeout_unknown",
  TOOL_USE: "tool_use", PLANNING: "planning", VERIFICATION: "verification",
  KNOWLEDGE: "knowledge", UNKNOWN: "unknown",
};
const TRIAGE_PRESCRIPTION = {
  [TRIAGE_CAUSE.LLM_STALL]: "taskbench 已强制单次 LLM 超时=任务预算/3 且含重试封顶<预算 (见下方 benchLlmGuard); 仍 stall → 连续慢调用烧穿预算, 查 provider 延迟/换更快模型档或调大 TASK_BUDGET_MS, 勿调低进程级 timeout_ms",
  [TRIAGE_CAUSE.LOOP]: "任务分解 + 验证器 + 重规划; 检查探索熔断阈值是否过松",
  [TRIAGE_CAUSE.TIMEOUT_UNKNOWN]: "补全轨迹采集后重跑定位 (当前轨迹不足以归因)",
  [TRIAGE_CAUSE.TOOL_USE]: "结构化输出 + 参数校验 + 失败重试 + 沙箱; 优先修该工具的 schema 与示例",
  [TRIAGE_CAUSE.PLANNING]: "任务分解 + 验证器 + 重规划 (轮次逼近上限仍未收敛)",
  [TRIAGE_CAUSE.VERIFICATION]: "生成 → 验证 → 修正: 给这类任务配确定性校验器, 让 agent 自查后再作答",
  [TRIAGE_CAUSE.KNOWLEDGE]: "RAG + 引用核验 + 工具查询 (先查再答, 不要凭记忆作答)",
  [TRIAGE_CAUSE.UNKNOWN]: "采集更多轨迹样本后重判",
};
// 工具调用签名 (同工具同参数视为重复; 键序无关稳定序列化, 换键序重发不算两次调用)
function triageSig(c) {
  try {
    return `${c.tool}::${stableJson(c.args || {}, 120)}`;
  } catch {
    return String(c.tool);
  }
}
export const CAUSE = TRIAGE_CAUSE;
export function triageFailure({ reply = "", toolCalls = [], ms = 0, budgetMs = 90000, maxRounds = 8, detail = "" } = {}) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const evidence = [];
  const fail = (cause, confidence) => ({ cause, confidence, evidence, action: TRIAGE_PRESCRIPTION[cause] });

  const failedCalls = calls.filter((c) => c && c.ok === false);
  const calledTools = new Set(calls.map((c) => c && c.tool).filter(Boolean));

  // ---- 1. 超时族: 跑满时限才被砍 ----
  const timedOut = ms >= budgetMs * 0.98 || /超时|timeout/i.test(String(reply || ""));
  if (timedOut) {
    evidence.push(`耗时 ${ms}ms 已达任务时限 ${budgetMs}ms`);
    const counts = new Map();
    for (const c of calls) {
      const k = triageSig(c);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const worst = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (worst && worst[1] >= 3) {
      evidence.push(`同一调用重复 ${worst[1]} 次: ${worst[0]}`);
      return fail(TRIAGE_CAUSE.LOOP, 0.85);
    }
    if (calls.length <= 2) {
      evidence.push(`整个任务只发生 ${calls.length} 次工具调用, 时间几乎全在 LLM 往返`);
      return fail(TRIAGE_CAUSE.LLM_STALL, 0.7);
    }
    evidence.push(`工具调用 ${calls.length} 次, 无重复签名, 但仍未收敛`);
    return fail(TRIAGE_CAUSE.TIMEOUT_UNKNOWN, 0.4);
  }
  // ---- 2. 工具不会用: 有工具返回错误 ----
  if (failedCalls.length) {
    const kinds = new Map();
    for (const c of failedCalls) {
      const e = String(c.error || "");
      const k = /参数错误|应为|必填/.test(e) ? "参数校验被拦"
        : /未知工具|已禁用/.test(e) ? "工具不可用"
        : /策略拦截|权限|审批/.test(e) ? "权限/策略拦截"
        : /超时/.test(e) ? "工具超时"
        : "执行报错";
      kinds.set(k, (kinds.get(k) || 0) + 1);
    }
    for (const [k, n] of kinds) evidence.push(`${k} × ${n} (涉及工具: ${[...new Set(failedCalls.map((c) => c.tool))].slice(0, 3).join(", ")})`);
    return fail(TRIAGE_CAUSE.TOOL_USE, 0.9);
  }
  // ---- 3. 规划错: 轮次逼近上限仍未收敛 ----
  if (maxRounds > 0 && calls.length >= Math.max(3, Math.floor(maxRounds * 0.75))) {
    evidence.push(`工具调用 ${calls.length} 次, 逼近轮次上限 ${maxRounds}, 无错误但未收敛`);
    return fail(TRIAGE_CAUSE.PLANNING, 0.7);
  }
  // ---- 4. 验证缺失: 该查的都查了、没错、有产出, 但结果不对 ----
  if (calls.length >= 1) {
    evidence.push(`工具调用 ${calls.length} 次且全部成功, 但判分失败 (${detail || "结果不符"})`);
    evidence.push(`涉及工具: ${[...calledTools].join(", ")}`);
    return fail(TRIAGE_CAUSE.VERIFICATION, 0.75);
  }
  // ---- 5. 知识不够: 几乎没查就作答 ----
  evidence.push(`工具调用 ${calls.length} 次 —— 基本没查就作答, 判分失败 (${detail || "结果不符"})`);
  return fail(TRIAGE_CAUSE.KNOWLEDGE, 0.8);
}

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
  // ---- F. 多步链 (2026-11-14): 链上每个关键域都必须用到 (锚点编辑/grep 确认/撤销/执行) ----
  "ms-anchored-refactor": ["read_file", "edit_lines", "grep"],
  "ms-grep-rename": ["grep", "edit_lines"],
  "ms-undo-roundtrip": ["write_file", "undo_file", "delete_file"],
  "ms-fg-exec": ["read_file", "run_command"],
  "ms-write-exec-gate": ["write_file", "run_command"],
  "ms-memory-long": ["memory_add", "memory_search"],
  "ms-anchored-multi-edit": ["read_file", "edit_lines", "grep"],
  "ms-cross-file-rename": ["read_file", "edit_lines", "grep"],
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

/* ==================== 重复试验与可复现元数据 ==================== */

export function parseRepeat(value = 1) {
  const n = Number(value ?? 1);
  if (!Number.isInteger(n) || n < 1) throw new TypeError("--repeat 必须是 >= 1 的整数");
  return n;
}

// 均值 / 样本方差 (n-1) / 最差值。空样本不硬造数字, 单样本方差必须为 null。
export function sampleStats(values = []) {
  const xs = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  const n = xs.length;
  if (!n) return { n: 0, mean: null, sampleVariance: null, worst: null };
  const mean = xs.reduce((sum, x) => sum + x, 0) / n;
  return {
    n,
    mean,
    sampleVariance: n >= 2 ? xs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (n - 1) : null,
    worst: Math.max(...xs),
  };
}

// Wilson score interval, 95% 双侧 (z=1.959963984540054)。小样本不用正态近似。
export function wilson95(passes = 0, attempts = 0) {
  const n = Number(attempts);
  const k = Number(passes);
  if (!Number.isInteger(n) || n < 1 || !Number.isFinite(k) || k < 0 || k > n) {
    return { low: null, high: null };
  }
  const z = 1.959963984540054;
  const z2 = z * z;
  const p = k / n;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n)) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

// 冻结本次实际运行的有序任务集。函数源码也入哈希, 夹具/判分器漂移不会被漏掉;
// 报告只写摘要, 不写函数源码 (其中可能含测试口令)。
export function hashTaskSet(list = []) {
  const frozen = (Array.isArray(list) ? list : []).map((t) => ({
    id: t?.id ?? null,
    category: t?.category ?? null,
    task: t?.task ?? null,
    setup: typeof t?.setup === "function" ? Function.prototype.toString.call(t.setup) : null,
    verify: typeof t?.verify === "function" ? Function.prototype.toString.call(t.verify) : null,
  }));
  return createHash("sha256").update(stableJson(frozen)).digest("hex");
}

function safeMetadataText(value) {
  if (value === null || value === undefined || value === "") return null;
  // 正常 provider/model 名原样保留; 若配置误把凭证塞进名称, 也不让常见密钥形态进报告。
  const text = String(value).slice(0, 160)
    .replace(/Bearer\s+[^\s,;]+/gi, "[redacted]")
    .replace(/(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "[redacted]");
  return text || null;
}

// 只取 provider/model 白名单, 不复制配置对象 (api_key/base_url/api_key_cmd 等绝不进报告)。
export function sanitizeProviderMetadata(providers = []) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(providers) ? providers : []) {
    if (!p || typeof p !== "object") continue;
    const row = {
      provider: safeMetadataText(p.providerId ?? p.provider ?? p.id ?? p.name ?? p.backend),
      model: safeMetadataText(p.model ?? p.models?.chat),
    };
    const key = `${row.provider || ""}\0${row.model || ""}`;
    if ((!row.provider && !row.model) || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function agentProviderMetadata(agent) {
  return sanitizeProviderMetadata([...(agent?.allProviders || []), agent?.llm].filter(Boolean));
}

/* ==================== 公开口径报告 ==================== */

function publicStats(stats, fallback) {
  if (!stats || typeof stats !== "object") return sampleStats(fallback);
  const n = Number.isInteger(stats.n) && stats.n >= 0 ? stats.n : fallback.filter((x) => Number.isFinite(Number(x))).length;
  const finiteOrNull = (x) => Number.isFinite(Number(x)) && x !== null ? Number(x) : null;
  return {
    n,
    mean: finiteOrNull(stats.mean),
    sampleVariance: n >= 2 ? finiteOrNull(stats.sampleVariance) : null,
    worst: finiteOrNull(stats.worst),
  };
}

function publicFailureSteps(value, { pass = false, attempts = 1, passes = 0, score = null } = {}) {
  const out = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [step, count] of Object.entries(value)) {
      if (!/^(?:0|[1-9]\d*|unknown)$/.test(step)) continue;
      const n = Number(count);
      if (Number.isInteger(n) && n > 0) out[step] = n;
    }
  } else if (!pass) {
    const step = Number.isInteger(score?.totalCalls) && score.totalCalls >= 0 ? String(score.totalCalls) : "unknown";
    out[step] = Math.max(1, attempts - passes);
  }
  return out;
}

function publicScore(score) {
  if (!score || typeof score !== "object") return null;
  const numberOrNull = (x) => Number.isFinite(Number(x)) && x !== null ? Number(x) : null;
  return {
    totalCalls: numberOrNull(score.totalCalls),
    failedCalls: numberOrNull(score.failedCalls),
    toolErrorRate: numberOrNull(score.toolErrorRate),
    redundancy: numberOrNull(score.redundancy),
    uniqueTools: numberOrNull(score.uniqueTools),
    planFollowed: typeof score.planFollowed === "boolean" ? score.planFollowed : null,
  };
}

/**
 * 生成对外可发布的评测报告 (schema v2, 重复统计为向后兼容的新增字段)。
 * 硬约束: 模型自由文本 (reply) / 失败明细 / 工具参数 / provider 密钥一律不进公开口径。
 * @param {object} summary   runAll 的汇总 (pass/total/passRate/totalTokens/avgMs/costEfficiency)
 * @param {Array}  results   逐任务聚合结果 [{id,category,pass,attempts,passes,msStats,tokenStats}]
 * @param {object} [meta]    {version, gitCommit, totalTasks, taskSetHash, repeat, providers}
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
  const attemptsOf = (r) => Number.isInteger(r?.attempts) && r.attempts > 0 ? r.attempts : 1;
  const totalAttempts = rows.reduce((sum, r) => sum + attemptsOf(r), 0);
  const providers = sanitizeProviderMetadata(meta.providers ?? rows.flatMap((r) => r?.providers || []));

  return {
    report_schema: 2, // 保持既有消费者契约; attempts/stats/hash/env.providers 均为新增可选字段
    suite: "taskbench",
    generated_at: new Date().toISOString(),
    task_set_hash: meta.taskSetHash ?? null,
    coverage: `${rows.length}/${totalTasks}`,
    env: {
      version: meta.version ?? null,
      git_commit: meta.gitCommit ?? null,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      providers,
    },
    summary: {
      total: summary.total ?? rows.length,
      pass: summary.pass ?? null,
      // 公开口径的比率保留 1 位小数 (0.6667 → 66.7)
      passRate: summary.passRate != null ? Math.round(summary.passRate * 1000) / 10 : null,
      totalTokens: summary.totalTokens ?? null,
      avgMs: summary.avgMs ?? null,
      costEfficiency: summary.costEfficiency ?? null,
      repeat: {
        trialsPerTask: Number.isInteger(meta.repeat) && meta.repeat > 0 ? meta.repeat : (rows.length ? Math.max(...rows.map(attemptsOf)) : 1),
        totalAttempts,
      },
      gpa,
    },
    // 只保留判分事实与数值分布: 无 reply / 无 detail / 无 failures / 无 toolCalls.args
    results: rows.map((r) => {
      const attempts = attemptsOf(r);
      const passes = Number.isInteger(r.passes) && r.passes >= 0 && r.passes <= attempts
        ? r.passes : (r.pass ? 1 : 0);
      const passRate = attempts ? passes / attempts : 0;
      return {
        id: r.id,
        category: r.category ?? null,
        pass: !!r.pass, // bench-gate 契约: 重复试验采用严格多数, 单次行为不变
        tokens: r.tokens ?? null, // 全部 trials 总 token, 保持 summary 成本口径
        ms: r.ms ?? null,         // 每 trial 平均 ms, n=1 与旧报告一致
        attempts,
        passes,
        passRate,
        wilson95: r.wilson95 ?? wilson95(passes, attempts),
        msStats: publicStats(r.msStats, [r.ms]),
        tokenStats: publicStats(r.tokenStats, [r.tokens]),
        failureSteps: publicFailureSteps(r.failureSteps, { pass: !!r.pass, attempts, passes, score: r.score }),
        cause: r.triage?.cause ?? null,
        score: publicScore(r.score),
      };
    }),
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
 * 跑单个基准任务的一次 trial。每次调用都会新建并独立清理 agent/sandbox。
 * @param {object} taskDef   {id, category, task, setup?, verify}
 * @param {object} [opts]
 * @param {boolean} [opts.quiet]
 * @param {number}  [opts.budgetMs]     任务墙钟预算 (默认 TASK_BUDGET_MS)
 * @param {Function}[opts.createAgent]  自定义 agent 工厂 (sandbox) => agent, 测试注入桩用
 */
export async function runOne(taskDef, {
  quiet = false, budgetMs = TASK_BUDGET_MS, createAgent = null, attempt = null,
} = {}) {
  const guard = benchLlmGuard(budgetMs);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-bench-"));
  let agent = null;
  let counter = { tokens: 0, calls: 0 };
  const toolCalls = [];
  let reply = "";
  let ms = 0;
  let verdict = null;
  let score = null;
  let triage = null;
  let providers = [];
  let operationError = null;

  try {
    taskDef.setup?.(sandbox);
    agent = typeof createAgent === "function"
      ? createAgent(sandbox)
      : new PPXAgent({
          root: sandbox,
          configFile: path.join(ROOT, "config", "ppx.json"), // 复用仓库 Key 配置, 沙箱内干活
          dataDir: path.join(sandbox, ".ppx"),
          globalDataDir: path.join(sandbox, ".ppx-global"),
        });
    providers = agentProviderMetadata(agent);
    installLlmGuard(agent, guard);
    installApprovalPolicy(agent);
    counter = makeTokenCounter(agent);
    installTraceCollector(agent, toolCalls);
    const t0 = Date.now();
    try {
      reply = String(await withTimeout(agent.chat(taskDef.task), budgetMs, `任务 ${taskDef.id} `) ?? "");
    } catch (e) {
      reply = `[异常] ${e.message}`;
    }
    ms = Date.now() - t0;
    try {
      verdict = taskDef.verify({ reply, tokens: counter.tokens, ms }, { sandbox });
    } catch (e) {
      verdict = { pass: false, detail: `判分异常: ${e.message}` };
    }
    score = scoreTrajectory(toolCalls, { plan: TASK_PLANS[taskDef.id] || null });
    // 归因只在失败时算, 且必须带真实轨迹 —— 否则会把"没查就答"误判成别的原因
    triage = verdict.pass
      ? null
      : triageFailure({ reply, toolCalls, ms, budgetMs, detail: verdict.detail });
  } catch (e) {
    operationError = e;
  } finally {
    // shutdown 与 rm 必须分别尝试: 一个清理失败不能阻止另一个, 也不能覆盖首个业务异常。
    try { await agent?.shutdown?.(); } catch (e) { operationError ??= e; }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { operationError ??= e; }
  }
  if (operationError) throw operationError;

  if (!quiet) {
    const trial = attempt ? ` [trial ${attempt.index}/${attempt.total}]` : "";
    console.log(`${verdict.pass ? "✓" : "✗"} ${taskDef.id}${trial} (${Math.round(ms / 100) / 10}s, ${counter.tokens} tok)${verdict.pass ? "" : " ← " + verdict.detail}`);
    if (!verdict.pass && triage) console.log(`   归因: ${triage.cause} (${triage.confidence}) → ${triage.action}`);
  }
  return {
    id: taskDef.id, category: taskDef.category, pass: !!verdict.pass, detail: verdict.detail,
    reply, tokens: counter.tokens, ms, toolCalls, score, triage, providers,
  };
}

// 把同一任务的 trials 聚成一行, 保留 results[].id/pass 给 bench-gate。
// tokens=全部 trials 总耗 (汇总成本), ms=每 trial 均值; 完整分布见 msStats/tokenStats。
export function aggregateTaskTrials(taskDef, trials = []) {
  const rows = Array.isArray(trials) ? trials : [];
  const votes = rows.map((r) => r?.pass === true);
  const verdict = majorityVerdict(votes);
  const msStats = sampleStats(rows.map((r) => r?.ms));
  const tokenStats = sampleStats(rows.map((r) => r?.tokens));
  const failureSteps = {};
  for (const r of rows) {
    if (r?.pass === true) continue;
    const step = Number.isInteger(r?.score?.totalCalls) && r.score.totalCalls >= 0
      ? String(r.score.totalCalls) : "unknown";
    failureSteps[step] = (failureSteps[step] || 0) + 1;
  }
  const last = rows.at(-1) || {};
  const lastFailure = [...rows].reverse().find((r) => r?.pass !== true);
  return {
    id: taskDef.id,
    category: taskDef.category,
    pass: verdict.pass,
    detail: rows.length > 1
      ? `${last.detail || "任务判分失败"} [${verdict.yes}/${rows.length} trials]`
      : last.detail,
    reply: last.reply || "",
    tokens: tokenStats.n ? rows.reduce((sum, r) => sum + (Number.isFinite(Number(r?.tokens)) ? Number(r.tokens) : 0), 0) : 0,
    ms: msStats.mean ?? 0,
    toolCalls: last.toolCalls || [],
    score: last.score || null,
    triage: verdict.pass ? null : (lastFailure?.triage || null),
    providers: sanitizeProviderMetadata(rows.flatMap((r) => r?.providers || [])),
    attempts: rows.length,
    passes: verdict.yes,
    passRate: verdict.passRate,
    wilson95: wilson95(verdict.yes, rows.length),
    msStats,
    tokenStats,
    failureSteps,
  };
}

export async function runAll(list, opts = {}) {
  const repeat = parseRepeat(opts.repeat ?? 1); // 默认严格一次, 不增加既有 CLI 成本
  const results = [];
  for (const t of list) {
    const trials = [];
    for (let index = 1; index <= repeat; index++) {
      try {
        trials.push(await runOne(t, {
          ...opts,
          attempt: repeat > 1 ? { index, total: repeat } : null,
        }));
      } catch (e) {
        trials.push({
          id: t.id, category: t.category, pass: false,
          detail: `运行器异常: ${e.message}`, tokens: 0, ms: 0, providers: [],
        });
        if (!opts.quiet) console.log(`✗ ${t.id}${repeat > 1 ? ` [trial ${index}/${repeat}]` : ""} (运行器异常: ${e.message})`);
      }
    }
    results.push(aggregateTaskTrials(t, trials));
  }
  return results;
}

function readGitCommit(root = ROOT) {
  try {
    let gitDir = path.join(root, ".git");
    if (fs.statSync(gitDir).isFile()) { // worktree 时 .git 是 gitdir 文件
      const marker = fs.readFileSync(gitDir, "utf8").trim();
      const match = marker.match(/^gitdir:\s*(.+)$/i);
      if (match) gitDir = path.resolve(root, match[1]);
    }
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40,64}$/i.test(head)) return head;
    const ref = head.match(/^ref:\s*(.+)$/)?.[1];
    if (!ref) return null;
    try {
      const commit = fs.readFileSync(path.join(gitDir, ...ref.split("/")), "utf8").trim();
      if (/^[0-9a-f]{40,64}$/i.test(commit)) return commit;
    } catch { /* packed-refs 兜底 */ }
    const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
    for (const line of packed.split(/\r?\n/)) {
      const m = line.match(/^([0-9a-f]{40,64})\s+(.+)$/i);
      if (m && m[2] === ref) return m[1];
    }
  } catch { /* 非 git 源码包 */ }
  return null;
}

// --out/--baseline 也不落完整回复和工具参数; triage.evidence 可能含调用签名, 同样剔除。
function portableResult(result) {
  const { reply: _reply, toolCalls: _toolCalls, triage, ...row } = result;
  return {
    ...row,
    providers: sanitizeProviderMetadata(row.providers),
    triage: triage ? {
      cause: triage.cause ?? null,
      confidence: triage.confidence ?? null,
      action: triage.action ?? null,
    } : null,
  };
}

/* ==================== CLI (仅在作为主模块运行时执行) ==================== */

async function main() {
  const args = process.argv.slice(2);
  const getArg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const hasFlag = (k) => args.includes(k);
  let repeat;
  try { repeat = parseRepeat(getArg("--repeat") ?? 1); }
  catch (e) { console.error(e.message); process.exit(2); }

  let tasks = TASKS;
  if (getArg("--only")) {
    const ids = getArg("--only").split(",");
    tasks = TASKS.filter((t) => ids.includes(t.id));
  } else if (!hasFlag("--full")) {
    tasks = TASKS.slice(0, Number(getArg("--limit") || 3));
  }
  if (tasks.length === 0) { console.error("没有匹配的任务"); process.exit(1); }

  const taskSetHash = hashTaskSet(tasks); // 开跑前冻结; 所有 trials 共用同一有序任务定义
  console.log(`→ 任务级评测: ${tasks.length} 个任务 × ${repeat} trial (真 LLM, 每 trial 独立 agent/沙箱)\n`);
  const t0 = Date.now();
  const results = await runAll(tasks, { repeat });
  const s = summarize(results);
  console.log(`\n===== 汇总 (${Math.round((Date.now() - t0) / 1000)}s) =====`);
  console.log(`成功率: ${s.pass}/${s.total} = ${(s.passRate * 100).toFixed(1)}% | trials: ${tasks.length * repeat}`);
  if (repeat > 1) console.log("逐任务 pass 采用严格多数; 分布统计与 Wilson95 见报告");
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
    gitCommit: readGitCommit(),
    totalTasks: TASKS.length,
    taskSetHash,
    repeat,
    providers: results.flatMap((r) => r.providers || []),
  });
  const reportPath = getArg("--report") || path.join(ROOT, "bench", "report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n→ 公开口径报告 (schema v${report.report_schema}) 已写入 ${reportPath} (覆盖 ${report.coverage})`);

  if (getArg("--out") || hasFlag("--baseline")) {
    const raw = results.map(portableResult);
    const outFile = getArg("--out");
    if (outFile) {
      const summary = { ...s, failures: s.failures.map(({ reply: _reply, ...failure }) => failure) };
      fs.writeFileSync(outFile, JSON.stringify({ date: new Date().toISOString(), summary, results: raw }, null, 2));
      console.log(`\n→ 脱敏结果已写入 ${outFile}`);
    }
  }
  if (hasFlag("--baseline")) {
    // 增量合并: 已有基线时按 id 替换/追加 (平台不稳定时可分批跑, 进度不丢)
    let prev = { results: [] };
    try { prev = JSON.parse(fs.readFileSync(BASELINE, "utf8")); } catch {}
    const map = new Map(prev.results.map((r) => [r.id, r]));
    for (const r of results.map(portableResult)) map.set(r.id, r);
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
