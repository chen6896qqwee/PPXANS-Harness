// scripts/analysis/dep-graph.js - 模块依赖图提取 + 技术债扫描
// 用法: node scripts/analysis/dep-graph.js <root>
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] || ".";
const srcDir = path.join(root, "src");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js") || e.name.endsWith(".mjs")) out.push(p);
  }
  return out;
}

const files = walk(srcDir);
const mods = new Map(); // abs -> rel

for (const f of files) {
  const rel = path.relative(root, f).replace(/\\/g, "/");
  mods.set(f, rel);
}

// 依赖: rel -> [rel...]
const deps = new Map();
const techDebt = { todo: 0, fixme: 0, hack: 0, consoleLog: 0, syncFs: 0, hardcodedVersion: [] };

for (const f of files) {
  const rel = mods.get(f);
  const code = fs.readFileSync(f, "utf8");
  const out = new Set();
  const re = /from\s+["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(code))) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    const base = path.join(path.dirname(f), spec);
    let target = null;
    const cands = [];
    if (/\.[cm]?js$/.test(spec)) cands.push(base); // spec 已带扩展名
    else cands.push(base + ".js", base + ".mjs", path.join(base, "index.js"));
    for (const cand of cands) {
      if (fs.existsSync(cand)) { target = cand; break; }
    }
    if (target) out.add(mods.get(target) || target);
  }
  deps.set(rel, [...out].sort());

  if (/TODO|FIXME|HACK|XXX/i.test(code)) techDebt.todo++;
  if (/console\.(log|warn|error|info)/.test(code)) techDebt.consoleLog++;
  const syncRe = /fs\.(readFileSync|writeFileSync|appendFileSync|renameSync|unlinkSync|mkdirSync|readdirSync|statSync|existsSync|rmSync|copyFileSync)/g;
  const syncs = code.match(syncRe);
  if (syncs) techDebt.syncFs += syncs.length;
  const verRe = /["'](\d+\.\d+\.\d+)["']/g;
  let vm;
  while ((vm = verRe.exec(code))) {
    if (!/2026-07-28|2025-06-18|2025-03-26|2024-11-05/.test(vm[1])) {
      techDebt.hardcodedVersion.push(`${rel}: ${vm[1]}`);
    }
  }
}

// 输出
console.log("===== 依赖图 (rel -> imports) =====");
for (const [rel, list] of deps) {
  if (list.length) console.log(`${rel} -> ${list.join(", ")}`);
}

console.log("\n===== 入度 Top (被依赖最多的模块) =====");
const indeg = new Map();
for (const [, list] of deps) for (const t of list) indeg.set(t, (indeg.get(t) || 0) + 1);
[...indeg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => console.log(`${v}\t${k}`));

console.log("\n===== 技术债扫描 =====");
console.log(`TODO/FIXME/HACK 文件数: ${techDebt.todo}`);
console.log(`console.* 文件数: ${techDebt.consoleLog}`);
console.log(`同步 fs 调用次数: ${techDebt.syncFs}`);
console.log(`硬编码版本: ${techDebt.hardcodedVersion.length ? techDebt.hardcodedVersion.join("; ") : "无"}`);
