// src/agent/usage.js - provider/设置/工具曝光/用量账本/预算 (从 index.js 拆出, mixin 挂回 prototype)
import fs from "node:fs";
import path from "node:path";

import { noteCatch } from "../utils/catch-log.js";
import { CORE_TOOL_EXPOSURE, META_TOOLS_ALWAYS } from "../tools/index.js";
import { estimateCost, isPriced } from "../llm/pricing.js";
import { resolveLLM, resolveAllLLMs, isUsableProvider } from "./plugins/builtin.js";
import { isPlaceholder, hasPlaceholderField } from "../config/placeholder.js";
import { registerMcpTools } from "../mcp/index.js";
import { configDisabledSkills } from "../skills/registry.js";
import { shouldApplyRouterRole, applyRouterRole } from "./role.js";
import { estimateTokens, estimateTokensBase } from "../utils/text.js";
import { recordTokenSample } from "../utils/token-calibration.js";
import { logicalDay, atomicWrite } from "../utils/store.js";
import { info, warn, debug } from "../utils/logger.js";

// 按天用量账本保留的天数上限 (使用统计页最长看一年, 再多只增体积不增信息)
const USAGE_DAY_KEEP = 370;

// ---- LLM 调用墙钟延迟账本 (评测-II P2-2) ----
// 口径: 只记**成功**调用的墙钟耗时 (发起 → 返回), 失败/中断不计 (provider 重试在上层,
//   这里看到的是单次包装调用的端到端耗时)。分桶存储不存样本 —— 持久账本不带 PII 风险,
//   体积恒定; p50/p95 由桶累积近似导出 (口径见 web/usage-stats.js latencySummary)。
export const LATENCY_BUCKETS = [
  { key: "lt1s", max: 1000 },
  { key: "lt3s", max: 3000 },
  { key: "lt10s", max: 10000 },
  { key: "lt30s", max: 30000 },
  { key: "lt60s", max: 60000 },
  { key: "lt120s", max: 120000 },
];

export function latencyBucketKey(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return null;
  for (const b of LATENCY_BUCKETS) if (n < b.max) return b.key;
  return "ge120s";
}

export function bumpLatency(target, ms) {
  if (!target || typeof target !== "object") return;
  const key = latencyBucketKey(ms);
  if (!key) return;
  const rounded = Math.max(0, Math.round(Number(ms)));
  target.count = (Number(target.count) || 0) + 1;
  target.sumMs = (Number(target.sumMs) || 0) + rounded;
  target.maxMs = Math.max(Number(target.maxMs) || 0, rounded);
  target.buckets ??= {};
  target.buckets[key] = (Number(target.buckets[key]) || 0) + 1;
}

