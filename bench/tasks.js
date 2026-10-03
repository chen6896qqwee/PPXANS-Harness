// bench/tasks.js - 任务级评测基准 (2026-10-02)
// 20 个可确定性验证的任务: 评测「agent 能不能把事干成」, 区别于守卫型单测 (功能不被破坏)。
// 每个任务: id / category / task (给 agent 的指令) / setup (沙箱夹具) / verify (确定性判分, 不用 LLM 评审)。
// verify 返回 { pass, detail }; 沙箱目录 ctx.sandbox 隔离, 不污染仓库。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const W = (dir, name, content) => { fs.writeFileSync(path.join(dir, name), content); };
const R = (dir, name) => fs.readFileSync(path.join(dir, name), "utf8");

// node 语法检查 + ESM 求值 (代码修复类任务判分用)
function nodeCheck(file) {
  try { execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }); return true; } catch { return false; }
}
function nodeRun(file, expr) {
  try {
    return execFileSync(process.execPath, ["-e", `import(${JSON.stringify(file)}).then(m=>console.log(${expr}))`], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) { return null; }
}
const hasNum = (reply, n) => new RegExp(String(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(reply);

export const TASKS = [
  // ---- A. 信息检索 ----
  {
    id: "version-report", category: "检索",
    task: "读 package.json, 告诉我 version 字段的值 (只要版本号)。",
    setup: (d) => W(d, "package.json", JSON.stringify({ name: "bench-fixture", version: "7.7.7" }, null, 2)),
    verify: (r) => ({ pass: hasNum(r.reply, "7.7.7"), detail: "应含 7.7.7" }),
  },
  {
    id: "count-files", category: "检索",
    task: "数一下 items 目录里有几个 .txt 文件, 报出数字。",
    setup: (d) => { fs.mkdirSync(path.join(d, "items")); for (let i = 1; i <= 6; i++) W(d, `items/f${i}.txt`, "x"); },
    verify: (r) => ({ pass: hasNum(r.reply, 6), detail: "应含 6" }),
  },
  {
    id: "find-symbol", category: "检索",
    task: "函数 calcDiscount 定义在哪个文件? 报出文件名。",
    setup: (d) => { W(d, "pricing.js", "export function calcDiscount(n){return n*0.9;}"); W(d, "unrelated.js", "export const x=1;"); },
    verify: (r) => ({ pass: r.reply.includes("pricing.js") && !r.reply.includes("unrelated.js"), detail: "应指认 pricing.js" }),
  },
  {
    id: "sum-numbers", category: "检索",
    task: "读 numbers.txt, 把里面的数字加总, 报出结果。",
    setup: (d) => W(d, "numbers.txt", "17\n25\n8\n"),
    verify: (r) => ({ pass: hasNum(r.reply, 50), detail: "应含 50" }),
  },
  {
    id: "read-secret", category: "检索",
    task: "读 config.ini, 报出 token 的值。",
    setup: (d) => W(d, "config.ini", "[auth]\ntoken = sk-bench-42\n"),
    verify: (r) => ({ pass: r.reply.includes("sk-bench-42"), detail: "应含 token 值" }),
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
    verify: (r, c) => { const t = R(c.sandbox, "log.txt"); return { pass: t.startsWith("line1") && /DONE/.test(t), detail: "应保留原内容且含 DONE" }; },
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
    setup: (d) => W(d, "broken.js", "export function greet(name) {\n  return `hi ${name`;\n}\n"),
    verify: (r, c) => ({ pass: nodeCheck(path.join(c.sandbox, "broken.js")), detail: "node --check 应通过" }),
  },
  {
    id: "fix-logic", category: "代码",
    task: "calc.js 的 add 函数算错了 (返回了差值), 修复成返回和。",
    setup: (d) => W(d, "calc.js", "export function add(a, b) {\n  return a - b;\n}\n"),
    verify: (r, c) => { const out = nodeRun(path.join(c.sandbox, "calc.js"), "m.add(2,3)"); return { pass: out === "5", detail: `add(2,3) 应为 5, 实际 ${out}` }; },
  },
  {
    id: "write-function", category: "代码",
    task: "在 utils.js 里写并导出函数 sum(a, b), 返回两数之和。",
    verify: (r, c) => { const out = nodeRun(path.join(c.sandbox, "utils.js"), "m.sum(20,22)"); return { pass: out === "42", detail: `sum(20,22) 应为 42, 实际 ${out}` }; },
  },
  {
    id: "rename-symbol", category: "代码",
    task: "把 rename-me.js 里的标识符 fetchData 全部改名为 loadData, 保持可运行。",
    setup: (d) => W(d, "rename-me.js", "export async function fetchData() { return 1; }\nexport async function main() { const r = await fetchData(); return r; }\n"),
    verify: (r, c) => {
      const t = R(c.sandbox, "rename-me.js");
      return { pass: !t.includes("fetchData") && t.includes("loadData") && nodeCheck(path.join(c.sandbox, "rename-me.js")), detail: "旧名清零/新名在/语法过" };
    },
  },

  // ---- D. 记忆与协作 ----
  {
    id: "memory-roundtrip", category: "协作",
    task: "记住: 基准测试口令-蓝鲸99, 然后立刻告诉我你记了什么。",
    verify: (r) => ({ pass: r.reply.includes("蓝鲸99"), detail: "回复应复述口令" }),
  },
  {
    id: "board-roundtrip", category: "协作",
    task: "用 board_publish 工具发布一条 content 为 军团暗号-QW7 的消息, 再用 board_query 查出来, 把查到的内容告诉我。",
    verify: (r) => ({ pass: r.reply.includes("QW7"), detail: "应查回暗号" }),
  },

  // ---- E. 多步综合 ----
  {
    id: "analyze-and-report", category: "综合",
    task: "读 data.csv (每行一条记录), 统计数据行数 (不含表头), 把结果写入 report.txt, 内容格式: 共 N 行。",
    setup: (d) => W(d, "data.csv", "id,name\n1,a\n2,b\n3,c\n4,d\n"),
    verify: (r, c) => { try { return { pass: hasNum(R(c.sandbox, "report.txt"), 4), detail: "report.txt 应含 4" }; } catch { return { pass: false, detail: "report.txt 不存在" }; } },
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
    verify: (r, c) => { try { const t = R(c.sandbox, "lib-list.txt"); return { pass: t.includes("a.js") && t.includes("b.js") && !t.includes("readme.md"), detail: "应列 2 个 js 不含 md" }; } catch { return { pass: false, detail: "lib-list.txt 不存在" }; } },
  },
  {
    id: "extract-field", category: "综合",
    task: "读 users.json, 告诉我 email 以 @bench.dev 结尾的用户有几个。",
    setup: (d) => W(d, "users.json", JSON.stringify([{ email: "a@bench.dev" }, { email: "b@other.com" }, { email: "c@bench.dev" }])),
    verify: (r) => ({ pass: hasNum(r.reply, 2), detail: "应答 2" }),
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
