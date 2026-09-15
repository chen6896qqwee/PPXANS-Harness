#!/usr/bin/env node
// scripts/stats.js - 可观测性状态面板
// 用法: node scripts/stats.js [--json]
//   默认输出可读文本面板; --json 输出原始 JSON (供脚本/监控采集)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = process.argv.includes("--json");
const agent = new PPXAgent({ root: ROOT });
const s = agent.stats();

if (json) {
  console.log(JSON.stringify(s, null, 2));
} else {
  const line = "=".repeat(46);
  const src = Object.entries(s.memory.l1.by_source || {}).map(([k, v]) => `${k}:${v}`).join(" ");
  const slow = s.slowTools || [];
  console.log(line);
  console.log("  皮皮虾 状态面板");
  console.log(line);
  console.log(`  Agent : ${s.agent.name} | 模式 ${s.agent.mode} | LLM ${s.agent.llm}`);
  console.log(`  记忆  : L0 ${s.memory.l0.events_total} 事件 / ${s.memory.l0.sessions} 会话`);
  console.log(`          L1 ${s.memory.l1.total} 事实 (上限 ${s.memory.l1.max_facts || "∞"})`);
  console.log(`          来源 [${src || "-"}]`);
  console.log(`          L2 ${s.memory.l2.scenes} 场景 | L3 用户画像 ${s.memory.l3.user_updated || "-"} | Agent ${s.memory.l3.agent_updated || "-"}`);
  console.log(`          longterm ${(s.memory.longterm_bytes / 1024).toFixed(1)} KB | 今日 ${s.memory.events_today} 事件`);
  console.log(`  工具  : ${s.tools.total} 个 (${s.tools.enabled} 启用 / ${s.tools.total - s.tools.enabled} 禁用)`);
  console.log(`  经验  : ${s.experience.lessons} 条`);
  console.log(`  轨迹  : ${s.count ?? 0} 调用 · 失败 ${s.failed ?? 0} · 失败率 ${s.failRate ?? "0%"}`);
  if (slow.length) console.log(`  慢工具: ${slow.map((x) => `${x.tool}(${x.avgMs}ms)`).join(" ")}`);
  if (s.health) console.log(`  自愈  : 修复 ${(s.health.fixes || []).length} 项 | 崩溃残留 ${s.health.crashed ? "是" : "否"}`);
  console.log(line);
}

agent.shutdown();
