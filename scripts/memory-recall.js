#!/usr/bin/env node
// scripts/memory-recall.js — 记忆检索质量探针 (2026-10-30, P2 / 第二轮: 加留出集)
//
// 问题: memory_search 走 dense+BM25 双路 RRF, dense 那一侧默认是**内置 256 维字符 n-gram
//   哈希向量**。这套"语义检索"的实际能力从来没被量过 —— 没人算过召回率。
//
// ⚠ 为什么必须有 holdout 集:
//   如果只有一个查询集, "调参直到分数变好"就等于对着考卷改答案 —— 尤其本项目的优化手段是
//   手工概念词典, 过拟合风险极高。所以:
//     dev     = 15 个查询, **允许**用来设计词典/调权重
//     holdout = 15 个查询, **只看不调** —— 它给出的数才是"泛化能力"
//   报告里 dev 涨而 holdout 不涨 = 过拟合, 必须重做, 不算优化成功。
//
// 做法: 固定 40 条记忆 (跨主题, 互相干扰) + dev/holdout 各 15 个查询,
//   算 recall@1 / recall@K / MRR。全部离线确定性, 不需要 LLM, 几秒钟跑完。
//
// 用法:
//   node scripts/memory-recall.js              # 人读 (dev + holdout)
//   node scripts/memory-recall.js --set dev    # 只看 dev
//   node scripts/memory-recall.js --json       # 机读 (面板/CI)
//   node scripts/memory-recall.js --top 5      # 改 top-K
//   node scripts/memory-recall.js --check      # 闸门: holdout recall@3 低于门槛即非零退出
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { appendHistory } from "./lib/bench-history.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const JSON_OUT = process.argv.includes("--json");
const topIdx = process.argv.indexOf("--top");
const TOP_K = topIdx >= 0 ? Math.max(1, Number(process.argv[topIdx + 1]) || 3) : 3;
const setIdx = process.argv.indexOf("--set");
const SET = setIdx >= 0 ? String(process.argv[setIdx + 1] || "all") : "all";
// --check: 闸门模式。门槛按"当前水位的下限"设, 不按"理想值"设 —— 它的职责是
//   拦住回退 (比如有人调了 RRF 权重/改了分词把召回打回去), 不是逼着往上加。
//   2026-10-30 建立时实测 holdout recall@3 = 100%, 门槛设 90%: 掉 1 条查询不报警,
//   掉 2 条以上报警 —— 单条波动属于语料边界, 系统性退化必须拦。
const CHECK = process.argv.includes("--check");
const MIN_ACCEPTANCE = 0.9;

// ---- 固定语料: 40 条有真实感的记忆 (跨主题, 长度不一, 有近义表述可互相干扰) ----
// 前 20 条是 dev 集的目标, 后 20 条既作干扰项也作 holdout 的目标。
const CORPUS = [
  "我习惯用 Node 22 跑测试",
  "项目根目录在 D:/projects/PPXANS-Harness",
  "发布前必须跑全量测试与自愈基准",
  "用户偏好结论先行, 不要寒暄",
  "会话日志是唯一事实源, 记忆只是派生物",
  "记忆库容量上限是一千条",
  "审计链用 SHA-256 链式哈希, 篡改可定位到行",
  "命令守卫有三层防线, 命令替换会被硬拦",
  "并发上不去, 是因为同步文件锁占住了事件循环",
  "工具 schema 占了固定开销的八成七",
  "用户用 Windows 11 加 Git Bash",
  "禁止自动 git commit",
  "技能库目前有六十七个技能",
  "离线基准的二十个任务全部通过",
  "探索熔断的阈值从三轮放宽到五轮",
  "归档合批每批最多五条",
  "记忆衰减率是每天百分之二",
  "大模型走 OpenAI 兼容端点",
  "飞书通道已连接可用",
  "微信通道还没有连接",
  "每天凌晨三点做一次自愈检查",
  "报价单模板在财务部的共享盘里",
  "上次部署失败是因为端口被占用",
  "团队周会在周四下午",
  "图片生成默认用 1024 尺寸",
  "客户投诉要当天回复",
  "数据库连接池大小设成二十",
  "日志保留三十天",
  "备用域名是 ppx.example.com",
  "这台机器是十六核三十二线程",
  "代码风格统一用两个空格缩进",
  "生产环境禁止直接改配置",
  "测试覆盖率要求不低于八成",
  "手机号验证走短信网关",
  "视频素材放在外置硬盘",
  "汇报材料要中英双语",
  "密钥统一存在环境变量里",
  "回滚窗口只有十分钟",
  "新同事入职先看架构文档",
  "训练数据每周更新一次",
];

