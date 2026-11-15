// src/selfcode/audit.js — 自审: 把代码图谱翻译成可执行的优化清单 (2026-11-02)
//
// 定位: graph.js 回答"长什么样", 本模块回答"哪里该动、先动哪里"。
//   皮皮虾自优化过去的闭环是"测试红 → 改代码", 缺一个**主动**入口:
//   没人报错时它不知道自己该优化什么。self_audit 补上这一环 —— 确定性扫描, 零 LLM,
//   输出评分 + 按严重度排序的 findings + 具体建议, 模型据此决定下一轮改哪里。
//
// 判定口径 (刻意保守, 不制造噪音):
//   · cycle / unresolved-import 是硬伤 (构建/运行会出问题), severity=high。
//   · unwired (产品不可达且无测试引用) 才是死代码候选; 有测试引用的标 reserved, 只提示不扣分。
//   · 巨石按行数分级; 静默 catch 只在 >80 行文件里看密度, 小文件不冤杀。
//   · 评分只用于趋势对比, 不追求绝对公平: 同一份代码两次扫描结果恒等 (无时间戳)。
import path from "node:path";
import { buildGraph, summarizeGraph, DEFAULT_SOURCE_DIRS } from "./graph.js";

const DEFAULT_AUDIT_THRESHOLDS = {
  hugeFileLines: 1200,
  largeFileLines: 600,
  silentCatchPerKLine: 6,
  minLinesForCatch: 80,
  minLinesForCatchCount: 10,
  maxFindings: 60,
};

const SEVERITY_PENALTY = {
  cycle: { each: 8, cap: 24 },
  "unresolved-import": { each: 5, cap: 15 },
  "unwired-module": { each: 3, cap: 12 },
  "oversized-module": { each: 4, cap: 16 },
  "large-module": { each: 1, cap: 8 },
  "silent-catch": { each: 2, cap: 8 },
  "swallowed-catch": { each: 2, cap: 6 },
};

function gradeOf(score) {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "E";
}

