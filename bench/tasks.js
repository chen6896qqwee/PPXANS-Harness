// bench/tasks.js - 任务级评测基准 (2026-10-02)
// 20 个可确定性验证的任务: 评测「agent 能不能把事干成」, 区别于守卫型单测 (功能不被破坏)。
// 每个任务: id / category / task (给 agent 的指令) / setup (沙箱夹具) / verify (确定性判分, 不用 LLM 评审)。
// verify 返回 { pass, detail }; 沙箱目录 ctx.sandbox 隔离, 不污染仓库。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { FactStore } from "../src/memory/fact-store.js";
import { LegionBoard } from "../src/memory/legion-board.js";

export const VERIFIER_VERSION = 3;

const W = (dir, name, content) => { fs.writeFileSync(path.join(dir, name), content); };
const R = (dir, name) => fs.readFileSync(path.join(dir, name), "utf8");
// 2026-10-10 修复: 代码类任务沙箱必须声明为 ESM 包 —— 否则 Node 按最近 package.json 判模块类型,
//   同一份「正确」代码在无 package.json 的临时沙箱里会因 `export` 语法被当 CJS 而判负。
const asEsm = (d) => W(d, "package.json", JSON.stringify({ name: "bench-fixture", type: "module" }, null, 2));

// node 语法检查 + ESM 求值 (代码修复类任务判分用)
function nodeCheck(file) {
  try { execFileSync(process.execPath, ["--check", file], { stdio: "pipe", timeout: 3000 }); return true; } catch { return false; }
}
// 2026-10-10 修复: ① 绝对路径必须先转 file:// URL, 否则 Windows 盘符被当 URL scheme (ERR_UNSUPPORTED_ESM_URL_SCHEME);
//   ② 探针要认「裸函数导出」(module.exports = sum / export default sum), 否则正确答案与"文件不存在"同分;
//   ③ 判分器不偏袒模块系统: ESM 包里的 CJS 写法 (module.exports) 要走 .cjs 副本 require 兜底;
//   ④ 名字闸门不拆: 只接受 name 与目标一致的函数, 匿名/改名的照旧判 null。
function nodeRun(file, fnName, args) {
  const url = pathToFileURL(file).href;
  const script = `
(async () => {
  const file = ${JSON.stringify(file)};
  const url = ${JSON.stringify(url)};
  const name = ${JSON.stringify(fnName)};
  const args = ${JSON.stringify(args)};
  const cands = [];
  const collect = (m) => {
    if (!m) return;
    if (typeof m[name] === "function") cands.push(m[name]);
    if (m.default) {
      if (typeof m.default[name] === "function") cands.push(m.default[name]);
      if (typeof m.default === "function" && m.default.name === name) cands.push(m.default);
    }
    if (typeof m === "function" && m.name === name) cands.push(m);
  };
  try { collect(await import(url)); } catch { /* 非 ESM 或语法错: 交给 CJS 兜底 */ }
  if (!cands.length) {
    // CJS 兜底: ESM 包 (.js + type:module) 里的 module.exports 写法 → 复制成 .cjs 再 require
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { createRequire } = await import("node:module");
      const dir = path.dirname(file);
      const tmp = path.join(dir, ".ppx-probe-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".cjs");
      fs.copyFileSync(file, tmp);
      try { collect(createRequire(path.join(dir, "x.js"))(tmp)); } finally { try { fs.rmSync(tmp); } catch {} }
    } catch { /* 语法错/求值错 → 保持无候选 */ }
  }
  const fn = cands[0];
  if (typeof fn !== "function") { console.log("null"); return; }
   try { console.log(JSON.stringify(String(await fn(...args)))); } catch { console.log("null"); }
})();
`;
  try {
    return JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 }).trim());
  } catch (e) { return null; }
}
// 数字命中 (2026-10-10 收紧): 必须是**独立数字** —— 不能是更长数字的一段。
//   旧实现是裸 substring 正则 ("一共有 16 个文件" 对「应含 6」判正 / "共 14 行" 对「应含 4」判正),
//   五个数字类任务的近失答案白拿分。边界口径:
//     左边界 (?<![\d.]) —— 前面不能是数字, 也不能是小数点 (挡 17.7.7 里的 7.7.7)
//     右边界 (?<!…) 之后 (?![\d]) —— 后面不能紧跟数字 (挡 150 里的 50, 16 里的 6)
//   刻意**不**禁尾部小数点: "7.7.7" 自身含点, 禁了就把正确版本号一起打死。
// These factual tasks explicitly request a single value. Free-form semantic
// judgment belongs to a model/reviewer, not a negation/keyword classifier.
const exactReply = (reply, value) => String(reply ?? "").trim() === String(value);
function verifyFunction(file, name, cases) {
  const outputs = [];
  for (const [args, expected] of cases) {
    const out = nodeRun(file, name, args);
    outputs.push(out);
    if (out !== String(expected)) return { pass: false, detail: `${name}(${args.map((x) => JSON.stringify(x)).join(",")}) 应为 ${expected}, 实际 ${out}` };
  }
  return { pass: true, detail: `${name}: ${cases.length} 组运行结果正确; 首组实际 ${outputs[0]}` };
}
function memoryStored(ctx, content) {
  const store = new FactStore(ctx.dataDir || path.join(ctx.sandbox, ".ppx"), {});
  try { return store.query(content, { limit: 50 }).some((f) => f.content.includes(content)); }
  finally { store.close?.(); }
}
function boardStored(ctx, content) {
  const board = new LegionBoard(ctx.globalDataDir || path.join(ctx.sandbox, ".ppx-global"));
  return board.query({ q: content }).some((entry) => entry.content === content);
}

