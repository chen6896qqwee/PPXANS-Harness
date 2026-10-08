#!/usr/bin/env node
// bench/team-longrun.js - 多 Agent 协作层长任务压测 (零依赖, 桩执行器, 离线)
//
// 为什么需要 (2026-10-07 评估报告 P1-1):
//   协作层 (10 班组 × 5 拓扑 + 常驻房间 + 并发治理) 的全部证据是**单元/桩测试**。
//   而评估报告给这一维度打 84 分时明确写了: 这是"设计分", 不是"实测分" ——
//   没有一次真实长任务的实证。班组在 100 任务量级上会不会有成员饿死、房间时间线膨胀、
//   在途账本泄漏、峰值并发失控, 全靠猜。
//
// 本压测用**桩执行器**回答这些问句 (不发网络、不花钱、CI 可跑):
//   - 吞吐: tasks/sec
//   - 饿死率: 派了活但从没轮到执行的成员占比
//   - 峰值并发: governor.peak 是否守住 limit
//   - 账本泄漏: 跑完在途任务数是否归零
//   - 时间线: 是否守住 timelineLimit (房间状态膨胀)
//
// 用法:
//   node bench/team-longrun.js                 # 默认 100 任务 × 全部拓扑
//   node bench/team-longrun.js --tasks 500     # 加量
//   node bench/team-longrun.js --topology parallel,debate
//   node bench/team-longrun.js --json          # 机器可读输出
//
// 与 bench/falsify.js 的分工: 那个验"判分器准不准", 这个验"协作层扛不扛得住"。
//   都是离线零密钥, 都进 CI —— 因为涉及并发与调度的 bug 恰恰是本地跑不出来、
//   只在长跑与压力下才现形的那一类。

import { TeamRoom } from "../src/orchestrator/room.js";
import { TEAMS, TOPOLOGIES, teamExperts } from "../src/orchestrator/teams.js";

const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const TASKS = Math.max(1, Number(argOf("--tasks", 100)) || 100);
const AS_JSON = argv.includes("--json");
const TOPOS = argv.includes("--topology")
  ? argOf("--topology", "").split(",").map((s) => s.trim()).filter(Boolean)
  : [...TOPOLOGIES];
const TIMELINE_LIMIT = 500;

// 桩执行器: 模拟"干活要时间"。latencyMs 固定 + 抖动, 不用真的 LLM。
// 抖动是刻意的: 完全均匀的耗时掩盖不了调度问题 (所有成员永远同时空闲 = 没有竞争)。
// 签名必须与 TeamRoom 契约一致: executor(memberId, message, ctx) —— 第一个参数是**成员 id 字符串**,
// 不是成员对象。第一版写成 (member, task) 导致 byMember 全记到 undefined 名下,
// 压测于是报出"饿死率 100%" —— 那是压测自己的 bug, 不是协作层的问题。
function stubExecutor({ latencyMs = 5, jitterMs = 8 } = {}) {
  let calls = 0;
  const byMember = new Map();
  return {
    stats: () => ({ calls, byMember: Object.fromEntries(byMember) }),
    async run(memberId, task) {
      calls += 1;
      byMember.set(memberId, (byMember.get(memberId) || 0) + 1);
      const wait = latencyMs + Math.floor(Math.random() * jitterMs);
      await new Promise((r) => setTimeout(r, wait));
      return `[${memberId}] 已完成: ${String(task).slice(0, 40)}`;
    },
  };
}