// 返回结构稳定 (数组排序固定、无时间戳)。调用方可以直接 JSON.stringify 做趋势对比。
export function runAudit({ root = process.cwd(), dirs = DEFAULT_SOURCE_DIRS, thresholds = {} } = {}) {
  const t = { ...DEFAULT_AUDIT_THRESHOLDS, ...(thresholds || {}) };
  const absRoot = path.resolve(root);
  const g = buildGraph({ root: absRoot, dirs });
  const summary = summarizeGraph(g, { top: 60 });
  const findings = [];
  const penalties = {};
  const addPenalty = (kind, n = 1) => {
    const p = SEVERITY_PENALTY[kind];
    if (!p) return;
    penalties[kind] = (penalties[kind] || 0) + p.each * n;
  };

  // ---- 1. 文件级依赖环 ----
  for (const c of summary.cycles) {
    findings.push({
      kind: "cycle",
      severity: "high",
      title: `文件级依赖环: ${c.length} 个文件互相 import`,
      files: c,
      advice: "抽公共底层模块、依赖倒置或把环上的一段改成事件/回调, 让依赖保持单向",
    });
  }
  addPenalty("cycle", summary.cycles.length);

  // ---- 2. 断链的相对 import ----
  for (const u of summary.unresolved) {
    findings.push({
      kind: "unresolved-import",
      severity: "high",
      title: `${u.file} 引用了不存在的相对路径`,
      files: [u.file],
      details: u.specs,
      advice: "删除失效 import, 或把文件放回原路径 (改名/删文件后最容易残留)",
    });
  }
  addPenalty("unresolved-import", summary.unresolved.length);

  // ---- 3. 死代码候选 vs 保留模块 ----
  for (const f of summary.unwired) {
    findings.push({
      kind: "unwired-module",
      severity: "medium",
      title: `${f} 产品不可达且无测试引用 (死代码候选)`,
      files: [f],
      advice: "确认无动态加载后删除, 或补测试/接线; 不确定时先保留并在 docs 标注用途",
    });
  }
  addPenalty("unwired-module", summary.unwired.length);
  if (summary.reserved.length) {
    findings.push({
      kind: "reserved-module",
      severity: "info",
      title: `${summary.reserved.length} 个模块产品不可达但被测试引用 (reserved, 不算死代码)`,
      files: summary.reserved,
      advice: "这些模块有测试契约兜底, 删除前先处理对应测试; 也可评估是否该接回产品链路",
    });
  }

  // ---- 4. 巨石文件 ----
  for (const s of summary.largest) {
    if (s.lines > t.hugeFileLines) {
      findings.push({
        kind: "oversized-module",
        severity: "high",
        title: `${s.file} 已 ${s.lines} 行 (阈值 ${t.hugeFileLines})`,
        files: [s.file],
        advice: "按职责拆分为 mixin/独立模块; 优先拆纯函数 (解析、格式化、策略) —— 它们最容易无痛外移",
      });
      addPenalty("oversized-module");
    } else if (s.lines > t.largeFileLines) {
      findings.push({
        kind: "large-module",
        severity: "medium",
        title: `${s.file} 已 ${s.lines} 行 (阈值 ${t.largeFileLines})`,
        files: [s.file],
        advice: "关注增长趋势; 新增功能优先放独立模块, 不要继续往巨石里堆",
      });
      addPenalty("large-module");
    }
  }

  // ---- 5. 静默 catch 热点 ----
  // 口径与 scripts/silent-catch-guard.mjs 同源 (catch-scan.js): 关键路径才扣分;
  //   非关键路径 (UI 回调/事件派发) 门禁明确允许, 这里只留 info 供趋势观察 ——
  //   两个工具对同一份代码必须给同一个结论。
  for (const s of summary.silentCatchHotspots) {
    if (s.lines < t.minLinesForCatch) continue;
    if (s.perKLine < t.silentCatchPerKLine) continue;
    if (s.silentCatches < t.minLinesForCatchCount) continue;
    const critical = (s.criticalSilentCatches || 0) > 0;
    findings.push({
      kind: "silent-catch",
      severity: critical ? "medium" : "info",
      critical,
      title: `${s.file}: ${s.silentCatches} 个静默 catch (${s.perKLine}/kL)${critical ? `, 其中关键路径 ${s.criticalSilentCatches}` : " · 非关键路径 (门禁允许)"}`,
      files: [s.file],
      details: s.loggedCatches ? [`已留痕 ${s.loggedCatches} 处 (noteCatch)`] : undefined,
      advice: critical
        ? "关键路径不要吞错: 改为 noteCatch(e) 留痕 (自动记录文件:行), 或把错误上抛给工具调用层"
        : "非关键路径允许静默; 若排查困难可改 noteCatch(e) 留痕, 不影响门禁",
    });
    if (critical) addPenalty("silent-catch");
  }

  // ---- 6. 关键路径吞错 (非空但无留痕) ----
  // 空块 catch 清零 ≠ 异常都被看见: `catch { return []; }` 既不是空块也不留痕,
  //   此前从所有指标里消失, 体检会把关键路径报成 0 (2026-11-03 补漏)。
  const criticalSwallowed = summary.catchTotals.criticalSwallowed;
  if (criticalSwallowed > 0) {
    const sites = summary.swallowedSites.filter((s) => s.critical);
    findings.push({
      kind: "swallowed-catch",
      severity: "medium",
      title: `关键路径吞错 ${criticalSwallowed} 处: 块非空但没有留痕 (空块口径看不到这里)`,
      files: [...new Set(sites.map((s) => s.file))].slice(0, 5),
      details: [
        ...sites.slice(0, 6).map((s) => `${s.file}:${s.line} fn=${s.fn || "?"}`),
        summary.catchTotals.criticalAcknowledged ? `另有 ${summary.catchTotals.criticalAcknowledged} 处已判读并标 swallowed-ok` : null,
      ].filter(Boolean),
      advice: "逐个人工判读: 真异常改 noteCatch(e) 留痕; 预期分支 (ENOENT 探针/损坏行跳过) 也应留痕或注释说明返回值含义 —— 不要用 return [] 伪装成「没有记录」",
    });
    addPenalty("swallowed-catch", Math.min(criticalSwallowed, 3));
  }

  const rawPenalty = Object.entries(penalties).reduce((sum, [kind, v]) => {
    const cap = SEVERITY_PENALTY[kind]?.cap ?? v;
    return sum + Math.min(v, cap);
  }, 0);
  const score = Math.max(0, 100 - rawPenalty);
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9)
    || String(a.kind).localeCompare(String(b.kind))
    || String(a.title).localeCompare(String(b.title)));
  const limited = findings.slice(0, Math.max(1, Number(t.maxFindings) || DEFAULT_AUDIT_THRESHOLDS.maxFindings));

  const metrics = {
    modules: summary.modules,
    edges: summary.edges,
    entries: summary.entries,
    reachable: summary.reachable,
    unreachable: summary.unreachable.length,
    reserved: summary.reserved.length,
    unwired: summary.unwired.length,
    cycles: summary.cycles.length,
    unresolvedImports: summary.unresolved.length,
    totalLines: summary.totalLines,
    silentCatches: summary.catchTotals.empty,
    criticalSilentCatches: summary.catchTotals.criticalEmpty,
    loggedCatches: summary.catchTotals.logged,
    swallowedCatches: summary.catchTotals.swallowed,
    criticalSwallowedCatches: criticalSwallowed,
    acknowledgedCatches: summary.catchTotals.acknowledged,
    criticalAcknowledgedCatches: summary.catchTotals.criticalAcknowledged,
    expiredAcks: summary.catchTotals.expiredAcks,
    undatedAcks: summary.catchTotals.undatedAcks,
    testFiles: g.tests.length,
    directlyTestedModules: g.testRefs.size,
    // 直接引用口径, 是下界 (集成测试/间接覆盖不计入), 只用于看趋势
    directTestCoveragePct: summary.modules ? Number((g.testRefs.size * 100 / summary.modules).toFixed(1)) : 0,
  };

  const recommendations = buildRecommendations({ findings: limited, metrics, thresholds: t });
  const bySeverity = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;

  return {
    ok: true,
    deterministic: true,
    root: absRoot,
    score,
    grade: gradeOf(score),
    penalties,
    bySeverity,
    metrics,
    findings: limited,
    truncated: findings.length > limited.length,
    totalFindings: findings.length,
    recommendations,
    summaryText: `${summary.modules} 模块 / ${summary.edges} 边 · 环 ${summary.cycles.length} · 断链 ${summary.unresolved.length} · 死代码候选 ${summary.unwired.length} · 评分 ${score} (${gradeOf(score)})`,
  };
}