export const usageMethods = {
// 工具名清单 (给 verifyLesson 做幻觉接地)
_toolNames() {
  try {
    if (this.tools && typeof this.tools.listDetailed === "function") return this.tools.listDetailed().map((t) => t.name);
    if (this.tools && typeof this.tools.names === "function") return this.tools.names();
  } catch {}
  return [];
},

// 接入 MCP 服务器: 连接 + 注册工具到 catalog (可选能力, 显式调用)
// servers 缺省用 config.mcp.servers; 返回注册的工具数
async connectMcp(servers = null) {
  const list = servers || (this.config.mcp && this.config.mcp.servers) || [];
  if (!list.length) return 0;
  const r = await registerMcpTools(this.tools, list);
  this._mcp = r;
  this._mcpStatus = Array.isArray(r.status) ? r.status : [];
  return r.count;
},

// 重连 MCP (2026-11-03, MCP 管理页): 关旧连接 → 卸载 category=mcp 工具 → 按最新 config 重连。
// 不重启进程即可让"新增/修改/删除服务器"生效。
async reloadMcp() {
  const old = this._mcp;
  this._mcp = null;
  this._mcpStatus = [];
  if (old && typeof old.close === "function") {
    // 旧连接可能已断/子进程已退 —— 关不掉不影响后续重连, 但要留痕
    try { old.close(); } catch (e) { debug("mcp", `关闭旧连接失败: ${e?.message || e}`); }
  }
  // catalog 未就绪 (测试替身) 时跳过卸载; listDetailed 抛错不应阻断重连
  try {
    for (const t of this.tools.listDetailed()) {
      if (t.category === "mcp") this.tools.unregister(t.name);
    }
  } catch (e) { debug("mcp", `卸载旧工具失败: ${e?.message || e}`); }
  this.config = this._loadConfig(null);
  const list = this.config?.mcp?.servers || [];
  if (!list.length) return { count: 0, servers: 0, status: [] };
  const count = await this.connectMcp(list);
  return { count, servers: list.length, status: this._mcpStatus };
},

// 发布首启引导: 未配置任何可用模型时明确提示 (不阻断运行)
// 默认本地优先 (agent.model_preference=local), 有本地模型或云端 key 即不告警
// v1.0.8 修复 (P2-3): 原判定自己手搓了一套"有本地/有云端key"逻辑, 既不看占位符也不看 model,
//   于是模板里 lmstudio(base_url=127.0.0.1, model=YOUR_LOCAL_MODEL_NAME) 会把告警吞掉 ——
//   用户端表现是"启动一切正常, 但每句话都在偷偷降级"。现改为直接复用路由的可用判定,
//   让"启动告警"与"实际选模型"共用一个口径, 并明确指出哪些条目还是占位符。
_warnMissingCloudApi() {
  const provs = (this.config && this.config.providers) || [];
  const usable = provs.filter((p) => { try { return isUsableProvider(p); } catch { return false; } });
  if (usable.length) return;
  // 全都不可用: 先点出"看着配了其实是模板占位"的条目, 再给通用引导
  const stubbed = provs.filter((p) => hasPlaceholderField(p));
  if (stubbed.length) {
    const detail = stubbed
      .map((p) => `${p.id || "?"}[${["model", "base_url", "api_key"].filter((f) => isPlaceholder(p[f])).join("/")}]`)
      .join(", ");
    warn(`以下 provider 仍是模板占位符, 已按"未配置"处理: ${detail}。请替换为真实值后重启。`);
  }
  warn(
    "还没有可用的模型 — 配置只要 1 分钟, 三选一:\n" +
    "  ① 交互式向导:  npm run setup        (选厂商 → 粘贴 Key → 自动探活)\n" +
    "  ② 一条命令:    ppx setup --provider deepseek --key sk-xxx   (ppx setup --list 看全部厂商)\n" +
    "  ③ 本地模型:    启动 LM Studio / Ollama 后重启皮皮虾, 默认端口即自动识别\n" +
    "Web 界面首页也有「配置模型」按钮。配好重启即生效。"
  );
},

// 热重载提供方: 从 config/ppx.json 重建 LLM 客户端列表
reloadProviders() {
  this.config = this._loadConfig(null);
  this.llm = resolveLLM(this.config);
  this.allProviders = resolveAllLLMs(this.config);
  this._installUsageTracking(); // 热重载换了新客户端实例, 记账包装必须重装 (否则 usage 统计/状态条全部失明)
  this._refreshAuxRouting();
  info(`[providers] 热重载完成: ${this.allProviders.length} 个客户端`);
  return { llm: this.llm ? (this.llm.backend || this.llm.model) : null, count: this.allProviders.length };
},

// 2026-10-24 (R16): 重算分层路由的 aux 指针 —— model_routing.aux 此前只在构造时
//   解析一次, Web UI 改完配置后内存里的 auxLLM 还是旧值 (改了等于没改)。
//   reloadProviders / /api/routing PUT 之后都会走到这里。
_refreshAuxRouting() {
  this.auxLLM = null;
  const auxId = this.config?.model_routing?.aux;
  if (!auxId) return;
  const hit = (this.allProviders || []).find((c) => c.providerId === auxId);
  if (hit) this.auxLLM = hit;
  else warn(`model_routing.aux="${auxId}" 未匹配任何可用 provider, 辅助调用回落主模型`);
},

// 热重载通用设置 (用户名/安全/agent 预设): 重新加载 config + 更新内存字段
// 不重建 LLM 客户端 (settings 不涉及 provider), 只让 user.name/security/agent 生效
reloadSettings() {
  this.config = this._loadConfig(null);
  this.userName = this.config.user?.name || "兄弟";
  this.ctx.provide("userName", this.userName);
  // 应用 tools.disabled 变更 (设置 UI 启停工具后立即生效)
  this._applyDisabledTools();
  // 应用 skills.disabled 变更 (技能管理页停用/启用后立即生效: 下一轮提示注入即按新清单)
  this._applyDisabledSkills();
  // 曝光名单同样随配置热更新 (改 tool_exposure 不用重启)
  this._applyToolExposure();
  info(`[settings] 热重载完成: 用户=${this.userName}, 模式=${this.config.agent?.mode || "react"}`);
  return { userName: this.userName, mode: this.config.agent?.mode || "react" };
},

// 应用 config.skills.disabled (技能管理页写盘后生效)
_applyDisabledSkills() {
  try {
    const disabled = configDisabledSkills(this.config);
    if (this.skills && typeof this.skills.setDisabled === "function") this.skills.setDisabled(disabled);
    // 覆盖率/能力矩阵读 registry, 必须与 loader 同口径, 否则停用技能仍被算进覆盖率
    if (this.skillRegistry) this.skillRegistry.disabledSkills = disabled.slice();
    if (disabled.length) info(`[skills] 已停用 ${disabled.length} 个技能: ${disabled.join(", ")}`);
  } catch { /* 技能加载器未就绪时静默跳过 */ }
},

// 应用 config.tools.disabled: 禁用列表中的工具 (启停工具 UI 写盘后生效)
_applyDisabledTools() {
  try {
    const disabled = Array.isArray(this.config.tools?.disabled) ? this.config.tools.disabled : [];
    if (!disabled.length) return;
    let n = 0;
    for (const name of disabled) {
      try { if (this.tools.disable(name)) n += 1; } catch {}
    }
    if (n) info(`[tools] 已禁用 ${n} 个工具: ${disabled.join(", ")}`);
  } catch { /* 工具未就绪时静默跳过 */ }
},

// 按需工具曝光 (2026-10-30 接线): config.agent.tool_exposure
//   "all" (默认) / 未设 = 全部工具下发完整 schema —— 与既有行为逐字节一致;
//   "core"          = 只下发 CORE_TOOL_EXPOSURE 名单的 schema, 其余降级为静态区【按需工具】名单
//                     (名字可见, 需要时用 tool_schema 取完整参数定义再调用);
//   数组            = 自定义名单 (与核心名单取并集, 保证 tool_schema / list_capabilities 永远可见,
//                     否则模型连"怎么取 schema"都不知道)。
// 为什么: 工具 schema 是全仓最贵的固定开销 (96 个 ≈ 11.2k tok/请求), 而真实轨迹里 96 个只用到 30 个。
//   机制 (catalog.setExposure) 早就写好了却零调用方 —— 这里把它接上, 默认不改变任何行为。
_applyToolExposure() {
  try {
    if (!this.tools || typeof this.tools.setExposure !== "function") return;
    const cfg = this.config?.agent?.tool_exposure;
    let list = null;
    if (cfg === "core") list = CORE_TOOL_EXPOSURE;
    else if (Array.isArray(cfg) && cfg.length) list = [...new Set([...cfg.map(String), ...META_TOOLS_ALWAYS])];
    else if (cfg && cfg !== "all") warn(`[tools] 未知 tool_exposure 配置: ${String(cfg)} (支持 "all" / "core" / 字符串数组), 按 all 处理`);
    this.tools.setExposure(list);
    if (list) {
      const hidden = this.tools.hiddenFromLLM();
      info(`[tools] 按需曝光: ${list.length} 个工具下发完整 schema, ${hidden.length} 个降级为按需 (用 tool_schema 取参数)`);
    }
  } catch (e) { /* 曝光配置异常不得阻断启动 */ warn(`[tools] 应用 tool_exposure 失败: ${e?.message || e}`); }
},

// Router 角色 (2026-11-04): config.agent.router_role.enabled=true 时本进程只分派不执行。
//   工具收窄在此完成 (省 schema token); 强制拦截在 _admitToolCall (覆盖启动后动态注册的
//   MCP 工具)。子进程由 agent-worker.js 标记为 worker, 不会继承该角色 (防递归分派)。
_applyRouterRole() {
  try {
    if (!shouldApplyRouterRole(this.config, process.env)) {
      if (!this.role) this.role = String(process.env.PPX_AGENT_ROLE || "main");
      return;
    }
    const r = applyRouterRole(this);
    info(`[role] Router 角色已启用: 保留 ${r.allow.length} 个工具, 禁用 ${r.disabled.length} 个执行/写类工具`);
  } catch (e) { /* 角色装配异常不得阻断启动 */ warn(`[role] 应用 Router 角色失败: ${e?.message || e}`); }
},

// ZCode 使用统计对齐: 包装所有 provider 的 chat/apiChat/streamChat, 累计 token/调用次数/金额 (零侵入)
// 2026-10-10: 追加金额折算 (cost) 与预算闸门 (usageStats 只有 token 不算成本控制)。
// 2026-10-24 (R2): streamChat 也纳入 —— 此前流式轮次对 usageStats/预算闸门完全失明
//   (chatStream 纯流式路径不过 chat/apiChat 包装)。streamChat 返回纯文本无 usage,
//   按生产估算器 (utils/text.js) 计账 (prompt + 产出), 方向保守; 云端若在流里回 usage
//   (部分兼容端点回传对象) 则优先用真值。
_installUsageTracking() {
  const clients = new Set([...(this.allProviders || []), this.llm].filter(Boolean));
  for (const c of clients) {
    if (!c || c.__ppxUsageWrapped) continue;
    c.__ppxUsageWrapped = true;
    for (const meth of ["apiChat", "chat", "streamChat", "apiChatStream"]) {
      if (typeof c[meth] !== "function") continue;
      const orig = c[meth].bind(c);
      c[meth] = async (msgs, opts) => {
        // 2026-11-12 (审计 loop#5): streamChat 的 usage 原挂在客户端实例单槽 (c.__ppxStreamUsage),
        //   两条并发流会互相覆盖 —— 后来的调用把真值写进别人的账。改为每次调用一个 sink:
        //   streamChat 结束前按自己的调用回传 usage, 实例槽仅作兼容保留。
        let streamUsage = null;
        const o = { ...(opts || {}), __ppxUsageSink: (u) => { streamUsage = u; } };
        // 评测-II P2-2: 墙钟延迟采样 (成功调用; 失败路径走异常分支不进记账块)
        const latencyT0 = Date.now();
        const r = await orig(msgs, o);
        const latencyMs = Date.now() - latencyT0;
        try {
          const isStream = meth === "streamChat";
          // streamChat 返回纯文本, usage 由本次调用的 sink 回传
          const u = isStream
            ? (streamUsage || (r && typeof r === "object" ? r.usage : (c.__ppxStreamUsage || null)))
            : r?.usage;
          // 无 usage (流式常态): 输入按消息体、输出按回复文本分别估算。
          //   2026-11 修复: 此前只算总量, 金额折账却传 {} —— 流式轮次成本恒为 0,
          //   budget.usd 对纯流式路径完全失明。
          const replyText = isStream
            ? String(r ?? "")
            : (typeof r?.message?.content === "string" ? r.message.content
              : (typeof r?.choices?.[0]?.message?.content === "string" ? r.choices[0].message.content : ""));
          const estPrompt = u ? 0 : estimateTokens(JSON.stringify(msgs ?? ""));
          const estCompletion = u ? 0 : estimateTokens(replyText);
          const tk = u
            ? ((u?.total_tokens ?? (u?.prompt_tokens || 0) + (u?.completion_tokens || 0)) || 0)
            : estPrompt + estCompletion;
          // 2026-10-11: 记录最近一次 LLM usage 原样 (含 DeepSeek 的 prompt_cache_hit_tokens /
          //   prompt_tokens_details.cached_tokens), 供 Web 状态条展示 "上下文长度 · 缓存命中" (HTTP done 事件透传)
          if (u) this.lastUsage = u;
          // 2026-10-31: token 校准采样 —— 有真值 completion_tokens 且回复是纯文本时, 用
          //   「真值 / 基础估算」喂 EWMA 校准器 (estimateTokens 内置启发式路径乘系数收敛)。
          //   只采纯文本: tool_calls 的 JSON 参数计入 completion_tokens 但不走文本估算, 混入会失真。
          {
            const completion = Number(u?.completion_tokens) || 0;
            if (completion > 0) {
              let replyText = null;
              if (isStream && typeof r === "string") replyText = r;
              else {
                const msg = r?.message || r?.choices?.[0]?.message || null;
                const c0 = msg?.content;
                if (typeof c0 === "string" && c0 && !(Array.isArray(msg?.tool_calls) && msg.tool_calls.length)) replyText = c0;
              }
              if (replyText) recordTokenSample({ observed: completion, estimatedBase: estimateTokensBase(replyText) });
            }
          }
          this.usageStats.calls++;
          this.usageStats.tokens += tk;
          this.usageStats.lastCallAt = new Date().toISOString();
          // 2026-10-30: 累计 prompt / 缓存命中 —— 底部状态条要显示"累计 tok · 缓存命中 %"。
          //   命中率只能靠累计算 (单次调用要么全命中要么全不命中, 显示出来没意义)。
          //   上游没给缓存字段时不计入分母, 避免把"不知道"算成"没命中"。
          let cachedTokens = 0;
          if (u) {
            const pt = Number(u.prompt_tokens) || 0;
            const ch = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens);
            if (pt > 0) this.usageStats.promptTokens += pt;
            if (Number.isFinite(ch) && ch >= 0) {
              cachedTokens = ch;
              this.usageStats.cacheHitTokens += ch;
            }
          }
          const m = c.model || "unknown";
          // 金额折算: 价格表来自 config.budget.model_prices 覆盖 + 内置表 (pricing.js)。
          // 未知价格的云端模型必须可见 —— 否则全程按 $0 记账, 预算闸门永远不触发,
          //   用户以为有预算保护其实没有。本地推理端点本身免费, 不计入未定价。
          const priceOverrides = this.config.budget?.model_prices;
          if (!isPriced(m, priceOverrides) && !this._isLocalClient(c)) this._noteUnpriced(m, tk);
          const assume = this._assumePriceFor(m, priceOverrides);
          const costUsage = u || { prompt_tokens: estPrompt, completion_tokens: estCompletion };
          const cost = estimateCost(m, costUsage,
            assume ? { ...(priceOverrides || {}), [m]: assume } : priceOverrides);
          this.usageStats.cost = Math.round((this.usageStats.cost + cost) * 1e9) / 1e9;
          if (cost > 0) this.usageStats.lastCostAt = new Date().toISOString();
          this.usageStats.byModel[m] ??= { calls: 0, tokens: 0, cost: 0, cachedTokens: 0 };
          this.usageStats.byModel[m].calls++;
          this.usageStats.byModel[m].tokens += tk;
          this.usageStats.byModel[m].cachedTokens = (Number(this.usageStats.byModel[m].cachedTokens) || 0) + cachedTokens;
          this.usageStats.byModel[m].cost = Math.round(((this.usageStats.byModel[m].cost || 0) + cost) * 1e9) / 1e9;
          // 按天 × 按模型分桶 (使用统计页的趋势/热力/占比数据源)
          const day = logicalDay();
          const d = this.usageStats.days[day] ??= { calls: 0, tokens: 0, byModel: {} };
          d.calls++;
          d.tokens += tk;
          const dm = d.byModel[m] ??= { calls: 0, tokens: 0, cachedTokens: 0 };
          dm.calls++;
          dm.tokens += tk;
          dm.cachedTokens = (Number(dm.cachedTokens) || 0) + cachedTokens;
          // 评测-II P2-2: 延迟账本 (累计 + 按天×按模型), 分桶结构见 bumpLatency
          bumpLatency(this.usageStats.latency ??= {}, latencyMs);
          bumpLatency((dm.latency ??= {}), latencyMs);
          this._afterUsageAccounted();
        } catch (e) {
          // 2026-10-10 (P0-1): 原为空 catch, 把 estimateCost 未 import 的 ReferenceError 吞了整整一轮。
          // 统计失败仍不阻塞调用, 但必须留痕 —— 静默失效比崩溃更难查。
          debug(`[usage] 记账失败 (不阻塞调用): ${e?.message || e}`);
        }
        return r;
      };
    }
  }
},

