// scripts/eval-ledger-report.js - 生产账本双口径 + 任务级成功率报表 (评测-II P2-4)
//
// 背景 (2026-11-14 二次评测): 审计链的 ok 字段在 2026-11-13 isToolErrorResult 统一口径
//   之前把 "[exit=1 ...]" 开头的命令失败记成成功 —— 表面成功率 (95.9%) 与真实执行成功率
//   (64.1%) 差距巨大, 且"按设计拒绝" (安全闸门正确拦截) 与"真失败"混在一个桶里。
// 本脚本以**只读**方式聚合生产账本, 不改写任何账本文件:
//   表面口径  = ok === true 的调用占比 (审计链原始语义)
//   严格口径  = 排除 [exit=N 开头 / 错误体 / 硬失败] 后的净执行成功占比
//   分类      = success / exitNonzero / deniedByDesign (按设计拒绝) / softError / hardFail
//   单步/任务 = 新 eval/tool、eval/turn、eval/request 与旧 tool/call 可混合聚合。
// 口径判定复用 src/core/errors.js isToolErrorResult —— 与运行时同一实现, 报表不说两套话。
//
// 用法: npm run eval:ledger            (输出 JSON 到 stdout)
//       npm run eval:ledger -- --out data/eval/ledger-report.json
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isToolErrorResult } from "../src/core/errors.js";

// 按设计拒绝: 安全闸门正确拦截 (路径越界/权限拒绝/内联执行拦截/白名单/未开启), 行为正确而非缺陷
const DENY_RE = /\[permission\]|路径越界|被拒绝|拦截|白名单|未开启|不允许|不要重试|降级拒绝/i;
const REAL_ERRORS = new Set(["exitNonzero", "softError", "hardFail"]);
const CATEGORY = new Map([
  ["success", "success"],
  ["exitnonzero", "exitNonzero"],
  ["exit_nonzero", "exitNonzero"],
  ["deniedbydesign", "deniedByDesign"],
  ["denied_by_design", "deniedByDesign"],
  ["softerror", "softError"],
  ["soft_error", "softError"],
  ["hardfail", "hardFail"],
  ["hard_fail", "hardFail"],
  ["unknown_tool", "hardFail"],
  ["shadow_call", "hardFail"],
  ["parameter_hallucination", "hardFail"],
]);

function explicitCategory(category) {
  if (category == null) return null;
  const key = String(category).trim().toLowerCase().replaceAll("-", "_");
  return CATEGORY.get(key) || null;
}

