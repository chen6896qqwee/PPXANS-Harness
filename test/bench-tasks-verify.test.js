// test/bench-tasks-verify.test.js — 代码类基准任务的判分器守卫 (2026-10-05, 纯离线零 LLM)
// 动机: 真跑 20 任务 代码=0/4。根因不在 agent, 在判分装置 —— 夹具把 `export` 语法写进
// 一个没有 package.json 的临时沙箱 (Node 按最近 package.json 判模块类型), 于是同一份
// 正确代码也可能被判负; nodeRun 又把 Windows 绝对路径当动态 import 的 specifier
// (ERR_UNSUPPORTED_ESM_URL_SCHEME), 与内容对错无关地恒返回 null。
// 本测试用"模拟一个成功的 agent"的方式钉死两件事:
//   (1) 已知正确的内容 → verify.pass === true  (装置能测到通过, 不是永远失败)
//   (2) 夹具原始坏内容 → verify.pass === false (装置没有变成白送分)
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TASKS } from "../bench/tasks.js";

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "ppx-bench-verify-"));
const byId = (id) => {
  const t = TASKS.find((x) => x.id === id);
  assert.ok(t, `任务 ${id} 应存在`);
  return t;
};
const W = (dir, name, content) => fs.writeFileSync(path.join(dir, name), content);
// 判分入口: 代码/文件类看沙箱产物 (reply 固定"已完成", 证明嘴皮子不影响判分);
// 检索类看回复文本 (沙箱已由 setup 摆好)。
const judge = (id, sandbox, reply = "已完成") => byId(id).verify({ reply, tokens: 0, ms: 0 }, { sandbox });

