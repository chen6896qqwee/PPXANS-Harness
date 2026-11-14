// src/llm/pricing.js - 模型价格表 + 成本折算 (增强框架第 8 条: "预算控制"的最后一环)
// 背景: usageStats 已聚合 token 数 (calls/tokens/byModel), 但没有金额折算与支出上限 ——
//       token 数不等于成本, 不同模型价差 100 倍, "预算控制"必须落在金额上。
// 设计:
//   - 内置常用模型价格表 (统一折算为 USD / 1M tokens), 前缀匹配取最长者
//   - 云厂商价格随时变动: 内置表只是"开箱即用的估算快照", 精确控费用 config.budget.model_prices 覆盖
//   - 未知模型 → 返回 null (cost 记 0), **不编数字**; 想纳入预算控制就显式配置价格
//     (调用方用 isPriced() 区分"免费"与"未知", 未知模型的账要做可见化)
//   - 只有 total_tokens 无拆分时, 全部按 completion 价计 (预算取保守侧, 宁高估不低估)
//   - 分时/分档/缓存价: 2026-11 起 DeepSeek 按工作日峰谷计价、GLM/Qwen 按单次输入长度阶梯计价、
//     多数厂商对缓存命中的输入单独计价 —— 只按单一单价折算会系统性偏离 (最高 30 倍)。
// 零依赖, 纯函数, 可独立测试。

// 价格快照元数据: 内置表的"生产日期"与汇率假设, 供审计脚本/UI 标注"这是估算"。
export const PRICING_META = {
  updated: "2026-11-12",
  cny_per_usd: 7.2,
  note: "内置表为公开目录价快照 (2026-08~11 核验), 国内厂商按人民币价折美元; 精确控费请用 config.budget.model_prices 覆盖",
};

const CNY = "CNY";
const USD = "USD";