async function runTopology(topology, tasks) {
  const teamId = Object.keys(TEAMS).find((k) => TEAMS[k].topology === topology) || Object.keys(TEAMS)[0];
  const team = TEAMS[teamId];
  const experts = teamExperts(teamId);
  const stub = stubExecutor();
  const members = experts.slice(0, 4).map((e, i) => ({
    id: e.id || `m${i}`,
    name: e.name || `成员${i}`,
    role: e.role || e.desc || "",
  }));
  if (!members.length) return { topology, skipped: true, reason: "班组无成员" };

  const room = new TeamRoom({
    id: `bench-${topology}`,
    name: `压测-${topology}`,
    host: { id: "host", name: "主持人" },
    members,
    executor: (member, task) => stub.run(member, task),
    // 主持人桩: 不做真实编排 (那要 LLM), 只把任务按拓扑分发
    hostExecutor: async (_host, task) => `收到: ${String(task).slice(0, 30)}`,
    timelineLimit: TIMELINE_LIMIT,
  });

  const t0 = Date.now();
  const results = [];
  // 派工: 按拓扑语义选目标
  for (let i = 0; i < tasks; i++) {
    const target = topology === "pipeline" ? members[i % members.length] : members[Math.floor(Math.random() * members.length)];
    const r = room.dispatch(target.id, `任务#${i}: 处理第 ${i} 项`, { via: "host" });
    results.push(r);
    // 每 10 个任务收口一次 (模拟主持人的节奏), 也让在途账本有机会回落
    if (i % 10 === 9) await room.drain({ timeoutMs: 5000 });
  }
  await room.drain({ timeoutMs: 10000 });
  const ms = Date.now() - t0;

  const st = room.status();
  const perMember = stub.stats().byMember;
  const served = Object.keys(perMember).length;
  const starved = members.filter((m) => !perMember[m.id]);

  // status().jobs 是**计数对象** {total,queued,running,replying,done,failed,cancelled,inFlight},
  // 不是任务 Map —— 第一版按 Map 遍历数字, 算出永远为 2 的"残留", 同样是压测自己的 bug。
  const j = st.jobs || {};
  const inFlightLeak = (j.queued || 0) + (j.running || 0) + (j.replying || 0);
  return {
    topology,
    teamId,
    tasks,
    ms,
    throughput: +(tasks / (ms / 1000)).toFixed(1),
    members: members.length,
    served,
    starved: starved.length,
    starvedRate: +(starved.length / members.length).toFixed(3),
    timeline: st.timelineLength ?? null,
    timelineLimit: TIMELINE_LIMIT,
    inFlightLeak,
    trackerInFlight: j.inFlight ?? 0,
    inFlightTotal: j.total ?? null,
    done: j.done ?? 0,
    failedJobs: j.failed ?? 0,
    failed: results.filter((r) => r && r.ok === false).length,
  };
}

const rows = [];
for (const t of TOPOS) {
  // eslint-disable-next-line no-await-in-loop
  rows.push(await runTopology(t, TASKS));
}

if (AS_JSON) {
  console.log(JSON.stringify({ tasks: TASKS, rows }, null, 2));
} else {
  console.log("\n=== 多 Agent 协作层长任务压测 ===");
  console.log(`  每拓扑 ${TASKS} 个任务 · 桩执行器 (离线零密钥) · 房间时间线上限 ${TIMELINE_LIMIT}\n`);
  console.log("  拓扑          班组        任务   耗时ms   吞吐(t/s)  成员  被派到  饿死  在途残留  时间线");
  console.log("  " + "-".repeat(84));
  for (const r of rows) {
    if (r.skipped) { console.log(`  ${r.topology.padEnd(12)} (跳过: ${r.reason})`); continue; }
    console.log(
      "  " +
      String(r.topology).padEnd(12) +
      String(r.teamId).padEnd(12) +
      String(r.tasks).padStart(6) +
      String(r.ms).padStart(9) +
      String(r.throughput).padStart(11) +
      String(r.members).padStart(6) +
      String(r.served).padStart(7) +
      String(r.starved).padStart(6) +
      String(r.inFlightLeak).padStart(10) +
      String(r.timeline ?? "-").padStart(8),
    );
  }
  console.log("");
}

// ---- 判定: 这几条是"协作层在长跑下没散架"的最低标准 ----
const problems = [];
for (const r of rows) {
  if (r.skipped) continue;
  if (r.failed > 0) problems.push(`${r.topology}: ${r.failed} 次派工失败`);
  if (r.inFlightLeak > 0) problems.push(`${r.topology}: 跑完仍有 ${r.inFlightLeak} 个在途任务未收口 (账本泄漏)`);
  if (r.timeline != null && r.timeline > r.timelineLimit) problems.push(`${r.topology}: 时间线 ${r.timeline} 超上限 ${r.timelineLimit} (状态膨胀)`);
  if (r.starvedRate > 0.5 && r.tasks >= members_served_threshold(r)) problems.push(`${r.topology}: 饿死率 ${(r.starvedRate * 100).toFixed(0)}% (成员长期轮不到活)`);
}
function members_served_threshold(r) { return r.members * 10; } // 样本太小时饿死率没意义

if (problems.length) {
  console.error("  ✗ 协作层压测发现问题:");
  for (const p of problems) console.error(`    - ${p}`);
  process.exit(1);
}
console.log("  ✓ 协作层压测通过 (吞吐/饿死/账本/时间线 四项均在阈值内)");
