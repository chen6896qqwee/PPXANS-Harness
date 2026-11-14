#!/usr/bin/env node
// scripts/external-bench.js — 外部基准适配器 (2026-11-14)
//
// 动机: 仓库全部基准 (taskbench/selfheal/memory-recall) 都是自建的 —— 防回归一流,
//   但回答不了"和外部水平比怎么样"。本脚本把 agent 接到**外部基准的数据格式**上:
//   GAIA 文本题风格 (question + 短答案 + 确定性判分), 数据集由使用者提供。
//
// 数据格式 (JSONL, 每行一题):
//   {"id": "gaia-001", "question": "...", "answer": "...", "eval_type": "exact_match", "files": {"notes.txt": "..."}}
//   eval_type ∈ exact_match (归一化后包含) | contains (全词命中) | numeric (数值容差)
//   files: 可选, {文件名: 内容} → 落进任务沙箱供 agent 读取
// GAIA 数据集本身是 gated 下载 (HuggingFace), **不进仓库**; bench/external/sample.jsonl
//   是 4 条合成样本, 只用于离线自检管线 (category 标 synthetic-*, 不是真 GAIA 题)。
// 转换方法见 docs/EXTERNAL-BENCH.md。
//
// 判分协议: 题目末尾追加"FINAL ANSWER: "协议 (GAIA 官方口径) —— agent 的最终答案
//   独占一行时判分只认那一行, 没有则回退全文。判分器全部纯函数导出, 离线可测
//   (沿 bench/falsify.js "尺子要可证伪"原则: 错答案必须判红)。
//
// 模式:
//   --offline  管线自检 (零 LLM 零网络): 脚本模型按标准协议作答 + 负对照 (错答案必须判红)
//   默认       真 LLM 模式: 复用 scripts/taskbench.js 的 runOne (仓库配置 Key, 沙箱内干活)
//
// 用法:
//   node scripts/external-bench.js --dataset bench/external/sample.jsonl --offline
//   node scripts/external-bench.js --dataset <你的GAIA转换.jsonl> --limit 20
//   node scripts/external-bench.js --dataset ... --json --strict
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendHistory } from "./lib/bench-history.js";
import { noteCatch } from "../src/utils/catch-log.js";
import { runOne } from "./taskbench.js";
import { PPXAgent } from "../src/agent/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// ---- 判分器 (纯函数, 导出供测试; "尺子要可证伪") ----