// 本地推理客户端 (lmstudio/ollama 等): 免 Key、不计费, 不算"未定价"。
//   provider 预设里本地项 cloud=false, 但 HTTP 层只认 baseUrl —— 两个都看。
_isLocalClient(client) {
  if (!client) return false;
  if (client.local === true || client.cloud === false) return true;
  const url = String(client.baseUrl || client.base_url || "");
  return /\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url);
},

// 未定价模型可见化: 账本累计 calls/tokens, 进程内每模型只告警一次。
//   不刹车 (调用照常), 但让"花了钱、账上 $0"有迹可查 (使用统计页/告警)。
_noteUnpriced(model, tokens) {
  const m = String(model || "unknown");
  const ledger = (this.usageStats.unpriced ??= {});
  const row = (ledger[m] ??= { calls: 0, tokens: 0 });
  row.calls++;
  row.tokens += Number(tokens) || 0;
  this._unpricedWarned ??= new Set();
  if (!this._unpricedWarned.has(m)) {
    this._unpricedWarned.add(m);
    warn(`[usage] 模型 ${m} 无价格数据, 成本按 $0 记 —— 在 config.budget.model_prices 配置单价`
      + ` (如 { "prompt": 0.5, "completion": 1.5 }), 或用 budget.assume_price 兜底; 本地模型可忽略本条`);
  }
},

