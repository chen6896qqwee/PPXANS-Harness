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
  // 自研溯源 (2026-11-02): 禁止上游 import/vendored 标记; 每个设计来源必须有原生模块与文档登记。
  { name: "自研溯源 (native-guard)",        file: "scripts/native-guard.js",         args: [] },
  // 版本收口 (2026-11-02): package / lock / CHANGELOG / README 版本必须一致。
  { name: "版本号一致性",                   file: "scripts/version-sync.js",         args: [] },
  { name: "Web UI 静态检查",                file: "scripts/check-web.mjs",           args: [] },
  { name: "审计链校验",                     file: "scripts/audit-verify.js",         args: [] },
  { name: "自愈基准",                       file: "scripts/selfheal-bench.js",       args: [] },
  { name: "技能格式检查",                   file: "scripts/skill-lint.js",           args: [] },
  { name: "缓存前缀审计",                   file: "scripts/cache-audit.js",          args: ["--check"] },
  // 价格覆盖 (2026-11-12): 云端预设模型必须有价; 价格表条目/阶梯必须合法。
  //   拦的是"换了新模型名, 账本静默按 $0 记账, 预算闸门形同虚设"。
  { name: "价格覆盖审计",                   file: "scripts/pricing-audit.js",        args: ["--check"] },
  { name: "上下文预算检查",                 file: "scripts/ctx-profile.js",          args: ["--check"] },
  { name: "本地能力评测",                   file: "scripts/eval.js",                 args: [] },
  // 痛觉闸门 (2026-10-30): 20 个确定性判分任务走真实工具循环, 离线零 LLM, 约 4s。
  //   它拦的是"harness 把正确计划执行错了" —— 路径解析/参数校验/超时/落盘/记忆写入。
  //   注意 --strict: 有任务红就非零退出, 否则它只是个报表。
  { name: "离线任务基准",                   file: "scripts/taskbench-offline.js",    args: ["--strict"] },
  // 记忆召回闸门 (2026-10-30): holdout 集 recall@3 低于 90% 即失败。
  //   防的是"改检索/分词/RRF 权重把召回打回去" —— 这条以前完全没人看着。
  { name: "记忆召回质量",                   file: "scripts/memory-recall.js",        args: ["--check"] },
  // 静默 catch 门禁 (2026-11-03): 必须 --strict —— 曾以 report 模式挂在这里, 永远 PASS,
  //   等于检查项存在但不拦人。scope 无效同样失败 (手填 if/for 等于没留位置)。
  { name: "静默 catch 守卫",                file: "scripts/silent-catch-guard.mjs",  args: ["--strict"] },
  // 文案门禁 (2026-11-13): 内核叫法 (本体/空间/工单/身体/轨迹/姿态/生命周期) 不许漏进
  //   用户可见文案 —— 词典 webapp/src/i18n/lexicon.js 是唯一出口, 这条闸门保证它真的生效。
  { name: "界面文案一致性 (lexicon)",       file: "scripts/lexicon-check.js",        args: [] },
  // README 数字同步 (2026-11-16): 工具/技能/schema/ctx/MCP/测试文件数与机读锚点一致。
  //   tests/pass/skip 不在这里跑 (全量测试 30s+), 由 readme:sync --with-tests 重建缓存。
  { name: "README 数字同步",                file: "scripts/readme-sync-check.js",    args: ["--check"] },
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