// category 是评测事件的显式事实, 优先于 ok/结果体推断; 旧调用仍可只传 (result, ok)。
export function classify(result, ok, category) {
  const explicit = explicitCategory(category);
  if (explicit) return explicit;
  if (ok === false) return "hardFail";
  const text = String(result ?? "");
  if (isToolErrorResult(text)) {
    if (/^\[exit=\d+/.test(text)) return "exitNonzero"; // 11-13 修复前的口径缺陷: 命令失败记成功
    if (DENY_RE.test(text)) return "deniedByDesign";
    return "softError";
  }
  return "success";
}

const round4 = (n) => Math.round(n * 10000) / 10000;
const round8 = (n) => Math.round(n * 1e8) / 1e8;
const rate = (ok, total) => total ? round4(ok / total) : null;
const isTool = (e) => e && (e.evt == null || e.evt === "tool/call" || e.evt === "eval/tool");
const isTurn = (e) => e?.evt === "eval/turn";
const isRequest = (e) => e?.evt === "eval/request";
const eventTime = (e) => String(e?.ts ?? e?.tsIso ?? e?.timestamp ?? "");
const toolClass = (e) => classify(e?.result ?? e?.error, e?.ok, e?.category);

function isShadowCall(e) {
  return e?.shadow_call === true || e?.shadowCall === true
    || e?.kind === "shadow_call" || e?.mode === "shadow_call"
    || e?.category === "shadow_call" || e?.tool === "shadow_call" || e?.name === "shadow_call"
    || (Array.isArray(e?.flags) && e.flags.includes("shadow_call"));
}

function hallucinationCategory(e) {
  if (isShadowCall(e)) return "shadow_call";
  const explicit = String(e?.category || "").trim().toLowerCase().replaceAll("-", "_");
  if (explicit === "unknown_tool" || explicit === "parameter_hallucination") return explicit;
  const text = String(e?.result ?? e?.error ?? "");
  if (/未知工具[:：]/i.test(text)) return "unknown_tool";
  if (/参数错误|无法解析.*JSON|JSON.*无法解析|参数不是完整 JSON|参数不是 JSON/i.test(text)) return "parameter_hallucination";
  return null;
}

function finiteNumber(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function requestTokens(e) {
  const usage = e?.usage && typeof e.usage === "object" ? e.usage : {};
  const total = finiteNumber(e?.totalTokens, e?.total_tokens,
    typeof e?.tokens !== "object" ? e?.tokens : null,
    usage.total_tokens, usage.totalTokens);
  if (total != null) return total;
  const prompt = finiteNumber(e?.promptTokens, e?.prompt_tokens, usage.prompt_tokens, usage.input_tokens);
  const completion = finiteNumber(e?.completionTokens, e?.completion_tokens, usage.completion_tokens, usage.output_tokens);
  return prompt == null && completion == null ? null : (prompt || 0) + (completion || 0);
}

function requestAmount(e) {
  // 0 是有效的已定价金额 (免费/赠送); null/缺失/false 才表示未知, 二者不可混淆。
  if (e?.priced === false || e?.pricingKnown === false || e?.unpriced === true) return null;
  const usage = e?.usage && typeof e.usage === "object" ? e.usage : {};
  return finiteNumber(e?.costUsd, e?.cost_usd, e?.amountUsd, e?.amount, e?.cost, usage.cost);
}

// nearest-rank: 升序样本 x, 取 x[ceil(p * N) - 1] (1-based rank), 不插值。
export function nearestRank(values, p) {
  const sorted = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.min(sorted.length, Math.ceil(p * sorted.length)));
  return sorted[rank - 1];
}

function groupKey(e, index) {
  const id = e?.taskId || e?.traceId;
  if (id != null && id !== "") return `task:${String(id)}`;
  // 旧 tool/call 没有任务标识, 保留 sessionId 分组以兼容旧 sessionChain/recovery。
  if (e?.evt == null || e?.evt === "tool/call") return `session:${String(e?.sessionId)}`;
  return `unassigned:${index}`;
}

function normalizeStrata(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return { value: String(value) };
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

function taskStrata(task) {
  // 最终 turn 的维度优先; 若它未带 strata, 回退到任务内第一条带维度的事件。
  const sorted = [...task.events].sort(compareEvents);
  const turns = sorted.filter((e) => isTurn(e.event) && e.event.strata != null);
  const found = turns.at(-1) || sorted.find((e) => e.event.strata != null);
  return found ? normalizeStrata(found.event.strata) : null;
}

function compareEvents(a, b) {
  return eventTime(a.event).localeCompare(eventTime(b.event)) || a.index - b.index;
}

function groupEvents(events) {
  const tasks = new Map();
  events.forEach((event, index) => {
    if (!isTool(event) && !isTurn(event) && !isRequest(event)) return;
    const key = groupKey(event, index);
    let task = tasks.get(key);
    if (!task) tasks.set(key, task = { key, events: [] });
    task.events.push({ event, index });
  });
  return tasks;
}

function finalTurn(task) {
  const turns = task.events.filter((e) => isTurn(e.event) && typeof e.event.taskOk === "boolean");
  turns.sort(compareEvents);
  return turns.at(-1) || null;
}

function costForSuccessfulTask(task, end) {
  const requests = task.events
    .filter((e) => isRequest(e.event) && compareEvents(e, end) <= 0)
    .map((e) => e.event);
  if (!requests.length) return { tokens: null, amount: null };
  let tokens = 0, amount = 0;
  for (const request of requests) {
    const t = requestTokens(request);
    const a = requestAmount(request);
    if (t == null) tokens = null;
    if (a == null) amount = null;
    if (tokens != null && t != null) tokens += t;
    if (amount != null && a != null) amount += a;
  }
  return { tokens, amount };
}

function summarizeEventSet(events, includeStrata) {
  const tasks = groupEvents(events);
  const byClass = { success: 0, exitNonzero: 0, deniedByDesign: 0, softError: 0, hardFail: 0 };
  const byDay = {};
  const tools = events.filter(isTool);
  let surfaceOk = 0;

  for (const c of tools) {
    const cls = toolClass(c);
    byClass[cls]++;
    if (c.ok === true) surfaceOk++;
    const day = eventTime(c).slice(0, 10);
    const d = (byDay[day] ??= {
      total: 0, success: 0, hardFail: 0, softError: 0, exitNonzero: 0, deniedByDesign: 0, surfaceOk: 0,
    });
    d.total++;
    d[cls]++;
    if (c.ok === true) d.surfaceOk++;
  }

  // 兼容字段: 新事件优先按 taskId||traceId 分组; 旧事件仍回退 sessionId。
  const sessionChain = { total: 0, zeroFailure: 0, zeroExecutionFailure: 0 };
  // 兼容字段: 旧 recovery 仍是"真实错误后的下一步是否成功", 不代表最终任务恢复。
  let recoveries = 0, recovered = 0;
  const taskSuccess = { total: 0, ok: 0, rate: null, unknownOutcome: 0, missingOutcome: 0 };
  const taskRecovery = { eligible: 0, recovered: 0, rate: null };
  const hallucinationCounts = { unknown_tool: 0, shadow_call: 0, parameter_hallucination: 0 };
  for (const event of tools) {
    const category = hallucinationCategory(event);
    if (category) hallucinationCounts[category]++;
  }
  let shadowCalls = 0, actualSteps = 0, successfulSteps = 0;
  const requestEvents = events.filter(isRequest);
  const requestUsage = { total: requestEvents.length, provider: 0, estimated: 0, none: 0, unknown: 0 };
  for (const event of requestEvents) {
    const source = ["provider", "estimated", "none"].includes(event.usageSource) ? event.usageSource : "unknown";
    requestUsage[source]++;
  }
  const latencies = requestEvents
    .map((e) => finiteNumber(e.durationMs, e.latencyMs, e.elapsedMs))
    .filter((n) => n != null);
  const successfulCosts = [];

  for (const task of tasks.values()) {
    const sorted = [...task.events].sort(compareEvents);
    const taskTools = sorted.filter((e) => isTool(e.event));
    if (taskTools.length) {
      sessionChain.total++;
      const classes = taskTools.map((e) => toolClass(e.event));
      if (classes.every((c) => c === "success")) sessionChain.zeroFailure++;
      if (classes.every((c) => c === "success" || c === "deniedByDesign")) sessionChain.zeroExecutionFailure++;
      for (let i = 1; i < taskTools.length; i++) {
        const prev = classes[i - 1];
        if (!REAL_ERRORS.has(prev)) continue;
        recoveries++;
        if (classes[i] === "success") recovered++;
      }
    }

    for (const entry of taskTools) {
      if (!isShadowCall(entry.event)) continue;
      shadowCalls++;
    }
    const actual = taskTools.filter((e) => !isShadowCall(e.event));
    actualSteps += actual.length;
    successfulSteps += actual.filter((e) => toolClass(e.event) === "success").length;

    const turns = task.events.filter((e) => isTurn(e.event));
    const end = finalTurn(task);
    if (!end) {
      if (turns.length) taskSuccess.unknownOutcome++;
      else taskSuccess.missingOutcome++;
      continue;
    }
    const taskOk = end.event.taskOk;
    taskSuccess.total++;
    if (taskOk) taskSuccess.ok++;
    const hadRealError = taskTools.some((e) => compareEvents(e, end) < 0
      && (isShadowCall(e.event) || REAL_ERRORS.has(toolClass(e.event))));
    if (hadRealError) {
      taskRecovery.eligible++;
      if (taskOk) taskRecovery.recovered++;
    }
    if (taskOk) successfulCosts.push(costForSuccessfulTask(task, end));
  }

  taskSuccess.rate = rate(taskSuccess.ok, taskSuccess.total);
  taskRecovery.rate = rate(taskRecovery.recovered, taskRecovery.eligible);

  const knownTokenTasks = successfulCosts.filter((c) => c.tokens != null);
  const pricedTasks = successfulCosts.filter((c) => c.amount != null);
  const knownTokens = knownTokenTasks.reduce((sum, c) => sum + c.tokens, 0);
  const pricedAmount = pricedTasks.reduce((sum, c) => sum + c.amount, 0);
  const successfulTaskCount = successfulCosts.length;
  const missingTokenTasks = successfulTaskCount - knownTokenTasks.length;
  const unpricedTasks = successfulTaskCount - pricedTasks.length;
  const totalTokens = successfulTaskCount === 0 ? 0 : (missingTokenTasks ? null : round8(knownTokens));
  const amount = successfulTaskCount > 0 && unpricedTasks === 0 ? round8(pricedAmount) : null;

  const summary = {
    totalCalls: tools.length,
    classes: byClass,
    surface: { ok: surfaceOk, rate: rate(surfaceOk, tools.length) },
    strict: { ok: byClass.success, rate: rate(byClass.success, tools.length) },
    sessionChain,
    recovery: { events: recoveries, recovered, rate: rate(recovered, recoveries) },
    stepSuccess: {
      ok: successfulSteps,
      total: actualSteps,
      rate: rate(successfulSteps, actualSteps),
      excludedShadowCalls: shadowCalls,
    },
    taskSuccess,
    taskRecovery,
    hallucinations: {
      totalAttempts: tools.length,
      unknown_tool: { count: hallucinationCounts.unknown_tool, rate: rate(hallucinationCounts.unknown_tool, tools.length) },
      shadow_call: { count: hallucinationCounts.shadow_call, rate: rate(hallucinationCounts.shadow_call, tools.length) },
      parameter_hallucination: { count: hallucinationCounts.parameter_hallucination, rate: rate(hallucinationCounts.parameter_hallucination, tools.length) },
    },
    successfulTaskCost: {
      tasks: successfulTaskCount,
      totalTokens,
      avgTokens: totalTokens == null || !successfulTaskCount ? null : round4(totalTokens / successfulTaskCount),
      knownTokens: round8(knownTokens),
      tokenTasks: knownTokenTasks.length,
      missingTokenTasks,
      currency: "USD",
      amount,
      avgAmount: amount == null ? null : round8(amount / successfulTaskCount),
      pricedAmount: round8(pricedAmount),
      pricedTasks: pricedTasks.length,
      unpricedTasks,
      amountComplete: successfulTaskCount > 0 && unpricedTasks === 0,
    },
    requestUsage,
    requestLatency: {
      total: requestEvents.length,
      samples: latencies.length,
      p50Ms: nearestRank(latencies, 0.50),
      p95Ms: nearestRank(latencies, 0.95),
      method: "nearest-rank",
    },
    byDay: Object.fromEntries(Object.entries(byDay).map(([d, v]) => [d, {
      ...v,
      surfaceRate: rate(v.surfaceOk, v.total),
      strictRate: rate(v.success, v.total),
    }])),
  };

  if (includeStrata) {
    const groups = new Map();
    for (const task of tasks.values()) {
      const strata = taskStrata(task);
      if (strata == null) continue;
      const key = JSON.stringify(strata);
      let group = groups.get(key);
      if (!group) groups.set(key, group = { strata, events: [] });
      for (const entry of task.events) group.events.push(entry.event);
    }
    summary.byStrata = Object.fromEntries([...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, group]) => [key, {
        strata: group.strata,
        ...summarizeEventSet(group.events, false),
      }]));
  }
  return summary;
}

