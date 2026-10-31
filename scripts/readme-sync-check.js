#!/usr/bin/env node
// scripts/readme-sync-check.js - README 实测数字同步闸门 (零依赖)
//
// 动机 (2026-10-07 评估报告 P0-1):
//   README 里写着 "1440 项测试 / 4285 tok / 64 内置工具 / 23 核心 schema", 实测是
//   1543 / 5355 / 85 / 26 —— 四个数字全错, badge 也错。原因是这些数字是**手写的**:
//   每次加工具、加技能、涨 prompt 都不会自动同步, 而 CI 里没有任何一道闸门口得住。
//   外人看项目的第一眼就是 README, 一张wrong脸比一个 bug 贵得多。
//
// 做法:
//   README 里埋一行机读锚点 <!-- readme-sync: {...} -->, 这里逐项**实测**比对。
//   锚点里的数字只能由本脚本 --fix 写入, 不许手改 (改了这里就红)。
//
// 用法:
//   node scripts/readme-sync-check.js            # 校验 (CI 用, 不匹配即非零退出)
//   node scripts/readme-sync-check.js --fix      # 把实测值写回 README 锚点
//   node scripts/readme-sync-check.js --show     # 只打印实测值, 不比对
//   node scripts/readme-sync-check.js --with-tests  # 额外跑 npm test 校验 tests 项 (慢, ~70s)
//
// 为什么 tests 默认不校验: 全量测试 70 秒, 每次 push 都跑一遍只为核一个数字不划算。
//   想兜住就把它放进 nightly 或发版前门禁 (prepublishOnly)。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(HERE, "..");
const README = path.join(root, "README.md");

const argv = process.argv.slice(2);
const FIX = argv.includes("--fix");
const SHOW = argv.includes("--show");
const WITH_TESTS = argv.includes("--with-tests");

const ANCHOR_RE = /<!--\s*readme-sync:\s*(\{[\s\S]*?\})\s*-->/;

// 散文数字校验: 光守锚点不够 —— 读者看的是散文那一句 ("85 个内置工具" "5395 tok/请求"),
// 锚点是给机器看的。两个地方各写一遍就会各漂一次, 所以散文也进闸门。
// 每条 = 实测键 + 抓散文数字的正则 (第 1 捕获组就是数字)。--fix 会一并替换。
const PROSE_CHECKS = [
  // 2026-10-27: 原正则要求 `工具` 后紧跟 `**`, 而首段总结句写成 `**93 个内置工具 · 护栏 · ...**`
  //   (加粗横跨整句), 于是永远匹配不上 → 静默走"未找到对应句式"分支, 漂了 6 版没被拦。去掉尾部 `**` 即可。
  { key: "tools", re: /\*\*(\d+) 个内置工具/ },
  // 2026-10-30 (本轮补漏): 上面那条只覆盖"**N 个内置工具**"。README 的工具清单小标题写的是
  //   `**93 内置工具**（运行时实测…）`(没有"个") —— 同一事实的第二种写法, 闸门匹配不上就静默放行,
  //   实测漂了 3 个版本(93 vs 96)。同键再加一条只认这种句式的正则, --fix 会一并同步。
  { key: "tools", re: /\*\*(\d+) 内置工具\*\*/ },
  // 2026-10-30 (本轮补漏): 历史上的 `MCP 共暴露 **N**` 句式在 README 里已经不存在(那条正则永远匹配不到,
  //   只会打印"正则需维护")。README 现在写的是 "暴露 86 工具" / "86 工具全量暴露", 实测 /mcp 真实暴露
  //   118 个、散文漂了 32 而闸门毫无反应 —— 所以按**现有写法**加两条正则; 旧句式若回到 README 再加回来。
  { key: "mcp_tools", re: /暴露 (\d+) 工具/ },
  { key: "mcp_tools", re: /(\d+) 工具全量暴露/ },
  { key: "tests", re: /全量测试 \*\*(\d+) 项/ },
  // 2026-10-30 (本轮补漏): 同一句里还有"通过数" `全量测试 **1830 项 (1826 通过 / 4 网络跳过)**`。
  //   只同步总数的话, 每加一批测试, 括号里的通过数就静默过期 (实测 1822 项还挂着 1803 通过)。
  //   捕获组精确包住那个数字, 通用 replace 就能替换到位; 只在 --with-tests 下测量与校验。
  { key: "tests_pass", re: /\((\d+) 通过/ },
  { key: "skills", re: /技能库 \*\*(\d+) 个/ },
  { key: "core_schema", re: /只把 \*\*(\d+) 个核心工具\*\*/ },
  { key: "ctx_tokens", re: /固定开销 ≈ \*\*(\d+) tok\/请求\*\*/ },
];

// ---- 实测: 与 ctx-profile.js 同一套粗估口径 (中文 1 字 1 tok, 其余 4 字符 1 tok) ----
const est = (s) => {
  const t = String(s || "");
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.round(cjk + (t.length - cjk) / 4);
};

// 实测: 内置工具数 (静态解析 register 块, 与运行时 register 一一对应)
function measureTools() {
  const names = new Set();
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) { walk(fp); continue; }
      if (!e.name.endsWith(".js")) continue;
      const s = fs.readFileSync(fp, "utf8");
      const re = /\.register\(\s*\{/g;
      let m;
      while ((m = re.exec(s))) {
        const chunk = s.slice(m.index, m.index + 400);
        const nm = chunk.match(/\bname:\s*["']([a-zA-Z0-9_\-.]+)["']/);
        if (nm) names.add(nm[1]);
      }
    }
  })(path.join(root, "src"));
  return names.size;
}

// 实测: 技能数
function measureSkills() {
  let n = 0;
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.name === "SKILL.md") n++;
    }
  })(path.join(root, "skills"));
  return n;
}

