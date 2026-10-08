// bench/falsify.js - 判分器可证伪门禁 (2026-10-05, 纯离线 / 零 LLM / 零网络 / 零 API 配额)
// 一句话: 每个基准任务必须自带参考解 (oracle) 与变异体 (mutants), 这里逐条验证
//   (1) oracle 产物 → verify 必须判正   (判分装置测得到"对", 不是永远红的坏尺子)
//   (2) 每个 mutant  → verify 必须判负   (判分装置不放过"看着像对的错答案")
//   (3) 结构约束     → 每任务有 oracle、≥2 mutant、其中≥1 个是"近失题"
// 三条里任何一条不成立 → 非零退出 (CI 闸门; 参照 ppx 刚在 taskbench.js 修掉的
// "恒退出 0" 反模式, 这里没有任何 || true / --allow-fail 豁免口子)。
//
// 为什么要有这个东西 (判分器偏袒 bug 已犯四次, 前三次都烧了真 LLM 配额):
//   nodeRun 用裸 Windows 路径 import → 代码类恒 null; 强行 {"type":"module"} → 把正确的
//   CJS 答案判成 null; 裸函数导出 (module.exports = sum) → 判 null; 本轮又抓到两处
//   hasNum 的 substring 匹配放过 "16 个"/"共 14 行" 这类近失答案, 和 fix-syntax 放过
//   "把函数整段注释掉" 这种非答案。四次都是"没有证据证明判分器接受正确答案"的表现。
// 用法:
//   node bench/falsify.js            全量 20 任务门禁 (退 0 = 可信)
//   node bench/falsify.js --only id  只看某个/某几个任务 (逗号分隔)
//   node bench/falsify.js --self-probe  反向自检: 故意把判分器改坏, 证明本门禁真的会红
//   node bench/falsify.js --verbose  列出每个 mutant 的判定明细
// 沙箱一律 fs.mkdtempSync(os.tmpdir()) 且用完即删, 与 scripts/taskbench.js:runOne 同策略,
// 绝不写进仓库。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "./tasks.js";

const MIN_MUTANTS = 2; // 每任务至少两个变异体 (terminal-bench 口径: 一条近失 + 一条低级错误)

const mkdtemp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ppx-falsify-"));