function buildRecommendations({ findings, metrics, thresholds }) {
  const out = [];
  const kinds = (k) => findings.filter((f) => f.kind === k);
  const cycles = kinds("cycle");
  if (cycles.length) {
    out.push(`先解依赖环 (${cycles.length} 个): ${cycles[0].files.join(" ↔ ")} —— 环会让任何局部修改都可能波及整圈`);
  }
  const broken = kinds("unresolved-import");
  if (broken.length) {
    out.push(`修断链 import (${broken.length} 处): ${broken[0].files[0]} → ${(broken[0].details || []).join(", ")}`);
  }
  const big = findings.filter((f) => f.kind === "oversized-module" || f.kind === "large-module");
  if (big.length) {
    out.push(`优先拆最大的文件: ${big.slice(0, 3).map((f) => f.title.replace(/ 已 /, " ")).join("; ")}`);
  }
  const dead = kinds("unwired-module");
  if (dead.length) {
    out.push(`清理或接线死代码候选 (${dead.length} 个): ${dead.slice(0, 3).map((f) => f.files[0]).join(", ")}${dead.length > 3 ? " …" : ""}`);
  }
  const catches = kinds("silent-catch").filter((f) => f.critical);
  const swallowed = kinds("swallowed-catch");
  if (catches.length) {
    out.push(`关键路径静默 catch: ${catches.slice(0, 3).map((f) => f.files[0]).join(", ")} —— 改为 noteCatch(e) 或上抛错误`);
  } else if (metrics.loggedCatches) {
    out.push(`空块 catch 关键路径已清零 (留痕 ${metrics.loggedCatches} 处); 非关键路径门禁允许, 不必为凑数改代码`);
  }
  if (swallowed.length) {
    out.push(`关键路径吞错 ${metrics.criticalSwallowedCatches} 处 (块非空但 return 默认值、无留痕): 先看审计/记忆路径, 真异常改 noteCatch(e), 预期分支补注释`);
  }
  if (metrics.directTestCoveragePct < 35) {
    out.push(`直接测试覆盖 ${metrics.directTestCoveragePct}% 偏低: 新改动先用 impactOf 找相关测试, 没有就先补一条回归测试 (红→绿)`);
  }
  if (!out.length) {
    out.push("未发现结构性问题; 下一步用 impact_of 定位待改文件的影响面与相关测试, 做小步可验证的改动");
  }
  if (metrics.totalLines > 0) {
    out.push(`口径提示: 巨石阈值 ${thresholds.hugeFileLines}/${thresholds.largeFileLines} 行, 静默 catch 阈值 ${thresholds.silentCatchPerKLine}/kL (只有关键路径扣分); 可用 thresholds 覆盖`);
  }
  return out.slice(0, 8);
}

// 模型/CLI 直接可读的紧凑文本 (不塞整个 JSON)。
export function formatAudit(report, { maxPerKind = 4 } = {}) {
  const r = report;
  const lines = [];
  lines.push(`=== 皮皮虾自审 · ${r.score}/100 (${r.grade}) ===`);
  lines.push(r.summaryText);
  lines.push(`测试文件 ${r.metrics.testFiles} · 直接测试覆盖 ${r.metrics.directTestCoveragePct}% (下界) · 高 ${r.bySeverity.high} / 中 ${r.bySeverity.medium} / 低 ${r.bySeverity.low}`);
  const ack = r.metrics.acknowledgedCatches || 0;
  const staleAcks = (r.metrics.expiredAcks || 0) + (r.metrics.undatedAcks || 0);
  lines.push(`catch: 空块 ${r.metrics.silentCatches} · 已留痕 ${r.metrics.loggedCatches} · 关键路径吞错 ${r.metrics.criticalSwallowedCatches} / ${r.metrics.swallowedCatches} (全仓)${ack ? ` · 已判读 ${ack}` : ""}${staleAcks ? ` · 豁免失效 ${staleAcks}` : ""}`);
  const groups = new Map();
  for (const f of r.findings) {
    if (!groups.has(f.kind)) groups.set(f.kind, []);
    groups.get(f.kind).push(f);
  }
  for (const [kind, list] of groups) {
    lines.push(`\n[${kind}] ${list.length}`);
    for (const f of list.slice(0, maxPerKind)) {
      lines.push(`  · ${f.title}`);
      if (f.details?.length) lines.push(`    细节: ${f.details.join(", ")}`);
    }
    if (list.length > maxPerKind) lines.push(`  …另有 ${list.length - maxPerKind} 条`);
  }
  if (r.recommendations.length) {
    lines.push("\n建议 (按优先级):");
    r.recommendations.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  }
  return lines.join("\n");
}