// 四个代码任务都必须让沙箱成为 ESM 包 (setup 里补 package.json {"type":"module"}),
// 否则判分结果取决于宿主 Node 是否有模块语法探测 —— 基准不可复现。
function assertEsmSandbox(id) {
  const d = mk();
  try {
    byId(id).setup?.(d);
    const pkg = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8"));
    assert.equal(pkg.type, "module", `${id}: setup 应把沙箱声明为 ESM 包`);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

test("代码任务 setup: 沙箱声明为 ESM 包 (fix-syntax/fix-logic/rename-symbol/write-function)", () => {
  for (const id of ["fix-syntax", "fix-logic", "rename-symbol", "write-function"]) assertEsmSandbox(id);
});

test("fix-syntax: 夹具坏内容判负 / 修好的内容判正", () => {
  const d = mk();
  try {
    byId("fix-syntax").setup(d);
    assert.equal(judge("fix-syntax", d).pass, false, "未修复的模板字符串语法错误应判负");
    W(d, "broken.js", "export function greet(name) {\n  return `hi ${name}`;\n}\n");
    assert.equal(judge("fix-syntax", d).pass, true, "语法修好后 node --check 应过");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("fix-logic: add 返回差值判负 / 返回和判正 (nodeRun 走 file URL, Windows 路径可导入)", () => {
  const d = mk();
  try {
    byId("fix-logic").setup(d);
    const before = judge("fix-logic", d);
    assert.equal(before.pass, false, "没真修应判负");
    assert.ok(/实际 -1/.test(before.detail), `坏内容应真的被执行出 -1 (证明判分在跑代码), 实际: ${before.detail}`);
    W(d, "calc.js", "export function add(a, b) {\n  return a + b;\n}\n");
    assert.equal(judge("fix-logic", d).pass, true, "add(2,3)=5 应判正");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("write-function: 缺 utils.js 判负 / agent 自建 sum 判正", () => {
  const d = mk();
  try {
    byId("write-function").setup(d);
    assert.equal(fs.existsSync(path.join(d, "utils.js")), false, "utils.js 必须由 agent 自己写");
    assert.equal(judge("write-function", d).pass, false, "文件缺失应判负");
    W(d, "utils.js", "export function sum(a, b) { return a + b; }\n");
    assert.equal(judge("write-function", d).pass, true, "sum(20,22)=42 应判正");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// 判分公平 (2026-10-05, 真跑 write-function 失败): 任务文本 "在 utils.js 里写并导出函数 sum(a, b)"
// 没指定模块系统, 而 setup 的 {"type":"module"} 让只有 ESM 写法可测 —— CJS 写法在同一 Node 上
// import() 不抛错却给出空导出表, 正确答案与"文件不存在"同样记 null (实测: 只有 ESM 通过)。
// 判分器必须两种都认; 同时"函数缺失/算错"这两种真失败必须照旧判负, 否则就成了白送分。
test("write-function: ESM 与 CommonJS 两种合法写法都判正 (判分器不偏袒模块系统)", () => {
  const good = {
    "ESM export function": "export function sum(a, b) { return a + b; }\n",
    "ESM export 列表": "function sum(a, b) { return a + b; }\nexport { sum };\n",
    "ESM 默认导出对象": "export default { sum(a, b) { return a + b; } };\n",
    "CJS module.exports": "module.exports = { sum: function (a, b) { return a + b; } };\n",
    "CJS exports.sum": "exports.sum = (a, b) => a + b;\n",
    "CJS module.exports.sum": "module.exports.sum = function (a, b) { return a + b; };\n",
  };
  for (const [label, body] of Object.entries(good)) {
    const d = mk();
    try {
      byId("write-function").setup(d); // 沙箱是 ESM 包 (package.json type=module)
      W(d, "utils.js", body);
      const v = judge("write-function", d);
      assert.equal(v.pass, true, `${label} 是正确答案, 应判正: ${v.detail}`);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
});

test("write-function: 真失败仍判负 —— 缺文件 / 实现算错 (ESM 与 CJS 各一例)", () => {
  const bad = {
    "ESM 实现算错 (a-b)": "export function sum(a, b) { return a - b; }\n",
    "CJS 实现算错 (a-b)": "module.exports = { sum: (a, b) => a - b };\n",
    "ESM 只导出别的函数": "export function diff(a, b) { return a - b; }\n",
    "CJS 空导出": "module.exports = {};\n",
    "语法错误": "export function sum(a, b) { return a + ; }\n",
  };
  for (const [label, body] of Object.entries(bad)) {
    const d = mk();
    try {
      byId("write-function").setup(d);
      W(d, "utils.js", body);
      const v = judge("write-function", d);
      assert.equal(v.pass, false, `${label} 必须判负`);
      assert.match(v.detail, /应为 42/, `${label} 的 detail 应给出实际取到的值: ${v.detail}`);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
  // 文件缺失: 判负且给出 null (不是把 null 当成 0 分蒙过)
  const d = mk();
  try {
    byId("write-function").setup(d);
    const v = judge("write-function", d);
    assert.equal(v.pass, false, "没有 utils.js 必须判负");
    assert.match(v.detail, /实际 null/, v.detail);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// 裸函数导出 —— 判分偏见第三犯 (2026-10-05, 见 docs/ppxans-audit-brief-2026-10-03.md 第 11 条
// 同一类): `module.exports = sum` / `export default sum` 的导出值本身就是那个函数, 而旧 probe
// 只会拿导出表去索引 (m.sum / m.default.sum), 于是这份"正确且完整"的答案得到 null, 与文件不存在
// 同一个分数。修法是给函数候选按它自己的 Function.prototype.name 补一个别名再求值。
// 名字闸门 (题目要的是"叫 sum 的函数", 不能因为补别名就把门拆了):
//   - module.exports = add      → name 是 "add", 补不出 sum → 判负
//   - module.exports = (a,b)=>… → 匿名, name === "", 什么都不补 → 判负
//   - 裸导出 + 实现算错 (a-b)    → 别名生效但值不对 → 判负且 detail 给出 -2 (证明真跑了代码)
// 判分入口一律走 write-function 真实的 verify (而不是直接调 probe helper), 这样 probe 与任务的
// 接线一旦改动测试就断。夹具沙箱与真任务 setup 完全一致 (同一份 asEsm package.json)。
const BARE_FN_CASES = [
  ["ESM export function (原本就能过)", "export function sum(a, b) { return a + b; }\n", true, /实际 42/],
  ["ESM export default sum (裸函数, 默认导出)", "function sum(a, b) { return a + b; }\nexport default sum;\n", true, /实际 42/],
  ["CJS module.exports = { sum } (原本就能过)", "function sum(a, b) { return a + b; }\nmodule.exports = { sum };\n", true, /实际 42/],
  ["CJS module.exports = sum (裸函数, 本条即 bug)", "function sum(a, b) { return a + b; }\nmodule.exports = sum;\n", true, /实际 42/],
  ["CJS exports.sum = sum", "function sum(a, b) { return a + b; }\nexports.sum = sum;\n", true, /实际 42/],
  ["CJS module.exports = add (名字不符必须仍判负)", "const add = (a, b) => a + b;\nmodule.exports = add;\n", false, /实际 null/],
  ["CJS module.exports = 匿名箭头 (无名可补, 判负)", "module.exports = (a, b) => a + b;\n", false, /实际 null/],
  ["ESM 实现算错 (a-b)", "function sum(a, b) { return a - b; }\n", false, /实际/],
];

test("write-function: 裸函数导出判正 / 名字不符与匿名与算错照旧判负 (ESM 沙箱)", () => {
  for (const [label, body, expectPass, detailRe] of BARE_FN_CASES) {
    const d = mk();
    try {
      byId("write-function").setup(d); // 与真任务同一夹具: package.json {"type":"module"}
      W(d, "utils.js", body);
      const v = judge("write-function", d);
      assert.equal(v.pass, expectPass, `${label} → 期望 ${expectPass ? "PASS" : "FAIL"}, 实际 ${v.pass}: ${v.detail}`);
      assert.match(v.detail, detailRe, `${label} 的 detail 应如实报告取到的值: ${v.detail}`);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
});

test("write-function: 无 utils.js 判负 (裸函数修复不影响缺文件)", () => {
  const d = mk();
  try {
    byId("write-function").setup(d);
    const v = judge("write-function", d);
    assert.equal(v.pass, false, "缺文件必须判负");
    assert.match(v.detail, /实际 null/, v.detail);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// 裸函数 + 别名路径必须仍然真跑代码: 走 (c) 形状但算错时, detail 要给出 -2 而不是 null,
// 否则就是"凡是函数都送分"。
test("write-function: 裸函数导出但实现算错 → 判负且 detail 给出 -2 (别名路径真在跑代码)", () => {
  for (const body of [
    "function sum(a, b) { return a - b; }\nmodule.exports = sum;\n",
    "function sum(a, b) { return a - b; }\nexport default sum;\n",
  ]) {
    const d = mk();
    try {
      byId("write-function").setup(d);
      W(d, "utils.js", body);
      const v = judge("write-function", d);
      assert.equal(v.pass, false, `算错的裸函数导出必须判负: ${body}`);
      assert.match(v.detail, /实际 -2/, `detail 应给出真实计算结果: ${v.detail}`);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
});

// 公平要双向: 沙箱没有 package.json (普通 CJS 目录) 时, 裸函数导出同样必须判正 ——
// 修复不能只在 ESM 包装里生效 (那只是把偏见换了个方向)。
test("write-function: 裸函数导出在无 type:module 的普通 CJS 目录里也判正 (双向公平)", () => {
  const good = {
    "CJS module.exports = sum": "function sum(a, b) { return a + b; }\nmodule.exports = sum;\n",
    "CJS module.exports = 具名函数表达式": "module.exports = function sum(a, b) { return a + b; };\n",
    "CJS exports.sum = sum": "function sum(a, b) { return a + b; }\nexports.sum = sum;\n",
    "CJS module.exports = { sum }": "function sum(a, b) { return a + b; }\nmodule.exports = { sum };\n",
  };
  const bad = {
    "CJS module.exports = add (名字不符)": "const add = (a, b) => a + b;\nmodule.exports = add;\n",
    "CJS module.exports = 匿名箭头": "module.exports = (a, b) => a + b;\n",
    "CJS 算错的裸函数导出": "function sum(a, b) { return a - b; }\nmodule.exports = sum;\n",
  };
  for (const [label, body] of Object.entries(good)) {
    const d = mk();
    try {
      assert.equal(fs.existsSync(path.join(d, "package.json")), false, "夹具目录不应有 package.json");
      W(d, "utils.js", body); // 只写 utils.js, 不调 setup (setup 会写 type:module)
      const v = judge("write-function", d);
      assert.equal(v.pass, true, `${label} 在普通 CJS 目录里应判正: ${v.detail}`);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
  for (const [label, body] of Object.entries(bad)) {
    const d = mk();
    try {
      W(d, "utils.js", body);
      const v = judge("write-function", d);
      assert.equal(v.pass, false, `${label} 在普通 CJS 目录里也必须判负: ${v.detail}`);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
  // 缺文件在普通 CJS 目录里同样判负
  const d = mk();
  try {
    const v = judge("write-function", d);
    assert.equal(v.pass, false, "普通 CJS 目录里缺文件必须判负");
    assert.match(v.detail, /实际 null/, v.detail);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("fix-logic: 判分器仍按任务意图跑代码 (坏内容 -1 判负, ESM 修好判正, 删文件判负)", () => {
  const d = mk();
  try {
    byId("fix-logic").setup(d);
    assert.equal(judge("fix-logic", d).pass, false, "未修复应判负");
    W(d, "calc.js", "export function add(a, b) {\n  return a + b;\n}\n");
    assert.equal(judge("fix-logic", d).pass, true, "ESM 修好应判正 (夹具本就是 ESM)");
    // 同一个任务的 CJS 裸函数写法也必须认 (别名修复惠及另一个代码任务, 不只是 write-function)
    W(d, "calc.js", "function add(a, b) { return a + b; }\nmodule.exports = add;\n");
    assert.equal(judge("fix-logic", d).pass, true, "裸 CJS 函数导出 module.exports = add 应判正");
    W(d, "calc.js", "const sub = (a, b) => a + b;\nmodule.exports = sub;\n");
    assert.equal(judge("fix-logic", d).pass, false, "名字不符 (sub) 仍不能替 add 交卷");
    fs.rmSync(path.join(d, "calc.js"));
    assert.equal(judge("fix-logic", d).pass, false, "目标文件消失必须判负");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("rename-symbol: 旧名仍在判负 / 全量改名且可运行判正", () => {
  const d = mk();
  try {
    byId("rename-symbol").setup(d);
    assert.equal(judge("rename-symbol", d).pass, false, "fetchData 未清应判负");
    W(d, "rename-me.js", "export async function loadData() { return 1; }\nexport async function main() { const r = await loadData(); return r; }\n");
    assert.equal(judge("rename-symbol", d).pass, true, "旧名清零/新名在/语法过 应判正");
    // 改坏 (引用未定义的旧名) 不能因为"旧名在别处"蒙过 nodeCheck
    W(d, "rename-me.js", "export async function main() { const r = await fetchData(); return r; }\n");
    assert.equal(judge("rename-symbol", d).pass, false, "漏改一处应判负");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("检索/文件/综合类判分不受 ESM 改动影响 (意图不变)", () => {
  const d = mk();
  try {
    byId("find-symbol").setup(d);
    // find-symbol 靠回复文本判, 且 setup 不应被塞进 package.json (夹具本身无需 ESM)
    assert.equal(fs.existsSync(path.join(d, "package.json")), false);
    assert.equal(judge("find-symbol", d, "pricing.js").pass, true);
    assert.equal(judge("find-symbol", d, "在 unrelated.js").pass, false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }

  const d2 = mk();
  try {
    byId("version-report").setup(d2);
    assert.equal(judge("version-report", d2, "7.7.7").pass, true);
    assert.equal(judge("version-report", d2, "版本 1.2.3").pass, false);
  } finally { fs.rmSync(d2, { recursive: true, force: true }); }

  const d3 = mk();
  try {
    byId("analyze-and-report").setup(d3);
    assert.equal(judge("analyze-and-report", d3).pass, false, "report.txt 缺失应判负");
    W(d3, "report.txt", "共 4 行");
    assert.equal(judge("analyze-and-report", d3).pass, true);
    W(d3, "report.txt", "共 1 行");
    assert.equal(judge("analyze-and-report", d3).pass, false, "猜错行数应判负 (装置不是白送分)");
  } finally { fs.rmSync(d3, { recursive: true, force: true }); }

  const d4 = mk();
  try {
    byId("src-listing").setup(d4);
    assert.equal(fs.existsSync(path.join(d4, "package.json")), false);
    W(d4, "lib-list.txt", "a.js\nb.js\n");
    assert.equal(judge("src-listing", d4).pass, true);
  } finally { fs.rmSync(d4, { recursive: true, force: true }); }

  const d5 = mk();
  try {
    byId("sum-numbers").setup(d5);
    assert.equal(judge("sum-numbers", d5, "50").pass, true);
    assert.equal(judge("sum-numbers", d5, "合计 49").pass, false);
  } finally { fs.rmSync(d5, { recursive: true, force: true }); }
});