// 价格单位: USD / 1M tokens。字段:
//   prompt / completion  输入(缓存未命中) / 输出
//   cached               缓存命中的输入 (缺省 = prompt, 即没有缓存优惠)
//   currency             "CNY" 时按 cny_per_usd 折算 (表里直接抄厂商人民币目录价, 便于核对)
//   peak                 高峰时段价格 (仅 DeepSeek 等分时厂商; 缺省 = 全天同价)
//   tiers                按**单次请求输入长度**取档 [{ minInput, prompt, completion, cached? }],
//                        取 minInput <= 本次输入 tokens 的最高档 (厂商规则: 按单次请求整单计价)
// 匹配规则: model 小写后按前缀匹配, 取最长命中 (如 glm-4.7-flash 命中 flash 行而非 glm-4.7 行)。
//   "vendor/model" 形式的 id (OpenRouter / 硅基流动) 会额外用 "/" 后的段名再匹配一次。
const PRICES = [
  // ---- 智谱 BigModel (CNY, 2026-11 目录价) ----
  { prefix: "glm-4.7-flash", prompt: 0, completion: 0, currency: CNY },      // 免费档 (输入/输出/缓存全免)
  { prefix: "glm-4.7", prompt: 2, completion: 8, cached: 0.4, currency: CNY, // 缓存命中 ¥0.4
    tiers: [{ minInput: 32768, prompt: 4, completion: 16, cached: 0.8 }] },  // 单次 >32K 整单翻倍
  { prefix: "glm-4.5-air", prompt: 0.8, completion: 2, currency: CNY },
  { prefix: "glm-4.6", prompt: 0.6, completion: 2.2 },
  { prefix: "glm-4.5", prompt: 0.6, completion: 2.2 },
  { prefix: "glm-4-flash", prompt: 0, completion: 0 },                       // 免费档
  { prefix: "glm-4", prompt: 0.5, completion: 1.5 },

  // ---- DeepSeek (USD, 2026-08 起工作日峰谷计价; 空闲价为基准, peak 为高峰价) ----
  // 2026-07-24 起官方目录只剩 deepseek-flash / deepseek-v4-pro (chat/reasoner 已退役, 保留旧价兼容)。
  //   高峰 = 工作日 UTC 01:00-04:00 与 06:00-10:00 (= 北京时间 09:00-12:00 / 14:00-18:00), 其余半价。
  { prefix: "deepseek-v4.1-flash", prompt: 0.15, completion: 0.6, cached: 0.005,
    peak: { prompt: 0.3, completion: 1.2, cached: 0.01 } },
  { prefix: "deepseek-flash", prompt: 0.22, completion: 0.66, cached: 0.007,
    peak: { prompt: 0.44, completion: 1.32, cached: 0.014 } },
  { prefix: "deepseek-v4-pro", prompt: 0.66, completion: 1.98, cached: 0.022,
    peak: { prompt: 1.32, completion: 3.96, cached: 0.044 } },
  { prefix: "deepseek-v3", prompt: 0.28, completion: 1.11, cached: 0.07 },
  { prefix: "deepseek-chat", prompt: 0.27, completion: 1.1, cached: 0.07 },     // 已退役
  { prefix: "deepseek-reasoner", prompt: 0.55, completion: 2.19, cached: 0.14 }, // 已退役

  // ---- OpenAI ----
  { prefix: "gpt-4o-mini", prompt: 0.15, completion: 0.6 },
  { prefix: "gpt-4o", prompt: 2.5, completion: 10 },
  { prefix: "gpt-4.1-mini", prompt: 0.4, completion: 1.6 },
  { prefix: "gpt-4.1", prompt: 2, completion: 8 },

  // ---- Anthropic ----
  // 4.x 用族名前缀; 3.x 的 id 是 claude-3-5-sonnet 这种 (族名在型号后), 必须显式列出 ——
  //   2026-11 前这里只有 "claude-sonnet" 等 4.x 前缀, 3.x 模型全部落到"未知 → 成本 0"。
  { prefix: "claude-opus", prompt: 15, completion: 75 },
  { prefix: "claude-sonnet", prompt: 3, completion: 15 },
  { prefix: "claude-haiku", prompt: 1, completion: 5 },
  { prefix: "claude-3-7-sonnet", prompt: 3, completion: 15 },
  { prefix: "claude-3-5-sonnet", prompt: 3, completion: 15 },
  { prefix: "claude-3-sonnet", prompt: 3, completion: 15 },
  { prefix: "claude-3-5-haiku", prompt: 0.8, completion: 4 },
  { prefix: "claude-3-haiku", prompt: 0.25, completion: 1.25 },
  { prefix: "claude-3-opus", prompt: 15, completion: 75 },

  // ---- Gemini ----
  { prefix: "gemini-2.5-pro", prompt: 1.25, completion: 10 },
  { prefix: "gemini-2.5-flash-lite", prompt: 0.1, completion: 0.4 },
  { prefix: "gemini-2.5-flash", prompt: 0.3, completion: 2.5 },

  // ---- 阿里通义千问 (CNY, 2026 目录价; qwen-plus 按单次输入长度阶梯) ----
  { prefix: "qwen-plus", prompt: 0.8, completion: 2, cached: 0.2, currency: CNY,
    tiers: [
      { minInput: 131072, prompt: 2.4, completion: 20 },
      { minInput: 262144, prompt: 4.8, completion: 48 },
    ] },
  { prefix: "qwen-max", prompt: 2.4, completion: 9.6, currency: CNY },
  { prefix: "qwen-turbo", prompt: 0.3, completion: 0.6, currency: CNY },
  { prefix: "qwen-flash", prompt: 0.8, completion: 2, currency: CNY },
  { prefix: "qwen3-32b", prompt: 2, completion: 8, currency: CNY },

  // ---- 月之暗面 (CNY) ----
  { prefix: "kimi-k2", prompt: 0.6, completion: 2.5 },
  { prefix: "moonshot-v1-128k", prompt: 10, completion: 30, currency: CNY },
  { prefix: "moonshot-v1-32k", prompt: 5, completion: 20, currency: CNY },
  { prefix: "moonshot-v1-8k", prompt: 2, completion: 10, currency: CNY },

  // ---- 聚合/推理平台 ----
  { prefix: "llama-3.3-70b", prompt: 0.59, completion: 0.79 }, // Groq 按需价
];

