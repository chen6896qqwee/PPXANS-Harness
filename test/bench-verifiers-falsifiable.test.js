// test/bench-verifiers-falsifiable.test.js — 基准判分器可证伪门禁 (2026-10-05, 纯离线 / 零 LLM)
// 一句话: 一个判分器只有在「参考解判正」且「故意写错的答案判负」同时成立时才算可信。
// 为什么必须存在 (判分器偏袒 bug 已犯四次, 每次都烧掉真 LLM 配额才发现):
//   1) nodeRun 用裸 Windows 路径当动态 import 的 specifier → ERR_UNSUPPORTED_ESM_URL_SCHEME,
//      代码类答案与「文件不存在」得同一个 null, 4 个任务无论模型怎么做都过不了;
//   2) 修法里强行给沙箱塞 {"type":"module"} → 反过来把正确的 CommonJS 答案判成 null
//      (移动球门而不是摆正球门);
//   3) 裸函数导出 (module.exports = sum) 判 null, 因为 probe 只会拿导出表去索引;
//   4) 本轮补 oracle 时又抓到两处: hasNum 是裸 substring 匹配 (「一共有 16 个文件」对
//      「应含 6」判正、「共 14 行」对「应含 4」判正 —— 五个数字任务的近失答案白拿分),
//      以及 fix-syntax 只做 node --check (把出错的函数整段注释掉、把 hi 改成 hello 都判正)。
// 本文件按 terminal-bench 的纪律钉死: 每个任务自带 instruction(task) + 判分器(verify) +
// 参考解(oracle) + 变异体(mutants)。逻辑全部复用 bench/falsify.js —— 同一份判分入口,
// 调用 verify 的形状与 scripts/taskbench.js:runOne 逐字一致 (verify({reply,tokens,ms},{sandbox})),
// 不在测试里另 fork 一把尺子。沙箱一律 mkdtemp(os.tmpdir()), 不写仓库。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TASKS } from "../bench/tasks.js";
import { checkTask, evaluate, structuralProblems, runArtifact } from "../bench/falsify.js";

const W = (dir, name, content) => fs.writeFileSync(path.join(dir, name), content);

// 跑一次门禁 (每任务全新沙箱 + 真实 setup, oracle/mutant 各一份)。
// 20 任务 / 88 个变异体离线跑完约 2s; 下面所有断言读同一份结果, 不重复计算。
const RES = evaluate(TASKS);

test("门禁整体可运行: 20 个任务全绿 (等价于 node bench/falsify.js 退 0)", () => {
  assert.equal(RES.tasks, TASKS.length, "每个任务都必须被跑到");
  assert.ok(RES.tasks >= 20, `应覆盖 20 任务, 实际 ${RES.tasks}`);
  const bad = RES.rows.filter((r) => !r.ok).map((r) => `${r.id}: ${r.problems.join(" | ")}`);
  assert.deepEqual(bad, [], `判分器不可信的任务:\n${bad.join("\n")}`);
  assert.equal(RES.ok, true);
});

test("结构: 每个任务都有 oracle + ≥2 mutants + 至少 1 个近失题 + 具名变异族", () => {
  for (const t of TASKS) {
    assert.deepEqual(structuralProblems(t), [], `${t.id} 的 oracle/mutant fixture 不合规`);
    assert.ok(t.mutants.length >= 2, `${t.id} 变异体太少`);
    assert.ok(t.mutants.some((m) => m.near === true), `${t.id} 缺近失题 (全是一眼错的 strawman = fixture 无意义)`);
    for (const m of t.mutants) assert.ok(m.family && m.family.length > 3, `${t.id} / ${m.name} 缺 family`);
  }
});

test("oracle 全部判正, 且 verify 返回合法 verdict (boolean pass + 非空 detail)", () => {
  for (const r of RES.rows) {
    assert.ok(r.oracle && !r.oracle.skipped, `${r.id} 没跑到 oracle`);
    assert.equal(r.oracle.pass, true, `${r.id} 的参考解被判负: ${r.oracle.detail}`);
    for (const v of [r.oracle, ...r.mutants]) {
      assert.equal(typeof v.pass, "boolean", `${r.id}: pass 必须是布尔 (不能是 truthy 字符串)`);
      assert.equal(typeof v.detail, "string", `${r.id}: detail 必须是字符串`);
      assert.ok(v.detail.length > 0, `${r.id}: detail 不能为空串 (失败归因要用它)`);
    }
  }
});

