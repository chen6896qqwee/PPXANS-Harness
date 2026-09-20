// src/ans/eviction.js - 排泄系 (⑤ 遗忘-归档) 自治治理 (ANS)
//
// 职责 (RC1 §1 ⑤): 记忆压缩、冷热层、历史会话归档、冗余识别、过期治理、遗忘与删除候选生成。
//   边界仅限跨会话长期记忆 (L1 FactStore + 会话日志); 功能性缓存/日志不归它管。
//
// 本期聚焦三大可落地的自治能力:
//   1. 冗余识别 - 利用 FactStore.findSimilar 检测高度重复记忆, 标记为"冗余候选"(合并/降权/删除候选)
//   2. 冷热分层 - 按 低访问天数×低衰减分 识别"冷记忆", 归档为只读, 不占热上下文
//   3. 归档扫描 - 产出结构化治理报告 (preview 不直接改), 挂 Scheduler 每日自动跑
//
// 删除策略 (务实): findSimilar 检测到的高相似对 → 保留高保真(importance/hits 更高)那条, 低的那条标"冗余候选"。
//   默认只"报告 + 标记", 硬删除交给 FactStore 既有 _prune (超 maxFacts 时)。本模块产出治理信号, 不越权改数据。
import { loadAgentState, saveAgentState } from "../utils/json-state.js";
import { charBigrams, setOverlap } from "../utils/similarity.js";
import { info } from "../utils/logger.js";

// 冗余判定阈值 (bigram overlap 相似度, 0~1; 中文同义变体通常 >0.6)
const SIM_THRESHOLD = 0.6;
// bigram overlap 收敛到 utils/similarity (原先此处自带一份 _bigramSet/_overlap 实现)
// 冷记忆判定: 连续 N 天未被访问 + 分数低于分位 → 冷
const COLD_DAYS = 14;
// 治理报告保留条数
const REPORT_LIMIT = 50;

// 治理状态读写 (实现收敛到 utils/json-state, 对外导出签名不变)
export function loadState(agent) {
  return loadAgentState(agent, "eviction");
}

export function saveState(agent, state) {
  return saveAgentState(agent, "eviction", state);
}

// 幂等记录一次扫描结果 (去重: 同 id 已存在则更新, 不无限追加)
function _recordRun(agent, run) {
  const st = loadState(agent);
  st.lastRun = run;
  saveState(agent, st);
}

// 扫描一次 L1 记忆: 返回 { redundant, cold, total, scanned } 治理报告 (只读, 不改数据)
export function scan(agent) {
  const facts = agent.facts;
  if (!facts || typeof facts.list !== "function" || !facts.findSimilar) {
    return { total: 0, redundant: [], cold: [], lastRunAt: Date.now() };
  }
  let all = [];
  try { all = facts.list() || []; } catch { return { total: 0, redundant: [], cold: [], error: "list-failed" }; }
  if (!all.length) return { total: 0, redundant: [], cold: [], lastRunAt: Date.now() };

  const now = Date.now();
  const DAY = 86400000;

  // 1) 冗余识别: 两两 findSimilar 检测高相似对, 标低保真那条为冗余候选
  // 2026-09-18 性能修复: 原实现每对都调 _overlap 重算两侧 bigram Set,
  //   maxFacts=1000 时最多 100 万次 Set 重建, 全程同步阻塞事件循环。
  //   现预建每条事实的 bigram Set (一次 O(n)), 两两比较只做交集计数。
  const redundant = [];
  const visited = new Set();
  const bigrams = new Map();
  for (const f of all) {
    try { bigrams.set(f.id, charBigrams(f.content)); } catch { bigrams.set(f.id, new Set()); }
  }
  // 两两比较 (自实现 overlap): findSimilar 对自身返回1.0无法用, 逐对算 bigram 相似度
  for (let i = 0; i < all.length; i++) {
    const f = all[i];
    if (visited.has(f.id)) continue;
    let best = null, bestSim = 0;
    const fa = bigrams.get(f.id);
    for (let j = 0; j < all.length; j++) {
      const g = all[j];
      if (g.id === f.id || visited.has(g.id)) continue;
      try {
        const sim = setOverlap(fa, bigrams.get(g.id));
        if (sim > bestSim) { bestSim = sim; best = g; }
      } catch {}
    }
    if (best && bestSim >= SIM_THRESHOLD) {
      const aKeep = (f.importance || 0) + (f.hits || 0);
      const bKeep = (best.importance || 0) + (best.hits || 0);
      const loser = aKeep >= bKeep ? best : f;
      const winner = aKeep >= bKeep ? f : best;
      redundant.push({
        id: loser.id,
        content: String(loser.content || "").slice(0, 120),
        keepId: winner.id,
        keep: String(winner.content || "").slice(0, 120),
        importance: loser.importance || 0,
        hits: loser.hits || 0,
        sim: Math.round(bestSim * 100) / 100,
      });
      visited.add(loser.id);
      visited.add(f.id);
    } else {
      visited.add(f.id);
    }
  }

  // 2) 冷热分层: N 天未访问 → 冷 (归档候选, 不参与热上下文)
  const cold = all
    .filter((f) => {
      const last = f.lastAccess ? new Date(f.lastAccess).getTime() : (f.created ? new Date(f.created).getTime() : now);
      return (now - last) > COLD_DAYS * DAY;
    })
    .map((f) => ({ id: f.id, content: String(f.content || "").slice(0, 120), lastAccess: f.lastAccess, importance: f.importance || 0, hits: f.hits || 0 }))
    .slice(0, REPORT_LIMIT);

  const run = {
    total: all.length,
    redundant: redundant.slice(0, REPORT_LIMIT),
    redundantCount: redundant.length,
    coldCount: cold.length,
    cold: cold.slice(0, REPORT_LIMIT),
    lastRunAt: Date.now(),
  };
  _recordRun(agent, run);
  info(`[eviction] 扫描 ${all.length} 条: 冗余 ${redundant.length}, 冷记忆 ${cold.length}`);
  return run;
}

// 人类可读状态 (可观测)
export function status(agent) {
  return loadState(agent);
}