// DeepSeek 峰谷窗口 (UTC 整点区间, 仅工作日): [起, 止)
const PEAK_UTC_WINDOWS = [[1, 4], [6, 10]];

function isPeakTime(at = Date.now()) {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return false;
  const day = d.getUTCDay(); // 0=周日, 6=周六
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return PEAK_UTC_WINDOWS.some(([s, e]) => h >= s && h < e);
}

const rateOf = (currency) => (String(currency || USD).toUpperCase() === CNY ? 1 / PRICING_META.cny_per_usd : 1);

// 规范化一组价格字段: 允许数字或数字字符串, 负数/非有限值视为无效 (返回 null)
function toPrice(raw, currency) {
  if (!raw || typeof raw !== "object") return null;
  const p = Number(raw.prompt), c = Number(raw.completion);
  if (!Number.isFinite(p) || !Number.isFinite(c) || p < 0 || c < 0) return null;
  const ch = raw.cached == null ? p : Number(raw.cached);
  const rate = rateOf(currency);
  return {
    prompt: p * rate,
    completion: c * rate,
    cached: (Number.isFinite(ch) && ch >= 0 ? ch : p) * rate,
  };
}

function toTiers(raw, currency) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const out = raw
    .map((t) => {
      const minInput = Number(t && t.minInput);
      if (!Number.isFinite(minInput) || minInput < 0) return null;
      const p = toPrice(t, currency);
      return p ? { minInput, ...p } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.minInput - b.minInput);
  return out.length ? out : null;
}

// 内置表条目 → 统一 USD 结构 (只算一次, 模块加载期)
const TABLE = PRICES.map((e) => ({
  prefix: String(e.prefix).toLowerCase(),
  base: toPrice(e, e.currency),
  peak: e.peak ? toPrice(e.peak, e.currency) : null,
  tiers: toTiers(e.tiers, e.currency),
})).filter((e) => e.base);

// 模型 id 的候选匹配串: 原串 + "/" 后的段名 (vendor/model 形式)
function candidates(model) {
  const m = String(model || "").toLowerCase().trim();
  if (!m) return [];
  const out = [m];
  const slash = m.lastIndexOf("/");
  if (slash >= 0 && slash < m.length - 1) out.push(m.slice(slash + 1));
  return out;
}

// 覆盖表 (config.budget.model_prices) → 有效条目列表; 非法条目直接忽略 (回落内置表)
function overrideEntries(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return [];
  const out = [];
  for (const [k, v] of Object.entries(overrides)) {
    const key = String(k).toLowerCase().trim();
    if (!key) continue;
    const base = toPrice(v, v && v.currency);
    if (!base) continue;
    out.push({
      key,
      base,
      peak: v && v.peak ? toPrice(v.peak, v.currency) : null,
      tiers: v ? toTiers(v.tiers, v.currency) : null,
    });
  }
  return out;
}

// 定位价格条目。优先级: overrides 精确命中 > overrides 前缀命中(最长) > 内置表前缀命中(最长)
function findEntry(model, overrides) {
  const cands = candidates(model);
  if (!cands.length) return null;
  const ovs = overrideEntries(overrides);
  for (const c of cands) {
    const exact = ovs.find((e) => e.key === c);
    if (exact) return exact;
  }
  let best = null, bestLen = -1;
  for (const c of cands) {
    for (const e of ovs) {
      if (c.startsWith(e.key) && e.key.length > bestLen) { best = e; bestLen = e.key.length; }
    }
  }
  if (best) return best;
  let hit = null, hitLen = -1;
  for (const c of cands) {
    for (const e of TABLE) {
      if (c.startsWith(e.prefix) && e.prefix.length > hitLen) { hit = e; hitLen = e.prefix.length; }
    }
  }
  return hit;
}