test("变异体全部判负: 没有任何「看着像对的错答案」被放过", () => {
  const survived = [];
  for (const r of RES.rows) {
    for (const m of r.mutants) if (m.pass) survived.push(`${r.id} / ${m.name} [${m.family}]${m.near ? " 近失" : ""} → ${m.detail}`);
  }
  assert.deepEqual(survived, [], `以下不合格答案被判正:\n${survived.join("\n")}`);
  assert.ok(RES.mutantTotal >= 40, `变异体太少 (${RES.mutantTotal}), 覆盖不到各族失败`);
  // 每个分类至少 3 个变异族, 证明变异是成套的而不是随手一两个
  const famByCat = {};
  for (const r of RES.rows) {
    (famByCat[r.category] ??= new Set());
    for (const m of r.mutants) famByCat[r.category].add(m.family);
  }
  for (const [cat, set] of Object.entries(famByCat)) {
    assert.ok(set.size >= 3, `${cat} 只覆盖了 ${set.size} 个变异族: ${[...set].join(", ")}`);
  }
});

test("判分器不靠崩溃表态: 全流程零抛异常 (缺文件也要给明确 verdict)", () => {
  const crashed = RES.rows.filter((r) => r.crashed.length).map((r) => `${r.id}: ${r.crashed.join(", ")}`);
  assert.deepEqual(crashed, [], `判分器抛异常。taskbench 的外层 catch 会收成判负, 分数不变, 但 detail `
    + `变成「判分异常: ...」, 归因信息丢了 —— 已在 append-file / rename-symbol 补 try/catch:\n${crashed.join("\n")}`);
});

// ---- 逐任务钉一遍 (20 行结果, 让「哪个任务的判分器不可信」一眼可见) ----
for (const t of TASKS) {
  test(`${t.id}: oracle ✓ / mutants ${t.mutants.length}/${t.mutants.length} ✗`, () => {
    const r = checkTask(t);
    assert.deepEqual(r.problems, [], `${t.id} 判分器不可信: ${r.problems.join(" | ")}`);
    assert.equal(r.oracle.pass, true, `${t.id} 参考解必须判正`);
    assert.equal(r.survived.length, 0, `${t.id} 变异体存活: ${r.survived.join(" | ")}`);
    assert.equal(r.crashed.length, 0, `${t.id} 判分器崩溃: ${r.crashed.join(" | ")}`);
  });
}

// ---- 反向自检: 这套 fixture 与门禁本身必须能失败 (否则只是另一个恒绿的摆设) ----
// 把坏判分器注进任务副本, 断言门禁每一种都抓到并指名道姓。
const probe = (n = 4) => TASKS.slice(0, n);

test("反向自检 A: 白送分的判分器 (什么都判正) 必被报为「变异体存活」", () => {
  const res = evaluate(probe().map((t) => ({ ...t, verify: () => ({ pass: true, detail: "来, 分给你" }) })));
  assert.equal(res.ok, false);
  assert.ok(res.survivedTotal > 0, "白送分判分器必须漏掉若干变异体");
  assert.ok(res.rows.every((r) => !r.ok), "每个任务都该判红");
  assert.match(res.rows[0].problems.join(" "), /变异体存活/);
});

test("反向自检 B: 参考解本身被判负 (判分器读不到 agent 能产出的东西) 必被报「oracle 被判负」", () => {
  const res = evaluate([{ ...TASKS[0], oracle: () => "我随口说了个 1.2.3" }]);
  assert.equal(res.ok, false);
  assert.match(res.rows[0].problems.join(" "), /oracle 被判负/);
});

test("反向自检 C: 缺 oracle / mutants 不足 / 全是 strawman 都算结构不合规", () => {
  assert.match(evaluate([{ ...TASKS[0], oracle: undefined }]).rows[0].problems.join(" "), /缺 oracle/);
  assert.match(evaluate([{ ...TASKS[0], mutants: TASKS[0].mutants.slice(0, 1) }]).rows[0].problems.join(" "), /mutants 只有/);
  assert.match(evaluate([{ ...TASKS[0], mutants: TASKS[0].mutants.map((m) => ({ ...m, near: false })) }])
    .rows[0].problems.join(" "), /没有近失题/);
});

