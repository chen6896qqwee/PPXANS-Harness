// scripts/check-web.mjs - Web 界面静态自检 v2 (v5.0 Vue3+Vite 前端, 零依赖, 不需要浏览器)
// 用途: 改完 webapp/ 下的界面后先跑一遍, 抓出"引用不存在的图标/资源/锚点 id"
//       这类必然导致运行时报错的问题; 用法: npm run web:check (CI web job 同款)
//
// v5.0 与旧版 (扫描 public/ 手写文件) 的差异:
//   - 前端源码在 webapp/ (Vue SFC), 构建产物在 webapp/dist (入库, npm ci 后可直接跑);
//   - JS 语法闸 = vite build 本身 (import/export 无法 new Function 解析), 所以本脚本
//     要求 dist 存在 —— 没有就明确提示先跑 npm run web:build, 不静默放过;
//   - CSP 契约在【构建产物】上断言: 无内联可执行脚本 (ppx-boot 由服务端运行时注入,
//     是 type="application/json" 数据节点, 不受 script-src 约束);
//   - 结构锚点 id 在 Vue 组件源码里找 (Electron 菜单/冒烟依赖这批 id, 见 electron/smoke.js)。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webapp = path.join(root, "webapp");
const dist = path.join(webapp, "dist");

let bad = 0;
const fail = (m) => { console.log("  ✗ " + m); bad++; };
const ok = (m) => console.log("  ✓ " + m);