// 把条目落到"本次请求"的有效单价: 先按输入长度取阶梯档, 再叠加峰谷档。
function effectivePrice(entry, { at = Date.now(), promptTokens = 0 } = {}) {
  let p = entry.base;
  if (entry.tiers) {
    const n = Number(promptTokens) || 0;
    for (const t of entry.tiers) if (n >= t.minInput) p = { prompt: t.prompt, completion: t.completion, cached: t.cached };
  }
  if (entry.peak && isPeakTime(at)) p = entry.peak;
  return p;
}

// 解析某模型的价格 (USD / 1M tokens)。overrides: config.budget?.model_prices, 形如
//   { "glm-4-flash": { prompt: 0, completion: 0 }, "my-private-model": { prompt: 1, completion: 3 } }
//   国内价格可直接写人民币: { "my-model": { prompt: 2, completion: 8, currency: "CNY" } }
// opts.at 决定峰谷档 (缺省当前时间); opts.promptTokens 决定阶梯档 (缺省最低档)。
// 未知模型 → null; 免费模型 → { prompt: 0, completion: 0, cached: 0 }。
export function resolvePrice(model, overrides, opts = {}) {
  const hit = findEntry(model, overrides);
  return hit ? effectivePrice(hit, opts) : null;
}

// 该模型是否有价格 (免费模型算"有价格"; 未知模型才返回 false)
export function isPriced(model, overrides) {
  return !!findEntry(model, overrides);
}

// 内置价格表快照 (审计脚本/文档用): 条目已折算 USD, 便于和 resolvePrice 对照
export function priceTable() {
  return TABLE.map((e) => ({
    prefix: e.prefix,
    prompt: e.base.prompt,
    completion: e.base.completion,
    cached: e.base.cached,
    peak: e.peak ? { prompt: e.peak.prompt, completion: e.peak.completion, cached: e.peak.cached } : null,
    tiers: e.tiers ? e.tiers.map((t) => ({ minInput: t.minInput, prompt: t.prompt, completion: t.completion, cached: t.cached })) : null,
  }));
}

// 折算一笔 usage 的成本 (USD)。usage: { prompt_tokens, completion_tokens, prompt_cache_hit_tokens? }
//   或仅 { total_tokens }。
// 无价格 → 0 (调用方无从区分"免费"与"未知", 需要区分时先调 isPriced)。
// opts.at / opts.promptTokens 透传给档位选择 (缺省为当前时间 / 本次输入长度)。
export function estimateCost(model, usage, overrides, opts = {}) {
  const hit = findEntry(model, overrides);
  if (!hit) return 0;
  const pt = usage?.prompt_tokens, ct = usage?.completion_tokens;
  let promptTokens, completionTokens, cachedTokens = 0;
  if (pt == null && ct == null) {
    // 只有总量 (部分本地推理后端不拆分): 全按 completion 价计 —— 预算保守侧
    promptTokens = 0;
    completionTokens = Number(usage?.total_tokens) || 0;
  } else {
    promptTokens = Math.max(0, Number(pt) || 0);
    completionTokens = Math.max(0, Number(ct) || 0);
    const cached = Number(usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens);
    // 上游对缓存命中数可能乱报 (负数/超过 prompt): 夹逼到 [0, promptTokens], 不让账目出现负成本
    if (Number.isFinite(cached) && cached > 0) cachedTokens = Math.min(cached, promptTokens);
  }
  const p = effectivePrice(hit, { at: opts.at, promptTokens });
  const billablePrompt = promptTokens - cachedTokens;
  return (billablePrompt * p.prompt + cachedTokens * p.cached + completionTokens * p.completion) / 1e6;
}
