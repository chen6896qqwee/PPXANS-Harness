#!/usr/bin/env node
// scripts/verify.js — 一键本地质量闸门 (offline, 零真实 LLM 调用)
// 把项目里分散的快速检查收敛为一条命令:
//   node scripts/verify.js           只打印通过/失败摘要
//   node scripts/verify.js --verbose 额外打印每个闸门尾部输出
// 退出码: 0 = 全部通过; 1 = 存在失败。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const NODE = process.execPath;

const CHECKS = [
  { name: "依赖完整性 (depcheck)",          file: "scripts/depcheck.js",             args: ["."] },
  { name: "架构守卫 (arch-guard)",          file: "scripts/arch-guard.js",           args: ["--check"] },
  { name: "README 数字同步",                file: "scripts/readme-sync-check.js",    args: [] },
  { name: "功能宣称闸门 (claim-gate)",      file: "scripts/claim-gate.js",           args: [] },
  { name: "Web UI 静态检查",                file: "scripts/check-web.mjs",           args: [] },
  { name: "审计链校验",                     file: "scripts/audit-verify.js",         args: [] },
  { name: "自愈基准",                       file: "scripts/selfheal-bench.js",       args: [] },
  { name: "技能格式检查",                   file: "scripts/skill-lint.js",           args: [] },
  { name: "缓存前缀审计",                   file: "scripts/cache-audit.js",          args: ["--check"] },
  { name: "上下文预算检查",                 file: "scripts/ctx-profile.js",          args: ["--check"] },
  { name: "本地能力评测",                   file: "scripts/eval.js",                 args: [] },
  // 痛觉闸门 (2026-10-30): 20 个确定性判分任务走真实工具循环, 离线零 LLM, 约 4s。
  //   它拦的是"harness 把正确计划执行错了" —— 路径解析/参数校验/超时/落盘/记忆写入。
  //   注意 --strict: 有任务红就非零退出, 否则它只是个报表。
  { name: "离线任务基准",                   file: "scripts/taskbench-offline.js",    args: ["--strict"] },
  // 记忆召回闸门 (2026-10-30): holdout 集 recall@3 低于 90% 即失败。
  //   防的是"改检索/分词/RRF 权重把召回打回去" —— 这条以前完全没人看着。
  { name: "记忆召回质量",                   file: "scripts/memory-recall.js",        args: ["--check"] },
  { name: "静默 catch 守卫",                file: "scripts/silent-catch-guard.mjs",  args: [] },
];

const verbose = process.argv.includes("--verbose");
let failed = 0;

for (const check of CHECKS) {
  const r = spawnSync(NODE, [check.file, ...check.args], {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, NO_COLOR: "1" },
  });
  const ok = r.status === 0;
  console.log(`  ${ok ? "✓" : "✗"} ${check.name}${ok ? "" : ` (exit ${r.status})`}`);
  if (!ok || verbose) {
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
    if (out) {
      const lines = out.split(/\r?\n/).slice(-25);
      for (const line of lines) console.log(`      ${line}`);
    }
    console.log("");
  }
  if (!ok) failed++;
}

console.log(`\n结果: ${CHECKS.length - failed}/${CHECKS.length} 项通过${failed ? `, ${failed} 项失败` : ""}`);
process.exitCode = failed ? 1 : 0;