// 聚合轨迹事件 ({evt: tool/call|eval/tool|eval/turn|eval/request, ...}) → 报表对象。
// 不带 evt 的旧调用仍按 tool/call 处理。
export function summarizeCalls(calls) {
  return summarizeEventSet(Array.isArray(calls) ? calls : [], true);
}

// 读取生产账本 (只读): traces/YYYY-MM-DD.jsonl 的新旧事件 + audit.ndjson
export function buildLedgerReport({ traceDir, auditFile } = {}) {
  const traces = [];
  if (traceDir && fs.existsSync(traceDir)) {
    for (const f of fs.readdirSync(traceDir).filter((f) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(f)).sort()) {
      for (const line of fs.readFileSync(path.join(traceDir, f), "utf8").split("\n").filter(Boolean)) {
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o?.evt === "tool/call" || o?.evt === "eval/tool" || o?.evt === "eval/turn" || o?.evt === "eval/request") traces.push(o);
      }
    }
  }
  const audit = { total: 0, ok: 0, fail: 0 };
  if (auditFile && fs.existsSync(auditFile)) {
    for (const line of fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean)) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      audit.total++; o?.ok ? audit.ok++ : audit.fail++;
    }
  }
  const traceSummary = summarizeCalls(traces);
  return {
    generatedAt: new Date().toISOString(),
    scope: { traceDir: traceDir || null, auditFile: auditFile || null },
    trace: {
      ...traceSummary,
      note: "traces = 新旧工具/任务/请求事件; deniedByDesign 是安全闸门正确拦截, 不算真实故障",
    },
    audit: {
      ...audit,
      surfaceRate: audit.total ? round4(audit.ok / audit.total) : null,
      note: "audit.ndjson 无结果体, 只能算表面口径; 严格口径以 trace 侧为准",
    },
    caliberContract: {
      surface: "ok===true / total (审计链原始语义)",
      strict: "排除 [exit=N 开头 / isToolErrorResult 错误体 / ok=false 后的成功占比",
      stepSuccess: "classify===success / 实际工具调用; shadow_call 不进分母",
      taskSuccess: "按 taskId||traceId 分组, 取最后一条布尔 eval/turn.taskOk; null 计入 unknownOutcome",
      taskRecovery: "最终 turn 前有真实工具错误或 shadow_call (deniedByDesign 除外) 且最终 taskOk=true",
      hallucinations: "unknown_tool/shadow_call/parameter_hallucination 分别除以全部模型工具尝试",
      successfulTaskCost: "只汇总最终成功任务; 未定价任务使完整 amount/avgAmount=null, pricedAmount 仅为已定价子合计",
      requestUsage: "provider=上游真值, estimated=本地估算, none=失败无用量, unknown=旧事件未标来源",
      requestLatency: "nearest-rank: 升序后取第 ceil(p*N) 个 (1-based), 不插值",
      byStrata: "strata 对象键排序后 JSON 序列化, 保留完整复合维度组合",
      fix: "2026-11-13 起 isToolErrorResult 已接入 catalog/审批/循环/MCP, 增量账本不再混入 exit≠0",
    },
  };
}

