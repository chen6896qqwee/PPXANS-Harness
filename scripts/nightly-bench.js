#!/usr/bin/env node
// scripts/nightly-bench.js - 公开可复现跑分报告生成器 (2026-10-24)
// 背景: ROADMAP-LIGHTKERNEL 承认"基准脚本齐备但对外讲不出数" —— 缺一条可第三方复现的
//   报告链。本脚本把已有的四道基准收敛成一次运行:
//     ① eval        本地能力评测 (7 项, 离线零 LLM)
//     ② bench       内核吞吐压测 (stub LLM, p50/p95/p99)
//     ③ selfheal    自愈基准 (7/7 门禁)
//     ④ audit:verify 审计链完整性
//   产出两份文件:
//     docs/bench/nightly-<date>.json  机器读 (可 diff/画趋势)
//     docs/bench/nightly-<date>.md    人读报告 (环境/命令/逐项结果)
// 用法: node scripts/nightly-bench.js [--out docs/bench]
//       PPX_BENCH_ROUNDS / PPX_BENCH_CONCURRENCY 透传给 bench 子进程
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDirArgIdx = process.argv.indexOf("--out");
const OUT_DIR = path.join(ROOT, outDirArgIdx >= 0 ? process.argv[outDirArgIdx + 1] : "docs", outDirArgIdx >= 0 ? "" : "bench");
const date = new Date().toISOString().slice(0, 10);
const NODE = process.execPath;
const RAW_MARKER = "PPX_BENCH_RAW_JSON";
const RAW_PHASES = new Set(["concurrent", "long_session", "isolated_concurrent", "serial"]);
const validIndex = (value) => Number.isInteger(value) && value >= 0;

