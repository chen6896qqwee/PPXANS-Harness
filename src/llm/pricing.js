// src/llm/pricing.js - 模型价格表 + 成本折算 (增强框架第 8 条: "预算控制"的最后一环)
// 背景: usageStats 已聚合 token 数 (calls/tokens/byModel), 但没有金额折算与支出上限 —— 
//       token 数不等于成本, 不同模型价差 100 倍, "预算控制"必须落在金额上。
// 设计:
//   - 内置常用模型价格表 (USD / 1M tokens, prompt + completion), 前缀匹配取最长者
//   - 云厂商价格随时变动: 内置表只是"开箱即用的估算快照", 精确控费用 config.budget.model_prices 覆盖
//   - 未知模型 / 缺失 usage → 返回 null, 不把未知伪装为免费; 精确预算需显式配置价格
//   - 只有 total_tokens 无拆分时, 全部按 completion 价计 (预算取保守侧, 宁高估不高估)
// 零依赖, 纯函数, 可独立测试。

// USD per 1M tokens。数字为各厂商公开目录价的历史快照 (2026-10), 仅供预算估算。
// 匹配规则: model 小写后按前缀匹配, 取最长命中 (如 glm-4-flash 命中 flash 行而非 glm-4 行)。
const PRICES = [
  // 智谱
  { prefix: "glm-4-flash", prompt: 0, completion: 0 },      // 免费档
  { prefix: "glm-4.5", prompt: 0.6, completion: 2.2 },
  { prefix: "glm-4.6", prompt: 0.6, completion: 2.2 },
  { prefix: "glm-4", prompt: 0.5, completion: 1.5 },
  // DeepSeek
  { prefix: "deepseek-chat", prompt: 0.27, completion: 1.1 },
  { prefix: "deepseek-reasoner", prompt: 0.55, completion: 2.19 },
  // OpenAI
  { prefix: "gpt-4o-mini", prompt: 0.15, completion: 0.6 },
  { prefix: "gpt-4o", prompt: 2.5, completion: 10 },
  { prefix: "gpt-4.1-mini", prompt: 0.4, completion: 1.6 },
  { prefix: "gpt-4.1", prompt: 2, completion: 8 },
  // Anthropic (前缀族: 3.x 与 4.x 同档从宽)
  { prefix: "claude-opus", prompt: 15, completion: 75 },
  { prefix: "claude-sonnet", prompt: 3, completion: 15 },
  { prefix: "claude-haiku", prompt: 1, completion: 5 },
  // Gemini
  { prefix: "gemini-2.5-pro", prompt: 1.25, completion: 10 },
  { prefix: "gemini-2.5-flash", prompt: 0.3, completion: 2.5 },
  // 阿里 / 月之暗面
  { prefix: "qwen-flash", prompt: 0.05, completion: 0.4 },
  { prefix: "qwen-plus", prompt: 0.4, completion: 1.2 },
  { prefix: "qwen-max", prompt: 1.6, completion: 6.4 },
  { prefix: "kimi-k2", prompt: 0.6, completion: 2.5 },
];

// 规范化一条价格: {prompt, completion} 均为非负有限数字, 否则视为无效 (返回 null)
function normPrice(v) {
  if (!v || typeof v !== "object") return null;
  const p = Number(v.prompt), c = Number(v.completion);
  if (!Number.isFinite(p) || !Number.isFinite(c) || p < 0 || c < 0) return null;
  return { prompt: p, completion: c };
}

// 解析某模型的价格。overrides: config.budget?.model_prices, 形如
//   { "glm-4-flash": { prompt: 0, completion: 0 }, "my-private-model": { prompt: 1, completion: 3 } }
// 优先级: overrides 精确命中 > overrides 前缀命中(最长) > 内置表前缀命中(最长) > null
export function resolvePrice(model, overrides) {
  const m = String(model || "").toLowerCase().trim();
  if (!m) return null;
  if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
    // 精确命中最优先
    const exact = normPrice(overrides[m]) || normPrice(overrides[String(model || "").trim()]);
    if (exact) return exact;
    // 前缀命中取最长
    let best = null, bestLen = -1;
    for (const k of Object.keys(overrides)) {
      const kk = String(k).toLowerCase();
      if (kk && m.startsWith(kk) && kk.length > bestLen) {
        const v = normPrice(overrides[k]);
        if (v) { best = v; bestLen = kk.length; }
      }
    }
    if (best) return best;
  }
  let hit = null, hitLen = -1;
  for (const e of PRICES) {
    if (m.startsWith(e.prefix) && e.prefix.length > hitLen) { hit = e; hitLen = e.prefix.length; }
  }
  return hit ? { prompt: hit.prompt, completion: hit.completion } : null;
}

// 折算一笔 usage 的成本 (USD)。usage: { prompt_tokens, completion_tokens } 或仅 { total_tokens }。
// 缺失/非法 usage 或价格 → null; 已知免费模型且有合法 usage → 0。
export function usageTokens(usage) {
  const valid = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!usage || typeof usage !== "object") return null;
  if (valid(usage.total_tokens)) return usage.total_tokens;
  if (valid(usage.prompt_tokens) && valid(usage.completion_tokens)) return usage.prompt_tokens + usage.completion_tokens;
  return null;
}

export function estimateCost(model, usage, overrides) {
  const p = resolvePrice(model, overrides);
  if (!p || usageTokens(usage) === null) return null;
  const pt = usage?.prompt_tokens, ct = usage?.completion_tokens;
  let prompt, completion;
  if (pt == null || ct == null) {
    // 只有总量 (部分本地推理后端不拆分): 全按 completion 价计 —— 预算保守侧
    prompt = 0;
    completion = usageTokens(usage);
  } else {
    if (typeof pt !== "number" || typeof ct !== "number" || !Number.isFinite(pt) || !Number.isFinite(ct) || pt < 0 || ct < 0) return null;
    prompt = pt;
    completion = ct;
  }
  return (prompt * p.prompt + completion * p.completion) / 1e6;
}
