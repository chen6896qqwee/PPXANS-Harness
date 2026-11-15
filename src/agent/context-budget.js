// src/agent/context-budget.js - 全局上下文配额 (架构优化 ④, 2026-11-13)
//
// 问题 (审计结论): 只有"历史"有 token 预算 (config.memory.history_token_budget, 自适应
//   window*0.3 clamp 2K~24K); tools schema / system prompt / 记忆注入 各自为政, 谁先写谁占。
//   结果是窗口被固定开销吃掉多少、什么时候会溢出, 只能等 400 报错才知道。
//
// 契约 (本文件): 一个纯函数把窗口切成配额, 溢出时按固定顺序让位, 顺序本身是设计决定:
//   tools schema > system prompt > 最近一轮历史 > 记忆召回 > 旧历史
//   越靠前越是"不给就没法工作"的部分; 记忆让位给历史, 是刻意的 (会话连贯 > 背景知识)。
//
// 约束: 零依赖、纯函数、可离线断言。不读 config、不碰 IO —— 预算口径与具体来源解耦。
export const DEFAULT_CONTEXT_WINDOW = 32000;

// 比例口径 (和为 1.0): 输出预留固定 20%, 其余按证据价值分配。
export const DEFAULT_ALLOC = {
  output: 0.2,
  tools: 0.16,
  system: 0.1,
  history: 0.3,
  memory: 0.08,
  slack: 0.16,
};

// 粗略 token 估计: 中文约 1 token/1.5 字, 英文约 1 token/4 字符; 混排取 2.8 字符/token。
//   与实际分词器有偏差, 但预算本来就要留 slack —— 宁可早让位, 不要等 400。
export function estimateTokens(text) {
  const s = String(text ?? "");
  if (!s) return 0;
  return Math.ceil(s.length / 2.8);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 核心规划器。
//   window   上下文窗口 (token)
//   fixed    已确定的固定开销 {tools, system} (token), 缺省 0
//   need     期望的历史/记忆需求 (token), 缺省 = 配额值
// 返回 { window, sections, actions[], overflow }
//   sections: 最终分配的 token; actions: 发生了哪些让位 (人话, 可直接进面板)
export function planContextBudget({
  window = DEFAULT_CONTEXT_WINDOW,
  fixed = {},
  alloc = DEFAULT_ALLOC,
  minHistory = 2000,
  maxHistory = 24000,
  minMemory = 300,
} = {}) {
  const win = Math.max(1000, Math.floor(Number(window) || DEFAULT_CONTEXT_WINDOW));
  const out = Math.floor(win * (alloc.output ?? DEFAULT_ALLOC.output));
  const avail = Math.max(0, win - out);
  const sections = {
    tools: Math.floor(avail * (alloc.tools ?? DEFAULT_ALLOC.tools)),
    system: Math.floor(avail * (alloc.system ?? DEFAULT_ALLOC.system)),
    history: Math.floor(avail * (alloc.history ?? DEFAULT_ALLOC.history)),
    memory: Math.floor(avail * (alloc.memory ?? DEFAULT_ALLOC.memory)),
  };
  const actions = [];

  // 1) 固定开销超配额: 先从 memory 借, 再压 history 到下限, 最后才动 system 配额
  //    (tools 不动 —— schema 不完整会直接导致调用失败, 比"记得少"更致命)
  let over = (Number(fixed.tools) || 0) - sections.tools;
  if (over > 0) {
    actions.push({ section: "tools", action: "exceeded", detail: `tools schema 超出配额 ${over} token, 从记忆/历史让位` });
    const take = Math.min(over, Math.max(0, sections.memory - minMemory));
    sections.memory -= take; over -= take;
    if (over > 0) {
      const take2 = Math.min(over, Math.max(0, sections.history - minHistory));
      sections.history -= take2; over -= take2;
      if (take2 > 0) actions.push({ section: "history", action: "shrunk", detail: `为 tools schema 让出 ${take2} token` });
    }
  }
  over = (Number(fixed.system) || 0) - sections.system;
  if (over > 0) {
    actions.push({ section: "system", action: "exceeded", detail: `system prompt 超出配额 ${over} token, 从记忆让位` });
    const take = Math.min(over, Math.max(0, sections.memory - minMemory));
    sections.memory -= take; over -= take;
  }

  // 2) 历史/记忆都不得超过各自上限 (小窗口下 0.3 也可能过大; 大窗口下别无限膨胀)
  sections.history = clamp(sections.history, Math.min(minHistory, avail), maxHistory);
  sections.memory = Math.max(0, Math.min(sections.memory, avail - sections.history));

  const used = (Number(fixed.tools) || 0) + (Number(fixed.system) || 0) + sections.history + sections.memory;
  const overflow = Math.max(0, used + out - win);
  if (overflow > 0) actions.push({ section: "window", action: "overflow", detail: `总占用超出窗口 ${overflow} token, 必须裁剪历史或记忆` });

  const unallocated = Math.max(0, win - out - sections.tools - sections.system - sections.history - sections.memory);
  return {
    window: win,
    sections: { ...sections, output: out, fixedTools: Number(fixed.tools) || 0, fixedSystem: Number(fixed.system) || 0 },
    used,
    unallocated, // 有意留白的部分 (slack): 分词器误差/工具返回体波动的缓冲
    overflow,
    actions,
  };
}

// 给面板/日志的单行摘要 (人话, 不暴露内部字段名)
export function summarizeBudget(plan) {
  if (!plan) return "";
  const s = plan.sections || {};
  const parts = [
    `窗口 ${plan.window}`,
    `历史 ${s.history}`,
    `记忆 ${s.memory}`,
    `工具 ${s.fixedTools || s.tools}`,
    `输出预留 ${s.output}`,
  ];
  const tail = plan.overflow > 0 ? ` · 超出 ${plan.overflow}, 需裁剪` : " · 未超窗";
  return parts.join(" / ") + tail;
}
