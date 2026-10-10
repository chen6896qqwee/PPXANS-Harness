// src/services/diagnose.js - Agent 自诊断 (2026-10-03, "按症状下药"表自动化)
// 数据源全部为本地白盒: 审计哈希链 (工具调用 ok/error/ms) + 失败案例库 + 使用统计 + 任务基线。
// 输出: 症状 → 根因 → 增强动作 (对齐强化框架的按症状下药表), 零 LLM 参与, 确定性可复现。
import fs from "node:fs";
import path from "node:path";
import { auditFile } from "../audit/audit-chain.js";

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

// 读审计链最近 maxLines 条, 聚合出工具级信号
function readAuditSignals(dataDir, maxLines = 5000) {
  const file = auditFile(dataDir);
  let lines = [];
  try { lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean); } catch { return null; }
  lines = lines.slice(-maxLines);
  const calls = [];
  for (const line of lines) {
    try { calls.push(JSON.parse(line)); } catch {}
  }
  if (!calls.length) return null;
  const byTool = new Map(); // tool -> {calls, fails, errors:{}}
  let paramErrors = 0, policyBlocks = 0, timeouts = 0;
  for (const c of calls) {
    const t = byTool.get(c.tool) || { calls: 0, fails: 0 };
    t.calls++;
    if (!c.ok) {
      t.fails++;
      const err = String(c.error || "");
      if (err.includes("参数错误")) paramErrors++;
      else if (err.includes("策略拦截") || err.includes("权限") || err.includes("审批")) policyBlocks++;
      else if (/超时|timeout/i.test(err)) timeouts++;
    }
    byTool.set(c.tool, t);
  }
  return { file, total: calls.length, byTool, paramErrors, policyBlocks, timeouts };
}

export function diagnoseAgent({ dataDir, rootDir = null, usageStats = null, topPerFinding = 3 } = {}) {
  const findings = [];
  const signals = {};

  // 1. 审计链信号
  const audit = readAuditSignals(dataDir);
  signals.audit = audit ? { total: audit.total, paramErrors: audit.paramErrors, policyBlocks: audit.policyBlocks, timeouts: audit.timeouts } : null;
  if (audit) {
    // 症状: 工具调用错 (参数类)
    if (audit.paramErrors > 0) {
      findings.push({
        severity: "info",
        symptom: `参数校验器拦截了 ${audit.paramErrors} 次错误参数 (未浪费 LLM 轮次)`,
        rootCause: "模型传参不规范 / 工具 schema 描述不够清晰",
        action: "参数校验已生效; 若同一工具反复被拦, 优先完善该工具的参数描述与示例",
      });
    }
    // 症状: 权限拦截频繁
    if (audit.policyBlocks >= 3) {
      findings.push({
        severity: "medium",
        symptom: `权限/策略拦截 ${audit.policyBlocks} 次`,
        rootCause: "权限配置与当前任务错配 (最小权限不等于处处设卡)",
        action: "用 PERMISSION_PRESETS 切换沙箱档位, 或对确需的高频工具 addRule allow (opencode 规则链)",
      });
    }
    // 症状: 单工具失败率异常
    for (const [tool, t] of audit.byTool) {
      if (t.calls >= 5 && t.fails / t.calls > 0.3) {
        findings.push({
          severity: "high",
          symptom: `工具 ${tool} 失败率 ${(100 * t.fails / t.calls).toFixed(0)}% (${t.fails}/${t.calls})`,
          rootCause: "工具 schema 不清晰 / 实现缺陷 / 上游依赖不稳",
          action: `优先修复 ${tool}: 补参数描述与示例 + 失败重试 (idempotent) + 结果验证器`,
        });
      }
    }
    // 症状: 超时
    if (audit.timeouts >= 2) {
      findings.push({
        severity: "medium",
        symptom: `工具超时 ${audit.timeouts} 次`,
        rootCause: "上游依赖不稳 / timeoutMs 配置过紧",
        action: "对幂等工具启用重试; 检查 timeoutMs 与上游可用性",
      });
    }
  }

  // 2. 失败案例库
  const episodes = readJson(path.join(dataDir, "memory", "failures", "episodes.json"), []);
  signals.failureEpisodes = episodes.length;
  if (episodes.length >= 3) {
    findings.push({
      severity: "medium",
      symptom: `失败案例库 ${episodes.length} 条 (近端: ${episodes.slice(0, topPerFinding).map((e) => e.tool).join(", ")})`,
      rootCause: "同类失败反复出现 = 系统性短板, 非偶发",
      action: "对高频失败做归因分类 (知识/工具/规划/验证/记忆), 逐类补齐; 每次修复后跑回归",
    });
  }

  // 3. 使用统计 (成本症状)
  const usage = usageStats || readJson(path.join(dataDir, "usage-stats.json"), null);
  signals.usage = usage;
  if (usage && usage.calls >= 5) {
    const costPerCall = Math.round(usage.tokens / usage.calls);
    if (costPerCall > 15000) {
      findings.push({
        severity: "medium",
        symptom: `单次调用平均 ${costPerCall} tok (共 ${usage.calls} 次)`,
        rootCause: "全用大模型 / 上下文冗余",
        action: "启用 model_routing.aux 分层路由 (辅助任务走便宜模型) + 检查上下文压缩是否生效",
      });
    }
  }

  // 4. 任务基线 (规划症状): 只读显式提供的 rootDir, 不回落 cwd (避免跨仓库污染诊断)
  let baseline = readJson(path.join(dataDir, "baseline.json"), null);
  if (!baseline && rootDir) baseline = readJson(path.join(rootDir, "bench", "baseline.json"), null);
  if (baseline && Array.isArray(baseline.results)) {
    const fails = baseline.results.filter((r) => !r.pass);
    signals.baseline = { coverage: `${baseline.results.length} 任务`, failures: fails.length };
    if (fails.length) {
      findings.push({
        severity: "high",
        symptom: `任务基线有 ${fails.length} 项未通过: ${fails.slice(0, topPerFinding).map((f) => f.id).join(", ")}`,
        rootCause: "规划差 / 验证缺失 / 环境限制 (需人工判定)",
        action: "任务分解 + 验证器 + 重规划; 先人工复跑确认是真实失败还是环境误伤",
      });
    }
  }

  if (!findings.length) {
    findings.push({ severity: "ok", symptom: "未检出系统性短板", rootCause: "各信号均在阈值内", action: "保持既有节奏: 跑基准 → 找短板 → 优化 → 对比" });
  }

  // 报告渲染
  const L = ["═══ 皮皮虾自诊断报告 ═══", ""];
  L.push(`审计信号: ${signals.audit ? `${signals.audit.total} 次工具调用 (参数错 ${signals.audit.paramErrors} / 策略拦 ${signals.audit.policyBlocks} / 超时 ${signals.audit.timeouts})` : "(无审计数据)"}`);
  L.push(`失败案例: ${signals.failureEpisodes} 条 | 使用: ${signals.usage ? `${signals.usage.calls} 次 / ${signals.usage.tokens} tok` : "(无数据)"}`);
  L.push(`任务基线: ${signals.baseline ? `${signals.baseline.coverage}, ${signals.baseline.failures} 项未通过` : "(未建立)"}`);
  L.push("");
  for (const f of findings) {
    L.push(`[${f.severity.toUpperCase()}] ${f.symptom}`);
    L.push(`  根因: ${f.rootCause}`);
    L.push(`  动作: ${f.action}`);
    L.push("");
  }
  return { report: L.join("\n").trim(), findings, signals };
}
