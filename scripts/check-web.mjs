// scripts/check-web.mjs - Web 界面静态自检 (零依赖, 不需要浏览器)
// 用途: 改完 public/ 下的界面后先跑一遍, 抓出"引用不存在的 DOM id / 图标 / 静态资源"
//       这类必然导致运行时报错的问题; 用法: npm run web:check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "app.css"), "utf8");

let bad = 0;
const fail = (m) => { console.log("  ✗ " + m); bad++; };
const ok = (m) => console.log("  ✓ " + m);

// 1) 图标: defs 里定义 vs 被引用
const defined = new Set([...html.matchAll(/<g id="(i-[a-z-]+)"/g)].map((m) => m[1]));
const used = new Set([...(html + js).matchAll(/href="#(i-[a-z-]+)"/g)].map((m) => m[1]));
const missIcon = [...used].filter((u) => !defined.has(u));
if (missIcon.length) fail("引用了未定义的图标: " + missIcon.join(", "));
else ok(`图标定义 ${defined.size} 个, 引用 ${used.size} 个, 全部命中`);

const unusedIcon = [...defined].filter((d) => !used.has(d));
if (unusedIcon.length) console.log("  · 未被使用的图标: " + unusedIcon.join(", "));

// 2) id: HTML 里声明的 + JS 模板里生成的
const htmlIds = new Set([...html.matchAll(/\bid="([A-Za-z][\w-]*)"/g)].map((m) => m[1]));
const jsIds = new Set([...js.matchAll(/\bid="([A-Za-z][\w-]*)"/g)].map((m) => m[1]));
const allIds = new Set([...htmlIds, ...jsIds]);
const refs = [...js.matchAll(/\$\("([\w-]+)"\)/g)].map((m) => m[1]);
const missId = [...new Set(refs)].filter((r) => !allIds.has(r));
if (missId.length) fail("$() 引用了不存在的 id: " + missId.join(", "));
else ok(`$() 引用 ${new Set(refs).size} 个 id, 全部存在于 DOM 或 JS 模板`);

// 3) app.js 语法校验 (真解析, 替代旧的括号计数粗检)
try {
  new Function(js);
  ok("app.js 语法解析通过");
} catch (e) {
  fail("app.js 语法错误: " + e.message);
}

// 4) CSS 里被 JS/HTML 使用的关键类是否已定义 (v3.0 codex 风格结构)
const cssClasses = new Set([...css.matchAll(/\.([a-z][\w-]*)/g)].map((m) => m[1]));
const need = ["side", "brand", "newchat", "ghead", "topbar", "hero", "stream",
  "ev", "toolcard", "approval", "plancard", "diffbox", "chip", "composer", "send",
  "palette", "pitem", "drawer", "tab", "dpane", "tree", "goal", "issue", "badge",
  "setrow", "toast", "btn"];
const missCls = need.filter((c) => !cssClasses.has(c));
if (missCls.length) fail("样式表缺少类: " + missCls.join(", "));
else ok(`样式表覆盖全部关键类 (${need.length} 个)`);

// 5) 关键结构断言 (v3.0: 时间线/命令面板/审批/抽屉四 Tab)
[["侧栏", 'id="side"'], ["composer", 'id="composer"'], ["抽屉", 'id="drawer"'],
 ["命令面板", 'id="palette"'], ["对话流", 'id="stream"'], ["空状态", 'id="hero"'],
 ["输入框", 'id="inp"'], ["发送按钮", 'id="btnSend"'],
 ["文件树面板", 'id="pane-files"'], ["目标面板", 'id="pane-goal"'],
 ["审查面板", 'id="pane-review"'], ["设置面板", 'id="pane-settings"']].forEach(([n, s]) => {
  if (!html.includes(s)) fail(`缺少结构: ${n} (${s})`);
});
if (bad) console.log("  · 结构断言未全部通过"); else ok("关键结构齐全");

// 6) 静态资源引用是否都会被内核静态服务命中
[...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]).forEach((u) => {
  const f = path.join(root, "public", u.replace(/^\//, ""));
  if (!fs.existsSync(f)) fail("静态资源不存在: " + u);
});
ok("静态资源引用全部存在");

console.log(bad ? `\n结果: ${bad} 个问题` : "\n结果: 全部通过");
process.exit(bad ? 1 : 0);
