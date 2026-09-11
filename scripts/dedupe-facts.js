// scripts/dedupe-facts.js - L1 记忆存量去重 (一次性工具)
// 背景: _normKey() 归一化去重只防新增 (fact-store.add), 存量重复需合并清理
// 逻辑:
//   默认: 按归一化键分组, 每组保留 score+hits 最高的那条, 累加 hits, 移除其余
//   --similar [阈值]: bigram Jaccard >= 阈值合并 (模板类同义变体, 默认 0.6)
//   --overlap [阈值]: bigram overlap (交集/较短者) >= 阈值合并 (词序变化的松散变体, 默认 0.65)
//     两者可叠加: 先 --similar 再 --overlap, 覆盖字面重复 + 语义变体两层
// 用法: node scripts/dedupe-facts.js [dataDir] [--similar 0.6] [--overlap 0.65]   (默认 ./data)
import path from "node:path";
import { FactStore } from "../src/memory/fact-store.js";

const args = process.argv.slice(2);
const simIdx = args.indexOf("--similar");
const similarThreshold = simIdx >= 0 ? Number(args[simIdx + 1] || 0.6) : 0;
const ovIdx = args.indexOf("--overlap");
const overlapThreshold = ovIdx >= 0 ? Number(args[ovIdx + 1] || 0.65) : 0;
// v1.0.9: 定位参数只取非 flag 项 — 原 args[0] 会拿到 "--similar" 并在 cwd 建出 "--similar/" 目录静默空跑
const positional = args.filter((a) => !a.startsWith("--") && !/^[0-9.]+$/.test(a));
const dataDir = path.resolve(positional[0] || path.join(process.cwd(), "data"));
const store = new FactStore(dataDir);
let before = store.list();

// 按归一化键分组 (复用 FactStore._normKey, 与 add 去重逻辑同源)
const groups = new Map();
for (const f of before) {
  const key = store._normKey(f.content);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(f);
}

const kept = [];
let removed = 0;
for (const [key, arr] of groups) {
  if (arr.length === 1) { kept.push(arr[0]); continue; }
  // 保留 score+hits 最高; 其余合并进 winner (hits 累加, 时间取最新)
  const winner = [...arr].sort((a, b) => (b.score + b.hits) - (a.score + a.hits))[0];
  const extraHits = arr.filter((f) => f !== winner).reduce((s, f) => s + (f.hits || 0), 0);
  const lastTs = arr.map((f) => f.lastAccess || f.created || "").filter(Boolean).sort().pop();
  if (extraHits) winner.hits = (winner.hits || 0) + extraHits;
  if (lastTs) winner.lastAccess = lastTs;
  kept.push(winner);
  removed += arr.length - 1;
  console.log(`合并 x${arr.length}: "${winner.content.slice(0, 60)}"`);
}

// 语义去重: 两两 bigram Jaccard >= 阈值视为同义变体, 并入代表
if (similarThreshold > 0) {
  const groups = [];
  for (const f of kept) {
    let placed = false;
    for (const g of groups) {
      if (store._jaccard(f.content, g.rep.content) >= similarThreshold) {
        g.items.push(f);
        if ((f.score + f.hits) > (g.rep.score + g.rep.hits)) g.rep = f;
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ rep: f, items: [f] });
  }
  const merged = groups.map((g) => {
    if (g.items.length === 1) return g.rep;
    const rep = { ...g.rep };
    rep.hits = g.items.reduce((a, x) => a + (x.hits || 0), 0);
    rep.score = g.items.reduce((a, x) => Math.max(a, x.score || 0), 0);
    return rep;
  });
  removed += kept.length - merged.length;
  console.log(`\n语义去重 (Jaccard ${similarThreshold}): ${kept.length} -> ${merged.length} (合并 ${kept.length - merged.length} 条变体)`);
  kept.length = 0;
  kept.push(...merged);
}

// 更强语义去重: bigram overlap (交集/较短者) >= 阈值, 处理词序变化的松散同义改写
// (LLM 提炼变体可能词序/措辞大变, Jaccard 低于 0.6 但共享核心词, overlap 能捕获)
if (overlapThreshold > 0) {
  const overlap = (a, b) => {
    const A = store._bigramSet(a), B = store._bigramSet(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / Math.min(A.size, B.size);
  };
  const groups = [];
  for (const f of kept) {
    let placed = false;
    for (const g of groups) {
      if (overlap(f.content, g.rep.content) >= overlapThreshold) {
        g.items.push(f);
        if ((f.score + f.hits) > (g.rep.score + g.rep.hits)) g.rep = f;
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ rep: f, items: [f] });
  }
  const merged = groups.map((g) => {
    if (g.items.length === 1) return g.rep;
    const rep = { ...g.rep };
    rep.hits = g.items.reduce((a, x) => a + (x.hits || 0), 0);
    rep.score = g.items.reduce((a, x) => Math.max(a, x.score || 0), 0);
    return rep;
  });
  removed += kept.length - merged.length;
  console.log(`\n语义去重 (overlap ${overlapThreshold}): ${kept.length} -> ${merged.length} (合并 ${kept.length - merged.length} 条变体)`);
  kept.length = 0;
  kept.push(...merged);
}

store.facts = kept;
store.rebuildIndex();
store.save();
console.log(`\n去重完成: ${before.length} -> ${kept.length} (移除 ${removed} 条重复)`);