function parseRawBenchOutput(out) {
  const markerLines = out.split(/\r?\n/).filter((line) => new RegExp(`^${RAW_MARKER}(?:\\s|$)`).test(line));
  if (markerLines.length !== 1) throw new Error(`bench raw marker 应恰好出现一次, 实际 ${markerLines.length}`);

  let payload;
  try { payload = JSON.parse(markerLines[0].slice(RAW_MARKER.length).trim()); }
  catch { throw new Error("bench raw marker JSON 损坏"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("bench raw payload 必须是对象");
  if (payload.raw_schema !== 1) throw new Error("bench raw_schema 缺失或不受支持");
  if (!validIndex(payload.count)) throw new Error("bench raw count 缺失或无效");
  if (!Array.isArray(payload.raw_requests) || payload.raw_requests.length !== payload.count) {
    throw new Error("bench raw_requests 缺失或 count 不一致");
  }

  payload.raw_requests.forEach((request, index) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error(`raw_requests[${index}] 必须是对象`);
    if (!RAW_PHASES.has(request.phase)) throw new Error(`raw_requests[${index}].phase 缺失或无效`);
    if (typeof request.sessionKey !== "string" || !request.sessionKey) throw new Error(`raw_requests[${index}].sessionKey 缺失或无效`);
    if (typeof request.ok !== "boolean") throw new Error(`raw_requests[${index}].ok 缺失或无效`);
    if (!Number.isFinite(request.ms) || request.ms < 0) throw new Error(`raw_requests[${index}].ms 缺失或无效`);
    if (request.worker !== undefined && !validIndex(request.worker)) throw new Error(`raw_requests[${index}].worker 无效`);
    if (!validIndex(request.round)) throw new Error(`raw_requests[${index}].round 缺失或无效`);
    if ((request.phase === "concurrent" || request.phase === "isolated_concurrent") && !validIndex(request.worker)) {
      throw new Error(`raw_requests[${index}].worker 缺失或无效`);
    }
  });
  return { raw_schema: payload.raw_schema, count: payload.count, raw_requests: payload.raw_requests };
}

// 每个子基准: 命令 + 关键行提取 (正则 → 字段)。提取失败不判死, 原文保留。
const BENCHES = [
  { key: "eval", name: "本地能力评测 (eval)", file: "scripts/eval.js",
    extract: (out) => ({
      passed: /(\d+)\s*过\s*\/\s*(\d+)\s*挂/.exec(out)?.slice(1, 3).join("/") ?? null,
    }) },
  { key: "bench", name: "内核吞吐压测 (bench)", file: "scripts/bench.js",
    extract: (out) => ({
      p50_ms: /p50 (\d+(?:\.\d+)?)ms/.exec(out)?.[1] ?? null,
      p95_ms: /p95 (\d+(?:\.\d+)?)ms/.exec(out)?.[1] ?? null,
      p99_ms: /p99 (\d+(?:\.\d+)?)ms/.exec(out)?.[1] ?? null,
      per_round_ms: /([\d.]+)ms\/轮/.exec(out)?.[1] ?? null,
    }) },
  { key: "selfheal", name: "自愈基准 (selfheal)", file: "scripts/selfheal-bench.js",
    extract: (out) => ({ score: /(\d+)\s*\/\s*(\d+)/.exec(out)?.slice(1, 3).join("/") ?? null }) },
  { key: "audit", name: "审计链校验 (audit:verify)", file: "scripts/audit-verify.js",
    extract: (out) => ({ integrity: /链完整性: (完整|已损坏)/.exec(out)?.[1] ?? null, signed: /HMAC: (启用|未启用)/.exec(out)?.[1] ?? null }) },
];

const results = [];
let allOk = true;
for (const b of BENCHES) {
  const t0 = Date.now();
  const r = spawnSync(NODE, [b.file], { cwd: ROOT, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const metrics = r.status === 0 ? b.extract(out) : {};
  let ok = r.status === 0;
  const result = {
    key: b.key, name: b.name, ok, exit: r.status, duration_ms: Date.now() - t0, metrics,
    tail: out.split(/\r?\n/).filter((line) => line && !new RegExp(`^${RAW_MARKER}(?:\\s|$)`).test(line)).slice(-12),
  };
  if (b.key === "bench") {
    try { Object.assign(result, parseRawBenchOutput(out)); }
    catch { ok = false; result.ok = false; }
  }
  if (!ok) allOk = false;
  results.push(result);
  console.log(`  ${ok ? "✓" : "✗"} ${b.name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

const report = {
  date,
  generated_at: new Date().toISOString(),
  reproducible: "node scripts/nightly-bench.js",
  env: { node: process.version, platform: `${os.platform()} ${os.arch()}`, cpus: os.cpus().length, bench_rounds: process.env.PPX_BENCH_ROUNDS || "200", bench_concurrency: process.env.PPX_BENCH_CONCURRENCY || "20" },
  all_ok: allOk,
  results,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const jsonPath = path.join(OUT_DIR, `nightly-${date}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

const md = [
  `# 皮皮虾 Nightly 基准报告 — ${date}`,
  "",
  `- 复现命令: \`node scripts/nightly-bench.js\`（零 LLM、零网络, 全部 stub 隔离）`,
  `- 环境: Node ${report.env.node} · ${report.env.platform} · ${report.env.cpus} CPU · bench ${report.env.bench_rounds} 轮 / 并发 ${report.env.bench_concurrency}`,
  `- 总体: ${allOk ? "✅ 全部通过" : "❌ 存在失败"}`,
  "",
  "| 基准 | 结果 | 耗时 | 关键指标 |",
  "|---|---|---|---|",
  ...results.map((r) => `| ${r.name} | ${r.ok ? "✅" : "❌ (exit " + r.exit + ")"} | ${(r.duration_ms / 1000).toFixed(1)}s | ${Object.entries(r.metrics).map(([k, v]) => `${k}=${v}`).join(" · ") || "-"} |`),
  "",
  "> 机器可读: 本目录同名 .json（字段稳定, 可直接 diff/画趋势）。CI 每晚自动运行: .github/workflows/nightly.yml",
  "",
].join("\n");
fs.writeFileSync(path.join(OUT_DIR, `nightly-${date}.md`), md);

console.log(`\n报告: ${path.relative(ROOT, jsonPath)} + .md`);
process.exitCode = allOk ? 0 : 1;
