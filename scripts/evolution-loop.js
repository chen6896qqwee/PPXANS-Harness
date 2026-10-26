#!/usr/bin/env node
// scripts/evolution-loop.js - 持续进化循环 CLI (2026-10-25, 自主进化第二层)
//
// 手动跑一轮完整进化周期 (与定时任务同一编排):
//   Phase 1 learn   : 弱点聚类定向学习 + 失败→经验 + 重复模式→技能
//   Phase 2 iterate : 代码自改进 (需 LLM + 目标测试文件, 默认 propose 只出补丁)
//   Phase 3 journal : 进化度量落账 (data/evolve/journal.jsonl)
//
// 用法:
//   npm run evolve:loop                          # 一轮学习+度量 (代码迭代按 config 目标)
//   npm run evolve:loop -- test/foo.test.js      # 学习 + 对指定测试代码迭代
//   npm run evolve:loop -- --status              # 只看进化报告 (等价 evolution_status 工具)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { EvolutionLoop } from "../src/evolve/loop.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const statusOnly = argv.includes("--status");
const files = argv.filter((a) => !a.startsWith("--"));

async function main() {
  const agent = new PPXAgent({ root: ROOT });
  const loop = agent._evolutionLoop || new EvolutionLoop(agent, agent.config?.agent?.evolution_loop || {});
  try {
    if (statusOnly) {
      console.log("== 能力快照 ==", JSON.stringify(loop.capabilitySnapshot()));
      console.log("== 弱点聚类 (头部 5) ==", JSON.stringify(loop.weaknessClusters().slice(0, 5)));
      console.log("== 最近进化 ==");
      const journal = loop.journalTail(10);
      if (!journal.length) console.log("(暂无记录)");
      for (const j of journal.reverse()) console.log(JSON.stringify(j));
      return;
    }
    const summary = await loop.cycle({
      targetFiles: files,
      onEvent: (t) => console.log(`  · ${t}`),
    });
    console.log("\n==== 进化周期结果 ====");
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    agent.shutdown();
  }
}

main().catch((e) => { console.error("[evolution-loop] 失败:", e.message); process.exit(1); });
