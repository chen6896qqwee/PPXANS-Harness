#!/usr/bin/env node
// scripts/taskbench-offline.js — 「痛觉」: 离线任务成功率基准 (2026-10-30)
//
// 问题: 守卫测试只证明"功能没被改坏", 不证明"事情能干成"。
//   而 taskbench.js 要真 LLM 才能跑 —— 没有 key 的时候, 任何优化都只能靠猜。
//
// 做法: 复用 bench/tasks.js 里 28 个**确定性判分**的任务 (verify 不用 LLM 评审), 给它配一个
//   脚本化模型 (bench/offline-plans.js): 每个任务回放一份"人类会怎么走"的工具序列, 走
//   **真实的** agent 工具循环 (runToolLoop → _runTool → 沙箱落盘), 最后跑原 verify。
//
// 它测的是 **harness 把一个正确计划执行成结果的能力**, 不是模型有多聪明:
//   路径解析 / 参数校验 / 命令超时 / 结果截断 / 文件落盘 / 记忆写入 —— 哪一环有毛病都会现形。
//   跑红了就是身体的毛病, 不是模型的锅。
//
// 用法:
//   node scripts/taskbench-offline.js               # 人读表格
//   node scripts/taskbench-offline.js --json        # 机读 (给面板/CI)
//   node scripts/taskbench-offline.js --json --out docs/bench/offline.json
//   node scripts/taskbench-offline.js --only fix-syntax,json-edit
//   node scripts/taskbench-offline.js --strict      # 任一选中任务失败即非零退出 (CI 用)
//   node scripts/taskbench-offline.js --list        # 只列任务
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendHistory } from "./lib/bench-history.js";
import { noteCatch } from "../src/utils/catch-log.js";
import { LEGACY_TASK_IDS, TASKS } from "../bench/tasks.js";
import { OFFLINE_PLANS, planCoverage } from "../bench/offline-plans.js";
import { runOne } from "./taskbench.js";
import { PPXAgent } from "../src/agent/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");
const STRICT = argv.includes("--strict");
const LIST = argv.includes("--list");
const onlyIdx = argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? String(argv[onlyIdx + 1] || "").split(",").map((s) => s.trim()).filter(Boolean) : null;
const outIdx = argv.indexOf("--out");
const OUT = outIdx >= 0 ? String(argv[outIdx + 1] || "").trim() : null;

const roundedRate = (passed, total) => total ? Math.round((passed / total) * 1000) / 1000 : 0;

// legacy.total 是本次实际选中的旧题数; complete 只在冻结的 20 个 ID 全部出现时成立。
// 因而 --only 子集可以 rate=1, 但不能冒充完整的旧 20 题结果。
export function summarizeLegacy(results) {
  const rows = results.filter((r) => LEGACY_TASK_IDS.includes(r.id));
  const ids = new Set(rows.map((r) => r.id));
  const passed = rows.filter((r) => r.pass === true).length;
  return {
    total: rows.length,
    passed,
    rate: roundedRate(passed, rows.length),
    complete: rows.length === LEGACY_TASK_IDS.length && LEGACY_TASK_IDS.every((id) => ids.has(id)),
  };
}

export function buildOfflineReport(results, ms, ts = new Date().toISOString()) {
  const passed = results.filter((r) => r.pass === true).length;
  return {
    kind: "taskbench-offline",
    ts,
    node: process.version,
    platform: process.platform,
    total: results.length,
    passed,
    rate: roundedRate(passed, results.length),
    legacy: summarizeLegacy(results),
    ms,
    results,
  };
}

export function serializeOfflineReport(report) {
  return JSON.stringify(report, null, 2);
}

export function offlineExitCode(results, strict) {
  return strict && results.some((r) => r.pass !== true) ? 1 : 0;
}

export function writeOfflineReport(outPath, serialized) {
  const target = path.resolve(outPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, serialized + "\n", "utf8");
  return target;
}

/**
 * 脚本化模型: 第 i 次调用回放第 i 步工具调用, 步数用完后给最终回复。
 * 故意做成"完美的计划者"—— 这样任何失败都只能归到 harness 或判分器, 不归到模型能力。
 */
function scriptedLLM(plan) {
  let i = 0;
  const calls = [];
  return {
    model: "offline-script",
    backend: "http",
    vision: false,
    supportsNativeToolCalls: true,
    supportsStream: false,
    calls,
    async apiChat(messages) {
      const step = plan.steps[i];
      if (step) {
        i += 1;
        const id = `off-${i}`;
        calls.push({ tool: step.tool, args: step.args || {} });
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args || {}) } }],
          },
        };
      }
      return { message: { role: "assistant", content: plan.reply || "(已完成)", tool_calls: null } };
    },
    async health() { return true; },
  };
}