function walk(dir, exts, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

const srcFiles = walk(path.join(webapp, "src"), [".js", ".vue", ".css"]);
const srcOf = (p) => fs.readFileSync(p, "utf8");
const allSrc = srcFiles.map(srcOf).join("\n");
const template = srcOf(path.join(webapp, "index.html"));

// 0) 构建产物存在 (web:check 的前置)
const distIndex = path.join(dist, "index.html");
if (!fs.existsSync(distIndex)) {
  fail("webapp/dist/index.html 不存在 —— 先跑 npm run web:build (产物已入库, 正常 clone 后应直接存在)");
  console.log("\n结果: 1 个问题");
  process.exit(1);
}
const distHtml = fs.readFileSync(distIndex, "utf8");

// 1) 图标: 模板 sprite 定义 vs 全站引用 (含 ico("name") 运行时调用)
const defined = new Set([...template.matchAll(/<g id="(i-[a-z-]+)"/g)].map((m) => m[1]));
const used = new Set();
for (const m of (template + allSrc).matchAll(/#(i-[a-z-]+)/g)) used.add(m[1]);
for (const m of allSrc.matchAll(/\bico\(\s*["']([a-z-]+)["']/g)) used.add("i-" + m[1]);
const missIcon = [...used].filter((u) => !defined.has(u));
if (missIcon.length) fail("引用了未定义的图标: " + missIcon.join(", "));
else ok(`图标定义 ${defined.size} 个, 引用 ${used.size} 个, 全部命中`);

// 2) dist 产物里的静态资源引用必须真实存在 (含哈希名的 js/css/字体)
for (const m of distHtml.matchAll(/(?:href|src)="(\/[^"]+)"/g)) {
  const u = m[1].replace(/\?.*$/, "");
  if (!fs.existsSync(path.join(dist, u.replace(/^\//, "")))) fail("dist 静态资源不存在: " + u);
}
if (!bad) ok("dist 静态资源引用全部存在");

// 2b) chunk 尺寸预算 (2026-11-14 优化循环): vite.config.mjs manualChunks 按库分块后,
//    主包/渲染栈各设上限防回潮 —— 谁往主包塞大依赖, web:check 当场红,
//    不再靠 chunkSizeWarningLimit 告警静音 (旧值 1500 曾把 817kB 主包捂住)。
const KB = 1024;
const jsChunks = fs.readdirSync(path.join(dist, "assets"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => ({ f, kb: Math.round(fs.statSync(path.join(dist, "assets", f)).size / KB) }));
const BUDGETS = [
  { re: /^index-/, max: 250, name: "主包(业务代码)" },
  { re: /^vendor-render-/, max: 650, name: "渲染栈(markdown-it/katex/highlight.js)" },
  { re: /^vendor-vue-/, max: 120, name: "Vue运行时" },
];
const sizeOf = (re) => jsChunks.filter((c) => re.test(c.f)).reduce((s, c) => s + c.kb, 0);
for (const { re, max, name } of BUDGETS) {
  if (sizeOf(re) > max) {
    fail(`chunk 预算超限: ${name} ${sizeOf(re)}kB > ${max}kB`);
  }
}
const unbudgeted = jsChunks.filter((c) => c.kb > 200 && !BUDGETS.some((b) => b.re.test(c.f)));
if (unbudgeted.length) fail("未预算的大块: " + unbudgeted.map((c) => `${c.f} ${c.kb}kB`).join(", "));
if (!bad) ok(`chunk 预算全在限: ${BUDGETS.map((b) => `${b.name} ${sizeOf(b.re)}kB≤${b.max}`).join(", ")}`);

// 3) CSP 契约: 构建产物无内联可执行脚本 (type=application/json 数据节点除外, 且 dist 本不含它)
const inlineExec = [...distHtml.matchAll(/<script\b([^>]*)>/g)]
  .filter((m) => !/\bsrc=/.test(m[1]) && !/type="application\/json"/.test(m[1]));
if (inlineExec.length) fail("dist/index.html 出现内联可执行脚本 (CSP script-src 'self' 会拦): " + inlineExec.length + " 处");
else ok("dist 无内联可执行脚本 (CSP 兼容)");
if (!/<script src="\/theme\.js"><\/script>/.test(distHtml)) fail("dist/index.html 缺少 head 内同步加载的 /theme.js (防 FOUC 契约)");
else ok("theme.js 同步加载契约保持");
// 2026-11-16: 外观 v2 的首屏契约与 theme.js 同源 —— 配色/壁纸/材质必须在首次绘制前
//   写入 data-*, 否则刷新时会先闪一下默认珊瑚色/无壁纸。
const themeJs = srcOf(path.join(webapp, "public", "theme.js"));
for (const [name, needle] of [
  ["外观存储键", "ppx_appearance_v1"],
  ["配色首屏", 'setAttribute("data-palette"'],
  ["壁纸首屏", 'setAttribute("data-wallpaper"'],
  ["材质首屏", 'setAttribute("data-material"'],
]) {
  if (!themeJs.includes(needle)) fail(`theme.js 缺少${name}契约: ${needle}`);
}
if (!bad) ok("外观首屏契约齐全");

// 4) 结构锚点 id (Electron 菜单/冒烟 + 面板定位依赖; 在 Vue 源码全文中找)
//    2026-11-08: 侧栏的「本体列表」(id=botList) 随信息架构收拢并入一级导航, 锚点换成
//    新增的三个一级视图 (项目 / 任务 / 能力) —— 检查的语义仍是"关键结构没被删掉"。
const ANCHORS = [
  ["侧栏", 'id="side"'], ["新会话按钮", 'id="btnNew"'],
  ["对话视图", 'id="view-chat"'], ["空状态", 'id="hero"'], ["开工姿态卡", 'id="typeCards"'],
  ["对话流", 'id="stream"'], ["composer", 'id="composer"'], ["输入框", 'id="inp"'],
  ["发送按钮", 'id="btnSend"'],
  ["项目视图", 'id="view-projects"'], ["任务视图", 'id="view-tasks"'], ["能力视图", 'id="view-caps"'],
  ["文件树面板", 'id="pane-files"'], ["目标面板", 'id="pane-goal"'],
  ["审查面板", 'id="pane-review"'], ["工单面板", 'id="pane-tickets"'], ["轨迹页签", 'id="pane-trace"'],
  ["本体设置", 'id="view-settings"'], ["本体设置容器", 'id="botSettings"'],
  ["使用统计视图", 'id="view-stats"'], ["使用统计容器", 'id="statsWrap"'],
];
for (const [name, s] of ANCHORS) {
  if (!allSrc.includes(s)) fail(`缺少结构锚点: ${name} (${s})`);
}
if (!bad) ok("结构锚点齐全 (" + ANCHORS.length + " 个)");

// 5) 关键 CSS 类 (JS 模板 class= + 各 css 文件选择器的并集里找)
const clsUsed = new Set();
for (const m of allSrc.matchAll(/class="([^"]+)"/g)) {
  for (const c of m[1].split(/\s+/)) if (/^[a-z][\w-]*$/i.test(c)) clsUsed.add(c);
}
for (const m of allSrc.matchAll(/\.([a-z][\w-]*)/gi)) clsUsed.add(m[1]);
// 2026-11-08: 首屏重排后 chip(命令快捷条) 与 hero-types(姿态卡区) 两个类随结构移除,
//   换成新的三块: 当前项目条 project / 起点卡容器 cards / 工作模式一行 modebar。
const need = ["side", "brand", "newchat", "ghead", "hero", "stream", "ev", "toolcard",
  "approval", "plancard", "diffbox", "cards", "composer", "send", "palette", "pitem",
  "drawer", "tab", "dpane", "tree", "goal", "issue", "badge", "setrow", "toast", "btn",
  "view", "botbar", "avavt", "bmeta", "bsub", "panes", "ptab", "project", "modebar", "bcard",
  "shint", "swrap", "ssec", "srow", "titem",
  "st-wrap", "st-kpis", "st-card", "st-heat", "st-cell", "st-legend", "st-models",
  "onb", "onb-mask", "onb-point", "onb-starter", "guidebtn", "tree-filter",
  "qcard", "verdict", "seatcard", "permcard", "codewrap", "codebar", "think"];
const missCls = need.filter((c) => !clsUsed.has(c));
if (missCls.length) fail("缺少关键类: " + missCls.join(", "));
else ok(`样式覆盖全部关键类 (${need.length} 个)`);

// 6) 公开契约: ppx-boot 数据节点消费 + PPXMarkdown 冒烟面 + 渲染库全局
const bootJs = srcOf(path.join(webapp, "src", "boot.js"));
if (!bootJs.includes('"ppx-boot"') && !bootJs.includes("'ppx-boot'")) fail("boot.js 不再解析 ppx-boot 节点 (服务端注入契约断裂)");
else ok("ppx-boot 注入契约已对接");
const mdJs = srcOf(path.join(webapp, "src", "markdown", "index.js"));
for (const [name, needle] of [
  ["window.PPXMarkdown", "window.PPXMarkdown"],
  ["window.markdownit", "window.markdownit"],
  ["window.DOMPurify", "window.DOMPurify"],
  ["window.katex", "window.katex"],
  ["window.hljs", "window.hljs"],
]) {
  if (!mdJs.includes(needle)) fail("markdown/index.js 缺少冒烟契约: " + name);
}
if (!bad) ok("PPXMarkdown + 渲染库全局契约齐全");

console.log(bad ? `\n结果: ${bad} 个问题` : "\n结果: 全部通过");
process.exit(bad ? 1 : 0);