// 未定价模型的可选兜底单价 (config.budget.assume_price, USD/1M tokens)。
//   私有网关/新模型没有公开目录价时, 仍能把预算闸门挂在"大致金额"上;
//   未配置则保持未知 ($0 + 告警), 不编数字。
_assumePriceFor(model, overrides) {
  const a = this.config?.budget?.assume_price;
  if (!a || typeof a !== "object" || isPriced(model, overrides)) return null;
  const p = Number(a.prompt), co = Number(a.completion);
  if (!Number.isFinite(p) || !Number.isFinite(co) || p < 0 || co < 0) return null;
  return a;
},

// 每次记账后的动作: ① 更新预算闸门 ② 周期落盘 (长跑进程被 kill 时不丢账)
_afterUsageAccounted() {
  const limit = Number(this.config.budget?.usd) || 0;
  // usd=0 或缺省 = 不限 (不置位, 不拦截)
  if (limit > 0 && this.usageStats.cost >= limit) this._budgetExceeded = true;
  // 每 10 次调用落一次盘 (无需 shutdown 也有账可查); 失败不阻塞
  if (this.usageStats.calls - this._lastUsageFlushCalls >= 10) this._flushUsageStats();
},

// 从 usage-stats.json 恢复累计账本 (2026-10-30)。
//   只恢复累计字段 (calls / tokens / cost / promptTokens / cacheHitTokens / byModel),
//   **不恢复** budget_usd 或任何闸门状态 —— 预算以当前 config 为准, 用旧文件里的值
//   会把"上次配置了 $5 预算"带到"这次没配"的场景里, 静默拦掉所有调用。
//   文件缺失 / 损坏 / 字段类型不对时一律从零开始, 不抛。
_loadUsageStats() {
  try {
    const f = path.join(this.dataDir, "usage-stats.json");
    if (!fs.existsSync(f)) return false;
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
    this.usageStats.calls = num(j.calls);
    this.usageStats.tokens = num(j.tokens);
    this.usageStats.cost = num(j.cost);
    this.usageStats.promptTokens = num(j.promptTokens);
    this.usageStats.cacheHitTokens = num(j.cacheHitTokens);
    this.usageStats.byModel = (j.byModel && typeof j.byModel === "object") ? j.byModel : {};
    this.usageStats.days = this._sanitizeUsageDays(j.days);
    this.usageStats.unpriced = this._sanitizeUnpriced(j.unpriced);
    this.usageStats.lastCallAt = j.lastCallAt || null;
    this.usageStats.lastCostAt = j.lastCostAt || null;
    // 落盘水位对齐到恢复后的值: 否则恢复 500 次调用后, 第一次 _afterUsageAccounted
    // 就会误判"距上次落盘已 500 次"而立刻再写一遍盘 (无害但多余)。
    this._lastUsageFlushCalls = this.usageStats.calls;
    return true;
  } catch { return false; }
},