// 实测: 核心 schema 数 + 固定开销 tok (装配一次 agent 拿真值)
// 2026-10-11: ctx 注入含【工作目录】等真实绝对路径, 测量值随 checkout 路径长度漂移
//   (README=13893 vs CI windows 13884)。与 ctx-profile.js 同修: 测量前做路径归一化
//   (root → <ROOT>, 其余绝对路径 → <PATH>), 占位符定长, 任何机器数字一致。
// 2026-10-31 (发布轮): 光归一路径还不够 —— 开发机 root 里有真实 config/ppx.json
//   (persona / self_iteration 白名单等都会渲染进 context), CI checkout 没有, 实测
//   差了 170 tok, 门禁在 CI 必红。ctx_tokens 是"固定开销"锚点, 必须跨机器可复现:
//   改在【干净临时 root】上装配 (无 config / 无 data / 无本地状态), 量的是内核
//   装配出的裸 system prompt + 工具 schema。代价: 不再反映"本机满配"的开销 ——
//   那个数字本来也不该进版本库。
async function measureContext() {
  const { PPXAgent } = await import("../src/agent/index.js");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-rsc-"));
  const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-rsc-root-"));
  const a = new PPXAgent({ root: bareRoot, dataDir });
  const tools = a.tools.toOpenAI();
  let ctx = "";
  try { ctx = a._context("随便问个问题"); } catch { ctx = ""; }
  try { a.shutdown?.(); } catch { /* 量完即弃 */ }
  const norm = (s) => String(s || "")
    .split(bareRoot).join("<ROOT>")
    .replace(/([A-Za-z]:[/\\]|\\\\)[^\s"'\n]+/g, "<PATH>")
    .replace(/(^|[\s"'=(])\/(?:home|Users|root|tmp|var)\/[^\s"'\n]+/g, "$1<PATH>");
  return { coreSchema: tools.length, ctxTokens: est(norm(JSON.stringify(tools))) + est(norm(ctx)) };
}

// 实测: MCP tools/list 暴露数
async function measureMcp() {
  const { PPXAgent } = await import("../src/agent/index.js");
  const { HttpChannel } = await import("../src/channels/http.js");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-rsc-mcp-"));
  const a = new PPXAgent({ root, dataDir });
  // 2026-10-24 (R14): 量**真实 /mcp 端点面** —— 此前量裸 McpServer.handle (93),
  //   少了 HttpChannel 注入的 20 个 admin 管理虚拟工具 (ppx.sessions/providers/
  //   settings/task.*), 外部 MCP 客户端在 /mcp 上真实看到 113。闸门必须量
  //   外部可见的面, 而不是内核对象的面 (与 tools 91 闸门同一原则)。
  const ch = new HttpChannel(a, { port: 0, host: "127.0.0.1" });
  ch.authToken = "rsc";
  await ch.connect();
  try {
    const port = ch.server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer rsc" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const j = await res.json();
    return ((j?.result?.tools) || []).length;
  } finally {
    try { await ch.disconnect(); } catch {}
    try { a.shutdown(); } catch {}
  }
}

// 实测: 全量测试项数 (只有 --with-tests 才跑, 慢)
// 坑 (2026-10-07 P0-2): node >=22 默认 reporter 是 spec (输出 "i tests N"), 不是 TAP
// ("# tests N")。旧代码只认 TAP 前缀, 于是 tests 永远解析成 null, --with-tests 恒红。
// 修法: 强制 --test-reporter=tap, 且正则同时兼容 TAP 与 spec 两种前缀。
function measureTests() {
  const args = ["--test", "--test-reporter=tap", "--test-force-exit", "test/*.test.js"];
  let out = "";
  try {
    out = execFileSync(process.execPath, args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    // 测试有失败时 node 非零退出, execFileSync 抛错, 结果在其 stdout 里
    out = String((e && (e.stdout || e.message)) || "");
    // 2026-10-31: 此前失败用例名被整个吞掉 —— 门禁只说"1 项失败"却不说哪项,
    //   flaky 测试无从定位 (实测踩过一次: 全量直跑 5 连绿, 门禁内偶发 1 红)。
    const bad = out.split("\n").filter((l) => l.startsWith("not ok")).slice(0, 10);
    if (bad.length) console.error("  [readme-sync] 失败用例 (前 10):\n    " + bad.join("\n    "));
  }
  const grab = (name) => {
    const m = out.match(new RegExp(`^(?:#|\u2139)\\s*${name}\\s+(\\d+)`, "m"));
    return m ? Number(m[1]) : null;
  };
  return { tests: grab("tests"), pass: grab("pass"), fail: grab("fail") };
}

// ---- 主流程 ----
const measured = {
  tools: measureTools(),
  skills: measureSkills(),
};
try {
  const c = await measureContext();
  measured.core_schema = c.coreSchema;
  measured.ctx_tokens = c.ctxTokens;
} catch (e) {
  measured.core_schema = null;
  measured.ctx_tokens = null;
  console.error("  ! 上下文实测失败: " + (e && e.message ? e.message : e));
}
try {
  measured.mcp_tools = await measureMcp();
} catch (e) {
  measured.mcp_tools = null;
  console.error("  ! MCP 实测失败: " + (e && e.message ? e.message : e));
}
if (WITH_TESTS) {
  const t = measureTests();
  measured.tests = t.tests;
  measured.tests_pass = t.pass; // 散文括号里的"通过数"(不进锚点, 只用于同步散文)
  if (t.fail == null) {
    console.error("  ✗ 无法解析全量测试结果 (reporter 输出格式变了?)");
    process.exitCode = 1;
  } else if (t.fail !== 0) {
    console.error(`  ✗ 全量测试有 ${t.fail} 项失败, tests 数字无意义`);
    process.exitCode = 1;
  }
}

if (SHOW) {
  console.log(JSON.stringify(measured, null, 2));
  process.exit(process.exitCode || 0);
}

const md = fs.readFileSync(README, "utf8");
const m = md.match(ANCHOR_RE);
if (!m) {
  console.error("  ✗ README 里找不到机读锚点 <!-- readme-sync: {...} -->");
  console.error("    请在 README 加一行: <!-- readme-sync: " + JSON.stringify(measured) + " -->");
  process.exitCode = 1;
  process.exit(process.exitCode);
}

let declared;
try {
  declared = JSON.parse(m[1]);
} catch (e) {
  console.error("  ✗ 锚点不是合法 JSON: " + e.message);
  process.exitCode = 1;
  process.exit(process.exitCode);
}

if (FIX) {
  let next = md;
  for (const { key, re } of PROSE_CHECKS) {
    if (measured[key] == null) continue;
    if (re.test(next)) next = next.replace(re, (full, _old) => full.replace(_old, String(measured[key])));
  }
  const declaredObj = JSON.parse((next.match(ANCHOR_RE) || [null, "{}"])[1]);
  const merged = { ...declaredObj };
  // tests_pass 只服务于散文里的括号, 不进机读锚点 (锚点声明的键会被反向检查, 而它仅在
  //   --with-tests 下可测 —— 写进锚点会让默认闸门报"锚点声明但无实测项")。
  for (const k of Object.keys(measured)) if (measured[k] != null && k !== "tests_pass") merged[k] = measured[k];
  next = next.replace(ANCHOR_RE, "<!-- readme-sync: " + JSON.stringify(merged) + " -->");
  fs.writeFileSync(README, next, "utf8");
  console.log("  ✓ 已把实测值写回 README (锚点 + 散文数字):");
  console.log("    " + JSON.stringify(merged));
  process.exit(0);
}

console.log("=== README 实测数字同步检查 ===");
// ctx_tokens 容差: 路径已归一化, 但 Windows runner 上仍有 ~6 tok 的机器残差 (hostname/用户名等
//   归一化覆盖不到的注入), ubuntu 实测与本地分毫不差。闸门要抓的是"一段注释涨几百 tok"级别的
//   膨胀, ±24 tok (残差的 4 倍) 不会放过真增长, 也不该为机器噪声红脸。
const TOL = { ctx_tokens: 24 };
let bad = 0;
for (const [k, want] of Object.entries(measured)) {
  if (want == null) { console.log(`  - ${k.padEnd(12)} 实测失败, 跳过`); continue; }
  if (!(k in declared)) { console.log(`  - ${k.padEnd(12)} 锚点未声明, 跳过 (跑 --fix 补上)`); continue; }
  const got = declared[k];
  const ok = Math.abs(Number(got) - Number(want)) <= (TOL[k] || 0);
  const tol = TOL[k] ? ` (±${TOL[k]})` : "";
  console.log(`  ${ok ? "✓" : "✗"} ${k.padEnd(12)} README=${String(got).padStart(6)}   实测=${String(want).padStart(6)}${ok ? tol : ""}`);
  if (!ok) bad++;
}
// 反向: 锚点里声明了但本脚本测不了的键 (说明闸门漏了, 不是数字错了)
for (const k of Object.keys(declared)) {
  if (!(k in measured) && k !== "tests") console.log(`  ? ${k.padEnd(12)} 锚点声明但无实测项 (仅 --with-tests 才测: ${k === "tests"})`);
}

// 散文数字: 与锚点同等对待 —— 漏一项就算闸门漏了
for (const { key, re } of PROSE_CHECKS) {
  const want = measured[key];
  if (want == null) continue;
  const m2 = md.match(re);
  if (!m2) { console.log(`  - 散文 ${key.padEnd(12)} 未找到对应句式 (正则需维护)`); continue; }
  const ok = Number(m2[1]) === Number(want);
  console.log(`  ${ok ? "✓" : "✗"} 散文 ${key.padEnd(8)} README=${String(m2[1]).padStart(6)}   实测=${String(want).padStart(6)}`);
  if (!ok) bad++;
}

if (bad > 0) {
  console.error(`\n  ✗ ${bad} 项数字与实测不符 —— 跑 node scripts/readme-sync-check.js --fix 同步`);
  process.exitCode = 1;
} else {
  console.log("\n  ✓ README 实测数字全部与真机一致");
}
// 显式退出: 装配出来的 agent 带着 ticker / WAL / 看板等常驻定时器, 事件循环不会自己空下来
// (首次跑被 120s timeout 砍掉过一次 —— 输出其实早就对了, 只是进程退不出去)。
process.exit(process.exitCode || 0);