test("反向自检 D: 把判分器换回「修复前的旧写法」, 门禁必须立刻变红 (证明测试在测量)", () => {
  // 旧 hasNum = 裸 RegExp, 对这些答案就是 substring 匹配。
  const oldHasNum = (reply, n) => new RegExp(String(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(reply);
  const legacyNumber = { "version-report": "7.7.7", "count-files": 6, "sum-numbers": 50, "extract-field": 2 };
  for (const [id, n] of Object.entries(legacyNumber)) {
    const t = TASKS.find((x) => x.id === id);
    const res = evaluate([{ ...t, verify: (r) => ({ pass: oldHasNum(r.reply, n), detail: `应含 ${n}` }) }]);
    assert.equal(res.ok, false, `${id}: 旧 hasNum (裸 substring) 必须被近失答案打穿`);
    assert.match(res.rows[0].problems.join(" "), /变异体存活/, `${id} 旧判分器下竟没漏? 那这条近失题是 strawman`);
  }
  // analyze-and-report 判的是 report.txt 里的数字, 同样只有旧口径才会漏
  const t = TASKS.find((x) => x.id === "analyze-and-report");
  const legacyReport = evaluate([{
    ...t,
    verify: (r, c) => {
      try { return { pass: oldHasNum(fs.readFileSync(path.join(c.sandbox, "report.txt"), "utf8"), 4), detail: "应含 4" }; }
      catch { return { pass: false, detail: "report.txt 不存在" }; }
    },
  }]);
  assert.match(legacyReport.rows[0].problems.join(" "), /变异体存活/, "「共 14 行」在旧判分器下应被判正");

  // fix-syntax 旧口径 (只做 node --check): 注释掉函数 / 改了逻辑 / 改了名字 全都该漏
  const ts = TASKS.find((x) => x.id === "fix-syntax");
  const legacySyntax = evaluate([{
    ...ts,
    verify: (r, c) => {
      let ok = true;
      try { execFileSync(process.execPath, ["--check", path.join(c.sandbox, "broken.js")], { stdio: "pipe" }); } catch { ok = false; }
      return { pass: ok, detail: "node --check 应通过" };
    },
  }]);
  assert.match(legacySyntax.rows[0].problems.join(" "), /变异体存活/,
    "旧 fix-syntax 放过「把函数整段注释掉」这类非答案, 必须被变异体打穿");

  // 旧 append-file 没有 try/catch: 缺文件时是崩溃而不是结论
  const af = TASKS.find((x) => x.id === "append-file");
  const legacyAppend = evaluate([{ ...af, verify: (r, c) => { const s = fs.readFileSync(path.join(c.sandbox, "log.txt"), "utf8"); return { pass: /DONE/.test(s) }; } }]);
  assert.ok(legacyAppend.rows[0].crashed.length > 0, "旧 append-file 应在缺文件变异体上抛异常 (本轮已修)");
});

// ---- 公平的另一半: 收紧判分器的同时, 正确产物的合理变体必须仍然判正 ----
// (第四次偏袒的教训: 修「太松」很容易顺手把正确答案一起打死。每一处收紧都配正例。)
const ACCEPTS = [
  // v3 tasks explicitly ask for one value. Harmless surrounding whitespace is
  // accepted; semantic free-form responses require a separate model reviewer.
  ["version-report", "完整版本号", () => "7.7.7"],
  ["version-report", "完整版本号带尾换行", () => "7.7.7\n"],
  ["count-files", "数字按显式输出契约", () => "6"],
  ["count-files", "数字带空白", () => " 6\n"],
  ["sum-numbers", "结果数字", () => "50"],
  ["extract-field", "结果数字带换行", () => "2\n"],
  // find-symbol 的既定意图: 两个文件名都提 = 没做出指认 (test/taskbench.test.js 早已钉住),
  // 所以「正确 + 顺带解释 unrelated.js」这种写法判负是边界而不是偏袒, 这里用不点名的解释。
  ["find-symbol", "完整文件名", () => "pricing.js"],
  ["read-secret", "完整值带尾换行", () => "sk-bench-42\n"],
  ["create-file", "内容带尾换行与额外一行 (边界: 只要求含指定内容)", ({ sandbox }) => {
    W(sandbox, "notes/todo.txt", "买牛奶\n\n(备注: 顺路)\n"); return "已创建";
  }],
  ["append-file", "DONE 之后再补一行 (追加语义)", ({ sandbox }) => {
    W(sandbox, "log.txt", "line1\nDONE\nextra\n"); return "已追加";
  }],
  ["json-edit", "键序不同 + 带缩进 (JSON.parse 之后比的是值)", ({ sandbox }) => {
    W(sandbox, "config.json", JSON.stringify({ retries: 3, timeout: 5000 }, null, 2)); return "已改";
  }],
  ["json-create", "额外多一个字段 (题面没禁止)", ({ sandbox }) => {
    W(sandbox, "person.json", JSON.stringify({ name: "Alice", age: 30, city: "X" })); return "已创建";
  }],
  ["conditional-write", "enabled.txt 内容随意 (题面原文)", ({ sandbox }) => {
    W(sandbox, "enabled.txt", ""); return "已创建";
  }],
  ["delete-file", "删除并留下 .bak 副本 (边界: 题面只约束 obsolete.txt 这个路径)", ({ sandbox }) => {
    fs.rmSync(path.join(sandbox, "obsolete.txt"), { force: true });
    W(sandbox, "obsolete.txt.bak", "old"); return "已删除 (备份留底)";
  }],
  ["src-listing", "带目录前缀的一行一个", ({ sandbox }) => {
    W(sandbox, "lib-list.txt", "lib/a.js\nlib/b.js\n"); return "已写入";
  }],
  ["analyze-and-report", "按题面 共 N 行 格式允许空白", ({ sandbox }) => {
    W(sandbox, "report.txt", "共4行\n"); return "已写入";
  }],
  ["fix-syntax", "改成字符串拼接 (逻辑不变, 修法语写法不同)", ({ sandbox }) => {
    W(sandbox, "broken.js", "export function greet(name) {\n  return \"hi \" + name;\n}\n"); return "已修复";
  }],
  ["fix-syntax", "CommonJS 裸函数导出 (判分器不偏袒模块系统)", ({ sandbox }) => {
    W(sandbox, "broken.js", "function greet(name) { return `hi ${name}`; }\nmodule.exports = greet;\n"); return "已修复";
  }],
  ["fix-logic", "CJS 对象导出 add", ({ sandbox }) => {
    W(sandbox, "calc.js", "function add(a, b) { return a + b; }\nmodule.exports = { add };\n"); return "已修复";
  }],
  ["write-function", "CJS 裸函数导出 sum", ({ sandbox }) => {
    W(sandbox, "utils.js", "function sum(a, b) { return a + b; }\nmodule.exports = sum;\n"); return "已写好";
  }],
  ["rename-symbol", "改名并加一行注释 (逻辑照旧)", ({ sandbox }) => {
    W(sandbox, "rename-me.js", "// renamed\nexport async function loadData() { return 1; }\nexport async function main() { const r = await loadData(); return r; }\n"); return "改完了";
  }],
];

for (const [id, label, artifact] of ACCEPTS) {
  test(`公平反例: ${id} 的合理正确写法仍判正 —— ${label}`, () => {
    const t = TASKS.find((x) => x.id === id);
    assert.ok(t, `${id} 不存在`);
    const r = runArtifact(t, artifact);
    assert.equal(r.pass, true, `${label} 是正确答案, 不该判负: ${r.detail}`);
  });
}

test("verify 调用形状与真跑基准一致 (不新增入参, 不改返回契约)", () => {
  // scripts/taskbench.js:runOne 的调用是 taskDef.verify({reply,tokens,ms},{sandbox})。
  // 任何「多要一个 ctx.trace / 少给一个 sandbox」的改动都会让真跑基准退化成永远判负。
  for (const t of TASKS) {
    assert.ok(t.verify.length <= 2, `${t.id}: verify 形参不应超过 (replyObj, ctx)`);
    const seen = [];
    const spy = { ...t, verify: (a, b) => { seen.push([a, b]); return t.verify(a, b); } };
    runArtifact(spy, t.oracle ?? (() => ""));
    assert.equal(seen.length, 1);
    const [replyObj, ctx] = seen[0];
    assert.deepEqual(Object.keys(replyObj).sort(), ["ms", "reply", "tokens"], `${t.id}: replyObj 形状变了`);
    assert.deepEqual(Object.keys(ctx), ["sandbox"], `${t.id}: ctx 形状变了`);
    assert.ok(path.isAbsolute(ctx.sandbox) && !ctx.sandbox.startsWith(process.cwd()), `${t.id}: 沙箱必须是临时目录`);
  }
});