// 按天账本清洗: 只认 YYYY-MM-DD 键与非负数值, 其余丢弃 (旧 usage-stats.json 没有这个字段)。
_sanitizeUsageDays(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  for (const [day, b] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !b || typeof b !== "object") continue;
    const byModel = {};
    for (const [m, v] of Object.entries((b.byModel && typeof b.byModel === "object") ? b.byModel : {})) {
      if (!v || typeof v !== "object") continue;
      byModel[m] = { calls: num(v.calls), tokens: num(v.tokens), cachedTokens: num(v.cachedTokens), cost: num(v.cost) };
    }
    out[day] = { calls: num(b.calls), tokens: num(b.tokens), byModel };
  }
  return out;
},

// 未定价账本清洗: 模型名 → {calls, tokens}, 数值非负; 旧文件没有这个字段。
_sanitizeUnpriced(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [m, v] of Object.entries(raw)) {
    if (!m || !v || typeof v !== "object") continue;
    const calls = Number(v.calls), tokens = Number(v.tokens);
    out[m] = {
      calls: Number.isFinite(calls) && calls > 0 ? calls : 0,
      tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : 0,
    };
  }
  return out;
},

// 按天账本裁剪: 只留最近 USAGE_DAY_KEEP 天, 防长跑进程把账本写肥。
_pruneUsageDays() {
  const days = Object.keys(this.usageStats.days || {}).sort();
  if (days.length <= USAGE_DAY_KEEP) return;
  for (const d of days.slice(0, days.length - USAGE_DAY_KEEP)) delete this.usageStats.days[d];
},

