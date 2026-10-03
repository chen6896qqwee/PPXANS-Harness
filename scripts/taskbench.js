// scripts/taskbench.js - 任务级评测基准运行器 (2026-10-02)
// 用法:
//   node scripts/taskbench.js --limit 3        快速冒烟 (前 3 个任务)
//   node scripts/taskbench.js --only fix-logic,create-file
//   node scripts/taskbench.js --full           全量 20 任务 (真 LLM, 有成本)
//   node scripts/taskbench.js --baseline       结果写入 bench/baseline.json (作回归基线)
// 指标: 任务成功率 / 每任务 token / 耗时; 沙箱隔离, 不污染仓库。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { withTimeout } from "../src/utils/async.js";
import { TASKS, summarize } from "../bench/tasks.js";
import { triageFailure, summarizeCauses } from "../src/services/triage.js";

const TASK_BUDGET_MS = 90000; // 单任务时限: LLM 卡死/平台抽风不让一个任务拖垮整场评测

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(ROOT, "bench", "baseline.json");

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

export async function runOne(taskDef, { quiet = false } = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-bench-"));
  taskDef.setup?.(sandbox);
  const agent = new PPXAgent({
    root: sandbox,
    configFile: path.join(ROOT, "config", "ppx.json"), // 复用仓库 Key 配置, 沙箱内干活
    dataDir: path.join(sandbox, ".ppx"),
    globalDataDir: path.join(sandbox, ".ppx-global"),
  });
  const counter = makeTokenCounter(agent);
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
    // 单任务 90s 护栏: LLM 卡死/平台抽风不让一个任务拖垮整场评测
    reply = String(await withTimeout(agent.chat(taskDef.task), TASK_BUDGET_MS, `任务 ${taskDef.id} 超时`) ?? "");
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
        budgetMs: TASK_BUDGET_MS,
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

(async () => {
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
  process.exit(0);
})();
