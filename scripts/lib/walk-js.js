// scripts/lib/walk-js.js - 守卫/巡检脚本的目录遍历骨架单源
//
// 2026-11-03 重复消除: arch-guard.js (listJs/dirLines) 与 native-guard.js (listJs)
// 此前各持一份逐字相同的 readdirSync 递归骨架。遍历顺序 (readdirSync 逐目录 DFS)
// 是闸门输出稳定性的前提, 骨架只有这一份, 改动它=同时改动两个闸门的扫描顺序。
// 2026-11-13 扩大收口: depcheck / lexicon-check / test-map / analysis/dep-graph 各自的
//   walk(dir, out=[]) 也并到这里 —— 四份的差别只有"扩展名 / 跳过目录 / 是否跳过点开头
//   条目 / 读不了的目录是否容忍", 用选项表达即可; 递归与顺序不再各写一遍。
import fs from "node:fs";
import path from "node:path";

// 深度优先遍历 dir 下的目标文件, 不跟随符号链接目录 (withFileTypes 的目录项即真实目录)。
//   exts     参与收集的扩展名 (含点, 如 ".js")
//   skipDirs 整目录跳过的名字 (只在目录项上判定)
//   skipDot  跳过所有以 "." 开头的条目 (文件与目录都算)
//   tolerant 某个目录读不了时跳过它继续扫兄弟目录; 默认 false (直接抛出)
export function walkFiles(dir, { exts = [".js"], skipDirs = [], skipDot = false, tolerant = false } = {}) {
  const extsSet = new Set(exts);
  const skipSet = new Set(skipDirs);
  const out = [];
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch (e) { if (tolerant) return; throw e; }
    for (const e of entries) {
      if (skipDot && e.name.startsWith(".")) continue;
      const fp = path.join(d, e.name);
      if (e.isDirectory()) {
        if (skipSet.has(e.name)) continue;
        walk(fp);
      } else if (extsSet.has(path.extname(e.name))) out.push(fp);
    }
  })(dir);
  return out;
}

// 只要 .js 并逐个回调 (arch-guard / native-guard 的行数统计与落点扫描用这个)。
export function walkJs(dir, visit) {
  for (const fp of walkFiles(dir)) visit(fp);
}
