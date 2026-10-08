// bench/tasks.js - 任务级评测基准 (2026-10-02)
// 20 个可确定性验证的任务: 评测「agent 能不能把事干成」, 区别于守卫型单测 (功能不被破坏)。
// 每个任务: id / category / task (给 agent 的指令) / setup (沙箱夹具) / verify (确定性判分, 不用 LLM 评审)。
// verify 返回 { pass, detail }; 沙箱目录 ctx.sandbox 隔离, 不污染仓库。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const W = (dir, name, content) => { fs.writeFileSync(path.join(dir, name), content); };
const R = (dir, name) => fs.readFileSync(path.join(dir, name), "utf8");
const RM = (dir, name) => { fs.rmSync(path.join(dir, name), { force: true }); };
const MKDIR = (dir, name) => { fs.mkdirSync(path.join(dir, name), { recursive: true }); };

// ESM 沙箱声明 (2026-10-05 修复判分器): 代码类夹具写的是 `export function ...` 语法,
// 但临时沙箱里没有任何 package.json, Node 按"最近的 package.json"判定模块类型 → 缺省即
// CommonJS。旧宿主 (Node < 22.7, 无模块语法探测) 上 `export` 本身就是 SyntaxError,
// nodeCheck 恒 false; 新宿主靠语法探测碰巧能过 —— 判分结果取决于 Node 版本, 基准不可复现
// (当时 nodeRun 那条路还另有 file URL 的 bug, 与内容对错无关地恒 null)。
// 修法是让沙箱本身是个确定的 ESM 包: setup 里补一行 {"type":"module"},
// 任务意图与判分标准不变 (坏内容照样判负), 只是把"测量装置"修得能测到东西。
// (同日另一处已修: nodeRun 曾把 Windows 绝对路径直接当 import 的 specifier → 恒 null。)
// 注意这一行只声明"夹具自己怎么写", 不等于"agent 只能这么答" —— 判分侧对模块写法的兼容见
// 下方 moduleProbeScript。
const asEsm = (dir) => W(dir, "package.json", JSON.stringify({ name: "bench-esm-sandbox", type: "module" }, null, 2));

// node 语法检查 (代码修复类任务判分用) + 模块系统无关的导出求值 (见 moduleProbeScript)
function nodeCheck(file) {
  try { execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }); return true; } catch { return false; }
}

// 模块系统无关地取一次导出并求值 (2026-10-05 修复判分公平性, 真跑 write-function 因此失败):
// 任务文本 "在 utils.js 里写并导出函数 sum(a, b)" 没指定 ESM 还是 CommonJS, 而 setup 补的
// {"type":"module"} 只保证 ESM 写法可测 —— 实测本机 Node 26 上, CJS 写法 (module.exports /
// exports.sum) 在 type:module 包里 import() 根本不抛错, 只是导出表为空 (命名导出/默认导出
// 都取不到), 于是正确答案与"文件不存在"得到同一个 null: 判分器偏袒了一种合法写法。
// (今天之前沙箱没有 package.json, 局面正好相反 —— CJS 能过、ESM 恒死, 那次的修法把球门
//  移动了而不是摆正了。)
// 现在的口径: 三种取法按序试到拿到可用导出为止 —— import() → createRequire 的 require()
// → 把源码当 CommonJS 直接求值 (前两种在 type:module 包下都会给出空导出表, 只有这条路能
// 还原 module.exports)。
// 覆盖到的导出形状 (同类偏见已犯三次, 逐条列清, 不要再写"两种形状通吃"这种不成立的概括):
//   (a) 命名导出表:  m.sum        —— export function sum / export {sum} / exports.sum= /
//                                    module.exports = { sum } / module.exports.sum =
//   (b) 默认导出表:  m.default.sum —— export default { sum }
//   (c) 裸函数导出:  导出值本身就是那个函数 —— module.exports = sum / export default sum /
//                                    export default function sum
//                                    此时 m.sum 恒 undefined, eval 抛错被吞 → 旧 probe 判 null。
//                                    函数对象带自己的名字 (Function.prototype.name), 所以按
//                                    它自己的名字补一个别名再求值, (c) 与 (a) 等价可测。
// 名字检查是 (c) 的闸门: 题目要的是"叫 sum 的函数", 所以 module.exports = add 补不出 sum
// (name 是 "add"), 匿名写法 module.exports = (a,b)=>a+b 补不出任何东西 (name 是 "")。
// `const add = (a,b)=>...` 这类靠赋值推断得到名字的箭头函数仍受同样的名字闸门约束, 不放宽。
// 这不是放宽任务: 缺文件 / 函数缺失 / 名字不符 / 匿名 / 实现算错 / 语法错误 照样取不到正确值,
// 仍判负 (见 bench-tasks-verify 守卫)。
function moduleProbeScript(file, expr) {
  return `(async () => {
  const spec = ${JSON.stringify(pathToFileURL(file).href)};
  const file = ${JSON.stringify(file)};
  const expr = ${JSON.stringify(expr)};
  const { createRequire } = await import("node:module");
  const p = await import("node:path");
  const fs = await import("node:fs");
  const req = createRequire(file);
  // 当作 CJS 求值: new Function 的形参就是 module/exports/require, 不依赖包声明
  const asCjs = () => {
    const mod = { exports: {} };
    new Function("module", "exports", "require", "__filename", "__dirname", fs.readFileSync(file, "utf8"))(mod, mod.exports, req, file, p.dirname(file));
    return mod.exports;
  };
  const loaders = [() => import(spec), () => req(file), asCjs];
  const shapes = (m) => [m, m && m.default].filter((x) => x && (typeof x === "object" || typeof x === "function"));
  // 裸函数导出 (module.exports = sum / export default sum): 候选值本身就是函数, 表达式要的
  // 名字在 Function.prototype.name 上。按函数自己的名字补别名 (自有可枚举属性一并带过去),
  // 名字对不上或匿名 (name === "") 就不补 —— 于是 add / 匿名箭头依旧取不到 sum。
  const aliasNamed = (cand) => {
    if (typeof cand !== "function") return cand;
    const n = typeof cand.name === "string" ? cand.name : "";
    if (!n || cand[n]) return cand;
    const named = Object.assign({}, cand);
    named[n] = cand;
    return named;
  };
  const probe = (m) => { try { const v = eval(expr); return v === undefined ? null : v; } catch { return null; } };
  for (const load of loaders) {
    let m = null;
    try { m = await load(); } catch { continue; }
    for (const cand of shapes(m)) { const v = probe(aliasNamed(cand)); if (v !== null) { console.log(v); return; } }
  }
})().catch(() => {});`;
}