// ---- CLI 入口 (被 import 时不执行) ----
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const dataDir = process.env.PPX_DATA_DIR || path.join(process.cwd(), "data");
  const report = buildLedgerReport({
    traceDir: path.join(dataDir, "logs", "traces"),
    auditFile: path.join(dataDir, "logs", "audit.ndjson"),
  });
  const json = JSON.stringify(report, null, 1);
  if (outIdx >= 0 && argv[outIdx + 1]) {
    const out = path.resolve(argv[outIdx + 1]);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json, "utf8");
    console.log(`报表已写入: ${out}`);
  } else {
    console.log(json);
  }
  console.log(`严格口径: trace ${report.trace.strict.rate} (${report.trace.strict.ok}/${report.trace.totalCalls}) | 表面口径 ${report.trace.surface.rate} | 会话零失败 ${report.trace.sessionChain.zeroFailure}/${report.trace.sessionChain.total} | 下一步恢复率 ${report.trace.recovery.rate}`);
  const cost = report.trace.successfulTaskCost;
  const latency = report.trace.requestLatency;
  console.log(`单步成功率: ${report.trace.stepSuccess.rate} (${report.trace.stepSuccess.ok}/${report.trace.stepSuccess.total}) | 最终任务成功率 ${report.trace.taskSuccess.rate} | 最终任务恢复率 ${report.trace.taskRecovery.rate} (${report.trace.taskRecovery.recovered}/${report.trace.taskRecovery.eligible})`);
  const hallucinations = report.trace.hallucinations;
  console.log(`幻觉率: 未知工具 ${hallucinations.unknown_tool.rate} (${hallucinations.unknown_tool.count}/${hallucinations.totalAttempts}) | 影子调用 ${hallucinations.shadow_call.rate} (${hallucinations.shadow_call.count}/${hallucinations.totalAttempts}) | 参数幻觉 ${hallucinations.parameter_hallucination.rate} (${hallucinations.parameter_hallucination.count}/${hallucinations.totalAttempts})`);
  console.log(`成功任务 tokens ${cost.totalTokens ?? "未知"} | 金额 ${cost.amount == null ? "未知" : `$${cost.amount}`} (未定价任务 ${cost.unpricedTasks}) | 请求 P50 ${latency.p50Ms}ms / P95 ${latency.p95Ms}ms (${latency.method}) | 估算用量请求 ${report.trace.requestUsage.estimated}/${report.trace.requestUsage.total}`);
}