export function normalizeAnswer(s) {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// FINAL ANSWER 协议: 取最后一行 "FINAL ANSWER: ..." 的内容; 无则 null (判分回退全文)
export function extractFinalAnswer(reply) {
  const lines = String(reply ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*FINAL\s+ANSWER\s*[:：]\s*(.+?)\s*$/i);
    if (m) return m[1];
  }
  return null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 短语命中: 字母数字 token 用词边界匹配 (防 "4" 误命中 "sample-004" 这类子串假阳性,
//   负对照实测抓到过); CJK/多词短语用包含匹配 (JS \b 不认 CJK 边界)。
function countHits(got, token) {
  if (/^[a-z0-9_]+$/i.test(token)) {
    const re = new RegExp(`(?<![a-z0-9_])${escapeRe(token)}(?![a-z0-9_])`, "gi");
    return (got.match(re) || []).length;
  }
  return got.split(token).length - 1;
}

function phraseHit(got, phrase) {
  const p = normalizeAnswer(phrase);
  if (!p) return false;
  if (p.includes(" ")) return got.includes(p);
  return countHits(got, p) > 0;
}

// exact_match: 归一化后命中 (agent 回复是完整句, GAIA 官方"最终答案相等"适配为
//   "FINAL ANSWER 行命中归一化答案"; 答案本体足够短, 误纳风险可接受)
export function scoreExactMatch(reply, answer) {
  const got = normalizeAnswer(reply);
  const want = normalizeAnswer(answer);
  if (!want) return { pass: false, detail: "答案为空, 尺子拒绝判白" };
  const ok = phraseHit(got, want);
  return { pass: ok, detail: ok ? "" : `期望「${want}」, 回复「${String(reply).slice(0, 80)}」未命中` };
}

// contains: 答案的每个词 (空白切分) 按出现次数都命中 —— "4 4" 要求 4 出现两次 (两个量),
//   只提一次不算全对 (负对照教训的延伸: 词要按乘数计)。
export function scoreContains(reply, answer) {
  const got = normalizeAnswer(reply);
  const tokens = normalizeAnswer(answer).split(" ").filter(Boolean);
  if (!tokens.length) return { pass: false, detail: "答案为空, 尺子拒绝判白" };
  const need = new Map();
  for (const t of tokens) need.set(t, (need.get(t) || 0) + 1);
  const missing = [];
  for (const [t, n] of need) {
    if (countHits(got, t) < n) missing.push(n > 1 ? `${t}×${n}` : t);
  }
  return { pass: missing.length === 0, detail: missing.length ? `未命中词: ${missing.join(", ")}` : "" };
}

function lastNumberIn(s) {
  const all = String(s ?? "").match(/-?\d[\d,]*(?:\.\d+)?/g);
  if (!all || !all.length) return null;
  return parseFloat(all[all.length - 1].replace(/,/g, ""));
}

// numeric: 提取回复中最后一个数字, 与答案数值比对 (相对容差 1e-6)
export function scoreNumeric(reply, answer, { tolerance = 1e-6 } = {}) {
  const target = parseFloat(String(answer ?? "").replace(/[, $¥%]/g, ""));
  if (!Number.isFinite(target)) return { pass: false, detail: `答案不是合法数字: ${answer}` };
  const got = lastNumberIn(reply);
  if (got == null) return { pass: false, detail: "回复中未找到数字" };
  const ok = Math.abs(got - target) <= Math.max(Math.abs(target) * tolerance, 1e-9);
  return { pass: ok, detail: ok ? "" : `数值不符: 期望 ${target}, 实际 ${got}` };
}

// 单题判分入口: FINAL ANSWER 行优先, 回退全文; 未知 eval_type 拒绝判白
export function scoreTask(task, reply) {
  const final = extractFinalAnswer(reply);
  const text = final != null ? final : String(reply ?? "");
  let r;
  switch (String(task.eval_type || "").toLowerCase()) {
    case "exact_match": r = scoreExactMatch(text, task.answer); break;
    case "contains": r = scoreContains(text, task.answer); break;
    case "numeric": r = scoreNumeric(text, task.answer); break;
    default: return { pass: false, detail: `未知 eval_type: ${task.eval_type}` };
  }
  return { ...r, viaFinalAnswer: final != null };
}

// ---- 数据集加载 (导出供测试) ----

export function loadDataset(file) {
  const raw = fs.readFileSync(file, "utf8");
  const tasks = [];
  const errors = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    try {
      const t = JSON.parse(s);
      if (!t.id || !t.question || t.answer === undefined || !t.eval_type) {
        errors.push(`第 ${i + 1} 行缺字段 (需要 id/question/answer/eval_type)`);
        return;
      }
      tasks.push(t);
    } catch (e) {
      /* swallowed-ok(2026-11-15): 解析错误已收集进 errors[] 随返回值上报 (非静默, 扫描器不追数据流) */
      errors.push(`第 ${i + 1} 行不是合法 JSON: ${e.message}`);
    }
  });
  return { tasks, errors };
}

// FINAL ANSWER 协议注入 (GAIA 口径): 判分只认这一行, agent 不守协议时回退全文并如实标注
export const ANSWER_PROTOCOL = "\n\n(回答要求: 最终答案独占一行, 以 \"FINAL ANSWER: \" 开头, 之后只写答案本身 — 判分只认这一行)";

// ---- 离线自检 (零 LLM 零网络) ----

function scriptedAnswerLLM(task) {
  return {
    model: "offline-script",
    backend: "http",
    vision: false,
    supportsNativeToolCalls: true,
    supportsStream: false,
    async apiChat() {
      // "完美的应试者": 按协议作答 —— 管线自检证明的是判分器/加载器, 不是模型能力
      return { message: { role: "assistant", content: `FINAL ANSWER: ${task.answer}`, tool_calls: null } };
    },
    async health() { return true; },
  };
}

