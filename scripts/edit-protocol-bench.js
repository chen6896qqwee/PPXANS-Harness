#!/usr/bin/env node
// scripts/edit-protocol-bench.js — 编辑协议成本基准 (2026-11-13)
//
// 离线、确定性、可复算: 量"模型为了表达一次编辑必须输出多少字符", 不量模型行为。
// 用法:
//   node scripts/edit-protocol-bench.js            # 人读表格
//   node scripts/edit-protocol-bench.js --json     # 机读
//   node scripts/edit-protocol-bench.js --markdown # 贴文档
import { summarize, EDIT_TASKS, breakEvenReadLines } from "../bench/edit-protocol.js";

const fmt = (n) => (n >= 0 ? `+${n}` : `${n}`);
const pad = (s, n) => String(s).padEnd(n);

function main() {
  const s = summarize(EDIT_TASKS);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  if (process.argv.includes("--markdown")) {
    console.log("| 任务 | 编辑数 | 读入行 | SEARCH/REPLACE | 锚点(含读税) | 净差 | 比值 |");
    console.log("|---|---|---|---|---|---|---|");
    for (const r of s.rows) {
      console.log(`| ${r.desc} | ${r.edits} | ${r.readLines} | ${r.patchTotal} | ${r.anchorTotal} | ${fmt(r.netDelta)} | ${r.anchorRatio} |`);
    }
    console.log(`\n合计: patch ${s.total.patch} 字符 / anchor ${s.total.anchor} 字符 → **${s.ratio}×**`);
    return;
  }

  console.log("=== 编辑协议成本基准 (字符数; 负净差 = 锚点更省) ===\n");
  console.log(pad("任务", 46), pad("编辑", 6), pad("读入行", 8), pad("patch", 8), pad("anchor", 9), pad("净差", 8), "比值");
  for (const r of s.rows) {
    console.log(pad(r.desc, 46), pad(r.edits, 6), pad(r.readLines, 8), pad(r.patchTotal, 8), pad(r.anchorTotal, 9), pad(fmt(r.netDelta), 8), r.anchorRatio);
  }
  console.log("\n合计: patch", s.total.patch, "字符 / anchor", s.total.anchor, "字符 →", s.ratio, "×");
  console.log("锚点净省的场景:", s.winners.anchor.join(", ") || "(无)");
  console.log("patch 更省的场景:", s.winners.patch.join(", ") || "(无)");
  console.log("\n--- 净收益判定 (每场景可读入多少行才回本) ---");
  for (const t of EDIT_TASKS) {
    const n = breakEvenReadLines(t);
    console.log(pad(t.id, 22), Number.isFinite(n) ? `读入 ≤ ${n} 行时锚点净省` : "此任务锚点不可能净省 (编辑载荷本身就比旧内容长)");
  }
  console.log("\n口径: 只算协议信息成本, 不含模型重试/写错; 读税 = 锚点视图每行多出的 `行号#hash| ` 前缀。");
}

main();