export const TASKS = [
  // ---- A. 信息检索 ----
  {
    id: "version-report", category: "检索",
    task: "读 package.json, 告诉我 version 字段的值 (只要版本号)。",
    setup: (d) => W(d, "package.json", JSON.stringify({ name: "bench-fixture", version: "7.7.7" }, null, 2)),
    verify: (r) => ({ pass: exactReply(r.reply, "7.7.7"), detail: "只回答版本号 7.7.7" }),
  },
  {
    id: "count-files", category: "检索",
    task: "数一下 items 目录里有几个 .txt 文件, 只回答数字。",
    setup: (d) => { fs.mkdirSync(path.join(d, "items")); for (let i = 1; i <= 6; i++) W(d, `items/f${i}.txt`, "x"); },
    verify: (r) => ({ pass: exactReply(r.reply, 6), detail: "只回答数字 6" }),
  },
  {
    id: "find-symbol", category: "检索",
    task: "函数 calcDiscount 定义在哪个文件? 只回答文件名。",
    setup: (d) => { W(d, "pricing.js", "export function calcDiscount(n){return n*0.9;}"); W(d, "unrelated.js", "export const x=1;"); },
    verify: (r) => ({ pass: exactReply(r.reply, "pricing.js"), detail: "只回答文件名 pricing.js" }),
  },
  {
    id: "sum-numbers", category: "检索",
    task: "读 numbers.txt, 把里面的数字加总, 只回答结果数字。",
    setup: (d) => W(d, "numbers.txt", "17\n25\n8\n"),
    verify: (r) => ({ pass: exactReply(r.reply, 50), detail: "只回答数字 50" }),
  },
  {
    id: "read-secret", category: "检索",
    task: "读 config.ini, 只回答 token 的值。",
    setup: (d) => W(d, "config.ini", "[auth]\ntoken = sk-bench-42\n"),
    verify: (r) => ({ pass: exactReply(r.reply, "sk-bench-42"), detail: "只回答完整 token 值" }),
  },

  // ---- B. 文件操作 ----
  {
    id: "create-file", category: "文件",
    task: "创建 notes/todo.txt, 内容为: 买牛奶",
    setup: (d) => fs.mkdirSync(path.join(d, "notes")),
    verify: (r, c) => { try { return { pass: R(c.sandbox, "notes/todo.txt").includes("买牛奶"), detail: "文件应存在且含内容" }; } catch { return { pass: false, detail: "文件不存在" }; } },
  },
  {
    id: "append-file", category: "文件",
    task: "在 log.txt 末尾追加一行: DONE",
    setup: (d) => W(d, "log.txt", "line1\n"),
    verify: (r, c) => {
      // 2026-10-10: 缺文件必须是"判负 + 可读归因", 不能抛异常 —— taskbench 的外层 catch 会把
      //   崩溃收成"判分异常: ...", 归因信息就丢了 (与 create-file/json-edit 同口径)。
      try { const t = R(c.sandbox, "log.txt"); return { pass: t.startsWith("line1") && /DONE/.test(t), detail: "应保留原内容且含 DONE" }; }
      catch { return { pass: false, detail: "log.txt 不存在 (原文件被覆盖或删除)" }; }
    },
  },
  {
    id: "json-edit", category: "文件",
    task: "把 config.json 里的 timeout 改成 5000。",
    setup: (d) => W(d, "config.json", JSON.stringify({ timeout: 1000, retries: 3 })),
    verify: (r, c) => { try { const j = JSON.parse(R(c.sandbox, "config.json")); return { pass: j.timeout === 5000 && j.retries === 3, detail: "timeout=5000 且其他字段不动" }; } catch (e) { return { pass: false, detail: e.message }; } },
  },
  {
    id: "delete-file", category: "文件",
    task: "删除 obsolete.txt。",
    setup: (d) => W(d, "obsolete.txt", "old"),
    verify: (r, c) => ({ pass: !fs.existsSync(path.join(c.sandbox, "obsolete.txt")), detail: "文件应已删除" }),
  },
  {
    id: "json-create", category: "文件",
    task: "创建 person.json, 内容: name 为 Alice, age 为 30。",
    verify: (r, c) => { try { const j = JSON.parse(R(c.sandbox, "person.json")); return { pass: j.name === "Alice" && j.age === 30, detail: "可解析且字段正确" }; } catch { return { pass: false, detail: "文件缺失或非法 JSON" }; } },
  },

  // ---- C. 代码修复 ----
  {
    id: "fix-syntax", category: "代码",
    task: "修复 broken.js 的语法错误 (不改逻辑)。",
    setup: (d) => { asEsm(d); W(d, "broken.js", "export function greet(name) {\n  return `hi ${name`;\n}\n"); },
    verify: (r, c) => {
      const f = path.join(c.sandbox, "broken.js");
      // 2026-10-10 收紧: 只做 node --check 会放过"把函数整段注释掉"这类非答案 (语法合法但功能没了),
      //   也放过"把 hi 改成 hello"这种**改了逻辑**的修补。题面要求"不改逻辑", 故必须真跑一次:
      //   语法通过 **且** greet("bench") 仍返回 "hi bench"。接受字符串拼接 / CJS 裸导出等写法
      //   (nodeRun 已认 ESM 默认导出、裸函数导出、CJS 兜底)。
      try {
        if (!nodeCheck(f)) return { pass: false, detail: "node --check 未通过" };
        return verifyFunction(f, "greet", [[["bench"], "hi bench"], [["雪"], "hi 雪"], [[""], "hi "]]);
      } catch (e) { return { pass: false, detail: `判分异常: ${e.message}` }; }
    },
  },
  {
    id: "fix-logic", category: "代码",
    task: "calc.js 的 add 函数算错了 (返回了差值), 修复成返回和。",
    setup: (d) => { asEsm(d); W(d, "calc.js", "export function add(a, b) {\n  return a - b;\n}\n"); },
    verify: (r, c) => verifyFunction(path.join(c.sandbox, "calc.js"), "add", [[[2, 3], 5], [[0, 0], 0], [[-4, 1], -3], [[0.5, 1.25], 1.75]]),
  },
  {
    id: "write-function", category: "代码",
    task: "在 utils.js 里写并导出函数 sum(a, b), 返回两数之和。",
    // 2026-10-10 补: 原任务缺 setup → byId("write-function").setup 不存在, 沙箱也没声明 ESM。
    //   utils.js 必须由 agent 自己写, 故 setup 只摆 package.json, 不预置 utils.js。
    setup: (d) => asEsm(d),
    verify: (r, c) => verifyFunction(path.join(c.sandbox, "utils.js"), "sum", [[[20, 22], 42], [[0, 0], 0], [[-4, 1], -3], [[0.5, 1.25], 1.75]]),
  },
  {
    id: "rename-symbol", category: "代码",
    task: "把 rename-me.js 里的标识符 fetchData 全部改名为 loadData, 保持可运行。",
    setup: (d) => { asEsm(d); W(d, "rename-me.js", "export async function fetchData() { return 1; }\nexport async function main() { const r = await fetchData(); return r; }\n"); },
    verify: (r, c) => {
      // 2026-10-10: 缺文件/语法异常一律收成判负 + 可读 detail (崩溃会把归因信息丢掉)
      try {
        const t = R(c.sandbox, "rename-me.js");
        const file = path.join(c.sandbox, "rename-me.js");
        const running = verifyFunction(file, "main", [[[], 1]]);
        return { pass: !t.includes("fetchData") && t.includes("loadData") && nodeCheck(file) && running.pass, detail: `旧名清零/新名在/可运行; ${running.detail}` };
      } catch (e) { return { pass: false, detail: `判分异常: ${e.message}` }; }
    },
  },

  // ---- D. 记忆与协作 ----
  {
    id: "memory-roundtrip", category: "协作",
    task: "记住: 基准测试口令-蓝鲸99, 然后只回答你记住的完整口令。",
    verify: (r, c) => ({ pass: exactReply(r.reply, "基准测试口令-蓝鲸99") && memoryStored(c, "基准测试口令-蓝鲸99"), detail: "口令须真实持久存储且完整回复" }),
  },
  {
    id: "board-roundtrip", category: "协作",
    task: "用 board_publish 工具发布一条 content 为 军团暗号-QW7 的消息, 再用 board_query 查出来, 只回答查到的完整内容。",
    verify: (r, c) => ({ pass: exactReply(r.reply, "军团暗号-QW7") && boardStored(c, "军团暗号-QW7"), detail: "内容须真实存于共享板且完整回复" }),
  },

  // ---- E. 多步综合 ----
  {
    id: "analyze-and-report", category: "综合",
    task: "读 data.csv (每行一条记录), 统计数据行数 (不含表头), 把结果写入 report.txt, 内容格式: 共 N 行。",
    setup: (d) => W(d, "data.csv", "id,name\n1,a\n2,b\n3,c\n4,d\n"),
    verify: (r, c) => { try { return { pass: /^共\s*4\s*行$/.test(R(c.sandbox, "report.txt").trim()), detail: "report.txt 格式须为 共 4 行" }; } catch { return { pass: false, detail: "report.txt 不存在" }; } },
  },
  {
    id: "conditional-write", category: "综合",
    task: "看 flag.txt 的内容: 如果是 on 就创建 enabled.txt (内容随意), 如果是 off 就什么都别做。",
    setup: (d) => W(d, "flag.txt", "on"),
    verify: (r, c) => ({ pass: fs.existsSync(path.join(c.sandbox, "enabled.txt")), detail: "on 应触发创建" }),
  },
  {
    id: "src-listing", category: "综合",
    task: "列出 lib 目录下的 js 文件名, 把清单写入 lib-list.txt (一行一个)。",
    setup: (d) => { fs.mkdirSync(path.join(d, "lib")); W(d, "lib/a.js", ""); W(d, "lib/b.js", ""); W(d, "lib/readme.md", ""); },
    verify: (r, c) => { try { const names = R(c.sandbox, "lib-list.txt").trim().split(/\r?\n/).map((name) => name.trim().replace(/^lib[\\/]/, "")).sort(); return { pass: JSON.stringify(names) === JSON.stringify(["a.js", "b.js"]), detail: "须恰好列 2 个 js, 一行一个" }; } catch { return { pass: false, detail: "lib-list.txt 不存在" }; } },
  },
  {
    id: "extract-field", category: "综合",
    task: "读 users.json, 统计 email 以 @bench.dev 结尾的用户有几个, 只回答数字。",
    setup: (d) => W(d, "users.json", JSON.stringify([{ email: "a@bench.dev" }, { email: "b@other.com" }, { email: "c@bench.dev" }])),
    verify: (r) => ({ pass: exactReply(r.reply, 2), detail: "只回答数字 2" }),
  },
];