function makeOfflineAgent(task) {
  return (sandbox) => {
    const agent = new PPXAgent({
      root: sandbox,
      configFile: null,
      dataDir: path.join(sandbox, ".ppx"),
      globalDataDir: path.join(sandbox, ".ppx-global"),
    });
    const llm = scriptedAnswerLLM(task);
    agent.llm = llm;
    agent.allProviders = [llm];
    return agent;
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const hasFlag = (f) => argv.includes(f);
  const valOf = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : null;
  };
  const datasetFile = valOf("--dataset") || path.join(ROOT, "bench", "external", "sample.jsonl");
  const OFFLINE = hasFlag("--offline");
  const JSON_OUT = hasFlag("--json");
  const STRICT = hasFlag("--strict");
  const limit = Number(valOf("--limit")) || null;

  if (!fs.existsSync(datasetFile)) {
    console.error(`✗ 数据集不存在: ${datasetFile} (--dataset 指定, 格式见 docs/EXTERNAL-BENCH.md)`);
    process.exit(2);
  }
  const { tasks, errors } = loadDataset(datasetFile);
  if (errors.length) {
    console.error(`✗ 数据集有问题:\n  ${errors.join("\n  ")}`);
    process.exit(2);
  }
  const selected = limit ? tasks.slice(0, limit) : tasks;
  if (!selected.length) {
    console.error("✗ 数据集为空");
    process.exit(2);
  }

  const t0 = Date.now();
  const results = [];
  for (const t of selected) {
    const taskDef = {
      id: t.id,
      category: t.category || "external",
      task: String(t.question) + ANSWER_PROTOCOL,
      setup: (sandbox) => {
        const files = t.files && typeof t.files === "object" ? t.files : {};
        for (const [name, content] of Object.entries(files)) {
          const p = path.join(sandbox, name);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, String(content), "utf8");
        }
      },
      verify: ({ reply }) => scoreTask(t, reply),
    };
    let r;
    try {
      r = OFFLINE
        ? await runOne(taskDef, { quiet: true, createAgent: makeOfflineAgent(t) })
        : await runOne(taskDef, { quiet: true });
    } catch (e) {
      r = { id: t.id, pass: false, detail: `执行器异常: ${e?.message || e}`, ms: 0 };
    }
    results.push({
      id: t.id,
      category: taskDef.category,
      eval_type: t.eval_type,
      pass: r.pass === true,
      detail: r.detail || "",
      ms: r.ms || 0,
      tokens: r.tokens || 0,
    });
  }
  const totalMs = Date.now() - t0;

  // 负对照 (仅离线): 同一批题喂"故意答错"的回复, 尺子必须全判红 —— 否则尺子坏了
  let negativeControl = null;
  if (OFFLINE) {
    const wrongPass = [];
    for (const t of selected) {
      const wrong = `FINAL ANSWER: deliberately-wrong-${t.id}`;
      if (scoreTask(t, wrong).pass) wrongPass.push(t.id);
    }
    negativeControl = { total: selected.length, wronglyPassed: wrongPass.length, ids: wrongPass };
    if (wrongPass.length) {
      console.error(`✗ 负对照失败: ${wrongPass.length} 个错答案被判白 (尺子坏了): ${wrongPass.join(", ")}`);
      process.exit(2);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const rate = results.length ? passed / results.length : 0;

  if (JSON_OUT) {
    console.log(JSON.stringify({
      kind: "external-bench",
      dataset: path.relative(ROOT, datasetFile) || datasetFile,
      offline: OFFLINE,
      negativeControl,
      ts: new Date().toISOString(),
      node: process.version,
      total: results.length,
      passed,
      rate: Math.round(rate * 1000) / 1000,
      ms: totalMs,
      results,
    }, null, 2));
  } else {
    console.log(`外部基准 | 数据集: ${datasetFile} | ${results.length} 题 | ${OFFLINE ? "离线自检 (脚本模型 + 负对照)" : "真 LLM 模式"}\n`);
    for (const r of results) {
      console.log(`  ${r.pass ? "✓" : "✗"} ${r.id.padEnd(24)} [${r.eval_type}]${r.pass ? "" : `  ← ${r.detail}`}`);
    }
    console.log(`\n=== 结果: ${passed}/${results.length} 通过 (${(rate * 100).toFixed(1)}%) | 总耗时 ${(totalMs / 1000).toFixed(1)}s ===`);
    if (OFFLINE && negativeControl) console.log(`负对照: ${negativeControl.total} 个错答案全部判红 ✓ (尺子可证伪)`);
    if (!OFFLINE) console.log("\n提示: 结果依赖模型能力与外部数据集; 离线自检 (--offline) 只证明管线与判分器。");
  }

  // 落历史 (趋势用; 失败不影响退出码)
  try {
    const dir = path.join(ROOT, "data", "bench");
    fs.mkdirSync(dir, { recursive: true });
    appendHistory(dir, "external-bench", { total: results.length, passed, rate, ms: totalMs, offline: OFFLINE });
  } catch (e) { noteCatch("scripts/external-bench.js#main", e); /* 存档失败不影响基准本身 */ }

  process.exit(STRICT && passed < results.length ? 1 : 0);
}

// 仅当被直接执行时才跑 CLI —— 测试会 import 本模块取纯函数 (同 taskbench.js 约定)。
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();
