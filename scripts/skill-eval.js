// scripts/skill-eval.js - 技能 A/B 对照评测 (2026-10-09, alibaba/skill-up 式闭环首环)
// 用法: node scripts/skill-eval.js --cases skills/<id>/eval.json --runs 2 [--report-json out.json]
// 声明式用例 (eval.json): { "skill": "content/web-artifacts-builder", "runs": 2,
//   "cases": [{ "id": "dark-page", "task": "做单页...", "artifact": "index.html",
//               "verifier": {"type": "html-structure"} }] }
// 判分三策略对照 skill-up: rule_based (html-structure/contains/file-exists) 本版全内置;
//   script/agent_judge 留接口 (verifier.type 扩展位)。
// 报告口径: with/without 两臂同任务跑分, delta>0 → 技能有效; ≤0 → 技能无增益或负效 (诚实记录)。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PPXAgent } from "../src/agent/index.js";

// ---- 纯函数: 用例校验 (守卫测试锁语义) ----
export function validateCases(obj) {
  const errs = [];
  if (!obj || typeof obj !== "object") return ["用例文件必须是 JSON 对象"];
  if (!obj.skill || typeof obj.skill !== "string") errs.push("缺少 skill 字段");
  if (!Array.isArray(obj.cases) || !obj.cases.length) errs.push("cases 必须是非空数组");
  else for (const c of obj.cases) {
    if (!c.id) errs.push("用例缺少 id");
    if (!c.task) errs.push(`用例 ${c.id || "?"} 缺少 task`);
    if (!c.artifact) errs.push(`用例 ${c.id || "?"} 缺少 artifact (产物路径)`);
    const t = c.verifier?.type;
    if (!["html-structure", "contains", "file-exists", "anti-slop"].includes(t)) errs.push(`用例 ${c.id || "?"} verifier.type 非法: ${t}`);
    if (t === "contains" && !c.verifier?.value) errs.push(`用例 ${c.id || "?"} contains 缺 value`);
  }
  return errs;
}

