#!/usr/bin/env node
// scripts/bench.js - 性能压测 (皮皮虾内核开销, 用 stub LLM 隔离网络)
// 直接调 agent.chat (绕过 HTTP 通道的限流保护, 那是安全特性不是压测目标)
// 覆盖: (1) 同会话并发 (2) 长会话稳定性 (同一 session 连打 N 轮) (3) 隔离会话并发 ← 2026-10-30 补
// 输出: p50/p95/p99 延迟 + 失败数 + 长会话每轮耗时 + **并发度 slowdown**
//
// 为什么要有 (3) (2026-10-30): (1) 和 (2) 都跑在 default 会话上, 量到的其实是
//   PPXAgent._withSessionLock 的**排队** —— 那是设计(防历史交错/记忆双写), 不是能力上限。
//   真正的问题是: 不同会话之间能不能并行? 内核热路径几乎全是 fs.*Sync, 它们会占住单线程
//   事件循环, 于是 N 个独立会话的请求彼此阻塞。用 (3) 量: 50 个请求分 20 个会话并发跑,
//   与"同样 50 个请求串行跑"比总耗时, 得到 slowdown (1.0 = 完全串行, 越接近 1/N 越好)。
//
// 用法:
//   node scripts/bench.js
//   PPX_BENCH_CONCURRENCY=50 PPX_BENCH_ROUNDS=500 node scripts/bench.js
import { makeTmpAgent, cleanupTmp } from "./lib/tmp-agent.js";

const CONCURRENCY = Number(process.env.PPX_BENCH_CONCURRENCY || 20);
const ROUNDS = Number(process.env.PPX_BENCH_ROUNDS || 200);
// 隔离会话并发压测的规模 (默认 20 会话 × 3 轮 = 60 请求, 约几秒)
const ISO_SESSIONS = Number(process.env.PPX_BENCH_ISO_SESSIONS || 20);
const ISO_ROUNDS = Number(process.env.PPX_BENCH_ISO_ROUNDS || 3);

// stub LLM: 不产生真实网络调用, 压的是皮皮虾自身 (agent/记忆/会话) 开销
function stubLLM() {
  return {
    chat: async () => ({ content: "[stub] 收到。" }),
    streamChat: async (_m, { onDelta } = {}) => { onDelta?.("[stub] 收到。"); return "[stub] 收到。"; },
    apiChat: async () => ({ message: { role: "assistant", content: "[stub] 收到。", tool_calls: null } }),
  };
}

(async () => {
  // 统一数据隔离 helper: 临时根 + 显式 dataDir 覆盖 PPX_DATA_DIR / 清理必经安全护栏 (杜绝误删生产)
  const { root, agent } = makeTmpAgent("bench");
  agent.llm = stubLLM();

  console.log(`皮皮虾内核压测 | 并发 ${CONCURRENCY} | 轮次 ${ROUNDS} | stub LLM\n`);

  // (1) 并发压测
  console.log("── (1) 并发调用压测 ──");
  const lat = [];
  let fails = 0;
  const per = Math.ceil(ROUNDS / CONCURRENCY);
  await Promise.all(Array.from({ length: CONCURRENCY }, async (_, i) => {
    for (let r = 0; r < per; r++) {
      const t0 = Date.now();
      try {
        const reply = await agent.chat(`并发#${i} 消息${r}`);
        if (!reply) fails++;
      } catch { fails++; }
      lat.push(Date.now() - t0);
    }
  }));
  lat.sort((a, b) => a - b);
  const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))];
  console.log(`  调用 ${lat.length} | 失败 ${fails} | p50 ${pct(0.5)}ms | p95 ${pct(0.95)}ms | p99 ${pct(0.99)}ms | 最慢 ${lat[lat.length - 1]}ms`);

  // (2) 长会话稳定性
  console.log(`\n── (2) 长会话 ${ROUNDS} 轮 (同一 session) ──`);
  let ok = 0;
  const t0 = Date.now();
  for (let i = 0; i < ROUNDS; i++) {
    try { if (await agent.chat(`长会话第${i}轮`)) ok++; } catch {}
  }
  const ms = Date.now() - t0;
  const sessions = agent.sessionStore.list();
  console.log(`  ${ROUNDS} 轮成功 ${ok} | 耗时 ${(ms / 1000).toFixed(1)}s | ${(ms / ROUNDS).toFixed(1)}ms/轮 | 会话事件 ${sessions.reduce((a, s) => a + (s.count || 0), 0)} 条`);

  // (3) 隔离会话并发: 不同 sessionKey 之间到底能不能并行
  console.log(`\n── (3) 隔离会话并发 (${ISO_SESSIONS} 会话 × ${ISO_ROUNDS} 轮 = ${ISO_SESSIONS * ISO_ROUNDS} 请求) ──`);
  const isoLat = [];
  let isoFails = 0;
  const tc0 = Date.now();
  await Promise.all(Array.from({ length: ISO_SESSIONS }, async (_, i) => {
    for (let r = 0; r < ISO_ROUNDS; r++) {
      const s = Date.now();
      try {
        if (!(await agent.chat(`隔离#${i} 第${r}轮`, { sessionKey: `iso-${i}` }))) isoFails++;
      } catch { isoFails++; }
      isoLat.push(Date.now() - s);
    }
  }));
  const concurrentMs = Date.now() - tc0;
  isoLat.sort((a, b) => a - b);
  const isoTotals = ISO_SESSIONS * ISO_ROUNDS;
  const ts0 = Date.now();
  for (let i = 0; i < isoTotals; i++) {
    try { await agent.chat(`串行#${i}`, { sessionKey: "seq-one" }); } catch { /* 失败已在上段计入 */ }
  }
  const serialMs = Date.now() - ts0;
  const slowdown = serialMs > 0 ? (concurrentMs / serialMs) : 0;
  const ideal = serialMs / CONCURRENCY; // 若真正 N 路并行, 总耗时应接近串行总耗时 / 并发数
  console.log(`  并发 ${concurrentMs}ms (p50 ${isoLat[Math.floor(isoLat.length * 0.5)]}ms) | 串行 ${serialMs}ms (${(serialMs / isoTotals).toFixed(1)}ms/请求)`);
  console.log(`  并发度 slowdown = ${slowdown.toFixed(2)}  (1.00 = 完全串行; 越接近 ${(1 / ISO_SESSIONS).toFixed(2)} 越好; 失败 ${isoFails})`);
  if (slowdown > 0.9) {
    console.log(`  ⚠ 不同会话之间没有有效并行 —— 内核热路径的同步 fs I/O 占住了事件循环 (详见 docs/OPTIMIZATION-2026-10-30.md §11)`);
  }

  cleanupTmp({ root, agent });
  console.log("\n=== bench 完成 (失败数 >0 时退出码 1) ===");
  process.exit(fails || isoFails ? 1 : 0);
})().catch((e) => { console.error("✗ bench 失败:", e.message); process.exit(1); });

