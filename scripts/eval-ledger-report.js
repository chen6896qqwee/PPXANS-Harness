// scripts/eval-ledger-report.js - 生产账本双口径成功率报表 (评测-II P2-4)
//
// 背景 (2026-11-14 二次评测): 审计链的 ok 字段在 2026-11-13 isToolErrorResult 统一口径
//   之前把 "[exit=1 ...]" 开头的命令失败记成成功 —— 表面成功率 (95.9%) 与真实执行成功率
//   (64.1%) 差距巨大, 且"按设计拒绝" (安全闸门正确拦截) 与"真失败"混在一个桶里。
// 本脚本以**只读**方式聚合生产账本, 双口径并列输出, 不改写任何账本文件:
//   表面口径  = ok === true 的调用占比 (审计链原始语义)
//   严格口径  = 排除 [exit=N 开头 / 错误体 / 硬失败 后的净执行成功占比
//   分类      = success / exitNonzero / deniedByDesign (按设计拒绝) / softError / hardFail
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

export function classify(result, ok) {
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

// 聚合一份轨迹调用列表 ({ts, sessionId, ok, result}) → 报表对象
export function summarizeCalls(calls) {
  const byClass = { success: 0, exitNonzero: 0, deniedByDesign: 0, softError: 0, hardFail: 0 };
  const byDay = {};
  const bySess = new Map();
  for (const c of calls) {
    const cls = classify(c.result, c.ok);
    byClass[cls]++;
    const day = String(c.ts || "").slice(0, 10);
    const d = (byDay[day] ??= { total: 0, success: 0, hardFail: 0, softError: 0, exitNonzero: 0, deniedByDesign: 0 });
    d.total++; d[cls]++;
    let sess = bySess.get(c.sessionId);
    if (!sess) bySess.set(c.sessionId, sess = []);
    sess.push(c);
  }
  const total = calls.length;
  const surfaceOk = byClass.success + byClass.exitNonzero + byClass.deniedByDesign + byClass.softError;

  // 会话级链路: 零失败 (连按设计拒绝都没有) / 零执行失败 (拒绝算行为正确)
  const sessionChain = { total: bySess.size, zeroFailure: 0, zeroExecutionFailure: 0 };
  // 错误恢复率: 真失败 (非按设计拒绝) 后的下一步调用是否成功
  let recoveries = 0, recovered = 0;
  for (const seq of bySess.values()) {
    seq.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const classes = seq.map((c) => classify(c.result, c.ok));
    if (classes.every((c) => c === "success")) sessionChain.zeroFailure++;
    if (classes.every((c) => c === "success" || c === "deniedByDesign")) sessionChain.zeroExecutionFailure++;
    for (let i = 1; i < seq.length; i++) {
      const prev = classes[i - 1];
      if (prev === "success" || prev === "deniedByDesign") continue;
      recoveries++;
      if (classes[i] === "success") recovered++;
    }
  }

  return {
    totalCalls: total,
    classes: byClass,
    surface: { ok: surfaceOk, rate: total ? round4(surfaceOk / total) : null },
    strict: { ok: byClass.success, rate: total ? round4(byClass.success / total) : null },
    sessionChain,
    recovery: { events: recoveries, recovered, rate: recoveries ? round4(recovered / recoveries) : null },
    byDay: Object.fromEntries(Object.entries(byDay).map(([d, v]) => [d, {
      ...v,
      surfaceRate: v.total ? round4((v.total - v.hardFail) / v.total) : null,
      strictRate: v.total ? round4(v.success / v.total) : null,
    }])),
  };
}

// 读取生产账本 (只读): traces/*.jsonl 的 tool/call + audit.ndjson
export function buildLedgerReport({ traceDir, auditFile } = {}) {
  const traces = [];
  if (traceDir && fs.existsSync(traceDir)) {
    for (const f of fs.readdirSync(traceDir).filter((f) => /^2026-\d\d-\d\d\.jsonl$/.test(f)).sort()) {
      for (const line of fs.readFileSync(path.join(traceDir, f), "utf8").split("\n").filter(Boolean)) {
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o?.evt === "tool/call") traces.push(o);
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
      note: "traces = 带结果体的工具调用 (2026-11-03 起按天分片); deniedByDesign 是安全闸门正确拦截, 不算缺陷",
    },
    audit: {
      ...audit,
      surfaceRate: audit.total ? round4(audit.ok / audit.total) : null,
      note: "audit.ndjson 无结果体, 只能算表面口径; 严格口径以 trace 侧为准",
    },
    caliberContract: {
      surface: "ok===true / total (审计链原始语义)",
      strict: "排除 [exit=N 开头 / isToolErrorResult 错误体 / ok=false 后的成功占比",
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
  console.log(`严格口径: trace ${report.trace.strict.rate} (${report.trace.strict.ok}/${report.trace.totalCalls}) | 表面口径 ${report.trace.surface.rate} | 会话零失败 ${report.trace.sessionChain.zeroFailure}/${report.trace.sessionChain.total} | 恢复率 ${report.trace.recovery.rate}`);
}
