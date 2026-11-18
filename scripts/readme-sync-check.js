#!/usr/bin/env node
// scripts/readme-sync-check.js — README 数字锚点与实测事实的一致性门禁
//
// 背景: README 的 `<!-- readme-sync: {...} -->` 锚点和散文数字长期靠手改 —— 工具/技能/
//   测试数一变就漂. 本脚本把"可测的数字"重新变成门禁:
//     node scripts/readme-sync-check.js             只校验 (不跑测试, 秒级)
//     node scripts/readme-sync-check.js --fix       修正 README 锚点与散文数字
//     node scripts/readme-sync-check.js --fix --with-tests   跑全量测试并同步 tests/pass/skip
//
// 数字口径:
//   tools        agent.tools.list().length (catalog 全量, 含按需隐藏的工具)
//   skills       skills/**/SKILL.md 数量
//   core_schema  agent.tools.toOpenAI().length (默认 tool_exposure=core 的实际下发数)
//   ctx_tokens   system 实测 token + tools schema token (裸装配, 空 user)
//   mcp_tools    MCP tools/list 单页全量 (catalog + ppx.chat.* 虚拟工具)
//   tests/pass/skip  全量测试统计 (仅由 --with-tests 实测并刷新缓存; 普通 check/fix 只读旧缓存)
//   test_files   test/**/*.test.js 数量
//   offline_total / offline_legacy_total  静态任务全集 / 冻结旧题数 (绝不触发离线基准)
//   verify_checks  scripts/verify.js 静态声明的检查项数 (不执行 verify)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { McpServer } from "../src/mcp/server.js";
import { LEGACY_TASK_IDS, TASKS } from "../bench/tasks.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const README = path.join(ROOT, "README.md");
const CACHE = path.join(ROOT, "docs", "bench", "test-count.json");
const ANCHOR_RE = /<!-- readme-sync: (\{[^}]*\}) -->/;

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function countTests() {
  try { return walk(path.join(ROOT, "test")).filter((f) => f.endsWith(".test.js")).length; } catch { return 0; }
}

function countSkills() {
  try { return walk(path.join(ROOT, "skills")).filter((f) => /SKILL\.md$/i.test(f)).length; } catch { return 0; }
}

export function countVerifyChecks() {
  try {
    const source = fs.readFileSync(path.join(ROOT, "scripts", "verify.js"), "utf8");
    const block = source.match(/const CHECKS = \[([\s\S]*?)\n\];/);
    return block ? (block[1].match(/\{\s*name:/g) || []).length : 0;
  } catch { return 0; }
}

export async function measure() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-readme-sync-"));
  const agent = new PPXAgent({ root, configFile: null });
  try {
    const tools = agent.tools.list().length;
    const coreSchema = agent.tools.toOpenAI().length;
    agent._context("");
    const stats = agent._lastContextStats || {};
    const ctxTokens = (Number(stats.systemTokens) || 0) + (Number(stats.toolTokens) || 0);
    const srv = new McpServer(agent);
    const mcpTools = (await srv._listTools()).length;
    return {
      tools,
      skills: countSkills(),
      core_schema: coreSchema,
      ctx_tokens: ctxTokens,
      mcp_tools: mcpTools,
      test_files: countTests(),
      offline_total: TASKS.length,
      offline_legacy_total: LEGACY_TASK_IDS.length,
      verify_checks: countVerifyChecks(),
    };
  } finally {
    try { agent.shutdown(); } catch { /* 关闭失败不影响计数 */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录清理失败忽略 */ }
  }
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return null; }
}

function runTests() {
  // spec reporter: 汇总行是 "ℹ tests N / ℹ pass N"; 全量日志可达数十 MB, maxBuffer 必须放大
  //   (默认 1MB 会 ENOBUFS 截断 stdout, 表现为"解析不到统计")。
  const r = spawnSync(process.execPath, ["--test", "--test-force-exit", "test/"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1" },
  });
  const out = String(r.stdout || "") + "\n" + String(r.stderr || "");
  const num = (label) => {
    const matches = [...out.matchAll(new RegExp(`^ℹ ${label} (\\d+)$`, "gm"))];
    return matches.length ? Number(matches[matches.length - 1][1]) : null;
  };
  const count = { tests: num("tests"), pass: num("pass"), fail: num("fail"), skipped: num("skipped") };
  if (count.tests == null || count.pass == null) {
    throw new Error(`无法从测试输出解析统计 (exit=${r.status}, signal=${r.signal || "-"}, stdout=${String(r.stdout || "").length}B)`);
  }
  if (count.fail > 0) {
    throw new Error(`全量测试有 ${count.fail} 项失败 —— 先修绿再同步 README`);
  }
  return count;
}

