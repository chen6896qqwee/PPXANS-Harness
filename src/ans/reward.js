// src/ans/reward.js - Reward 反馈闭环 (ANS, ⑦内分泌系)
// 把 refine 的"隐式离散反馈"显式化 + 自动化:
//   - 订阅总线 tool/result 事件, 每笔工具成败自动采集 (无需主动触发)
//   - 按工具名维护 EWMA 指数平滑倾向权重 (最近成败 > 历史, 有韧性不跳变)
//   - 低可靠性工具 (样本足够且权重 < 阈值) 识别为"不可靠", 注入 system prompt 提示谨慎
//   - 驱动 lifecycle 进化 (失败达阈值触发 evolve 计数)
//   - 持久化 data/memory/reward.json, 跨进程/重启不归零
//
// 与 refine 的关系: refine 是"失败→经验库"(事后的深度提炼), reward 是"成败→行为倾向"(实时的行为调节)。
// 两者互补: reward 管"下次倾向怎么做", refine 管"为什么失败下次怎么做更好"。
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../utils/store.js";
import { info } from "../utils/logger.js";

// EWMA 平滑系数 α: 越大越偏重最近结果 (α=0.25 对偶发抖动有韧性, 又能反映近期趋势)
const ALPHA = 0.25;
// 判定"不可靠"的最小样本数 (样本太少不判, 防偶发一次失败误伤)
const MIN_SAMPLES = 5;
// 不可靠权重阈值 (权重 < 此值 → 标记低可靠)
const LOW_WEIGHT = 0.45;
// 持久化文件
function _file(agent) { return path.join(agent.dataDir, "memory", "reward.json"); }

const STATE = { ALPHA, MIN_SAMPLES, LOW_WEIGHT };

// 读取状态 (缺失/损坏 → 空)
export function loadState(agent) {
  try {
    const f = _file(agent);
    if (fs.existsSync(f)) {
      const s = JSON.parse(fs.readFileSync(f, "utf8"));
      return (s && typeof s === "object") ? s : {};
    }
  } catch {}
  return {};
}

export function saveState(agent, state) {
  try {
    const f = _file(agent);
    ensureDir(path.dirname(f));
    fs.writeFileSync(f, JSON.stringify(state, null, 2), "utf8");
  } catch {}
}

// 记一笔工具成败 (总线 tool/result 驱动)。ok: boolean (工具调用成功与否)
// state 结构:
//   { tools: { [name]: { weight, samples, wins, losses, lastTs, lastOk } }, total: { turns, wins, losses } }
export function record(agent, { tool, ok }) {
  let state = loadState(agent);
  state.tools = state.tools || {};
  state.total = state.total || { turns: 0, wins: 0, losses: 0 };

  const t = state.tools[tool] || { weight: 0.5, samples: 0, wins: 0, losses: 0, lastTs: 0, lastOk: null };
  t.lastTs = Date.now();
  t.lastOk = ok;
  t.samples += 1;
  if (ok) t.wins += 1; else t.losses += 1;
  // EWMA 更新: 权重向 (ok?1:0) 移动 α 步
  t.weight = (1 - ALPHA) * t.weight + ALPHA * (ok ? 1 : 0);
  // 四舍五入防浮点噪音膨胀
  t.weight = Math.round(t.weight * 1000) / 1000;
  state.tools[tool] = t;

  state.total.turns += 1;
  if (ok) state.total.wins += 1; else state.total.losses += 1;

  saveState(agent, state);

  // 触发 lifecycle 进化: 汇总"任一工具样本够且权重过低" → 视为行为失调, 记为进化信号
  const { unreliable } = summarize(agent);
  if (unreliable.some((u) => u.name === tool) && t.samples >= MIN_SAMPLES) {
    if (agent.lifecycle) agent.lifecycle.evolve();
  }
  return t;
}

// 汇总当前倾向: 各工具 weight + 不可靠清单
// 返回 { tools: [{name, weight, samples, wins, losses}], unreliable: [{name, weight, samples}] }
export function summarize(agent) {
  let state = loadState(agent);
  const tools = Object.entries(state.tools || {}).map(([name, t]) => ({
    name, weight: t.weight, samples: t.samples, wins: t.wins, losses: t.losses,
  })).sort((a, b) => a.weight - b.weight);
  const unreliable = tools.filter((t) => t.samples >= MIN_SAMPLES && t.weight < LOW_WEIGHT);
  return { tools, unreliable };
}

// 注入 context: 低可靠性工具提示文本 (供 agent 拼进 system prompt)
// 有不可靠工具才产出, 无则返回 "" (零回归)
export function context(agent) {
  const { unreliable } = summarize(agent);
  if (!unreliable.length) return "";
  const list = unreliable.map((t) => `- ${t.name} (成功率 ${Math.round(t.weight * 100)}%, 样本 ${t.samples} 次)`).join("\n");
  return "【⚠ 低可靠性工具·谨慎使用】以下工具近期失败率偏高, 除非必要否则优先用替代方案或先确认参数:\n" + list;
}

// 人类可读状态 (可观测)
export function status(agent) {
  const { tools, unreliable } = summarize(agent);
  const st = loadState(agent).total || {};
  return {
    unreliable_count: unreliable.length,
    unreliable: unreliable,
    tool_count: tools.length,
    top_tools: tools.slice(-8).reverse(), // 权重最高的几个
    total: st,
  };
}

export { STATE };