// 跑一个"产物" (oracle 或 mutant): 每次都是全新沙箱 + 任务真实 setup, 变体之间零串扰。
// verify 抛异常按判负处理 —— 与 scripts/taskbench.js:runOne 里的 try/catch 同口径
// (判分器崩溃从来不是"通过"), 但单独记 crashed, 好把"判分器不处理缺文件"这类毛病显式暴露出来。
export function runArtifact(task, artifact) {
  const dir = mkdtemp();
  try {
    task.setup?.(dir);
    const reply = String(artifact({ sandbox: dir }) ?? "");
    let verdict;
    let crashed = false;
    let crashMessage = null;
    try {
      verdict = task.verify({ reply, tokens: 0, ms: 0 }, { sandbox: dir });
    } catch (e) {
      crashed = true;
      crashMessage = e?.message || String(e);
      verdict = { pass: false, detail: `判分器抛异常 (应为 verdict 而不是崩溃): ${crashMessage}` };
    }
    return { pass: !!verdict?.pass, detail: String(verdict?.detail ?? ""), crashed, reply };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 结构检查 (不跑判分): oracle/mutant 的契约本身是否成立 —— 缺 oracle 的任务等于"没有参考解",
// 门禁必须直接判红, 而不是"跳过"。
export function structuralProblems(task) {
  const p = [];
  if (typeof task.oracle !== "function") p.push("缺 oracle (或 oracle 不是函数)");
  if (!Array.isArray(task.mutants)) p.push("缺 mutants 数组");
  else {
    if (task.mutants.length < MIN_MUTANTS) p.push(`mutants 只有 ${task.mutants.length} 个 (<${MIN_MUTANTS})`);
    const names = new Set();
    task.mutants.forEach((m, i) => {
      const at = `mutants[${i}]`;
      if (!m || typeof m.artifact !== "function") p.push(`${at} 缺 artifact 函数`);
      if (!m?.name || typeof m.name !== "string") p.push(`${at} 缺 name`);
      else if (names.has(m.name)) p.push(`${at} name 重复: ${m.name}`);
      else names.add(m.name);
      if (!m?.family || typeof m.family !== "string") p.push(`${at} (${m?.name ?? i}) 缺 family (变异族)`);
    });
    if (Array.isArray(task.mutants) && !task.mutants.some((m) => m?.near === true)) {
      p.push("没有近失题 (near: true) —— 全是一眼错的 strawman, 证明不了判分器在测量");
    }
  }
  return p;
}

// 单任务: oracle 必须过, 全部 mutant 必须不过。survived = 被判正了的不合格答案 (= 判分器洞)。
export function checkTask(task) {
  const problems = structuralProblems(task);
  const row = {
    id: task.id,
    category: task.category,
    problems,
    oracle: null,
    mutants: [],
    survived: [],
    crashed: [],
    ok: false,
  };
  if (typeof task.oracle !== "function") {
    row.oracle = { skipped: true };
    row.problems = problems.length ? problems : ["oracle 不可调用"];
    return row;
  }
  row.oracle = runArtifact(task, task.oracle);
  if (row.oracle.crashed) row.crashed.push("oracle");
  if (!row.oracle.pass) row.problems.push(`oracle 被判负: ${row.oracle.detail}`);
  for (const m of task.mutants || []) {
    if (!m || typeof m.artifact !== "function") continue;
    const r = runArtifact(task, m.artifact);
    row.mutants.push({ name: m.name, family: m.family, near: m.near === true, ...r });
    if (r.crashed) row.crashed.push(m.name);
    if (r.pass) row.survived.push(`${m.name} [${m.family}${m.near ? " 近失" : ""}] 被判正: ${r.detail}`);
  }
  if (row.survived.length) row.problems.push(`${row.survived.length} 个变异体存活 (判分器放过): ${row.survived.join(" | ")}`);
  row.ok = row.problems.length === 0;
  return row;
}

export function evaluate(tasks = TASKS) {
  const rows = tasks.map((t) => checkTask(t));
  const bad = rows.filter((r) => !r.ok);
  const survivedTotal = rows.reduce((s, r) => s + r.survived.length, 0);
  const mutantTotal = rows.reduce((s, r) => s + r.mutants.length, 0);
  // 判分器崩溃次数: 不改变判分结果 (taskbench 的 try/catch 与本文件同样收成"判负"),
  // 但它是"判分器不处理缺文件"的味道, 单独亮出来而不是闷声算通过。
  const crashed = rows.reduce((s, r) => s + r.crashed.length, 0);
  return {
    rows,
    ok: bad.length === 0 && rows.length === tasks.length && tasks.length > 0,
    tasks: rows.length,
    failedTasks: bad.length,
    survivedTotal,
    mutantTotal,
    crashedTotal: crashed,
    oraclePass: rows.filter((r) => r.oracle && r.oracle.pass).length,
  };
}

// 表格对齐: 中文按 2 格宽度算, 避免 Windows 控制台歪成楼梯。
const w = (s, n) => {
  let width = 0;
  for (const ch of String(s)) width += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return `${s}${" ".repeat(Math.max(1, n - width))}`;
};

function printTable(res, { verbose = false } = {}) {
  console.log(`${w("任务 id", 22)}${w("分类", 8)}${w("oracle", 10)}${w("mutants", 12)}状态`);
  console.log("-".repeat(76));
  for (const r of res.rows) {
    const oracle = r.oracle?.skipped ? "缺失" : r.oracle?.pass ? "✓" : "✗";
    const failedCount = r.mutants.filter((m) => !m.pass).length;
    const muts = r.mutants.length ? `${failedCount}/${r.mutants.length} ✗` : "-";
    console.log(`${w(r.id, 22)}${w(r.category, 8)}${w(`oracle ${oracle}`, 10)}${w(muts, 12)}${r.ok ? "PASS" : "FAIL"}${r.crashed.length ? `  (判分器崩溃 ${r.crashed.length} 次, 已被收成判负)` : ""}`);
    if (verbose) {
      if (r.oracle && !r.oracle.skipped) console.log(`    oracle reply=${JSON.stringify(r.oracle.reply)} → ${r.oracle.detail}`);
      for (const m of r.mutants) console.log(`      ${m.pass ? "存活!" : "判负 "} ${m.name} [${m.family}]${m.near ? " 近失" : ""} → ${m.detail}`);
    }
    for (const p of r.problems) console.log(`    ↳ ${p}`);
  }
}

// ---- 反向自检 (--self-probe): 门禁本身必须可失败 ----
// 把三件坏事分别注入一份任务清单副本, 断言门禁每种都抓到并指名道姓:
//   A. 判分器改成"什么都放过" → 必须报"变异体存活"
//   B. 删掉 oracle            → 必须报"缺 oracle"
//   C. oracle 换成错答案      → 必须报"oracle 被判负"
// 任一条没抓到 → 本自检退出 1 (说明门禁是摆设)。
function selfProbe() {
  const clone = (t) => ({ ...t });
  const cases = [
    { label: "白送分的判分器", want: "变异体存活", tasks: TASKS.map((t) => clone({ ...t, verify: () => ({ pass: true, detail: "什么都判正" }) })) },
    { label: "缺 oracle", want: "缺 oracle", tasks: TASKS.map((t, i) => (i === 0 ? { ...t, oracle: undefined } : clone(t))) },
    { label: "oracle 是错答案", want: "oracle 被判负", tasks: TASKS.map((t, i) => (i === 0 ? { ...t, oracle: () => "我随便说说" } : clone(t))) },
    { label: "mutants 不够", want: "mutants 只有", tasks: TASKS.map((t, i) => (i === 0 ? { ...t, mutants: t.mutants.slice(0, 1) } : clone(t))) },
    { label: "全是 strawman", want: "没有近失题", tasks: TASKS.map((t, i) => (i === 0 ? { ...t, mutants: t.mutants.map((m) => ({ ...m, near: false })) } : clone(t))) },
  ];
  let allCaught = true;
  for (const c of cases) {
    const res = evaluate(c.tasks);
    const hit = res.rows.some((r) => !r.ok && r.problems.join(" | ").includes(c.want));
    console.log(`  ${hit ? "PASS" : "FAIL"}  注入「${c.label}」→ 门禁应报「${c.want}」`);
    if (!hit) {
      allCaught = false;
      console.log(`        实际: ok=${res.ok} problems=${res.rows.flatMap((r) => r.problems).slice(0, 3).join(" / ") || "(无)"}`);
    }
  }
  //  sanity: 真实任务集在这套探针下必须是"另一回事" —— 若真任务也报同样问题说明探针无意义
  const real = evaluate(TASKS);
  console.log(`  参考: 真实任务集 → ${real.ok ? "全绿 (门禁放行)" : `${real.failedTasks} 个任务判红`}`);
  console.log(allCaught
    ? "\n反向自检: 门禁可失败 ✓ (四类坏判分器全被抓住)"
    : "\n反向自检: 门禁抓不住注入的坏判分器 ✗ —— falsify 形同虚设, 判失败");
  process.exitCode = allCaught ? 0 : 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-probe")) { selfProbe(); return; }
  const onlyIdx = args.indexOf("--only");
  const list = onlyIdx >= 0 && args[onlyIdx + 1]
    ? TASKS.filter((t) => args[onlyIdx + 1].split(",").includes(t.id))
    : TASKS;
  if (!list.length) { console.error("✗ 没有匹配的任务 (--only 用逗号分隔的 task id)"); process.exit(2); }
  const verbose = args.includes("--verbose") || args.includes("-v");
  console.log(`→ 判分器可证伪门禁: ${list.length} 个任务 (离线, 零 API 调用)\n`);
  const res = evaluate(list);
  printTable(res, { verbose });
  console.log("-".repeat(76));
  console.log(`oracle 判正: ${res.oraclePass}/${res.tasks} | 变异体正确判负: ${res.mutantTotal - res.survivedTotal}/${res.mutantTotal} | 判红任务: ${res.failedTasks}`);
  if (res.crashedTotal) console.log(`⚠ 判分器抛异常次数: ${res.crashedTotal} (运行器按判负处理, 不影响分数, 但说明 verify 没处理缺文件这类基本形态)`);
  if (res.ok) {
    console.log("\n✓ 全部任务的判分器可证伪: 参考解判正, 所有不合格答案判负。");
    process.exitCode = 0;
  } else {
    console.log("\n✗ 门禁失败: 有任务的判分器不可信 (oracle 判负 / 变异体存活 / fixture 结构不合规)。");
    process.exitCode = 1;
  }
}

// 只在直跑时执行 (被 import 时不打印/不退出, 供 test/bench-verifiers-falsifiable.test.js 复用,
// 与 scripts/taskbench.js 同一"判分入口可离线注入"惯例)。
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const a = path.resolve(entry);
  const b = fileURLToPath(import.meta.url);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
})();

if (invokedDirectly) await main();