// 使用统计落盘 (周期 + shutdown 共用)。失败静默 (不阻塞对话/退出)。
_flushUsageStats() {    try {
    const budgetUsd = Number(this.config.budget?.usd) || 0;
    this._pruneUsageDays();
    const payload = {
      updated: new Date().toISOString(),
      ...this.usageStats,
    };
    // usd=0 视为不限, 不写入 budget_usd (未生效的预算不假装生效)
    if (budgetUsd > 0) payload.budget_usd = budgetUsd;
    // 2026-11-02: 改原子写 —— 进程在 writeFileSync 中途被 kill 会留下半截 JSON,
    //   下次启动 _loadUsageStats 解析失败即整账清零; tmp+rename 让"旧账或新账"总有一个完整。
    atomicWrite(path.join(this.dataDir, "usage-stats.json"), JSON.stringify(payload, null, 2));
    this._lastUsageFlushCalls = this.usageStats.calls;
    return true;
  } catch (e) {
    noteCatch(e);
    return false;
  }
},

// 预算耗尽提示 (chat / chatStream 共用, 保证文案与入口口径一致)
_budgetExhaustedReply() {
  const limit = Number(this.config.budget?.usd) || 0;
  return `[预算耗尽] 本次会话累计成本 $${this.usageStats.cost.toFixed(6)} 已达上限 $${limit} `
    + `(config budget.usd), 已停止调用模型。请调高 budget.usd 或清空预算后继续。`;
},

// 预算闸门: 已超限则返回提示文本, 未超限返回 null (调用方据此决定是否继续)
// 2026-11-12 修复: 旧实现只看记账时置位的 sticky 标志 —— 调高 budget.usd (或清空预算) 后
//   仍永久拦截, 而提示文案用的是**当前**上限, 会出现"显示未超支却拒绝"。每次判定按当前配置重算。
_budgetBlocked() {
  const limit = Number(this.config.budget?.usd) || 0;
  if (limit <= 0) { this._budgetExceeded = false; return null; }
  if (this.usageStats.cost >= limit) {
    this._budgetExceeded = true;
    return this._budgetExhaustedReply();
  }
  this._budgetExceeded = false;
  return null;
}
};
