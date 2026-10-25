#!/usr/bin/env node
// scripts/memory-benchmark.js - 记忆检索基准 (三路对比: BM25 / dense embedding / LLM 查询扩展)
// 用法: node scripts/memory-benchmark.js [chat模型名]
//   - BM25:    纯离线, 恒可用 (零依赖)
//   - dense:   需 config.embedding 配置 (本地/云 embedding 端点), 走 dense + BM25 RRF 融合
//   - LLM扩展: 需本地 chat 模型 (默认 gemma), 走查询改写 + RRF
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { LLMClient } from "../src/llm/client.js";
import { cleanupTmp } from "./lib/tmp-agent.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHAT_MODEL = process.argv[2] || "gemma-4-e2b-uncensored-hauhaucs-aggressive-q8_k_p";

// 量化交易领域的事实集 (20 条, 模拟真实用户记忆)
const FACTS = [
  "止损规则是亏损5%就无条件清仓，连续亏损2次暂停交易",
  "不做科创板688和ST股票，只做主板加创业板",
  "当前持仓国际复材，发现创业板违规已经修复排除规则",
  "兄弟主要做A股量化交易，关注资金流驱动的短线策略",
  "华泰柏瑞杯模拟交易比赛第二轮，2026年7月21日开始",
  "仓位管理：单只股票不超过总仓位的20%",
  "喜欢用MACD金叉作为买入信号",
  "讨厌追高，只买回调到均线的股票",
  "每天收盘后复盘龙虎榜资金流向",
  "重仓了半导体板块，看好国产替代",
  "用同花顺看北向资金净流入",
  "设置止盈线是盈利8%就分批卖出",
  "偏好下午2点半尾盘操作",
  "关注的股票有宁德时代、比亚迪",
  "风险偏好偏激进，但拒绝杠杆",
  "喜欢研究财报里的毛利率和现金流",
  "交易频率平均每天2-3次",
  "看盘用东方财富，下单用华泰",
  "最近在研究打板策略",
  "仓位轻的时候喜欢做T降低持仓成本",
];

// 查询用例: [查询, 期望命中的唯一关键词]
// #2/#4/#10 是「纯语义改写」(与目标事实无任何字面/数字重合), 纯 BM25 必然 miss, 用来测语义召回
const CASES = [
  ["止损规则是什么", "止损"],
  ["哪些票不能碰", "ST"],
  ["仓位怎么控制", "仓位"],
  ["涨了什么时候走", "止盈"],
  ["止盈线是多少", "止盈"],
  ["买入用什么指标", "MACD"],
  ["关注哪些股票", "宁德时代"],
  ["每天交易几次", "2-3次"],
  ["用什么软件下单", "华泰"],
  ["赔了怎么办", "止损"],
];

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-membench-"));
  const agent = new PPXAgent({ root: ROOT, dataDir });

  for (const f of FACTS) agent.facts.add(f, { source: "benchmark" });

  // dense: 构造时从 config.embedding 自动注入 (无需额外代码)
  const hasDense = !!agent.facts.embedder;
  // LLM 扩展: 探测本地 chat 模型
  let llm = null, llmName = "离线";
  try {
    const p = new LLMClient({ id: "lmstudio", base_url: "http://127.0.0.1:1234/v1", api_key: "lm-studio", model: CHAT_MODEL, timeout_ms: 60000 });
    if (await p.health()) { llm = p; agent.llm = p; llmName = CHAT_MODEL; }
  } catch {}

  console.log(`→ 记忆检索基准 | 事实 ${FACTS.length} | 用例 ${CASES.length} | dense: ${hasDense ? "nomic-embed-text" : "未配置"} | LLM扩展: ${llmName}\n`);
  console.log("查询".padEnd(20) + "BM25".padEnd(8) + "dense".padEnd(14) + "LLM扩展");
  console.log("-".repeat(64));

  let bm25Hit = 0, denseHit = 0, llmHit = 0;
  const denseMsArr = [], llmMsArr = [];

  for (const [q, expect] of CASES) {
    const bm25 = agent.facts.query(q, { limit: 3 });
    const bm25Ok = bm25.some((f) => f.content.includes(expect));
    if (bm25Ok) bm25Hit++;

    let denseOk = false, denseMs = 0;
    if (hasDense) {
      const t = Date.now();
      const dense = await agent.facts.querySemantic(q, { limit: 3 });
      denseMs = Date.now() - t;
      denseOk = dense.some((f) => f.content.includes(expect));
      if (denseOk) denseHit++;
      denseMsArr.push(denseMs);
    }

    let llmOk = false, llmMs = 0;
    if (llm) {
      const t = Date.now();
      try {
        const variants = [q, ...(await agent._expandQuery(q))];
        const res = agent.facts.queryMulti(variants, { limit: 3 });
        llmOk = res.some((f) => f.content.includes(expect));
        llmMs = Date.now() - t;
      } catch { llmMs = Date.now() - t; }
      if (llmOk) llmHit++;
      llmMsArr.push(llmMs);
    }

    const m = (ok) => (ok ? "✓" : "✗");
    const denseCell = hasDense ? `${m(denseOk)} ${denseMs}ms` : "—";
    const llmCell = llm ? `${m(llmOk)} ${llmMs}ms` : "—";
    console.log(q.slice(0, 18).padEnd(20) + m(bm25Ok).padEnd(8) + denseCell.padEnd(14) + llmCell);
  }

  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
  console.log("\n=== 汇总 ===");
  console.log(`BM25:    ${bm25Hit}/${CASES.length} (${(bm25Hit / CASES.length * 100).toFixed(0)}%)`);
  if (hasDense) {
    console.log(`dense:   ${denseHit}/${CASES.length} (${(denseHit / CASES.length * 100).toFixed(0)}%)  | 平均 ${avg(denseMsArr)}ms`);
    const gain = denseHit - bm25Hit;
    console.log(`dense vs BM25: ${gain > 0 ? "+" + gain + " 语义召回" : gain < 0 ? gain + " (dense 更差, 检查 embedding 质量)" : "持平"}`);
  }
  if (llm) console.log(`LLM扩展: ${llmHit}/${CASES.length} (${(llmHit / CASES.length * 100).toFixed(0)}%)  | 平均 ${avg(llmMsArr)}ms`);

  agent.shutdown();
  cleanupTmp(dataDir); // 安全删除临时数据目录 (dataDir 在 os.tmpdir 内, 过安全护栏)
}

main().catch((e) => { console.error("✗ 失败:", e.message); process.exit(1); });
