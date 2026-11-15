#!/usr/bin/env node
// scripts/bench-gate.js — 任务成功率回归门禁 (架构优化 ⑤, 2026-11-13)
//
// 缺口 (审计结论): 仓库已有真 LLM 任务基准 (scripts/taskbench.js, 20 个确定性判分任务) 和
//   基线文件 (bench/baseline.json), 但两者之间没有比较器 —— 基线只是"存着", 从不判断
//   "这次是不是比上次差"。于是每次优化都靠肉眼比对 CHANGELOG 里的成功率数字。
//
// 本脚本补上这一环: 读基线 + 最新报告 → 逐任务比对 → 掉分就非零退出。
//   判定口径刻意保守: 任何 pass→fail 都算回归 (不设容差), 因为单任务失败在大盘里会被平均掉;
//   fail→pass 记改进 (只报不拦)。样本不足 (覆盖率低) 也拦 —— 少跑几个任务的成功率不叫成功率。
//
// 用法:
//   node scripts/bench-gate.js                       # 基线 vs bench/report.json
//   node scripts/bench-gate.js --report <path>
//   node scripts/bench-gate.js --min-coverage 0.9    # 覆盖率下限 (默认 0.8)
//   node scripts/bench-gate.js --json                # 机读
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { noteCatch } from "../src/utils/catch-log.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(ROOT, "bench", "baseline.json");
const REPORT = path.join(ROOT, "bench", "report.json");

const getArg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const hasFlag = (n) => process.argv.includes(n);

// 逐任务比对 (纯函数, 便于单测): baseline/current 都是 {results:[{id, pass}]}
//   → { ok, regressions, improvements, missing, successRate:{before,after}, reasons }
export function compareBench(baseline, current, { minCoverage = 0.8, minSuccessDelta = 0 } = {}) {
  const b = new Map(((baseline && baseline.results) || []).map((r) => [r.id, r]));
  const c = new Map(((current && current.results) || []).map((r) => [r.id, r]));
  const regressions = [];
  const improvements = [];
  const missing = [];

  for (const [id, before] of b) {
    const after = c.get(id);
    if (!after) { missing.push(id); continue; }
    if (before.pass === true && after.pass !== true) {
      regressions.push({ id, before: true, after: false, detail: after.detail || after.error || null, cause: after.triage?.cause || null });
    } else if (before.pass !== true && after.pass === true) {
      improvements.push({ id });
    }
  }

  const rate = (m) => {
    const all = [...m.values()];
    if (!all.length) return 0;
    return all.filter((r) => r.pass === true).length / all.length;
  };
  const successRate = { before: Number(rate(b).toFixed(4)), after: Number(rate(c).toFixed(4)) };
  const coverage = b.size ? Number(Math.max(0, (c.size - missing.length) / b.size).toFixed(4)) : 0;

  const reasons = [];
  if (!b.size) reasons.push("基线为空: 先跑 node scripts/taskbench.js --baseline 建立基线");
  if (!c.size) reasons.push("没有当前报告: 先跑 node scripts/taskbench.js 生成 bench/report.json");
  if (regressions.length) reasons.push(`${regressions.length} 个任务由通过变失败: ${regressions.map((r) => r.id).join(", ")}`);
  if (coverage < minCoverage) reasons.push(`覆盖率 ${(coverage * 100).toFixed(0)}% 低于下限 ${(minCoverage * 100).toFixed(0)}% (少跑不等于跑过)`);
  if (successRate.after < successRate.before + minSuccessDelta) {
    reasons.push(`成功率 ${successRate.before} → ${successRate.after}, 低于基线`);
  }

  return {
    ok: reasons.length === 0,
    regressions,
    improvements,
    missing,
    coverage,
    successRate,
    reasons,
  };
}

function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    // 文件缺失/坏 JSON 都按"没有基线"处理, 但必须留痕 —— 静默当成空基线会让门禁假通过
    noteCatch(e);
    return null;
  }
}

function main() {
  const reportPath = getArg("--report") || REPORT;
  const minCoverage = Number(getArg("--min-coverage") ?? 0.8);
  const baseline = loadJson(BASELINE);
  const current = loadJson(reportPath);
  const r = compareBench(baseline, current, { minCoverage });

  if (hasFlag("--json")) {
    console.log(JSON.stringify({ baseline: BASELINE, report: reportPath, ...r }, null, 2));
  } else {
    console.log("=== 任务基准回归门禁 ===");
    console.log(`  基线: ${BASELINE}`);
    console.log(`  当前: ${reportPath}`);
    console.log(`  成功率: ${r.successRate.before} → ${r.successRate.after}  覆盖率 ${(r.coverage * 100).toFixed(0)}%`);
    if (r.regressions.length) {
      console.log(`  ✗ 回归 ${r.regressions.length} 项:`);
      for (const g of r.regressions) {
        console.log(`    - ${g.id}${g.cause ? ` [${g.cause}]` : ""}${g.detail ? `: ${String(g.detail).slice(0, 120)}` : ""}`);
      }
    }
    if (r.improvements.length) console.log(`  ✓ 改进 ${r.improvements.length} 项: ${r.improvements.map((x) => x.id).join(", ")}`);
    if (r.missing.length) console.log(`  · 缺失 ${r.missing.length} 项: ${r.missing.slice(0, 10).join(", ")}`);
    for (const why of r.reasons) console.log(`  ⚠ ${why}`);
    console.log(r.ok ? "  ✓ 通过 (没有任务退化)" : "  ✗ 未通过");
  }
  process.exit(r.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) main();