// ---- 纯函数: rule_based 判分器 ----
const HTML_CHECKS = [
  [/<!DOCTYPE html>/i, "DOCTYPE"],
  [/name=["']viewport["']/i, "viewport"],
  [/<title>[^<]{3,}<\/title>/, "title"],
  [/<nav|nav-links/i, "nav"],
  [/hero/i, "hero"],
  [/(class=["'][^"']*card)/gi, "卡片≥2"],
  [/<footer/i, "footer"],
  [/@media[^{]+\{/, "响应式"],
  [/:hover/, "hover"],
  [/--[a-z-]+\s*:/i, "CSS token"],
  [/<main|<section|<article/, "语义标签"],
];

export function scoreArtifact(verifier, html) {
  const h = String(html || "");
  if (verifier.type === "file-exists") return h.length > 0 ? 1 : 0;
  if (verifier.type === "contains") return h.includes(verifier.value) ? 1 : 0;
  // anti-slop (2026-10-09 超纲题): web-artifacts-builder 的"AI slop"戒律转成规则 ——
  //   四俗 = 紫色渐变 / 全页居中 (无任何左对齐) / 圆角值全同 / Inter 字体。分数 = 戒律保持数/4。
  //   依据: 实测模型默认审美恰好全中 (今日官网产物: 居中hero+统一14px圆角)。
  if (verifier.type === "anti-slop") {
    const css = (h.match(/<style>([\s\S]*)<\/style>/) || [])[1] || h;
    let ok = 0;
    if (!/(#8b5cf6|#a855f7|#7c3aed|#6d28d9|#9333ea|rgb\(\s*139\s*,\s*92\s*,\s*246)/i.test(h)) ok++; // 无紫色系
    if (!(/text-align:\s*center/.test(css) && !/text-align:\s*left/.test(css))) ok++;                 // 非全页居中
    const radii = new Set((css.match(/border-radius:\s*([^;}]+)/g) || []).map((r) => r.replace(/border-radius:\s*/, "").trim()));
    if (radii.size === 0 || radii.size >= 3) ok++;                                                    // 圆角有节奏 (非单一值)
    if (!/font-family:[^;!]*\bInter\b/i.test(h)) ok++;                                                // 不用 Inter
    return Number((ok / 4).toFixed(3));
  }
  // html-structure: 0~1 线性分 (过检数/总数), 卡片≥2 按 2 张计
  let passed = 0, total = 0;
  for (const [re] of HTML_CHECKS) {
    total++;
    const m = h.match(re);
    if (re.source.includes("card")) passed += (m || []).length >= 2 ? 1 : 0;
    else passed += m ? 1 : 0;
  }
  return Number((passed / total).toFixed(3));
}

export function verdictOf(withAvg, withoutAvg) {
  const delta = Number((withAvg - withoutAvg).toFixed(3));
  if (delta > 0.05) return { delta, verdict: "有效" };
  if (delta < -0.05) return { delta, verdict: "负效(考虑修技能)" };
  return { delta, verdict: "无显著差异" };
}

// ---- 跑一臂: 同一任务 N 次, PPX_DISABLE_SKILLS 控制 ----
async function runArm(caseDef, skill, disable, runs, configFile) {
  const scores = [];
  const prev = process.env.PPX_DISABLE_SKILLS;
  for (let i = 0; i < runs; i++) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-skill-eval-"));
    if (disable) process.env.PPX_DISABLE_SKILLS = skill;
    else delete process.env.PPX_DISABLE_SKILLS;
    let agent = null;
    try {
      agent = new PPXAgent({
        root: sandbox,
        configFile: process.env.PPX_CONFIG_FILE || configFile || path.join(process.cwd(), "config", "ppx.json"),
        dataDir: path.join(sandbox, ".ppx"),
        globalDataDir: path.join(sandbox, ".ppx-global"),
      });
      await agent.chat(caseDef.task);
      const f = path.join(sandbox, caseDef.artifact);
      const html = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
      scores.push(scoreArtifact(caseDef.verifier, html));
    } catch (e) {
      scores.push(0); // 失败按 0 计 (对照口径: 挂了就是没产出)
    } finally {
      if (prev === undefined) delete process.env.PPX_DISABLE_SKILLS; else process.env.PPX_DISABLE_SKILLS = prev;
      try { await agent?.shutdown(); } catch {}
    }
  }
  return { scores, avg: Number((scores.reduce((a, b) => a + b, 0) / runs).toFixed(3)) };
}

async function main() {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const casesPath = arg("--cases");
  if (!casesPath) { console.error("用法: node scripts/skill-eval.js --cases <eval.json> --runs 2 [--report-json out.json]"); process.exit(2); }
  const obj = JSON.parse(fs.readFileSync(casesPath, "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")); // 容忍行注释 (JSONC, 用例可读性优先)
  const errs = validateCases(obj);
  if (errs.length) { console.error("✗ 用例校验失败:\n" + errs.map((e) => "  - " + e).join("\n")); process.exit(2); }
  const runs = Math.max(1, Math.min(5, Number(arg("--runs")) || obj.runs || 2));
  const report = { skill: obj.skill, runs, cases: [], generatedAt: new Date().toISOString() };
  for (const c of obj.cases) {
    console.log(`→ 用例 ${c.id}: without 臂 ${runs} 跑...`);
    const without = await runArm(c, obj.skill, true, runs, arg("--config"));
    console.log(`→ 用例 ${c.id}: with 臂 ${runs} 跑...`);
    const with_ = await runArm(c, obj.skill, false, runs, arg("--config"));
    const v = verdictOf(with_.avg, without.avg);
    report.cases.push({ id: c.id, with: with_, without, ...v });
    console.log(`  with=${with_.avg} (${with_.scores.join(",")}) without=${without.avg} (${without.scores.join(",")}) → ${v.verdict} (Δ${v.delta})`);
  }
  const wAvg = report.cases.reduce((a, c) => a + c.with.avg, 0) / report.cases.length;
  const woAvg = report.cases.reduce((a, c) => a + c.without.avg, 0) / report.cases.length;
  report.summary = verdictOf(wAvg, woAvg);
  console.log(`\n===== 技能 ${obj.skill}: with=${wAvg.toFixed(3)} without=${woAvg.toFixed(3)} → ${report.summary.verdict} (Δ${report.summary.delta}) =====`);
  const out = arg("--report-json");
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2)); console.log("报告:", out); }
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("skill-eval.js")) main();