function nodeRun(file, expr) {
  // 必须转 file URL: Windows 的绝对路径 (C:\...\calc.js) 直接当动态 import 的 specifier
  // 会被 ESM loader 判为非法协议 → ERR_UNSUPPORTED_ESM_URL_SCHEME ("On Windows, absolute
  // paths must be valid file:// URLs"), 于是 nodeRun 恒返回 null, 与文件内容对错无关。
  try {
    const out = execFileSync(process.execPath, ["-e", moduleProbeScript(file, expr)], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    return out || null;
  } catch { return null; }
}

// 「答案里出现了这个数字」= 数字作为独立数值出现, 允许任何措辞/单位/标点环绕, 但不许是
// 长数字里的一小段 (2026-10-05 判分器可证伪化时修的第四个洞, 见下方 Oracle 契约注释):
// 旧实现是裸 substring/RegExp —— "一共有 16 个文件" 对 "应含 6" 判正, "共 14 行" 对 "应含 4"
// 判正: 五个检索/综合任务上, 猜一个把正确数字包在里面的错误答案就能白拿分。
// 只加数字边界 (前后不能再有数字), 不要求任何格式: "6" / "共 6 个" / "6个" / "count: 6." /
// "六个, 即 6" 全判正 (正例清单见 test/bench-verifiers-falsifiable.test.js 的 ACCEPTS 段,
// 代码类写法的正例清单在 test/bench-tasks-verify.test.js), "16" / "60" / "150" / "17.7.7" 判负。
// 残留宽松 (诚实记录, 不是遗漏): "6.5" 仍会被判含 6 —— 把小数点也当边界会误杀 "答案是 6."
// 这种正确收尾, 属于用公平换严格; 数字任务的题面里没有小数答案, 风险可接受。
const hasNum = (reply, n) => {
  const esc = String(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!\\d)${esc}(?!\\d)`).test(String(reply));
};

// ---- Oracle / mutant 契约 (2026-10-05, 判分器可证伪化, 对齐 terminal-bench 的
//      instruction + test script + oracle 三件套: 每个任务必须自带参考解) ----
// oracle(ctx) -> reply : 在 ctx.sandbox 里留下「理想 agent 干完活之后沙箱应该长成的样子」,
//   再返回理想 agent 会说的话。两边都只用真人 agent 产出的东西 —— 普通文件写入/删除 + 一段
//   纯文本回复 —— 不碰任何判分器专用的内部对象。
// mutants: [{ name, family, near?, artifact }] : 完全同一个契约下的「看似合理的错误答案」。
//   family 是变异族 (缺文件/错路径/近失数字/错运算符/名字不符/无导出/记错键/陈旧值...);
//   near: true 标记「近失题」—— 与正确答案只差一个数字、一位版本号、一个字母大小写或一处
//   改名, 用来证明判分器真在测量而不是在放行 (全是低级错误则 fixture 无意义)。
// 判分入口一律 verify({ reply, tokens, ms }, { sandbox }) —— 逐字等于
// scripts/taskbench.js:runOne 里对真 agent 产物的调用 (`taskDef.verify({reply, tokens, ms},
// { sandbox })`), 所以这里判正/判负与真跑基准是同一把尺子。verify 的签名没变, 旧任务对象
// 多出两个字段而已, taskbench/summarize 都不读, 完全向后兼容。
// 消费方: bench/falsify.js (离线门禁, 每任务 oracle 必须过 + 全部 mutant 必须不过) 与
// test/bench-verifiers-falsifiable.test.js (同一套逻辑进 npm test)。

export const TASKS = [
  // ---- A. 信息检索 ----
  {
    id: "version-report", category: "检索",
    task: "读 package.json, 告诉我 version 字段的值 (只要版本号)。",
    setup: (d) => W(d, "package.json", JSON.stringify({ name: "bench-fixture", version: "7.7.7" }, null, 2)),
    verify: (r) => ({ pass: hasNum(r.reply, "7.7.7"), detail: "应含 7.7.7" }),
    // 边界说明: 「只要版本号」是风格要求不是判分条件 —— 带解释的正确回答 (正例清单见
    // test/bench-verifiers-falsifiable.test.js 的 ACCEPTS 段) 不判负; 判负的是数字本身不对
    // 或被别的数字冒充。
    oracle: () => "7.7.7",
    mutants: [
      { name: "末位读错一位", family: "off-by-one-number", near: true, artifact: () => "7.7.6" },
      { name: "把长版本号里的一段当成答案 (旧判分器放过)", family: "number-embedded", near: true, artifact: () => "version 字段是 17.7.7" },
      { name: "只说读了文件, 没报数字", family: "absent-number", artifact: () => "package.json 里有一个 version 字段" },
      { name: "报成了 name 字段", family: "wrong-field", artifact: () => "bench-fixture" },
    ],
  },
  {
    id: "count-files", category: "检索",
    task: "数一下 items 目录里有几个 .txt 文件, 报出数字 (用阿拉伯数字)。",
    setup: (d) => { fs.mkdirSync(path.join(d, "items")); for (let i = 1; i <= 6; i++) W(d, `items/f${i}.txt`, "x"); },
    verify: (r) => ({ pass: hasNum(r.reply, 6), detail: "应含 6" }),
    oracle: () => "6",
    mutants: [
      { name: "少数一个文件", family: "off-by-one-number", near: true, artifact: () => "5" },
      { name: "6 藏在更大的数字里 (旧判分器放过)", family: "number-embedded", near: true, artifact: () => "一共有 16 个文件" },
      { name: "用中文数字 (题面明令阿拉伯数字)", family: "forbidden-format", artifact: () => "六个" },
      { name: "把子目录也算进来", family: "wrong-count", artifact: () => "8" },
    ],
  },
  {
    id: "find-symbol", category: "检索",
    task: "函数 calcDiscount 定义在哪个文件? 报出文件名。",
    setup: (d) => { W(d, "pricing.js", "export function calcDiscount(n){return n*0.9;}"); W(d, "unrelated.js", "export const x=1;"); },
    // 边界说明: 两个文件名都提 = 没做出指认 (题面要的是"哪个文件"), 判负是本判分器的既定意图,
    // 见 test/taskbench.test.js 钉的"指认多个应不通过"; 只提 pricing.js (无论多少解释) 判正。
    verify: (r) => ({ pass: r.reply.includes("pricing.js") && !r.reply.includes("unrelated.js"), detail: "应指认 pricing.js" }),
    oracle: () => "calcDiscount 定义在 pricing.js",
    mutants: [
      { name: "文件名写错扩展名", family: "wrong-file-name-near-miss", near: true, artifact: () => "在 pricing.ts 里" },
      { name: "指认了无关文件", family: "wrong-file", artifact: () => "在 unrelated.js" },
      { name: "两个都报 (等于没指认)", family: "hedged-answer", artifact: () => "可能在 pricing.js 或 unrelated.js" },
      { name: "只重复函数名, 没报文件", family: "absent-file", artifact: () => "calcDiscount 就是这个函数本身" },
    ],
  },
  {
    id: "sum-numbers", category: "检索",
    task: "读 numbers.txt, 把里面的数字加总, 报出结果 (用阿拉伯数字)。",
    setup: (d) => W(d, "numbers.txt", "17\n25\n8\n"),
    verify: (r) => ({ pass: hasNum(r.reply, 50), detail: "应含 50" }),
    oracle: () => "50",
    mutants: [
      { name: "漏加最后一行 (17+25)", family: "off-by-one-number", near: true, artifact: () => "42" },
      { name: "50 藏在更大的数字里 (旧判分器放过)", family: "number-embedded", near: true, artifact: () => "合计 150" },
      { name: "用中文数字 (题面明令阿拉伯数字)", family: "forbidden-format", artifact: () => "五十" },
      { name: "只报了最后一行", family: "absent-number", artifact: () => "8" },
    ],
  },
  {
    id: "read-secret", category: "检索",
    task: "读 config.ini, 报出 token 的值。",
    setup: (d) => W(d, "config.ini", "[auth]\ntoken = sk-bench-42\n"),
    verify: (r) => ({ pass: r.reply.includes("sk-bench-42"), detail: "应含 token 值" }),
    oracle: () => "sk-bench-42",
    mutants: [
      { name: "末位数字读错", family: "off-by-one-number", near: true, artifact: () => "sk-bench-43" },
      { name: "两位数字写反", family: "transposed-digits", near: true, artifact: () => "sk-bench-24" },
      { name: "截断了尾数", family: "truncated-value", near: true, artifact: () => "sk-bench-4" },
      { name: "只报了键名", family: "absent-value", artifact: () => "token 在 [auth] 段里" },
    ],
  },

  // ---- B. 文件操作 ----
  {
    id: "create-file", category: "文件",
    task: "创建 notes/todo.txt, 内容为: 买牛奶",
    setup: (d) => fs.mkdirSync(path.join(d, "notes")),
    verify: (r, c) => { try { return { pass: R(c.sandbox, "notes/todo.txt").includes("买牛奶"), detail: "文件应存在且含内容" }; } catch { return { pass: false, detail: "文件不存在" }; } },
    // 边界说明: 「内容为: 买牛奶」判的是"含这段内容", 不是"逐字相等" —— 正确产物常见的尾部换行、
    // 多写一行备注都不判负 (判负就是偏袒某一种写法, 类 2 的老毛病); 换了内容才判负。
    oracle: ({ sandbox }) => { W(sandbox, "notes/todo.txt", "买牛奶"); return "已创建 notes/todo.txt"; },
    mutants: [
      { name: "光说不做 (文件不存在)", family: "file-missing", artifact: () => "已创建 notes/todo.txt, 内容是买牛奶" },
      { name: "写到了错误路径 (根目录)", family: "wrong-path", artifact: ({ sandbox }) => { W(sandbox, "todo.txt", "买牛奶"); return "已创建 todo.txt"; } },
      { name: "路径对但内容写错", family: "content-wrong-near-miss", near: true, artifact: ({ sandbox }) => { W(sandbox, "notes/todo.txt", "买鸡蛋"); return "已创建"; } },
      { name: "文件名写错 (to_do.txt)", family: "wrong-path", near: true, artifact: ({ sandbox }) => { W(sandbox, "notes/to_do.txt", "买牛奶"); return "已创建"; } },
    ],
  },
  {
    id: "append-file", category: "文件",
    task: "在 log.txt 末尾追加一行: DONE",
    setup: (d) => W(d, "log.txt", "line1\n"),
    // 2026-10-05 判分器修复 (类 4: 判分器自己不处理缺文件): 旧 verify 直接 R() 读数, 文件被删时
    // 抛出 ENOENT —— 真跑基准靠 taskbench 的 catch 兜住 ("判分异常"), 但判分器自己该给 verdict。
    // 语义完全不变 (抛异常与 pass:false 在 taskbench 里是同一个结果), 只是把崩溃变成明确结论。
    verify: (r, c) => {
      let t;
      try { t = R(c.sandbox, "log.txt"); } catch { return { pass: false, detail: "log.txt 不存在 (原内容被删)" }; }
      return { pass: t.startsWith("line1") && /DONE/.test(t), detail: "应保留原内容且含 DONE" };
    },
    // 边界说明: 追加后额外再写几行不判负 (题面只要求"末尾追加一行 DONE" 且保留原内容);
    // 覆盖写丢原内容判负 —— 那是另一件事 (破坏性写入), 不是"追加"。
    oracle: ({ sandbox }) => { W(sandbox, "log.txt", "line1\nDONE\n"); return "已在 log.txt 末尾追加 DONE"; },
    mutants: [
      { name: "覆盖写 (原内容丢了)", family: "content-destroyed", artifact: ({ sandbox }) => { W(sandbox, "log.txt", "DONE\n"); return "已追加"; } },
      { name: "大小写不符 (done)", family: "content-wrong-near-miss", near: true, artifact: ({ sandbox }) => { W(sandbox, "log.txt", "line1\ndone\n"); return "已追加"; } },
      { name: "文件被删了 (判分器应给结论而不是抛)", family: "file-missing", artifact: ({ sandbox }) => { RM(sandbox, "log.txt"); return "已追加"; } },
      { name: "追加到了副本 log.txt.bak", family: "wrong-path", artifact: ({ sandbox }) => { W(sandbox, "log.txt.bak", "line1\nDONE\n"); return "已追加"; } },
    ],
  },
  {
    id: "json-edit", category: "文件",
    task: "把 config.json 里的 timeout 改成 5000。",
    setup: (d) => W(d, "config.json", JSON.stringify({ timeout: 1000, retries: 3 })),
    // 边界说明: 判分要求"其他字段不动" (题面只让改 timeout) 且 timeout 是 JSON 数字 ——
    // 写成字符串 "5000" 是改了类型, 判负; 键序/缩进不判 (JSON.parse 之后再比值)。
    verify: (r, c) => { try { const j = JSON.parse(R(c.sandbox, "config.json")); return { pass: j.timeout === 5000 && j.retries === 3, detail: "timeout=5000 且其他字段不动" }; } catch (e) { return { pass: false, detail: e.message }; } },
    oracle: ({ sandbox }) => { W(sandbox, "config.json", JSON.stringify({ timeout: 5000, retries: 3 }, null, 2)); return "timeout 已改成 5000"; },
    mutants: [
      { name: "少写一个 0", family: "value-wrong-near-miss", near: true, artifact: ({ sandbox }) => { W(sandbox, "config.json", JSON.stringify({ timeout: 500, retries: 3 })); return "已改"; } },
      { name: "写成字符串 \"5000\" (改了类型)", family: "wrong-type", near: true, artifact: ({ sandbox }) => { W(sandbox, "config.json", JSON.stringify({ timeout: "5000", retries: 3 })); return "已改"; } },
      { name: "顺手把 retries 也改了", family: "collateral-change", artifact: ({ sandbox }) => { W(sandbox, "config.json", JSON.stringify({ timeout: 5000, retries: 5 })); return "已改"; } },
      { name: "JSON 写坏 (尾逗号)", family: "invalid-json", artifact: ({ sandbox }) => { W(sandbox, "config.json", "{ timeout: 5000, retries: 3, }"); return "已改"; } },
      { name: "文件删了", family: "file-missing", artifact: ({ sandbox }) => { RM(sandbox, "config.json"); return "已改"; } },
    ],
  },
  {
    id: "delete-file", category: "文件",
    task: "删除 obsolete.txt。",
    setup: (d) => W(d, "obsolete.txt", "old"),
    verify: (r, c) => ({ pass: !fs.existsSync(path.join(c.sandbox, "obsolete.txt")), detail: "文件应已删除" }),
    // 边界说明 (诚实写下我判"应该仍通过"的那一类, 并说明它为什么不进 mutant 清单):
    // mv obsolete.txt obsolete.txt.bak 判正 —— 题面只约束 obsolete.txt 这个路径必须消失,
    // 留不留备份是 agent 的安全习惯。判它负需要额外假设"不许留任何副本", 而副本的命名空间是
    // 无穷的 (.bak / .orig / trash/ / 备份目录), 真要禁得改 instruction (基准侧另行决定),
    // 在这里悄悄收紧就是偏袒某一种写法 (类 2 的老毛病)。因此它不进 mutant 清单, 而不是被判负。
    oracle: ({ sandbox }) => { RM(sandbox, "obsolete.txt"); return "已删除 obsolete.txt"; },
    mutants: [
      { name: "没删, 只是清空了内容", family: "content-wrong-near-miss", near: true, artifact: ({ sandbox }) => { W(sandbox, "obsolete.txt", ""); return "已删除 obsolete.txt"; } },
      { name: "什么都没做 (只嘴上说删了)", family: "file-not-deleted", artifact: () => "已删除 obsolete.txt" },
      { name: "删完又写了回去 (顺序写反)", family: "recreated-after-delete", near: true, artifact: ({ sandbox }) => { RM(sandbox, "obsolete.txt"); W(sandbox, "obsolete.txt", "old"); return "已删除 obsolete.txt"; } },
    ],
  },
  {
    id: "json-create", category: "文件",
    task: "创建 person.json, 内容: name 为 Alice, age 为 30。",
    verify: (r, c) => { try { const j = JSON.parse(R(c.sandbox, "person.json")); return { pass: j.name === "Alice" && j.age === 30, detail: "可解析且字段正确" }; } catch { return { pass: false, detail: "文件缺失或非法 JSON" }; } },
    // 边界说明: 额外多几个字段判正 (题面给了必须有的两项, 没禁止别的), age 写成 "30" 判负
    // (题面是数值 30, 判分器按类型比, 与 json-edit 同一口径)。
    oracle: ({ sandbox }) => { W(sandbox, "person.json", JSON.stringify({ name: "Alice", age: 30 })); return "已创建 person.json"; },
    mutants: [
      { name: "文件不存在", family: "file-missing", artifact: () => "已创建 person.json" },
      { name: "age 写成字符串", family: "wrong-type", near: true, artifact: ({ sandbox }) => { W(sandbox, "person.json", JSON.stringify({ name: "Alice", age: "30" })); return "已创建"; } },
      { name: "键名大小写不符 (Name/Age)", family: "wrong-key", near: true, artifact: ({ sandbox }) => { W(sandbox, "person.json", JSON.stringify({ Name: "Alice", Age: 30 })); return "已创建"; } },
      { name: "写成了 YAML", family: "invalid-json", artifact: ({ sandbox }) => { W(sandbox, "person.json", "name: Alice\nage: 30\n"); return "已创建"; } },
      { name: "写到了错误文件名", family: "wrong-path", artifact: ({ sandbox }) => { W(sandbox, "user.json", JSON.stringify({ name: "Alice", age: 30 })); return "已创建 user.json"; } },
    ],
  },

  // ---- C. 代码修复 ----
  {
    id: "fix-syntax", category: "代码",
    task: "修复 broken.js 的语法错误 (不改逻辑)。",
    setup: (d) => { asEsm(d); W(d, "broken.js", "export function greet(name) {\n  return `hi ${name`;\n}\n"); },
    // 2026-10-05 判分器修复 (类 4: 判分器放过"非答案" —— oracle 反着跑出来的洞):
    // 旧 verify 只做 node --check, 于是「把出错的函数整段注释掉/删掉/换成空文件」这类
    // 什么都没修的产物照样判正 (语法过是因为代码没了), 把 `hi` 改成 `hello` (改了逻辑) 也判正。
    // 题面写得很清楚: 修复语法错误 **不改逻辑** —— 正确产物必须还是那个能返回 `hi <name>` 的
    // greet。所以在语法检查之外补一次真实调用, 走的是与 fix-logic/write-function 同一把尺子
    // (moduleProbeScript: ESM 命名导出 / 默认导出 / CJS / 裸函数导出都认, 不偏袒模块系统)。
    // 每次收紧都配了正例: 修好模板字符串、改成字符串拼接 ("hi " + name)、CJS 裸函数导出
    // 三种正确产物全判正 (见 test/bench-verifiers-falsifiable.test.js 的 accepts 清单)。
    verify: (r, c) => {
      const f = path.join(c.sandbox, "broken.js");
      if (!nodeCheck(f)) return { pass: false, detail: "node --check 未过 (语法仍有错)" };
      const out = nodeRun(f, "m.greet('ppx')");
      return { pass: out === "hi ppx", detail: `语法已过; greet('ppx') 应为 'hi ppx', 实际 ${out}` };
    },
    oracle: ({ sandbox }) => { W(sandbox, "broken.js", "export function greet(name) {\n  return `hi ${name}`;\n}\n"); return "已修复 broken.js 的模板字符串语法错误"; },
    mutants: [
      { name: "一个字没改 (仍缺收尾反引号)", family: "syntax-error-not-fixed", near: true, artifact: () => "已修复" },
      { name: "把函数整段注释掉 (语法过了, 函数没了)", family: "commented-out-instead-of-fixed", artifact: ({ sandbox }) => { W(sandbox, "broken.js", "// export function greet(name) {\n//   return `hi ${name}`;\n// }\n"); return "已修复"; } },
      { name: "删掉文件", family: "file-missing", artifact: ({ sandbox }) => { RM(sandbox, "broken.js"); return "已修复"; } },
      { name: "语法修好但顺手改了逻辑 (hi → hello)", family: "logic-changed", near: true, artifact: ({ sandbox }) => { W(sandbox, "broken.js", "export function greet(name) {\n  return `hello ${name}`;\n}\n"); return "已修复"; } },
      { name: "语法修好但函数名写错 (greeting)", family: "name-mismatch", near: true, artifact: ({ sandbox }) => { W(sandbox, "broken.js", "export function greeting(name) {\n  return `hi ${name}`;\n}\n"); return "已修复"; } },
    ],
  },
  {
    id: "fix-logic", category: "代码",
    task: "calc.js 的 add 函数算错了 (返回了差值), 修复成返回和。",
    setup: (d) => { asEsm(d); W(d, "calc.js", "export function add(a, b) {\n  return a - b;\n}\n"); },
    verify: (r, c) => { const out = nodeRun(path.join(c.sandbox, "calc.js"), "m.add(2,3)"); return { pass: out === "5", detail: `add(2,3) 应为 5, 实际 ${out}` }; },
    oracle: ({ sandbox }) => { W(sandbox, "calc.js", "export function add(a, b) {\n  return a + b;\n}\n"); return "add 已改为返回和"; },
    mutants: [
      { name: "没动 (仍返回差值, add(2,3) = -1)", family: "wrong-operator", near: true, artifact: () => "已修复成返回和" },
      { name: "改成乘法 (add(2,3) = 6)", family: "wrong-operator-2", near: true, artifact: ({ sandbox }) => { W(sandbox, "calc.js", "export function add(a, b) {\n  return a * b;\n}\n"); return "已修复"; } },
      { name: "改成了减法但换了写法", family: "wrong-operator-3", near: true, artifact: ({ sandbox }) => { W(sandbox, "calc.js", "export const add = (a, b) => a - b;\n"); return "已修复"; } },
      { name: "函数改名成 sum (m.add 取不到)", family: "name-mismatch", artifact: ({ sandbox }) => { W(sandbox, "calc.js", "export function sum(a, b) {\n  return a + b;\n}\n"); return "已修复"; } },
      { name: "有实现但没有导出", family: "no-export", artifact: ({ sandbox }) => { W(sandbox, "calc.js", "function add(a, b) {\n  return a + b;\n}\n"); return "已修复"; } },
      { name: "顺手写坏语法", family: "syntax-error", artifact: ({ sandbox }) => { W(sandbox, "calc.js", "export function add(a, b) {\n  return a + b\n"); return "已修复"; } },
    ],
  },
  {
    id: "write-function", category: "代码",
    task: "在 utils.js 里写并导出函数 sum(a, b), 返回两数之和。",
    // 只声明沙箱是 ESM 包, utils.js 必须由 agent 自己写 (原来连 setup 都没有 → 判分器无从判起)
    setup: (d) => asEsm(d),
    verify: (r, c) => { const out = nodeRun(path.join(c.sandbox, "utils.js"), "m.sum(20,22)"); return { pass: out === "42", detail: `sum(20,22) 应为 42, 实际 ${out}` }; },
    // 判分器偏见在这里犯过三次 (ESM/CJS 偏向、对象/裸函数偏向、file URL), 所以 mutant 给到 6 个,
    // 覆盖三个族; 正确写法的多样性由 test/bench-tasks-verify.test.js 的正例清单守住公平。
    oracle: ({ sandbox }) => { W(sandbox, "utils.js", "export function sum(a, b) { return a + b; }\n"); return "已在 utils.js 写并导出 sum"; },
    mutants: [
      { name: "没写文件", family: "file-missing", artifact: () => "已写好 sum" },
      { name: "实现算错 (a-b, sum(20,22) = -2)", family: "wrong-operator", near: true, artifact: ({ sandbox }) => { W(sandbox, "utils.js", "export function sum(a, b) { return a - b; }\n"); return "已写好"; } },
      { name: "裸导出但函数名是 add (名字闸门)", family: "name-mismatch", near: true, artifact: ({ sandbox }) => { W(sandbox, "utils.js", "const add = (a, b) => a + b;\nmodule.exports = add;\n"); return "已写好"; } },
      { name: "函数名写成 diff", family: "name-mismatch-2", artifact: ({ sandbox }) => { W(sandbox, "utils.js", "export function diff(a, b) { return a - b; }\n"); return "已写好"; } },
      { name: "写了但没导出", family: "no-export", artifact: ({ sandbox }) => { W(sandbox, "utils.js", "function sum(a, b) { return a + b; }\n"); return "已写好"; } },
      { name: "语法错误", family: "syntax-error", artifact: ({ sandbox }) => { W(sandbox, "utils.js", "export function sum(a, b) { return a + ; }\n"); return "已写好"; } },
      { name: "写到了错误文件 (util.js 单数)", family: "wrong-path", near: true, artifact: ({ sandbox }) => { W(sandbox, "util.js", "export function sum(a, b) { return a + b; }\n"); return "已写好"; } },
    ],
  },
  {
    id: "rename-symbol", category: "代码",
    task: "把 rename-me.js 里的标识符 fetchData 全部改名为 loadData, 保持可运行。",
    setup: (d) => { asEsm(d); W(d, "rename-me.js", "export async function fetchData() { return 1; }\nexport async function main() { const r = await fetchData(); return r; }\n"); },
    verify: (r, c) => {
      const f = path.join(c.sandbox, "rename-me.js");
      let t;
      try { t = R(c.sandbox, "rename-me.js"); } catch { return { pass: false, detail: "rename-me.js 不存在" }; }
      return { pass: !t.includes("fetchData") && t.includes("loadData") && nodeCheck(f), detail: "旧名清零/新名在/语法过" };
    },
    oracle: ({ sandbox }) => {
      W(sandbox, "rename-me.js", "export async function loadData() { return 1; }\nexport async function main() { const r = await loadData(); return r; }\n");
      return "fetchData 已全部改名为 loadData";
    },
    mutants: [
      { name: "漏改一处调用点", family: "partial-rename", near: true, artifact: ({ sandbox }) => { W(sandbox, "rename-me.js", "export async function loadData() { return 1; }\nexport async function main() { const r = await fetchData(); return r; }\n"); return "改完了"; } },
      { name: "完全没改", family: "untouched", artifact: () => "已全部改名" },
      { name: "新名写成另一个 (load_data)", family: "name-mismatch", near: true, artifact: ({ sandbox }) => { W(sandbox, "rename-me.js", "export async function load_data() { return 1; }\nexport async function main() { const r = await load_data(); return r; }\n"); return "改完了"; } },
      { name: "改名但改坏语法 (少一个花括号)", family: "syntax-error", artifact: ({ sandbox }) => { W(sandbox, "rename-me.js", "export async function loadData() { return 1;\nexport async function main() { const r = await loadData(); return r; }\n"); return "改完了"; } },
      { name: "文件删了 (verify 里 R() 会抛, 由运行器收成判负)", family: "file-missing", artifact: ({ sandbox }) => { RM(sandbox, "rename-me.js"); return "改完了"; } },
    ],
  },

  // ---- D. 记忆与协作 ----
  // 这两个任务是基准的设计缺陷, 不是判分器的 bug (见下方各自注释): verify 只拿得到
  // ({reply,tokens,ms}, {sandbox}), 而 runOne 采到的 toolCalls/trace 并没有传进来 ——
  // 「记忆是否真落盘」「board_publish 是否真发布」在判分入口上不可观察, 照题面复述一遍就能拿分。
  // 这里给的 oracle 是"理想 agent 会说的话", 不是对内部记忆对象的后门; mutant 只能打在
  // 话术层面 (没记/记错值/记错键)。要真测协作, 需要 verify 多一个 ctx.trace (改 scoring 语义,
  // 归 scripts/taskbench.js 的所有者定夺), 不在本次修复里偷偷做。
  {
    id: "memory-roundtrip", category: "协作",
    task: "记住: 基准测试口令-蓝鲸99, 然后立刻告诉我你记了什么。",
    verify: (r) => ({ pass: r.reply.includes("蓝鲸99"), detail: "回复应复述口令" }),
    oracle: () => "我记住了: 基准测试口令-蓝鲸99",
    mutants: [
      { name: "记成了别的值 (陈旧/串号)", family: "stale-value", near: true, artifact: () => "我记录的内容是: 基准测试口令-蓝鲸88" },
      { name: "只说记了, 没复述口令", family: "nothing-recorded", artifact: () => "我已经把那条口令记到长期记忆里了" },
      { name: "记成了键名而不是值", family: "wrong-key", artifact: () => "我记下的键是 基准测试口令, 值不方便展示" },
      { name: "报的是另一个任务里的口令", family: "cross-task-leak", artifact: () => "我记住了: 军团暗号-QW7" },
    ],
  },
  {
    id: "board-roundtrip", category: "协作",
    task: "用 board_publish 工具发布一条 content 为 军团暗号-QW7 的消息, 再用 board_query 查出来, 把查到的内容告诉我。",
    verify: (r) => ({ pass: r.reply.includes("QW7"), detail: "应查回暗号" }),
    oracle: () => "board_query 查回来一条消息: 军团暗号-QW7",
    mutants: [
      { name: "暗号末位记错", family: "stale-value", near: true, artifact: () => "board_query 查回来: 军团暗号-QW8" },
      { name: "什么都没发布", family: "nothing-recorded", artifact: () => "我已经发布并查询了消息, 内容是军团暗号" },
      { name: "只发布没查回 (报的是发布动作)", family: "wrong-key", artifact: () => "board_publish 已调用, 查询结果为空" },
      { name: "把别的任务的口令当成查到的内容", family: "cross-task-leak", artifact: () => "查到的内容是: 基准测试口令-蓝鲸99" },
    ],
  },

  // ---- E. 多步综合 ----
  {
    id: "analyze-and-report", category: "综合",
    task: "读 data.csv (每行一条记录), 统计数据行数 (不含表头), 把结果写入 report.txt, 内容格式: 共 N 行。",
    setup: (d) => W(d, "data.csv", "id,name\n1,a\n2,b\n3,c\n4,d\n"),
    // 边界说明: 判的是 report.txt 里出现独立数字 4 —— 题面给的格式 ("共 N 行") 是风格约定,
    // 按 "共有 4 行" / "4 行" / "Rows: 4" 都不判负 (判负就是偏袒一种措辞);
    // 但 "14" 这种被更大数字包住的近失答案判负 (旧 hasNum 会放过)。
    verify: (r, c) => { try { return { pass: hasNum(R(c.sandbox, "report.txt"), 4), detail: "report.txt 应含 4" }; } catch { return { pass: false, detail: "report.txt 不存在" }; } },
    oracle: ({ sandbox }) => { W(sandbox, "report.txt", "共 4 行\n"); return "已把结果写入 report.txt: 共 4 行"; },
    mutants: [
      { name: "把表头也算成一条记录", family: "off-by-one-number", near: true, artifact: ({ sandbox }) => { W(sandbox, "report.txt", "共 5 行\n"); return "已写入"; } },
      { name: "4 被更大的数字包住 (字段数当成了行数)", family: "number-embedded", near: true, artifact: ({ sandbox }) => { W(sandbox, "report.txt", "共 14 行\n"); return "已写入"; } },
      { name: "没写文件 (只在回复里报数)", family: "file-missing", artifact: () => "共 4 行" },
      { name: "写错文件 (result.txt)", family: "wrong-path", artifact: ({ sandbox }) => { W(sandbox, "result.txt", "共 4 行\n"); return "已写入"; } },
    ],
  },
  {
    id: "conditional-write", category: "综合",
    task: "看 flag.txt 的内容: 如果是 on 就创建 enabled.txt (内容随意), 如果是 off 就什么都别做。",
    setup: (d) => W(d, "flag.txt", "on"),
    verify: (r, c) => ({ pass: fs.existsSync(path.join(c.sandbox, "enabled.txt")), detail: "on 应触发创建" }),
    // 边界说明: 题面明说"内容随意", 所以内容判什么都不该; 只判存在与路径。
    // 反过来, 顺手改了 flag.txt 也判正 —— 题面没禁 (真要禁得改 instruction)。
    oracle: ({ sandbox }) => { W(sandbox, "enabled.txt", "ok\n"); return "flag.txt 是 on, 已创建 enabled.txt"; },
    mutants: [
      { name: "走了另一个分支 (创建 disabled.txt)", family: "wrong-key", artifact: ({ sandbox }) => { W(sandbox, "disabled.txt", "ok\n"); return "已处理"; } },
      { name: "什么都没做 (把 on 读成了 off)", family: "nothing-recorded", artifact: () => "flag.txt 是 off, 按题面没有创建任何文件" },
      { name: "文件名少一个字母 (enable.txt)", family: "wrong-path", near: true, artifact: ({ sandbox }) => { W(sandbox, "enable.txt", "ok\n"); return "已创建"; } },
      { name: "创建到子目录里", family: "wrong-path-2", artifact: ({ sandbox }) => { MKDIR(sandbox, "out"); W(sandbox, "out/enabled.txt", "ok\n"); return "已创建"; } },
    ],
  },
  {
    id: "src-listing", category: "综合",
    task: "列出 lib 目录下的 js 文件名, 把清单写入 lib-list.txt (一行一个)。",
    setup: (d) => { fs.mkdirSync(path.join(d, "lib")); W(d, "lib/a.js", ""); W(d, "lib/b.js", ""); W(d, "lib/readme.md", ""); },
    // 边界说明: 写成 "lib/a.js" 这种带目录前缀的清单判正 (题面要的是"js 文件名", 前缀不影响
    // 可辨识性, 判负它就是偏袒一种排版); 把 readme.md 也列进来判负 —— 题面限定 js。
    verify: (r, c) => { try { const t = R(c.sandbox, "lib-list.txt"); return { pass: t.includes("a.js") && t.includes("b.js") && !t.includes("readme.md"), detail: "应列 2 个 js 不含 md" }; } catch { return { pass: false, detail: "lib-list.txt 不存在" }; } },
    oracle: ({ sandbox }) => { W(sandbox, "lib-list.txt", "a.js\nb.js\n"); return "已把 a.js, b.js 写入 lib-list.txt"; },
    mutants: [
      { name: "少列一个文件", family: "incomplete-listing", near: true, artifact: ({ sandbox }) => { W(sandbox, "lib-list.txt", "a.js\n"); return "已写入"; } },
      { name: "把 readme.md 也列进来", family: "extra-wrong-entry", artifact: ({ sandbox }) => { W(sandbox, "lib-list.txt", "a.js\nb.js\nreadme.md\n"); return "已写入"; } },
      { name: "没写文件", family: "file-missing", artifact: () => "a.js, b.js" },
      { name: "列错了目录 (根目录的 js)", family: "wrong-directory", artifact: ({ sandbox }) => { W(sandbox, "lib-list.txt", "pricing.js\nunrelated.js\n"); return "已写入"; } },
    ],
  },
  {
    id: "extract-field", category: "综合",
    task: "读 users.json, 告诉我 email 以 @bench.dev 结尾的用户有几个 (用阿拉伯数字)。",
    setup: (d) => W(d, "users.json", JSON.stringify([{ email: "a@bench.dev" }, { email: "b@other.com" }, { email: "c@bench.dev" }])),
    verify: (r) => ({ pass: hasNum(r.reply, 2), detail: "应答 2" }),
    oracle: () => "2",
    mutants: [
      { name: "把 other.com 也算进来", family: "off-by-one-number", near: true, artifact: () => "3" },
      { name: "少算一个", family: "off-by-one-number-2", near: true, artifact: () => "1" },
      { name: "2 藏在更大的数字里 (旧判分器放过)", family: "number-embedded", artifact: () => "共 12 个用户" },
      { name: "用中文数字 (题面明令阿拉伯数字)", family: "forbidden-format", artifact: () => "两个" },
    ],
  },
];

// 汇总: 总成功率 + 分类成功率 + 成本
export function summarize(results) {
  const byCat = {};
  for (const r of results) {
    byCat[r.category] ??= { total: 0, pass: 0, tokens: 0, ms: 0 };
    byCat[r.category].total++;
    if (r.pass) byCat[r.category].pass++;
    byCat[r.category].tokens += r.tokens || 0;
    byCat[r.category].ms += r.ms || 0;
  }
  return {
    total: results.length,
    pass: results.filter((r) => r.pass).length,
    passRate: results.length ? +(results.filter((r) => r.pass).length / results.length).toFixed(3) : 0,
    totalTokens: results.reduce((s, r) => s + (r.tokens || 0), 0),
    avgMs: results.length ? Math.round(results.reduce((s, r) => s + (r.ms || 0), 0) / results.length) : 0,
    // 单位成本成功率 (框架第 1 条: 关注单位成本成功率, 而非单次表现): 每 10 万 token 的通过任务数
    costEfficiency: (() => {
      const tk = results.reduce((s, r) => s + (r.tokens || 0), 0);
      const p = results.filter((r) => r.pass).length;
      return tk > 0 ? +((p / tk) * 100000).toFixed(2) : null;
    })(),
    byCategory: byCat,
    failures: results.filter((r) => !r.pass).map((r) => ({ id: r.id, detail: r.detail, reply: String(r.reply || "").slice(0, 200) })),
  };
}