function parseAnchor(md) {
  const m = String(md).match(ANCHOR_RE);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// 散文与锚点共用一份实测值。这里只替换静态可测口径; 基准通过数必须来自当次报告,
// 测试总项数也只有调用方显式提供 counts (--with-tests 或既有缓存) 时才同步。
export function syncProse(md, measured, counts) {
  let next = String(md);
  if (counts) {
    next = next.replace(
      /全量测试 \d+ 项 \(\d+ 通过 \/ \d+ 跳过\)/,
      `全量测试 ${counts.tests} 项 (${counts.pass} 通过 / ${counts.skipped} 跳过)`,
    );
  }
  next = next.replace(/(\*\*)\d+( 个内置工具 · 能力边界护栏)/, `$1${measured.tools}$2`);
  next = next.replace(/\*\*\d+ 内置工具\*\*/, `**${measured.tools} 内置工具**`);
  next = next.replace(/(- \*\*)\d+( 内置\*\*：)/, `$1${measured.tools}$2`);
  next = next.replace(/(只下发)(?:约 )?\d+( 个主干工具 schema)/, `$1 ${measured.core_schema}$2`);
  next = next.replace(/(`POST \/mcp` 暴露 )\d+( 工具)/, `$1${measured.mcp_tools}$2`);
  next = next.replace(/(tools\/call` — )\d+( 工具全量暴露)/, `$1${measured.mcp_tools}$2`);
  next = next.replace(/(一键本地快检 \()\d+( 项)/, `$1${measured.verify_checks}$2`);
  next = next.replace(/(工具系统 \()\d+( 个注册工具; MCP 另暴露)/, `$1${measured.tools}$2`);
  next = next.replace(/(测试 \()\d+( 文件)/, `$1${measured.test_files}$2`);
  next = next.replace(
    /(\*\*痛觉\*\*：`npm run taskbench:offline` —— )\d+( 个确定性判分任务（冻结旧 )\d+( \+ 后续 )\d+( 题）)/,
    `$1${measured.offline_total}$2${measured.offline_legacy_total}$3${measured.offline_total - measured.offline_legacy_total}$4`,
  );
  next = next.replace(
    /(\*\*离线任务基准口径\*\*：冻结旧 \*\*)\d+(\*\* 题，全量 \*\*)\d+(\*\* 题（后续 )\d+( 题）)/,
    `$1${measured.offline_legacy_total}$2${measured.offline_total}$3${measured.offline_total - measured.offline_legacy_total}$4`,
  );
  return next;
}

export function applyFix(md, measured, counts) {
  const merged = { ...(parseAnchor(md) || {}), ...measured };
  if (counts) {
    merged.tests = counts.tests;
    merged.pass = counts.pass;
    merged.skipped = counts.skipped;
  }
  const anchor = `<!-- readme-sync: ${JSON.stringify(merged)} -->`;
  const withAnchor = String(md).replace(ANCHOR_RE, anchor);
  return { next: syncProse(withAnchor, merged, counts), merged };
}

async function main() {
  const argv = new Set(process.argv.slice(2));
  const fix = argv.has("--fix");
  const withTests = argv.has("--with-tests");

  const measured = await measure();
  let counts = null;
  if (withTests) {
    counts = runTests();
  } else {
    const cache = readCache();
    if (cache && Number.isInteger(cache.tests) && Number.isInteger(cache.pass)) counts = cache;
  }

  const md = fs.readFileSync(README, "utf8");
  const anchor = parseAnchor(md);
  if (!anchor) {
    console.error("✗ README 缺少 readme-sync 机读锚点 (<!-- readme-sync: {...} -->)");
    process.exit(1);
  }

  if (fix) {
    // 普通 --fix 绝不重写缓存或 measuredAt: 旧测试统计不能伪装成本轮新实测。
    if (withTests && counts) {
      fs.mkdirSync(path.dirname(CACHE), { recursive: true });
      fs.writeFileSync(CACHE, JSON.stringify({ ...counts, measuredAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
    }
    const { next, merged } = applyFix(md, measured, counts);
    fs.writeFileSync(README, next, "utf8");
    console.log("✓ README 数字已同步");
    console.log(`  ${JSON.stringify(merged)}`);
    process.exit(0);
  }

  const expect = { ...measured };
  if (counts) {
    expect.tests = counts.tests;
    expect.pass = counts.pass;
    expect.skipped = counts.skipped;
  }
  const drift = [];
  for (const [k, v] of Object.entries(expect)) {
    if (anchor[k] !== v) drift.push(`${k}: README=${anchor[k]} 实测=${v}`);
  }
  if (syncProse(md, measured, counts) !== md) {
    drift.push("README 散文数字与机读锚点/实测口径不一致");
  }
  if (drift.length) {
    console.error("✗ README 数字与实测不一致:");
    for (const d of drift) console.error("  · " + d);
    console.error("  修复: node scripts/readme-sync-check.js --fix [--with-tests]");
    process.exit(1);
  }
  if (!counts) {
    console.log("· tests/pass/skip 未校验 (无缓存; 跑 --with-tests 可建立基线)");
  }
  console.log(`✓ README 数字一致 (${Object.keys(expect).length} 项)`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