// ---- dev: 15 个查询, 字面重合度刻意不一致 (有高有低), 用于设计优化手段 ----
const DEV_QUERIES = [
  { q: "Node 版本", expect: 0, note: "字面重合" },
  { q: "代码放在哪个目录", expect: 1, note: "近义 (根目录/放在哪)" },
  { q: "上线之前要做什么检查", expect: 2, note: "近义 (发布/上线)" },
  { q: "他喜欢我怎么说话", expect: 3, note: "抽象 (偏好/风格)" },
  { q: "什么才是可信的来源", expect: 4, note: "抽象 (事实源)" },
  { q: "能存多少条记忆", expect: 5, note: "近义 (容量/存多少)" },
  { q: "怎么防止日志被改", expect: 6, note: "抽象 (防篡改)" },
  { q: "危险命令怎么拦", expect: 7, note: "字面重合 (命令/拦)" },
  { q: "为什么快不起来", expect: 8, note: "抽象 (并发/快)" },
  { q: "token 花在哪了", expect: 9, note: "抽象 (开销/token)" },
  { q: "什么操作系统", expect: 10, note: "近义 (系统/OS)" },
  { q: "能不能自己提交代码", expect: 11, note: "抽象 (提交/commit)" },
  { q: "有多少技能", expect: 12, note: "字面重合" },
  { q: "基准测试结果", expect: 13, note: "字面重合 (基准)" },
  { q: "连续几轮只读会被叫停", expect: 14, note: "抽象 (熔断/叫停)" },
];

// ---- holdout: 15 个查询, **只用于验收, 不参与任何调优** ----
// 措辞刻意与 dev 不同 (口语化/换谓语), 避免"记住 dev 的句式"混过去。
const HOLDOUT_QUERIES = [
  { q: "半夜会自己检查吗", expect: 20, note: "抽象 (凌晨/自愈)" },
  { q: "价格单放哪了", expect: 21, note: "近义 (报价单/价格)" },
  { q: "端口冲突", expect: 22, note: "字面重合" },
  { q: "什么时候开会", expect: 23, note: "近义 (周会)" },
  { q: "出图尺寸多大", expect: 24, note: "近义 (图片尺寸)" },
  { q: "客人不满怎么处理", expect: 25, note: "抽象 (投诉/不满)" },
  { q: "连接数最多几个", expect: 26, note: "近义 (连接池/连接数)" },
  { q: "日志留多久", expect: 27, note: "近义 (保留/留)" },
  { q: "备用地址", expect: 28, note: "近义 (备用域名/地址)" },
  { q: "这台机器多少核", expect: 29, note: "字面重合 (核)" },
  { q: "缩进用几个空格", expect: 30, note: "字面重合" },
  { q: "线上能改配置吗", expect: 31, note: "抽象 (生产环境/线上)" },
  { q: "覆盖率要求", expect: 32, note: "字面重合" },
  { q: "怎么发验证码", expect: 33, note: "近义 (手机号验证/验证码)" },
  { q: "密钥放哪", expect: 36, note: "字面重合 (密钥)" },
];