function makeOfflineAgent(taskId) {
  return (sandbox) => {
    const agent = new PPXAgent({
      root: sandbox,
      configFile: null, // 不起仓库配置: 离线基准不需要任何 provider/key
      dataDir: path.join(sandbox, ".ppx"),
      globalDataDir: path.join(sandbox, ".ppx-global"),
    });
    const llm = scriptedLLM(OFFLINE_PLANS[taskId]);
    agent.llm = llm;
    agent.allProviders = [llm];
    // 危险工具默认会被免疫闸门拦下 (独立于审批的第二道防线, 这是设计)。
    // 基准要测的是"授信之后能不能把事干成", 所以对**计划里实际用到**的工具逐个显式授信 ——
    // 而不是全局放水: 没写进计划里的危险工具仍然拦着。
    for (const step of OFFLINE_PLANS[taskId].steps) {
      try { agent.approveGuard?.(step.tool); } catch { /* 无闸门实例时跳过 */ }
    }
    return agent;
  };
}

async function main() {
  if (outIdx >= 0 && (!OUT || OUT.startsWith("--"))) {
    console.error("✗ --out 需要报告文件路径");
    process.exit(2);
  }

  // 覆盖率自检: 任务有、计划没有 = 痛觉有盲区。宁可报出来, 也不静默跳过。
  const { missing, extra } = planCoverage(TASKS.map((t) => t.id));
  if (missing.length) {
    console.error(`✗ 以下任务没有离线计划 (痛觉盲区): ${missing.join(", ")}`);
    process.exit(2);
  }
  if (extra.length && !JSON_OUT) console.warn(`! 计划里有任务集不存在: ${extra.join(", ")}`);

  if (LIST) {
    for (const t of TASKS) console.log(`${t.id.padEnd(22)} [${t.category}] ${t.task.slice(0, 40)}`);
    process.exit(0);
  }

  const selected = ONLY ? TASKS.filter((t) => ONLY.includes(t.id)) : TASKS;
  if (ONLY && !selected.length) {
    console.error(`✗ --only 没匹配到任务: ${ONLY.join(", ")}`);
    process.exit(2);
  }

  const results = [];
  const t0 = Date.now();
  for (const task of selected) {
    let r;
    try {
      r = await runOne(task, { quiet: true, createAgent: makeOfflineAgent(task.id) });
    } catch (e) {
      r = { id: task.id, pass: false, detail: `执行器异常: ${e?.message || e}`, ms: 0 };
    }
    results.push({
      id: task.id,
      category: task.category,
      pass: r.pass === true,
      detail: r.detail || (r.verdict && r.verdict.detail) || "",
      ms: r.ms || 0,
    });
  }
  const totalMs = Date.now() - t0;
  const passed = results.filter((r) => r.pass).length;
  const rate = results.length ? passed / results.length : 0;
  const report = buildOfflineReport(results, totalMs);
  const serialized = serializeOfflineReport(report);

  if (JSON_OUT) {
    console.log(serialized);
  } else {
    console.log(`皮皮虾离线任务基准 | ${results.length} 个任务 | 脚本化计划 (零 LLM 零网络)\n`);
    let lastCat = null;
    for (const r of results) {
      if (r.category !== lastCat) { console.log(`── ${r.category} ──`); lastCat = r.category; }
      console.log(`  ${r.pass ? "✓" : "✗"} ${r.id.padEnd(22)} ${String(r.ms).padStart(5)}ms${r.pass ? "" : `  ← ${r.detail}`}`);
    }
    console.log(`\n=== 结果: ${passed}/${results.length} 通过 (${(rate * 100).toFixed(1)}%) | 总耗时 ${(totalMs / 1000).toFixed(1)}s ===`);
    console.log(`旧 20 题口径: ${report.legacy.passed}/${report.legacy.total} 通过 | complete=${report.legacy.complete}`);
    if (passed < results.length) {
      console.log("\n失败 = harness 没能把正确计划执行成结果 (路径/校验/超时/落盘), 不是模型能力问题。");
    }
  }

  if (OUT) {
    try {
      const target = writeOfflineReport(OUT, serialized);
      if (!JSON_OUT) console.log(`机读报告已写入: ${target}`);
    } catch (e) {
      console.error(`✗ --out 写入失败: ${e?.message || e}`);
      process.exit(1);
    }
  }

  // 落一份历史 (面板/趋势用; 失败不影响退出码)。--out 不替代也不抑制既有历史。
  try {
    const dir = path.join(ROOT, "data", "bench");
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(dir, `taskbench-offline-${day}.json`), JSON.stringify({
      ts: report.ts,
      total: results.length,
      passed,
      rate,
      legacy: report.legacy,
      ms: totalMs,
      results,
    }, null, 2));
    // 趋势条目保持原有字段与未舍入 rate, 避免改变面板历史口径。
    appendHistory(dir, "taskbench-offline", { total: results.length, passed, rate, ms: totalMs });
  } catch (e) { noteCatch("scripts/taskbench-offline.js#main", e); /* 存档失败不影响基准本身 */ }

  process.exit(offlineExitCode(results, STRICT));
}

// 测试 import 纯函数时不执行任务、不写历史; 只有 CLI 直跑才进入 main。
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