// ===========================================================================
// 可证伪夹具 (oracle + mutants) —— 2026-10-10 补齐
// 判分器只有在「参考解判正」且「故意写错的答案判负」同时成立时才算可信。每个任务自带:
//   oracle   参考解: 形状与 taskbench 里 agent 的产出一致 (写文件 / 返回文本), 必须判正
//   mutants  变异体: ≥2 个, 至少 1 个是**近失题** (near: true) —— 一眼错的 strawman 证明不了
//            判分器在测量, 只有"看起来像对"的错答案才有效。family = 变异族 (成套而非随手)。
// 由 bench/falsify.js 逐条验证 (纯离线 / 零 LLM)。
const FIXTURES = {
  // ---- A. 检索 ----
  "version-report": {
    oracle: () => "7.7.7",
    mutants: [
      { name: "版本号多一位", family: "数值边界近失", near: true, artifact: () => "package.json 里写的是 17.7.7" },
      { name: "凭空猜版本", family: "凭空断言", artifact: () => "版本号是 1.0.0" },
      { name: "答非所问", family: "未给答案", artifact: () => "package.json 里同时有 name 和 version 两个字段" },
    ],
  },
  "count-files": {
    oracle: () => "6",
    mutants: [
      { name: "多报十位", family: "数值边界近失", near: true, artifact: () => "一共有 16 个文件" },
      { name: "不给数字", family: "凭空断言", artifact: () => "items 目录里有几个文本文件" },
    ],
  },
  "find-symbol": {
    oracle: () => "pricing.js",
    mutants: [
      { name: "两个文件都提", family: "未做指认", near: true, artifact: () => "pricing.js 和 unrelated.js 里都可能有" },
      { name: "指认错误文件", family: "指认错误", artifact: () => "定义在 unrelated.js" },
    ],
  },
  "sum-numbers": {
    oracle: () => "50",
    mutants: [
      { name: "结果多一位", family: "数值边界近失", near: true, artifact: () => "三项加起来是 150" },
      { name: "少加一项", family: "算术错误", artifact: () => "结果是 42" },
      { name: "只报中间结果", family: "答案不完整", artifact: () => "17 + 25 = 42, 还要再加 8" },
    ],
  },
  "read-secret": {
    oracle: () => "sk-bench-42",
    mutants: [
      { name: "只说位置不给值", family: "未给答案", near: true, artifact: () => "token 的值可以在 config.ini 里找到" },
      { name: "值被截断", family: "答案不完整", artifact: () => "token = sk-bench-4" },
    ],
  },

  // ---- B. 文件操作 ----
  "create-file": {
    oracle: ({ sandbox }) => { W(sandbox, "notes/todo.txt", "买牛奶"); return "已创建"; },
    mutants: [
      { name: "建了空文件", family: "内容缺失", near: true, artifact: ({ sandbox }) => { W(sandbox, "notes/todo.txt", ""); return "已创建"; } },
      { name: "建错目录", family: "路径错误", artifact: ({ sandbox }) => { W(sandbox, "todo.txt", "买牛奶"); return "已创建"; } },
    ],
  },
  "append-file": {
    oracle: ({ sandbox }) => { fs.appendFileSync(path.join(sandbox, "log.txt"), "DONE\n"); return "已追加"; },
    mutants: [
      { name: "覆盖而非追加", family: "破坏原内容", near: true, artifact: ({ sandbox }) => { W(sandbox, "log.txt", "DONE\n"); return "已追加"; } },
      { name: "删掉原文件", family: "目标丢失", artifact: ({ sandbox }) => { fs.rmSync(path.join(sandbox, "log.txt"), { force: true }); return "已追加"; } },
    ],
  },
  "json-edit": {
    oracle: ({ sandbox }) => { W(sandbox, "config.json", JSON.stringify({ timeout: 5000, retries: 3 }, null, 2)); return "timeout 已改成 5000"; },
    mutants: [
      { name: "只留改动字段", family: "破坏同文件其他字段", near: true, artifact: ({ sandbox }) => { W(sandbox, "config.json", JSON.stringify({ timeout: 5000 })); return "已改"; } },
      { name: "写成字符串", family: "类型错误", artifact: ({ sandbox }) => { W(sandbox, "config.json", JSON.stringify({ timeout: "5000", retries: 3 })); return "已改"; } },
    ],
  },
  "delete-file": {
    oracle: ({ sandbox }) => { fs.rmSync(path.join(sandbox, "obsolete.txt"), { force: true }); return "已删除"; },
    mutants: [
      { name: "没删只承诺", family: "未执行动作", near: true, artifact: () => "好的, 我马上处理" },
      { name: "删了别的文件", family: "路径错误", artifact: ({ sandbox }) => { W(sandbox, "other.txt", "x"); fs.rmSync(path.join(sandbox, "other.txt"), { force: true }); return "已删除"; } },
    ],
  },
  "json-create": {
    oracle: ({ sandbox }) => { W(sandbox, "person.json", JSON.stringify({ name: "Alice", age: 30 }, null, 2)); return "已创建"; },
    mutants: [
      { name: "年龄写成字符串", family: "字段类型错误", near: true, artifact: ({ sandbox }) => { W(sandbox, "person.json", JSON.stringify({ name: "Alice", age: "30" })); return "已创建"; } },
      { name: "不是合法 JSON", family: "格式非法", artifact: ({ sandbox }) => { W(sandbox, "person.json", "{name: Alice, age: 30}"); return "已创建"; } },
    ],
  },

  // ---- C. 代码修复 ----
  "fix-syntax": {
    oracle: ({ sandbox }) => { W(sandbox, "broken.js", "export function greet(name) {\n  return `hi ${name}`;\n}\n"); return "已修复"; },
    mutants: [
      { name: "整段注释掉", family: "非答案修补", near: true, artifact: ({ sandbox }) => { W(sandbox, "broken.js", "// export function greet(name) {\n//   return `hi ${name}`;\n// }\n"); return "已修复"; } },
      { name: "把返回值改错", family: "语义变更", artifact: ({ sandbox }) => { W(sandbox, "broken.js", "export function greet(name) {\n  return `hello ${name}`;\n}\n"); return "已修复"; } },
    ],
  },
  "fix-logic": {
    oracle: ({ sandbox }) => { W(sandbox, "calc.js", "export function add(a, b) {\n  return a + b;\n}\n"); return "已修复"; },
    mutants: [
      { name: "原样未改", family: "未修复缺陷", near: true, artifact: ({ sandbox }) => { W(sandbox, "calc.js", "export function add(a, b) {\n  return a - b;\n}\n"); return "已修复"; } },
      { name: "改成乘法", family: "算术错误", artifact: ({ sandbox }) => { W(sandbox, "calc.js", "export function add(a, b) {\n  return a * b;\n}\n"); return "已修复"; } },
    ],
  },
  "write-function": {
    oracle: ({ sandbox }) => { W(sandbox, "utils.js", "export function sum(a, b) {\n  return a + b;\n}\n"); return "已写好"; },
    mutants: [
      { name: "写了但没导出", family: "非模块答案", near: true, artifact: ({ sandbox }) => { W(sandbox, "utils.js", "function sum(a, b) {\n  return a + b;\n}\n"); return "已写好"; } },
      { name: "导出却算错", family: "算术错误", artifact: ({ sandbox }) => { W(sandbox, "utils.js", "export function sum(a, b) {\n  return a - b;\n}\n"); return "已写好"; } },
    ],
  },
  "rename-symbol": {
    oracle: ({ sandbox }) => { W(sandbox, "rename-me.js", "export async function loadData() { return 1; }\nexport async function main() { const r = await loadData(); return r; }\n"); return "已改名"; },
    mutants: [
      { name: "只改一半", family: "重命名不彻底", near: true, artifact: ({ sandbox }) => { W(sandbox, "rename-me.js", "export async function loadData() { return 1; }\nexport async function main() { const r = await fetchData(); return r; }\n"); return "已改名"; } },
      { name: "改成别的名字", family: "改名错误", artifact: ({ sandbox }) => { W(sandbox, "rename-me.js", "export async function getData() { return 1; }\nexport async function main() { const r = await getData(); return r; }\n"); return "已改名"; } },
    ],
  },

  // ---- D. 记忆与协作 ----
  "memory-roundtrip": {
    oracle: ({ sandbox }) => { new FactStore(path.join(sandbox, ".ppx"), {}).add("基准测试口令-蓝鲸99"); return "基准测试口令-蓝鲸99"; },
    mutants: [
      { name: "口令回显但未存储", family: "无实质存储", near: true, artifact: () => "基准测试口令-蓝鲸99" },
      { name: "口令记错", family: "内容错误", artifact: () => "已记住: 基准测试口令-蓝鲸9" },
      { name: "复述成别的", family: "答非所问", artifact: () => "我记住了你刚才说的内容" },
    ],
  },
  "board-roundtrip": {
    oracle: ({ sandbox }) => { new LegionBoard(path.join(sandbox, ".ppx-global")).publish({ from: "oracle", content: "军团暗号-QW7" }); return "军团暗号-QW7"; },
    mutants: [
      { name: "暗号回显但未发布", family: "未用工具", near: true, artifact: () => "军团暗号-QW7" },
      { name: "暗号残缺", family: "内容错误", artifact: () => "查到的是 军团暗号-QW" },
      { name: "只报发布成功", family: "答非所问", artifact: () => "消息已成功发布到共享板" },
    ],
  },

  // ---- E. 多步综合 ----
  "analyze-and-report": {
    oracle: ({ sandbox }) => { W(sandbox, "report.txt", "共 4 行"); return "已写入 report.txt"; },
    mutants: [
      { name: "把表头算进去", family: "计数口径近失", near: true, artifact: ({ sandbox }) => { W(sandbox, "report.txt", "共 5 行"); return "已写入"; } },
      { name: "数字粘连", family: "数值边界近失", artifact: ({ sandbox }) => { W(sandbox, "report.txt", "共 14 行"); return "已写入"; } },
    ],
  },
  "conditional-write": {
    oracle: ({ sandbox }) => { W(sandbox, "enabled.txt", "on"); return "已创建 enabled.txt"; },
    mutants: [
      { name: "条件判反", family: "条件误判", near: true, artifact: () => "flag 内容是 on, 但我判断不需要创建" },
      { name: "建错文件名", family: "文件名错误", artifact: ({ sandbox }) => { W(sandbox, "enable.txt", "on"); return "已创建"; } },
    ],
  },
  "src-listing": {
    oracle: ({ sandbox }) => { W(sandbox, "lib-list.txt", "a.js\nb.js\n"); return "已写入"; },
    mutants: [
      { name: "把 md 也列进去", family: "过滤缺失", near: true, artifact: ({ sandbox }) => { W(sandbox, "lib-list.txt", "a.js\nb.js\nreadme.md\n"); return "已写入"; } },
      { name: "只列一个", family: "清单不全", artifact: ({ sandbox }) => { W(sandbox, "lib-list.txt", "a.js\n"); return "已写入"; } },
    ],
  },
  "extract-field": {
    oracle: () => "2",
    mutants: [
      { name: "口径放太宽", family: "匹配口径错误", near: true, artifact: () => "一共有 3 个用户" },
      { name: "数字粘连", family: "数值边界近失", artifact: () => "共有 12 个用户" },
    ],
  },
};