function pickQueries() {
  if (SET === "dev") return [{ set: "dev", items: DEV_QUERIES }];
  if (SET === "holdout") return [{ set: "holdout", items: HOLDOUT_QUERIES }];
  return [{ set: "dev", items: DEV_QUERIES }, { set: "holdout", items: HOLDOUT_QUERIES }];
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-recall-"));
let rows = [];
let sets = [];
let summary;
try {
  // 必须走真实装配: plugin/builtin.js 会在没有 config.embedding 时注入内置哈希 embedder,
  //   于是 memory_search 走 dense + BM25 的 RRF 融合。直接 new FactStore 测的只是纯 BM25 ——
  //   那是**另一个口径**, 拿它下结论等于自欺 (第一版就是这么错的, recall@1 33%)。
  const agent = new PPXAgent({ root: dir, configFile: null, dataDir: path.join(dir, ".ppx"), globalDataDir: path.join(dir, ".ppx-global") });
  const store = agent.facts;
  const embedderOn = typeof store.embedder === "function";
  const ids = [];
  for (const text of CORPUS) {
    const f = store.add(text, { source: "conversation" });
    ids.push(f ? f.id : null);
  }

  for (const group of pickQueries()) {
    const gRows = [];
    for (const { q, expect, note } of group.items) {
      const hits = (await store.querySemantic(q, { limit: Math.max(TOP_K, 5) })) || [];
      const rank = hits.findIndex((h) => h.id === ids[expect]);
      const row = {
        set: group.set,
        query: q,
        expect: CORPUS[expect],
        note,
        rank: rank < 0 ? null : rank + 1, // 1-based, null = 没进候选
        top: hits.slice(0, 3).map((h) => String(h.content).slice(0, 24)),
      };
      gRows.push(row);
      rows.push(row);
    }
    const n = gRows.length;
    const at1 = gRows.filter((r) => r.rank === 1).length;
    const atK = gRows.filter((r) => r.rank != null && r.rank <= TOP_K).length;
    const mrr = gRows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n;
    sets.push({
      set: group.set,
      queries: n,
      recall1: Math.round((at1 / n) * 1000) / 1000,
      recallK: Math.round((atK / n) * 1000) / 1000,
      mrr: Math.round(mrr * 1000) / 1000,
    });
  }

  const n = rows.length;
  const at1 = rows.filter((r) => r.rank === 1).length;
  const atK = rows.filter((r) => r.rank != null && r.rank <= TOP_K).length;
  const mrr = rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n;
  const hold = sets.find((s) => s.set === "holdout");
  summary = {
    embedder: embedderOn ? "hash(256d)" : "off (纯 BM25)",
    corpus: CORPUS.length,
    queries: n,
    topK: TOP_K,
    recall1: Math.round((at1 / n) * 1000) / 1000,
    recallK: Math.round((atK / n) * 1000) / 1000,
    mrr: Math.round(mrr * 1000) / 1000,
    // 验收指标: 有 holdout 就认 holdout, 没有就用总体 (身体面板读这个字段)
    acceptance: hold ? hold.recallK : Math.round((atK / n) * 1000) / 1000,
    sets,
  };
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ kind: "memory-recall", ts: new Date().toISOString(), node: process.version, ...summary, rows }, null, 2));
} else if (CHECK) {
  const ok = summary.acceptance >= MIN_ACCEPTANCE;
  console.log(`记忆召回闸门: holdout recall@${TOP_K} = ${(summary.acceptance * 100).toFixed(0)}% (门槛 ${(MIN_ACCEPTANCE * 100).toFixed(0)}%) ${ok ? "✓" : "✗"}`);
  if (!ok) {
    for (const r of rows) {
      if (r.rank && r.rank <= TOP_K) continue;
      console.log(`  退化的查询: ${r.query} → 期望「${r.expect}」, 实返 ${r.top.join(" | ") || "(空)"}`);
    }
  }
} else {
  console.log(`记忆检索质量探针 | ${summary.corpus} 条语料 | ${summary.queries} 个查询 | dense=${summary.embedder} + BM25 RRF | 离线\n`);
  for (const g of sets) {
    console.log(`── ${g.set} (${g.queries} 查询) ──`);
    for (const r of rows.filter((x) => x.set === g.set)) {
      const mark = r.rank === 1 ? "✓" : r.rank && r.rank <= TOP_K ? "~" : "✗";
      const pos = r.rank ? `第 ${r.rank} 位` : "未命中";
      console.log(`  ${mark} ${r.query.padEnd(20)} ${pos.padEnd(8)} [${r.note}]`);
      if (r.rank !== 1) {
        console.log(`      期望: ${r.expect}`);
        console.log(`      实返: ${r.top.join(" | ") || "(空)"}`);
      }
    }
    console.log(`  → recall@1 ${(g.recall1 * 100).toFixed(0)}% | recall@${TOP_K} ${(g.recallK * 100).toFixed(0)}% | MRR ${g.mrr}\n`);
  }
  console.log(`=== 总体 recall@1 ${(summary.recall1 * 100).toFixed(0)}% | recall@${TOP_K} ${(summary.recallK * 100).toFixed(0)}% | MRR ${summary.mrr} ===`);
  const hold = sets.find((s) => s.set === "holdout");
  if (hold) {
    console.log(`=== 验收口径 (holdout) recall@${TOP_K} ${(hold.recallK * 100).toFixed(0)}% —— 优化只认这个数 ===`);
  }
  if (summary.acceptance < 0.8) {
    console.log("\nrecall 偏低: 记忆检索是全仓唯一没有质量指标的部分, 这个数就是它现在的真实水平。");
    console.log("定位方向: 内置哈希向量 (256 维字符 n-gram) 语义能力弱 → 概念扩展 / IDF 加权 / 配 config.embedding。");
  }
}

try {
  const outDir = path.join(ROOT, "data", "bench");
  fs.mkdirSync(outDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(outDir, `memory-recall-${day}.json`), JSON.stringify({ ts: new Date().toISOString(), ...summary, rows }, null, 2));
  // 追加趋势: 存 acceptance (验收口径 = holdout) 而不是混合的 recallK, 面板才不会把
  //   "dev 难例拉低的总分"和"泛化能力"混成一条线。
  appendHistory(outDir, "memory-recall", {
    recall1: summary.recall1, recallK: summary.recallK, acceptance: summary.acceptance,
  });
} catch { /* 存档失败不影响探针 */ }

process.exit(CHECK && summary.acceptance < MIN_ACCEPTANCE ? 1 : 0);