// 挂到任务上 (只补 oracle / mutants 两个字段, 其余定义不动)
for (const t of TASKS) {
  const fx = FIXTURES[t.id];
  if (fx) { t.oracle = fx.oracle; t.mutants = fx.mutants; }
}
export { FIXTURES };

// 汇总: 总成功率 + 分类成功率 + 成本
export function summarize(results) {
  const byCat = {};
  const number = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const sum = (key) => results.reduce((s, r) => s + (number(r[key]) ? r[key] : 0), 0);
  const completeSum = (key) => results.length && results.every((r) => number(r[key])) ? sum(key) : null;
  const pass = results.filter((r) => r.pass === true).length;
  const totalTokens = completeSum("tokens");
  const totalCostUsd = completeSum("costUsd");
  const calls = sum("calls");
  for (const r of results) {
    byCat[r.category] ??= { total: 0, pass: 0, tokens: 0, knownTokens: 0, costUsd: 0, knownCostUsd: 0, ms: 0 };
    byCat[r.category].total++;
    if (r.pass === true) byCat[r.category].pass++;
    byCat[r.category].tokens = number(r.tokens) && byCat[r.category].tokens !== null ? byCat[r.category].tokens + r.tokens : null;
    byCat[r.category].knownTokens += number(r.knownTokens) ? r.knownTokens : number(r.tokens) ? r.tokens : 0;
    byCat[r.category].costUsd = number(r.costUsd) && byCat[r.category].costUsd !== null ? byCat[r.category].costUsd + r.costUsd : null;
    byCat[r.category].knownCostUsd += number(r.knownCostUsd) ? r.knownCostUsd : number(r.costUsd) ? r.costUsd : 0;
    byCat[r.category].ms += r.ms || 0;
  }
  return {
    total: results.length,
    pass,
    passRate: results.length ? +(pass / results.length).toFixed(3) : 0,
    totalTokens,
    knownTokens: results.reduce((s, r) => s + (number(r.knownTokens) ? r.knownTokens : number(r.tokens) ? r.tokens : 0), 0),
    totalCostUsd,
    knownCostUsd: results.reduce((s, r) => s + (number(r.knownCostUsd) ? r.knownCostUsd : number(r.costUsd) ? r.costUsd : 0), 0),
    tokensPerSuccess: pass > 0 && totalTokens !== null ? totalTokens / pass : null,
    costUsdPerSuccess: pass > 0 && totalCostUsd !== null ? totalCostUsd / pass : null,
    usageCoverage: calls > 0 ? sum("usageKnownCalls") / calls : null,
    costCoverage: calls > 0 ? (calls - sum("costUnknownCalls")) / calls : null,
    avgMs: results.length ? Math.round(results.reduce((s, r) => s + (r.ms || 0), 0) / results.length) : 0,
    // 单位成本成功率 (框架第 1 条: 关注单位成本成功率, 而非单次表现): 每 10 万 token 的通过任务数
    costEfficiency: (() => {
      return totalTokens > 0 ? +((pass / totalTokens) * 100000).toFixed(2) : null;
    })(),
    byCategory: byCat,
    failures: results.filter((r) => !r.pass).map((r) => ({ id: r.id, detail: r.detail, reply: String(r.reply || "").slice(0, 200) })),
  };
}
