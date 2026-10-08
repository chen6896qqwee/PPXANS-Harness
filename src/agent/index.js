// src/agent/index.js - Agent 引擎 (皮皮虾核心) v0.2 含工具调用
import { ensureUTF8Console } from "../utils/winutf8.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { TOOL_ERROR_PREFIX } from "../tools/index.js";
import { normalizeCommand } from "../tools/command-guard.js";
// 重构第一刀 (2026-09-14): 工具循环执行策略抽至 src/core/policy.js
// (探索熔断/重复检测/溢出降档/错误重试/结果裁剪/循环驱动), 重新导出保持测试与外部兼容
import { runToolLoop, LLM_FAILED_HINT } from "../core/policy.js";
// 重构第三刀 (2026-09-14): 结构化事件流 traceId 贯穿 (AsyncLocalStorage), 关键路径埋点
import { EventTracer, runWithTrace, currentTrace } from "../core/trace.js";
// 重构第二刀 (2026-09-14): 记忆升降级 + 自我学习收敛为独立服务, agent 只保留薄委托
import { MemoryService } from "../services/memory-service.js";
import { LearningService } from "../services/learning-service.js";
export { isOverflowError as _isOverflowError, trimToolResult, toToolContent } from "../core/policy.js";
import { logicalDay } from "../utils/store.js";
import { loadConfig } from "../config/index.js";
// 成本折算 (2026-10-03l): usageStats 加金额维度 + 支出预算闸门 (增强框架第 8 条: 预算控制)
import { estimateCost } from "../llm/pricing.js";
import { info, warn, error, debug } from "../utils/logger.js";
import { Context, compose, loadPlugins } from "../plugin/index.js";
import { builtinPlugins, resolveLLM, resolveAllLLMs, isUsableProvider } from "../plugin/builtin.js";
// v3.0 (codex 对齐): 新层插件 (permissions/hooks/commands/evidence/protocol)
import { v3Plugins } from "../plugin/v3.js";
// P2-3: 占位符判定与路由共用唯一真相源, 避免"启动告警"和"实际选模型"两套口径漂移
import { isPlaceholder, hasPlaceholderField } from "../config/placeholder.js";
import { registerMcpTools } from "../mcp/index.js";
import { Auditor } from "../audit/verifier.js";
import { classifyFailure } from "../memory/failure-episode.js";
// ANS 独立模块 (可更换): 价值对齐 / 自主任务生成 / 生命周期
import { Lifecycle } from "../ans/lifecycle.js";
import { suggestProactive, markTaskDone } from "../ans/proactive.js";
import { record as rewardRecord, status as rewardStatus } from "../ans/reward.js";
import { scan as evictionScan, status as evictionStatus } from "../ans/eviction.js";
import { installGuard, guardStatus, installGuardOnCatalog } from "../ans/guard.js";
import { scanToolResult, wrapUntrusted, reportSuspicious, stripProtoKeys } from "../security/injection.js";
import { SkillLoader } from "../skills/loader.js";
import { createSkillRegistry } from "../skills/registry.js";
import { EvolutionEngine } from "../selfheal/evolve.js";
// 重构 (2026-09-15): 历史/上下文管理 + 提示词构建从 PPXAgent 类抽出为 mixin
// (context.js: 历史裁剪/token 预算/会话压缩; prompts.js: 技能清单/核心价值/DSML/画像/多模态)
import { contextMethods } from "./context.js";
import { promptMethods } from "./prompts.js";
import { TurnProjection } from "../session/projection.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 会话历史条数/token 预算已迁到 config.memory (max_history_items / history_token_budget)
// (上下文窗口常量 DEFAULT_CONTEXT_WINDOW / DEFAULT_CONTEXT_RATIO 与辅助 LLM 超时 AUX_LLM_TIMEOUT_MS
//  已随历史管理迁至 src/agent/context.js)
// (工具循环阈值 DEFAULT_MAX_TOOL_ROUNDS / EXPLORE_TOOLS 等已迁至 src/core/policy.js)

// (工具结果裁剪 trimToolResult / 溢出判定 isOverflowError / LLM 失败提示 LLM_FAILED_HINT
//  已迁至 src/core/policy.js, 本文件经 re-export 保持兼容)
// (多模态视觉 content 注入 visionUserContent 已迁至 src/agent/prompts.js)

// P2-2 降级提示标记: 追加在用户可见回复末尾的哨兵串 (历史/记忆写入前按它剥离)
const FALLBACK_NOTICE_TAG = "\n\n> ⚠ ";

// ---- 轮内 assistant 草稿的暂存闸门 (2026-10-06 交接项) ----
// 病根: src/core/policy.js runToolLoop() 把每轮 apiChat 返回的 assistant 消息 push 进它**局部的**
//   messages 数组, 轮次一结束整个数组就被丢弃 —— 中间草稿 (含后置校验丢弃的那条错答) 从来没有
//   到达过任何持久层。 Manus 公开过的 harness 教训恰是"错的那一轮要留在现场": 抹掉它就抹掉了
//   下次不再这么干的唯一证据。本层把它按会话暂存, 交 recordTurn 落记忆层的可重建上下文档。
// 边界 (三条都是硬约束): ① 只存文本 + 工具**名**, 绝不存工具入参值 (今日硬化后的 name-only 日志口径);
//   ② 草稿只进 memory/turns 档, 不进蒸馏输入 (user+最终回复) 也不进 system prompt (固定开销零增长);
//   ③ 双上限 + 每轮 finally 收口, 长跑进程不无界增长。
const DRAFT_PENDING_MAX = 8;        // 每会话每轮最多暂存的草稿条数 (超出的丢最旧)
const DRAFT_BUCKETS_MAX = 32;       // 同时在排的会话桶上限 (丢最旧桶, 防长跑泄漏)
const DRAFT_UNATTRIBUTED = "__unattributed__"; // 无 ALS trace 时 (MCP 直调/测试裸调用) 的兜底桶, 与证据采集同约定

export class PPXAgent {
  constructor({ root = ROOT, configFile = null, plugins = [], dataDir = null, globalDataDir = null } = {}) {
    this.root = root;
    // dataDir 可覆盖: 显式参数 > PPX_DATA_DIR 环境变量 > 默认目录
    // 默认目录: 包装在 node_modules 里时外置到 ~/.ppx (防卸载丢数据), 否则 root/data
    this.dataDir = dataDir || process.env.PPX_DATA_DIR || this._defaultDataDir(root);
    // 全局共享数据目录 (跨 agent 共享经验等): 显式参数 > PPX_AGENT_GLOBAL_DATA_DIR > 本地 dataDir
    this.globalDataDir = globalDataDir || process.env.PPX_AGENT_GLOBAL_DATA_DIR || this.dataDir;
    this.config = this._loadConfig(configFile);
    this.userName = this.config.user?.name || "兄弟";

    // 装配顺序固定: 插件容器 → 内置/用户插件 → 服务绑定 → ANS 接线 → 起始状态 → 启动动作
    // (2026-09-18 重构: 原 120 行单块构造函数按阶段拆为私有方法, 顺序与语义完全不变)
    this._initPluginContainer(plugins);
    this._bindServices();
    this._wireANS();
    this._initTurnState();
    this._initEngines();
    this._initServices();
    this._initStartup();
  }

  // ---- 装配阶段 1: 插件容器与插件装配 (一切皆插件) ----
  _initPluginContainer(plugins) {
    // P2⑧: 顶层 ctx 为 full-access 基座 (内置插件可信), 用户插件默认 restricted
    this.ctx = new Context(null, { access: "full-access" });
    this.ctx.provide("root", this.root);
    this.ctx.provide("dataDir", this.dataDir);
    this.ctx.provide("globalDataDir", this.globalDataDir);
    this.ctx.provide("config", this.config);
    this.ctx.provide("userName", this.userName);
    this.ctx.provide("agent", this);
    // 装配顺序: 内置插件 → 用户插件目录(声明式) → 构造函数传入插件(编程式)
    const pluginsDir = path.join(this.root, this.config.plugins?.dir || "plugins");
    compose(this.ctx, [...builtinPlugins, ...v3Plugins, ...loadPlugins(pluginsDir), ...plugins]);
  }

  // ---- 装配阶段 2: 从 ctx 取服务, 设置公开属性 (向后兼容, 外部代码不变) ----
  _bindServices() {
    this.healer = this.ctx.consume("healer");
    this.health = this.ctx.consume("health");
    this.persona = this.ctx.consume("persona");
    this.facts = this.ctx.consume("facts");
    this.experience = this.ctx.consume("experience");
    this.sessionStore = this.ctx.consume("sessions");
    this.memory = this.ctx.consume("memory");
    this.llm = this.ctx.consume("llm");
    this.allProviders = this.ctx.consume("allProviders");
    // 可选分层路由 (2026-10-02): config.model_routing.aux 指定辅助任务 (记忆提取/摘要/压缩等
    // 非主对话调用) 的厂商 id; 不配置 = 辅助调用跟随主模型, 零配置零门槛。
    this.auxLLM = null;
    {
      const auxId = this.config.model_routing?.aux;
      if (auxId) {
        const hit = (this.allProviders || []).find((c) => c.providerId === auxId);
        if (hit) this.auxLLM = hit;
        else warn(`model_routing.aux="${auxId}" 未匹配任何可用 provider, 辅助调用回落主模型`);
      }
    }
    this.l0 = this.ctx.consume("l0");
    this.scenes = this.ctx.consume("scenes");
    this.personaStore = this.ctx.consume("personaStore");
    this.traces = this.ctx.consume("traces");
    // 故障病历 (2026-10-03 接线): 原先 evolvePlugin 提供了却零消费 —— 失败只写经验库,
    // 本模块的"结构化病历 + 同类检索"从未生效。现于 _runTool 接入读写闭环。
    this.failures = this.ctx.consume("failures");
    // 记忆管线健康监控 (2026-10-03 接线): 与 failures 同属"装配了但零消费"的预留件 ——
    // 没人 record() 时 status() 永远 healthy, 降级建议形同虚设。现由 MemoryService 记账与消费。
    this.memoryHealth = this.ctx.consume("memoryHealth");
    // 重构第三刀: 结构化事件流 (记忆升降级/工具失败/spawn/自愈触发), 独立于工具轨迹
    this.tracer = new EventTracer(this.dataDir);
    this.bus = this.ctx.consume("bus");
    this.tools = this.ctx.consume("tools");
    // 2026-10-03 接线: 语境 Playbook (evolve 引擎) —— prompts._playbookPrompt 注入 system
    // prompt, LearningService.refine 失败提炼时自动 ADD bullet (原 provide 后零消费)
    this.playbook = this.ctx.consume("playbook");
    this.scheduler = this.ctx.consume("scheduler");
    this.toolsEnabled = this.ctx.consume("toolsEnabled");
    // 专家包目录册 (2026-10-07 吸收 Octop): 由 toolsPlugin 装配, 这里取引用 ——
    // 供 delegate / team-room 把"专家包 id"解析成成员规格与渲染后的角色人格块。
    this.expertPacks = this.ctx.consume("expertPacks");
    // v3.0 (codex 对齐): 权限引擎 / 钩子链 / 命令注册表 / 目标看板 / 协议总线
    this.hooks = this.ctx.consume("hooks");
    this.permissions = this.ctx.consume("permissions");
    this.commands = this.ctx.consume("commands");
    this.goalBoard = this.ctx.consume("goalBoard");
    this.protocolBus = this.ctx.consume("protocolBus");
    // ZCode 工具能力门接线 (2026-10-02 吸收): 工具声明式能力 → 权限引擎
    //   开关: config.agent.capability_gate (默认开); auto_approve_high_risk (默认关)
    //   ⚠ 必须在 permissions/tools 都消费之后 (2026-10-03 自测发现: 原先放在消费前被静默跳过)
    if (this.permissions && this.tools && typeof this.tools.getCapability === "function") {
      this.permissions.getCapability = (n) => this.tools.getCapability(n);
      this.permissions.capabilityGate = this.config.agent?.capability_gate !== false;
      this.permissions.autoApproveHighRisk = !!this.config.agent?.auto_approve_high_risk;
    }
    // ZCode 使用统计对齐 (2026-10-02): 会话级 token/调用次数记账 (零侵入包装 provider)
    // 2026-10-03l: 加 cost (USD) 维度 + budget.usd 支出上限 (超限后 chat/chatStream 拒绝继续烧钱)
    this.usageStats = { calls: 0, tokens: 0, cost: 0, byModel: {} };
    this._budgetExceeded = false;
    this._usageLastFlush = 0;
    this._healthCache = null;
    this._installUsageTracking();
    // 待审批映射 (codex approval flow): id -> { req, resolve, timer }
    this._pendingApprovals = new Map();
    this._approvalSeq = 0;
    // 审批可达面 (2026-10-04): 谁能把审批请求递到人面前并回传裁决。
    // 目前只有挂了 HTTP/Web UI 的进程算数 (resolveApproval 的唯一调用点是 /api/approvals/:id)。
    // 空集 = headless: 审批注定无人应答, 不该再等 120s。
    this._approvalSurfaces = new Set();
    // clarify 的"有没有人能答"谓词 (2026-10-05): CLI 聊天进程启动时置 true, 默认无
    this._humanChannel = false;
    // B2: 审批缓存 (codex ApprovalStore 语义) — 会话内相同命令批准后不重复 ask
    // key = `${tool}:${normalizeCommand(command)}`; 只存批准结果, 拒绝/超时不入缓存
    // v3.2.3 (P2#12): 加上限防无界增长 (长跑进程反复批准不同命令会持续膨胀)
    this._approvalCache = new Map();
    this._approvalCacheMax = 500;
    // v3.2.3 (P2#17): stats() TTL 缓存 (原实现每次请求同步聚合 10000 行 JSONL, 高频轮询
    // /api/stats 时重复付全量聚合成本); `agent.stats_cache_ms` 可调, 0 = 关闭
    this._statsCache = null;
    this._statsCacheAt = 0;
  }

  // ---- 装配阶段 3: ANS 自治接线 (免疫闸门 / Reward 闭环 / 排泄自治) ----
  _wireANS() {
    // ⑧ 免疫系: 全局闸门挂到总线命令通道 (拦截+审计)
    this.__guard = installGuard(this, { allowList: this.config.agent?.guardAllowList || [] });
    // ⑦ Reward 闭环: 订阅总线工具成败, 自动更新行为倾向 (EWMA)
    this.bus?.on("tool/result", (ev) => {
      const { name, ok } = ev.payload || {};
      if (name) { try { rewardRecord(this, { tool: name, ok: !!ok }); } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); } }
    });
    // P0 (2026-09-15): 免疫闸门接入工具执行收口 (修 MERGE-REPORT 遗留 P2 —— guard 之前只盖总线命令,
    // 工具走 catalog 绕过全局闸门)。共享同一 state: approveGuard 一次授权同时作用于总线+工具。
    try {
      this.__guardOnCatalog = installGuardOnCatalog(this.tools, this.__guard);
    } catch (e) {
      warn(`[guard] 工具收口接入失败: ${e.message}`);
    }
    // ⑤排泄自治: 每日扫描长期记忆做冗余识别/冷热分层 (幂等注册, 不重复)
    // 2026-09-18 配合 Scheduler 重启恢复修复: 持久化恢复的 eviction-daily 无 action 闭包
    //   (JSON 序列化丢函数), 直接复用会走 onFire 兜底变成"记一条备忘"而非真正扫描 ——
    //   故检测到"同名的无 action 恢复任务"时先移除再重挂真闭包。
    try {
      const jobs = this.scheduler?.jobs || [];
      const stale = jobs.find((j) => j.name === "eviction-daily" && typeof j.action !== "function");
      if (stale) this.scheduler?.remove(stale.id);
      const hasE = jobs.some((j) => j.name === "eviction-daily" && typeof j.action === "function");
      if (!hasE) this.scheduler?.add({ name: "eviction-daily", cron: "02:00", type: "daily", action: () => { try { evictionScan(this); this.sweepMemoryTtl(); } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); } } });
    } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); }
    // 首次启动跑一次排遗扫描 (预热治理状态)
    try { evictionScan(this); } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); }
    this._warnMissingCloudApi(); // 发布首启引导: 未配云端 key 时明确提示
  }

  // ---- 装配阶段 4: 单轮对话运行态 (通知/中断/工具事件) ----
  _initTurnState() {
    this._notifyCb = null;
    this._onToolEvent = null; // 工具事件回调
    this._toolCallSeq = 0; // 工具调用序号: 给 start/done 事件生成唯一 id, 供 UI 精确配对
    this._interrupted = false;
    this._interruptedSessions = new Set(); // v3.0.1 (P1#3): 按会话中断, 并发会话不串台
    // /plan 计划模式 (2026-10-05 死命令修复): 按会话存, 不落盘、不跨进程 ——
    // 新会话默认非 plan (不残留), 引擎级 permissions.planEnabled 只作进程级兜底。
    this._planSessions = new Set();
    // 2026-10-04: sessionKey -> AbortController。此前 interrupt() 只翻一个协作标志位,
    //   逐字流式路径 (streamChat) 完全不看它 —— 用户点"停止"/关掉网页后 SSE 已断,
    //   上游却继续把整段回答生成完 (继续计费)。现在由 interrupt 真正掐断请求。
    this._streamAborts = new Map();
    this._turnCbs = new Map(); // v3.0.1 (P1#4): traceId -> { onTool, onStep }, 并发流式回调互不覆盖
    this._turnsUsedTools = new Set(); // v3.0.1 (P1#4): 用过工具的 traceId 集合 (替代单布尔标志)
    this._turnFallbacks = new Map(); // v3.0.1 (P1#4): traceId -> 降级事实 (替代单槽 _lastFallback)
    // 2026-10-06 交接: sessionKey -> 本轮 runToolLoop 的中间 assistant 草稿 (含被后置校验丢弃的错答)。
    //   此前这类消息只活在 runToolLoop 的局部数组里, 轮次结束即整体丢弃 = 记忆层"那一轮什么都没发生"。
    //   现在按会话暂存, 由 _persistTurn 交给 recordTurn 落 memory/turns 的可重建上下文档。
    this._draftPending = new Map();
    this._lastTurnUsedTools = false; // 兼容保留: 无 trace 上下文的裸调用路径
    this._lastFallback = null; // P2-2: 最近一次 provider 降级事实 (在本轮内有效, 用完即清)
    this._mcp = null; // MCP 连接句柄 (connectMcp 后赋值)
    this._proactiveTimer = null; // 主动任务生成定时器
    // v3.1 首片 (P1#8): Turn 投影层接入 —— SessionStore 仍是唯一事实源,
    // 本层只投影每轮生命周期 (open/closed/aborted), 纯可观测, config.agent.turn_projection=false 可旁路
    this.turnProjection = new TurnProjection();
    this.turnProjection.enabled = this.config.agent?.turn_projection !== false;
  }

  // ---- 装配阶段 5: 长期状态引擎 (生命周期 / 进化 / 审计 / 技能) ----
  _initEngines() {
    // 生命周期 (ANS 独立模块): born → growing → mature → evolving / reproducing
    // v1.0.7 持久化: 状态落盘 data/memory/lifecycle.json, 跨进程/重启不归零 (P1)
    this.lifecycle = new Lifecycle({ file: path.join(this.dataDir, "memory", "lifecycle.json") });
    this.evolve = new EvolutionEngine(this, this.config.agent?.evolve || {});
    // Auditor (P0①): 唯一“已验证写回”通道 + 已验证账本 (data/audit/verified.json)
    this.auditor = new Auditor({ ledgerPath: path.join(this.dataDir, "audit", "verified.json") });
    // 方法技能目录 (Superpowers 吸收): 供 _context 注入技能清单, LLM 按需 load_skill
    // 2026-10-07 内置技能层 v2: 多源装配 (内置 skills/ + 用户 ~/.ppx/skills + 项目/附加目录)
    //   + 领域二级目录 (skills/<domain>/<skill>/)。优先复用插件装配阶段已建好的注册表实例
    //   (同一份 loader 才能共享缓存与使用计数; 各建一份会让 skill_search 与 load_skill 各算各的)。
    try {
      const provided = this.ctx.consume ? this.ctx.consume("skillRegistry") : null;
      this.skillRegistry = provided || createSkillRegistry(this.config, this.root);
      this.skills = this.skillRegistry.loader;
    } catch (e) {
      warn(`[skills] 多源技能库装配失败, 回落单目录: ${e.message}`);
      try { this.skills = new SkillLoader(path.join(this.root, "skills")); } catch { this.skills = null; }
      this.skillRegistry = null;
    }
  }

  // ---- 装配阶段 6: 业务服务 (记忆协调 / 自我学习, 依赖注入) ----
  _initServices() {
    // 重构第二刀: 记忆协调服务 + 自我学习服务 (依赖注入, llm 用闭包实时取当前 provider)
    // 2026-10-02: 辅助服务优先走 model_routing.aux (可选, 未配置回落主模型)
    this.memorySvc = new MemoryService({
      getLlm: () => this.auxLLM || this.llm,
      facts: this.facts,
      scenes: this.scenes,
      personaStore: this.personaStore,
      experience: this.experience,
      lifecycle: this.lifecycle,
      tracer: this.tracer,
      health: this.memoryHealth, // 记忆管线健康度: 每步 record, 降级时跳过 LLM 压缩/提炼
    });
    this.learningSvc = new LearningService({
      getLlm: () => this.auxLLM || this.llm,
      traces: this.traces,
      skills: this.skills,
      experience: this.experience,
      lifecycle: this.lifecycle,
      auditor: this.auditor,
      tracer: this.tracer,
      toolNames: () => this._toolNames(),
      runTool: (name, args) => this.tools.call(name, args, { agent: this }),
      playbook: this.playbook, // 2026-10-03 接线: 教训沉淀为 playbook bullets
    });
    // 注入 LLM 摘要器/提炼器 (依赖 service, 装配后注入)
    this.memory.summarizer = (raw) => this.memorySvc.summarizeMemory(raw);
    this.memory.setExtractor((u, a, related) => this.memorySvc.extractMemory(u, a, related));
  }

  // ---- 装配阶段 7: 启动动作 (禁用工具 / MCP 自动连接 / 首次画像) ----
  _initStartup() {
    // 应用 tools.disabled: 从 config/ppx.json 读取需禁用的工具, 启动时禁用 (设置 UI 写盘生效)
    this._applyDisabledTools();
    // 应用工具披露策略: 只把核心工具 schema 发给 LLM, 其余按需加载 (省上下文)
    this._applyToolExposure();

    // 可选: 启动时自动连接 MCP 服务器 (config.mcp.auto_connect = true 时非阻塞连接)
    if (this.config.mcp?.auto_connect && this.config.mcp.servers?.length) {
      this.connectMcp()
        .then((n) => { if (n) info(`[mcp] 自动连接 ${n} 个 MCP 工具`); })
        .catch((e) => warn(`[mcp] 自动连接失败: ${e.message}`));
    }

    // 首次启动生成 L3 画像 (零依赖高频词统计, 同步快, 不调 LLM)
    this._maybeRefreshPersona();
  }

  // 默认数据目录: 包装在 node_modules 里(全局/本地安装)时外置到 ~/.ppx, 否则 root/data
  _defaultDataDir(root) {
    if (String(root).includes("node_modules")) return path.join(os.homedir(), ".ppx");
    return path.join(root, "data");
  }

  // 主动通知 + 中断 API
  setNotify(cb) { this._notifyCb = typeof cb === "function" ? cb : null; }
  // 工具调用过程可视化 - 回调 (tool名, 参数, 耗时, 状态) 供 Web UI 推送
  setToolEvent(cb) { this._onToolEvent = typeof cb === "function" ? cb : null; }
  // turn/step 分层: 推理轮次事件 (每轮工具循环发一次 step), 供军团 worker 上报进度
  setStepEvent(cb) { this._onStepEvent = typeof cb === "function" ? cb : null; }
  notify(message) { if (this._notifyCb) { try { this._notifyCb(String(message)); } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); } } }
  // v3.0.1 (P1#3): 中断支持按会话 —— 带 sessionKey 只中断该会话 (HTTP 并发场景不串台);
  // 无 key 全局中断 (CLI 单会话兼容)。
  interrupt(sessionKey) {
    if (sessionKey) this._interruptedSessions.add(sessionKey);
    else this._interrupted = true;
    // 协作标志位只能拦工具轮次; 逐字流式在等 SSE, 必须另外掐断底层请求 (2026-10-04)
    const abort = (ac) => { try { ac?.abort?.(); } catch { /* 已结束的控制器 abort 无副作用 */ } };
    if (sessionKey) abort(this._streamAborts.get(sessionKey));
    else for (const ac of this._streamAborts.values()) abort(ac);
  }
  // 每轮对话开始复位: 清本会话中断 + 全局标志 (兼容 CLI /stop → 下一轮继续的既有语义)
  clearInterrupt(sessionKey) {
    if (sessionKey) this._interruptedSessions.delete(sessionKey);
    else { this._interruptedSessions.clear(); this._streamAborts.clear(); }
    this._interrupted = false;
  }
  isInterrupted(sessionKey) {
    if (this._interrupted) return true;
    if (sessionKey) return this._interruptedSessions.has(sessionKey);
    return this._interruptedSessions.size > 0;
  }

  // v3.0.1 (P1#4): 工具/step 事件路由 —— 优先当前 trace 注册的按轮回调 (并发流式会话互不覆盖),
  // 无按轮回调时兜底全局回调 (setToolEvent/setStepEvent, Web UI 全局面板用)
  _emitTool(ev) {
    const per = this._turnCbs.get(currentTrace()?.traceId);
    const cb = (per && per.onTool) || this._onToolEvent;
    if (cb) { try { cb(ev); } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); } }
  }
  _emitStep(ev) {
    const per = this._turnCbs.get(currentTrace()?.traceId);
    const cb = (per && per.onStep) || this._onStepEvent;
    if (cb) { try { cb(ev); } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); } }
  }
  // 取走当前轮的降级事实 (按 traceId, 无则回落全局单槽), 取后即清
  _takeFallback() {
    const tid = currentTrace()?.traceId;
    if (tid && this._turnFallbacks.has(tid)) {
      const fb = this._turnFallbacks.get(tid);
      this._turnFallbacks.delete(tid);
      return fb;
    }
    const fb = this._lastFallback;
    this._lastFallback = null;
    return fb;
  }

  // 只读模式 (SDD 审查者, 吸收 Superpowers): 禁用一切修改/执行类工具, 只能读/查
  // 供 spawn_agent review 循环的审查者角色 (worker 经 PPX_AGENT_READONLY=1 触发)
  enableReadonlyMode() {
    const disabled = [
      "run_command", "write_file", "code_act", "create_skill",
      "memory_add", "add_schedule",
      "scene_create", "scene_describe", "spawn_agent", "refine_skill",
      "refine", // v1.0.8: refine 会写经验库, 只读审查者也不应触发
    ];
    for (const t of disabled) { try { this.tools.disable(t); } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); } }
    this.readonly = true;
    return this;
  }

  _loadConfig(configFile) {
    return loadConfig(this.root, configFile);
  }

  // P1#9: LLM 结构化记忆提炼 (实现已迁 src/services/memory-service.js, 此处分发保持公共 API)
  async _extractMemory(user, assistant, existing = []) {
    return this.memorySvc.extractMemory(user, assistant, existing);
  }

  // 辅助 LLM 调用前置健康探测 (v1.0.7): 模型不可用 (本地服务未运行/远端不可达) 时快速跳过,
  // 不发起 10s 超时等待 — 本地未运行的 health() 是 ECONNREFUSED 毫秒级失败, 开销可忽略
  // (记忆/学习方法已用 service 内部版本, 此处保留供 _maybeCompact 等使用)
  async _auxLlmReady() {
    if (!this.llm) return false;
    if (typeof this.llm.health !== "function") return true;
    try { return await this.llm.health(); } catch { return false; }
  }

  // 用 LLM 把旧对话浓缩成语义摘要 (实现已迁 memory-service, 此处分发)
  async _summarizeMemory(raw) {
    return this.memorySvc.summarizeMemory(raw);
  }

  // P1: LLM 查询扩展 (实现已迁 memory-service, 此处分发)
  async _expandQuery(q) {
    return this.memorySvc.expandQuery(q);
  }

  // P1: 语义记忆检索 (实现已迁 memory-service, 此处分发)
  async _memoryQuery(q, { limit = 5, scope = null } = {}) {
    return this.memorySvc.query(q, { limit, scope });
  }

  // 重置某会话历史 (新会话): 删除事件日志
  // plan 模式随会话重置一并清除 (2026-10-05): /reset 语义是"全新会话", 旧会话的计划态
  // 不该跟着进新会话 —— 否则就是"意外幸存进不相关会话"的那条不变量。
  resetSession(sessionKey) {
    this._planSessions.delete(sessionKey || "default");
    this.sessionStore.delete(sessionKey || "default");
  }

  // ---- 会话级 plan 模式状态 (2026-10-05 /plan 死命令修复) ----
  // 存储: 进程内 Set<sessionKey>, 不落盘 —— 按会话而非全局进程; 新 sessionKey 默认不在集合,
  // 因此既不跨会话泄漏, 也不跨重启幸存。权限引擎保持无状态: 准入链每次 check 现取现传
  // (ctx.planEnabled), 引擎级 planEnabled 仅作进程级兜底/测试注入 (语义 = 全开)。
  setPlanMode(sessionKey = "default", on = true) {
    const key = sessionKey || "default";
    if (on) this._planSessions.add(key); else this._planSessions.delete(key);
    return this.isPlanMode(key);
  }
  isPlanMode(sessionKey = "default") { return this._planSessions.has(sessionKey || "default"); }
  planModeSessions() { return [...this._planSessions]; }

  // /plan 与 /do 的真实落地: 走 commands 注册表 (命令模型 → intent → 集成层翻转状态),
  // 命令文件里那句 "enter_plan_mode" 从"文档里的能力"变成"有消费者的能力"。
  // 返回 null = 不是本集成层实现的命令, 原样回落既有链路 (其他 intent 尚无消费者, 不假装处理)。
  _consumePlanCommand(userMsg, sessionKey = "default") {
    try {
      if (!this.commands || typeof this.commands.execute !== "function") return null;
      const out = this.commands.execute(String(userMsg || "").trim(), {});
      if (!out || out.type !== "intent") return null;
      if (out.action === "enter_plan_mode") {
        this.setPlanMode(sessionKey, true);
        return "[计划模式] 已进入 (会话 " + (sessionKey || "default") + "): 本会话转为只读 —— 读/查类工具照常, "
          + "写/执行/派生类工具调用会被权限引擎拒绝 (拒绝结果会带下一步指引)。产出执行计划交用户确认后, 由用户发送 /do 退出计划模式恢复正常执行。";
      }
      if (out.action === "exit_plan_mode") {
        const was = this.isPlanMode(sessionKey);
        this.setPlanMode(sessionKey, false);
        // 用户显式升级 (与 escalated 审批同一条"人工裁决可退"口径): 引擎级 planEnabled 若是开着的,
        // /do 一并清掉, 否则会出现"会话早退出了、全局计划态还卡着"的死角。
        if (this.permissions) this.permissions.planEnabled = false;
        return was
          ? "[计划模式] 已退出 (会话 " + (sessionKey || "default") + "): 恢复正常审批语义 (workspace-write + on-request)。"
          : "[计划模式] 本会话当前不在计划模式, 无需退出。";
      }
      return null;
    } catch { return null; }
  }

  // 对话主入口 (含工具调用循环)
  async chat(userMsg, { persist = true, sessionKey = "default", mode = null } = {}) {
    // 重构第三刀: 入口生成 traceId, 记忆/工具/学习子调用自动继承 (AsyncLocalStorage)
    return runWithTrace(async () => {
    // 支出预算闸门 (2026-10-03l): 超限后拒绝继续烧钱, 提示如何调额
    if (this._budgetExceeded) return this._budgetMessage();
    // /plan 与 /do: 控制命令在集成层先行消费 (2026-10-05 死命令修复) —— 不开 turn、不调 LLM、
    // 不落库, 与 CLI 侧 /stop /reset 同一口径; 其余斜杠命令维持原链路 (原文进模型)。
    const planCmd = this._consumePlanCommand(userMsg, sessionKey);
    if (planCmd !== null) return planCmd;
    const tid = currentTrace()?.traceId;
    // v3.1 首片 (P1#8): Turn 投影 begin (纯可观测, 失败不影响主链路)
    const turnInfo = this.turnProjection.begin(sessionKey, userMsg);
    let turnEnded = false;
    const _endTurn = (interrupted) => {
      if (turnEnded) return;
      turnEnded = true;
      const endInfo = interrupted ? this.turnProjection.abort(sessionKey) : this.turnProjection.complete(sessionKey);
      if (turnInfo) {
        this.bus?.emit("chat/turn/end", { sessionKey, ...turnInfo, ...endInfo, interrupted }, { source: "agent.chat" });
        this.protocolBus?.eq?.push?.({ type: "TASK_TURN_ENDED", payload: { sessionKey, ...turnInfo, ...endInfo, interrupted } });
      }
    };
    try {
    this.clearInterrupt(sessionKey); // 新一轮对话开始, 复位本会话的上一轮中断状态
    this.bus?.emit("chat/user", { userMsg, sessionKey }, { source: "agent.chat" });
    if (turnInfo) {
      this.bus?.emit("chat/turn/begin", { sessionKey, ...turnInfo }, { source: "agent.chat" });
      this.protocolBus?.eq?.push?.({ type: "TASK_TURN_BEGAN", payload: { sessionKey, ...turnInfo } });
    }
    let reply;
    // 内核自主决策: 高置信简单指令本地处理, 不调 LLM
    const local = (this.config.agent?.localIntent !== false) ? await this._localIntent(userMsg) : null;
    if (local) {
      reply = local;
    } else {
      // 模式分发: 编排策略可插拔 (react/single, 未来 plan-exec/multi-agent/graph 等)
      const modeName = mode || this.config.agent?.mode || "react";
      try {
        reply = await this.ctx.consume("modes").run(modeName, this, userMsg, { sessionKey });
      } catch (e) {
        error("LLM 调用失败:", e.message);
        reply = LLM_FAILED_HINT(e.message);
      }
    }

    // v3.0.1 (P1#4): 按轮读取工具使用标记 (traceId 路由), 无 trace 时回落兼容单槽
    const usedTools = tid ? this._turnsUsedTools.delete(tid) : this._lastTurnUsedTools;
    if (!tid) this._lastTurnUsedTools = false;
    if (this._notifyCb && usedTools) this.notify("[done] 任务完成 (工具执行)。");

    if (persist) {
      // 会话落盘 + L0/L1 记忆写入 + 记忆升降级协调 (afterTurn: L2 场景归档/经验学习/L3 画像刷新)
      await this._persistTurn(sessionKey, userMsg, reply, { afterTurn: true });
    }
    // 生命周期推进: 每次对话计数, 阶段转换 born→growing→mature
    this.bus?.emit("chat/reply", { reply }, { source: "agent.chat" });
    this._lifecycleTick();
    this.evolve && this.evolve.tick();
    // P2-2: 本轮若发生过 provider 降级, 在回复末尾附可见提示
    //   (放在 persist 之后 —— 写入会话历史/记忆的始终是模型原文, 提示只对当轮用户可见)
    const fb = this._takeFallback();
    if (fb) {
      reply = String(reply ?? "") + this._fallbackNotice(fb);
      this.notify(`[降级] ${fb.from} → ${fb.to}`);
    }
    // v3.1 首片 (P1#8): 本轮被中断 → turn 标 aborted, 否则正常 closed
    _endTurn(this.isInterrupted(sessionKey));
    return reply;
    } finally {
      // v3.0.1 (P1#4): 无论成功/失败都清本轮状态, 防长跑进程按 trace 泄漏
      if (tid) { this._turnsUsedTools.delete(tid); this._turnFallbacks.delete(tid); }
      // 2026-10-06 交接: 本轮草稿同样不跨过这一收口 (落库路径已在 _persistTurn 里排空, 这里只兜
      // 异常/中断路径)。persist=false 时**不清**: 那是 chatStream 降级重发的嵌套调用, 草稿要留给
      // 外层那一轮一起落档, 否则"降级前那次尝试"就又凭空消失了。
      if (persist) this._dropDrafts(sessionKey);
      // v3.1 首片: 异常路径 turn 未正常结束 → 标 aborted 收口
      _endTurn(true);
    }
    }, { sessionKey, channel: "chat", userMsg: String(userMsg).slice(0, 200) });
  }
  // 单轮落库公共路径 (chat / chatStream 共用, 2026-09-18 重构去重):
  //   会话事件日志追加 → L0/L1 记忆写入 → (可选) 记忆升降级协调 (L2 归档/经验学习/L3 画像刷新)
  // 注意: 写入的始终是"模型原文" —— 用户可见的降级提示由调用方在落库之后再拼接。
  // 2026-10-06 交接: 记忆层现在同时拿到"做了什么"(本轮工具证据) 与"错过什么"(轮内中间草稿)。
  //   证据取自 _pushTurn 刚落盘的折叠态事件 (与模型看到的同一份, 不在这里另起一套截断);
  //   两者在记忆层只作为**可重建上下文**落 memory/turns, 蒸馏输入仍是 user + 最终回复原文
  //   (见 src/memory/memory-ticker.js recordTurn 的注释), 所以工具抓来的网页原文不会变成"用户记忆"。
  async _persistTurn(sessionKey, userMsg, assistantText, { afterTurn = false, evidence = null, drafts = null } = {}) {
    this._pushTurn(sessionKey, String(userMsg), assistantText);
    const ev = evidence || this._durableTurnEvidence(sessionKey);
    const dr = drafts || this._takeDrafts(sessionKey);
    await this.memory.recordTurn(userMsg, assistantText, { evidence: ev, drafts: dr, sessionKey });
    if (afterTurn) {
      this.bus?.emit("memory/record", { userMsg, reply: assistantText }, { source: "agent.chat" });
      this.memorySvc.afterTurn(userMsg, assistantText);
    }
  }

  // 本轮的工具证据 = 刚被 _pushTurn 落盘的那批 tool/call + tool/result 事件 (已折叠)。
  // 从"落盘之后"往回取而不是从采集缓冲取, 有两个理由:
  //   ① 拿到的是磁盘事实 (与压缩/重建同一口径), 不依赖调用方是否显式传了证据;
  //   ② 采集缓冲已被 _pushTurn 排空, 再读一次只会读到空或读到上一轮的残留。
  // 上界 maxScan 条: 只在尾部找, 撞到本轮的 user 事件即停 —— 绝不全量扫历史。
  _durableTurnEvidence(sessionKey, { maxScan = 200 } = {}) {
    try {
      const store = this.sessionStore;
      if (!store || typeof store.replay !== "function") return [];
      const evs = store.replay(sessionKey || "default") || [];
      const out = [];
      for (let i = evs.length - 1, seen = 0; i >= 0 && seen < maxScan; i--, seen++) {
        const e = evs[i];
        if (!e || !e.data) continue;
        if (e.type === "tool/call" || e.type === "tool/result") { out.push({ type: e.type, data: e.data }); continue; }
        if (e.type === "user/message") break; // 本轮起点: 更早的证据属于上一轮, 不该记在这一轮名下
      }
      return out.reverse();
    } catch { return []; }
  }

  // 轮内草稿采集: 在**唯一调用点** (_llmWithTools) 包一层 apiChat, 只观察 resp.message。
  //   - 不改动 llm 实例本身 (Object.create 原型继承: 属性读取全部走原实例, 调用时 this 绑回原实例,
  //     原实例的内部状态/重试计数照常写在自己身上), 也不改动返回值 (策略层拿到同一个 response)。
  //   - 与 _installUsageTracking 的包装兼容: 它把 apiChat 挂在实例上, 这里经原型链调用它。
  //   - 采集失败 fail-open: 观察层坏了绝不能影响工具链。
  _withDraftCapture(llmInstance) {
    const llm = llmInstance;
    if (!llm || typeof llm.apiChat !== "function") return llm;
    const self = this;
    const wrapped = Object.create(llm);
    wrapped.apiChat = async (msgs, opts) => {
      const r = await llm.apiChat(msgs, opts);
      try { self._recordDraft(r && r.message); } catch { /* 观察失败: 证据降级, 主链照跑 */ }
      return r;
    };
    return wrapped;
  }

  _draftBucketKey() {
    const t = currentTrace();
    return (t && t.sessionKey) ? String(t.sessionKey) : DRAFT_UNATTRIBUTED;
  }

  // 只留文本 + 工具**名** (硬约束: 工具入参值一律不落记忆档 —— 与今日硬化后的 name-only 日志同口径)
  _recordDraft(message) {
    if (!message || typeof message !== "object") return;
    const text = message.content == null ? "" : String(message.content);
    const tools = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((c) => String((c && c.function && c.function.name) || (c && c.name) || "")).filter(Boolean)
      : [];
    if (!text.trim() && !tools.length) return;
    const k = this._draftBucketKey();
    let list = this._draftPending.get(k);
    if (!list) {
      while (this._draftPending.size >= DRAFT_BUCKETS_MAX) this._draftPending.delete(this._draftPending.keys().next().value);
      list = [];
      this._draftPending.set(k, list);
    }
    list.push({ text, tools });
    while (list.length > DRAFT_PENDING_MAX) list.shift();
  }

  // 排空本会话的草稿 (无归属桶兜底, 与证据采集同约定: 宁可挂到相邻轮次也不静默丢)
  _takeDrafts(sessionKey) {
    const k = sessionKey ? String(sessionKey) : "default";
    let list = this._draftPending.get(k) || [];
    if (!list.length) list = this._draftPending.get(DRAFT_UNATTRIBUTED) || [];
    this._draftPending.delete(k);
    this._draftPending.delete(DRAFT_UNATTRIBUTED);
    return list;
  }

  // 异常/未落库轮次的收口: 草稿绝不跨过本轮 (长跑进程泄漏闸门, 与 _turnsUsedTools 同一口径)
  _dropDrafts(sessionKey) {
    if (!this._draftPending) return;
    this._draftPending.delete(sessionKey ? String(sessionKey) : "default");
    this._draftPending.delete(DRAFT_UNATTRIBUTED);
  }


  // 生命周期: 每次对话计数 + 阶段转换 (委托 ans/lifecycle 模块)
  _lifecycleTick() {
    this.lifecycle.tick();
  }

  // 生命周期摘要 (可观测, 委托 ans/lifecycle 模块)
  lifecycleStatus() {
    return this.lifecycle.status();
  }

  // Reward 行为倾向可观测 (⑦内分泌)
  rewardStatus() {
    return rewardStatus(this);
  }

  // 排泄治理可观测 (⑤遗忘-归档)
  evictionStatus() {
    return evictionStatus(this);
  }

  // 立即手动触发一次记忆治理扫描 (冗余识别 + 冷热分层 + TTL 时效归档)
  runMemoryEviction() {
    const report = evictionScan(this);
    const ttl = this.sweepMemoryTtl();
    if (report && typeof report === "object") report.ttl = ttl;
    return report;
  }

  // TTL 时效治理 (2026-10-04 接线): FactStore.sweepExpired 写好了却从没被 src 调用过
  //   (只有测试直接调), 等于"过期记忆"这一层治理是空的 —— 带 ttlDays 的条目 (如 legion-board
  //   7 天临时板报) 和超过 memory.ttl_days 未访问的条目永久驻留, 挤占 max_facts 名额,
  //   把真正常用的记忆当"最弱"裁掉。软归档可 restore 回滚, 不是硬删。
  sweepMemoryTtl() {
    const ttlDays = Number(this.config.memory?.ttl_days ?? 90);
    if (!Number.isFinite(ttlDays) || ttlDays <= 0) return { swept: 0, disabled: true };
    try {
      const r = this.facts?.sweepExpired?.({ ttlDays }) || { swept: 0 };
      if (r.swept) info(`[memory] TTL 治理: 软归档 ${r.swept} 条 (超过 ${ttlDays} 天未访问, 可用 restore 回滚)`);
      return r;
    } catch (e) {
      debug(`[agent/index] TTL 治理失败: ${e && e.message ? e.message : e}`);
      return { swept: 0, error: e && e.message ? e.message : String(e) };
    }
  }

  // 免疫闸门可观测 (⑧安全治理)
  guardStatus() {
    return guardStatus(this);
  }

  // 单次审批: 放行一个危险命令 verb (一次用完自动失效)
  approveGuard(verb) {
    return this.__guard ? this.__guard.approveOnce(String(verb)) : null;
  }


  // 流式对话: 返回 { text, history } 或回调 onDelta 推送增量
  // 支持工具循环: 若消息触发工具调用, 走 _llmWithTools (触发 onTool 事件推送工具活动),
  // 最终结果作为一次 delta 推送; 否则走 streamChat 逐字流式 [P1#7]
  async chatStream(userMsg, { sessionKey = "default", onDelta, onTool, onStep } = {}) {
    // 重构第三刀: 入口生成 traceId (无 LLM 降级 chat 时嵌套新 trace, 独立可追踪)
    return runWithTrace(async () => {
    if (!this.llm) return this.chat(userMsg, { sessionKey });
    // 支出预算闸门 (2026-10-03l): 超限后不再发请求, 直接以提示文案收尾本轮流
    if (this._budgetExceeded) { const m = this._budgetMessage(); if (onDelta) onDelta(m); return m; }
    // /plan 与 /do 同样在流式入口先行消费 (与 chat 一个口径, Web UI 打字即生效)
    const planCmd = this._consumePlanCommand(userMsg, sessionKey);
    if (planCmd !== null) { onDelta && onDelta(planCmd); return planCmd; }
    this.clearInterrupt(sessionKey); // 新一轮对话开始, 复位本会话中断状态
    // 内核自主决策: 高置信简单指令本地处理
    const local = (this.config.agent?.localIntent !== false) ? await this._localIntent(userMsg) : null;
    if (local) { onDelta && onDelta(local); return local; }
    const system = this._context(userMsg);
    const history = await this._loadHistory(sessionKey);
    const messages = [{ role: "system", content: system }, ...history, { role: "user", content: this._userContent(userMsg) }];

    // 多模态路由: 消息含图片时优先 vision provider (否则图片发到文本后端无意义)
    const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c && c.type === "image_url"));
    const activeLLM = hasImage ? (this._visionLLM() || this.llm) : this.llm;

    // v3.0.1 (P1#4): 按轮回调注册 (traceId 路由) —— 并发流式会话互不覆盖,
    // 替代原 prev/restore 单槽模式 (并发下 A 结束会抹掉 B 的回调, B 结束会泄漏 A 的回调)
    const tid = currentTrace()?.traceId;
    if (tid && (onTool || onStep)) {
      this._turnCbs.set(tid, {
        onTool: onTool ? (ev) => { try { onTool(ev); } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); } } : null,
        onStep: onStep ? (ev) => { try { onStep(ev); } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); } } : null,
      });
    }

    // v3.1 首片 (P1#8): Turn 投影 begin (纯可观测)
    const turnInfo = this.turnProjection.begin(sessionKey, userMsg);
    let turnEnded = false;
    const _endTurn = (interrupted) => {
      if (turnEnded) return;
      turnEnded = true;
      const endInfo = interrupted ? this.turnProjection.abort(sessionKey) : this.turnProjection.complete(sessionKey);
      if (turnInfo) {
        this.bus?.emit("chat/turn/end", { sessionKey, ...turnInfo, ...endInfo, interrupted }, { source: "agent.chatStream" });
        this.protocolBus?.eq?.push?.({ type: "TASK_TURN_ENDED", payload: { sessionKey, ...turnInfo, ...endInfo, interrupted } });
      }
    };

    let reply;
    // 逐字流式的可中断句柄 (2026-10-04): interrupt(sessionKey) → abort → fetch 立即断。
    // 此前 interrupt 只翻协作标志位, 而流式路径不看它 —— 用户关掉网页后上游照样把整段生成完并计费。
    const ac = new AbortController();
    this._streamAborts.set(sessionKey, ac);
    let streamed = "";
    try {
      try {
      // 无工具开启: 直连后端可逐字流式 (恢复打字机效果); 有工具时走工具循环保轨迹完整 [复审 P2]
      if (!this.toolsEnabled && activeLLM.supportsStream) {
        reply = await activeLLM.streamChat(messages, {
          signal: ac.signal,
          onDelta: (d) => { streamed += d; onDelta && onDelta(d); },
        });
      } else {
        reply = await this._llmWithTools(messages, activeLLM);
        if (onDelta) onDelta(reply);
      }
    } catch (e) {
      if (ac.signal.aborted) {
        // 用户主动中断: 保留已流出的部分收尾。绝不降级重发 —— 走 chat() 等于无视"停下来",
        //   再花一次 token 生成用户刚刚叫停的回答。
        warn("chatStream 被中断, 保留已生成部分:", e.message);
        reply = streamed || "[已中断]";
      } else {
        warn("chatStream 失败, 降级非流式 chat:", e.message);
        // persist:false (2026-10-04): 降级调用只负责产出回复, 落库仍由下面 _persistTurn 单点完成。
        //   原实现两处都落库 → 会话历史重复一轮, 记忆重复计数/重复升降级。
        reply = await this.chat(userMsg, { sessionKey, persist: false });
        if (onDelta) onDelta(reply);
      }
    } finally {
      // v3.0.1 (P1#4): 清本轮按回注册 (原 prev/restore 模式已废弃)
      if (tid) this._turnCbs.delete(tid);
      this._takeFallback(); // 丢弃本轨降级事实 (chatStream 不向用户展示降级提示)
      if (this._streamAborts.get(sessionKey) === ac) this._streamAborts.delete(sessionKey);
    }
    // 落库用模型原文 (剥掉本轮降级提示), 与 chat 共用同一路径
    // afterTurn:true (2026-10-04): 与 chat 对齐。流式轮次此前不推进记忆升降级 ——
    //   全程用 Web UI 的会话只有 L0/L1 在长, L2 场景归档/经验学习/L3 画像刷新半速运转。
    await this._persistTurn(sessionKey, userMsg, this._stripFallbackNotice(reply), { afterTurn: true });
    // v3.1 首片 (P1#8): 本轮被中断 → turn 标 aborted, 否则正常 closed
    _endTurn(this.isInterrupted(sessionKey));
    return reply;
    } catch (e) {
      // v3.1 首片: 异常路径 turn 收口为 aborted 后原样抛出 (chatStream 自身无兜底, 保持原语义)
      throw e;
    } finally {
      // 2026-10-04: 工具循环按 trace 登记的状态此前只在 chat 的 finally 里回收,
      //   流式轮次跑完后 _turnsUsedTools/_turnFallbacks 的条目永久残留 (长跑进程无界增长)。
      if (tid) { this._turnsUsedTools.delete(tid); this._turnFallbacks.delete(tid); }
      // 2026-10-06 交接: 轮内草稿同一收口 (成功路径已由 _persistTurn 排空, 这里只兜异常/中断)
      this._dropDrafts(sessionKey);
      _endTurn(true);
    }
    }, { sessionKey, channel: "chatStream" });
  }

  // 多 provider 回退: 依次尝试, 失败切下一个
  // 多 provider 并发健康探测 + 回退: 只对可用 provider 调用, 避免串行等待 180s 超时
  async _llmWithFallback(seedMessages) {
    let clients = (this.allProviders || []).length ? this.allProviders : [this.llm];
    // 多模态路由: 消息含图片 (image_url 块) 时, 优先 vision provider, 避免图片发到文本后端浪费
    const hasImage = seedMessages.some((m) => Array.isArray(m.content) && m.content.some((c) => c && c.type === "image_url"));
    if (hasImage) {
      const visionClients = clients.filter((c) => c.vision);
      if (visionClients.length) clients = visionClients;
      else info("消息含图片但无 vision provider, 图片将无法被模型理解 (请配置 vision: true 的 provider)");
    }
    // 工具类任务: 优先原生 tool_calls 后端 (http)。
    // openclaw 是完整 agent 运行时, 会拒绝围栏协议(视为伪协议); 实测 http 原生 tool_calls 全链路通过。
    // v2.5.0: 外部引擎底座已移除, 仅 http 后端 (原生 tool_calls + 文本工具修复)。
    if (this.toolsEnabled) {
      const native = clients.filter((c) => c.supportsNativeToolCalls);
      const fence = clients.filter((c) => !c.supportsNativeToolCalls);
      if (native.length) clients = [...native, ...fence];
    }
    if (clients.length > 1) {
      // 健康探测 TTL 缓存 (2026-10-03m): 每轮 chat 都全量探活 = 高频对话下每次多一段串行探活延迟。
      // TTL 内复用上次结果 (默认 30s, config.agent.health_cache_ms 可调, 0 = 关闭缓存);
      // provider 集合变化 (键不匹配) 时重新探测。
      const ttl = Number(this.config?.agent?.health_cache_ms ?? 30000);
      const cacheKey = clients.map((c) => c.model || c.name).join("|");
      const cached = ttl > 0 && this._healthCache && this._healthCache.key === cacheKey
        && Date.now() - this._healthCache.ts < ttl ? this._healthCache.states : null;
      if (cached) {
        const healthy = clients.filter((_, i) => cached[i]);
        if (healthy.length) clients = healthy;
      } else {
        try {
          const states = await Promise.all(clients.map((c) => c.health ? c.health() : Promise.resolve(true)));
          this._healthCache = { ts: Date.now(), key: cacheKey, states };
          const healthy = clients.filter((_, i) => states[i]);
          if (healthy.length) clients = healthy;
          else info("所有 provider 健康探测失败, 按原配置顺序尝试兜底");
        } catch (e) {
          warn("health 探测异常, 按原顺序回退:", e.message);
        }
      }
    }
    let lastErr = null;
    // v1.0.8 修复 (P2-2): 记录"本轮发生了降级切换"这一事实并对外广播。
    //   原实现只在日志里 warn 一句, 用户侧完全静默 —— 拿到的是备用模型的回答却无从感知。
    //   注意: **不改动返回值** (回退语义本身保持透明, chaos 测试锁死了成功时返回原始文本)。
    const failed = [];
    for (const client of clients) {
      try {
        const out = await this._llmWithTools(seedMessages, client);
        if (failed.length) {
          // v3.0.1 (P1#4): 降级事实按轮存 (traceId 路由), 并发会话各记各的
          const fb = {
            from: failed[0].model,
            to: client.model,
            reason: failed[0].message,
            chain: failed.map((f) => f.model),
            ts: Date.now(),
          };
          const _tid = currentTrace()?.traceId;
          if (_tid) this._turnFallbacks.set(_tid, fb); else this._lastFallback = fb;
          this.bus?.emit("llm/fallback", fb, { source: "agent._llmWithFallback" });
          warn(`provider 降级: ${fb.from} 不可用 → 已切至 ${client.model} (${failed[0].message})`);
        }
        return out;
      } catch (e) {
        lastErr = e;
        failed.push({ model: client.model, message: e.message });
        warn("provider 失败, 切换下一个:", client.model, e.message);
      }
    }
    throw lastErr || new Error("所有 provider 均失败");
  }

  // 降级原因"人话化": 原始错误常带整段 JSON 报错体 (含 key 片段/内部字段),
  // 既不适合直接给用户看, 也没必要。这里归一到几类常见故障。
  _shortReason(msg) {
    const s = String(msg ?? "");
    if (/40[13]|unauthor|api.?key|authentication|invalid_request_error/i.test(s)) return "鉴权失败 (key 无效或已过期)";
    if (/429|rate.?limit|too many requests|quota|insufficient/i.test(s)) return "限流或额度不足";
    if (/timeout|timed out|abort|ETIMEDOUT/i.test(s)) return "请求超时";
    if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|socket hang up/i.test(s)) return "连接失败";
    if (/\b50[0-9]\b/.test(s)) return "服务端错误";
    const brief = s.replace(/\{[\s\S]*$/, "").replace(/\s+/g, " ").trim();
    return (brief || "调用失败").slice(0, 60);
  }

  // 降级提示文案 (用户可见) —— 由 chat/chatStream 在回复末尾追加
  _fallbackNotice(fb) {
    if (!fb) return "";
    const chain = fb.chain && fb.chain.length > 1 ? ` (失败链: ${fb.chain.join(" → ")})` : "";
    return `${FALLBACK_NOTICE_TAG}主模型 ${fb.from} 不可用: ${this._shortReason(fb.reason)}。本轮回答已自动切换到 ${fb.to}${chain}。`;
  }

  // 从回复中剥掉降级提示: 保证写入会话历史/记忆的是模型原文, 提示只面向当轮用户可见
  _stripFallbackNotice(text) {
    const s = String(text ?? "");
    const i = s.indexOf(FALLBACK_NOTICE_TAG);
    return i === -1 ? s : s.slice(0, i).trimEnd();
  }

  // B2: 审批缓存 key 计算 — 仅命令类工具参与 (非命令工具改参数不放行, 防止漏审对象被缓存)
  // 复用 command-guard 的 normalizeCommand (去引号防绕过 + 合并空白), 防 `echo  a` / `echo "a"` 变体
  //   造成同命令不同 key 或异命令同 key 导致漏审。返回 null = 不缓存该工具。
  _approvalCacheKey(name, args) {
    if (!/run_command|shell|exec|bash|code_act/i.test(String(name))) return null;
    const cmd = args?.command ?? args?.cmd ?? args?.code ?? args?.script;
    if (typeof cmd !== "string" || !cmd.trim()) return null;
    const norm = normalizeCommand(cmd);
    return norm ? `${name}:${norm}` : null;
  }

  // 统一工具执行入口 (http 原生 tool_calls + 文本工具调用修复) [P0#1]
  // v1.0.7: 移除未使用的 llmInstance 死参数, 所有工具执行统一走此入口 (trace/事件只此一份)
  // 2026-09-17 体检修复: start/done 事件带唯一 callId。
  //   原先 Web UI 只能按"工具名"匹配起止事件, 同一轮里出现两个 read_file 时,
  //   后到的事件会回填到前一张卡片上 (public/app.js 旧实现注释里也自述了这个缺陷)。
  // v3.0 (codex 对齐): PreToolUse 钩子(可否决/改参) → 权限引擎(deny/ask/allow) → 执行 → PostToolUse 钩子
  async _runTool(name, args) {
    const t0 = Date.now();
    // v3.0.1 (P1#4): 按轮标记"用过工具" (traceId 路由), 并发会话互不串台; 无 trace 时回落单槽
    const _tid = currentTrace()?.traceId;
    if (_tid) this._turnsUsedTools.add(_tid); else this._lastTurnUsedTools = true;
    // 原型污染消毒: 剥离 __proto__/constructor/prototype 键 (LLM JSON 可携带恶意键)
    const stripped = stripProtoKeys(args);
    if (stripped.stripped.length) {
      this.tracer.event("security/proto-stripped", { tool: name, keys: stripped.stripped });
      args = stripped.clean;
    }
    const callId = `t${++this._toolCallSeq}-${t0.toString(36)}`;

    // ① 准入: PreToolUse 钩子链 (可否决/改参) + 权限引擎 (deny/ask/审批缓存)
    const admit = await this._admitToolCall(name, args, callId, t0);
    if (!admit.ok) return admit.error;
    args = admit.args;

    this.bus?.emit("tool/call", { name, args, callId }, { source: "agent._runTool" });
    this._emitTool({ type: "start", id: callId, tool: name, args, ts: Date.now() });
    // let 而非 const: 后处理(注入标注/病历回灌)与 PostToolUse 钩子都会追加内容
    // (2026-09-18 修复: 原为 const, 钩子追加时抛 "Assignment to constant variable" 被 catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); } 静默吞掉)
    let result = await this.tools.call(name, args, { agent: this, timeoutMs: Number(this.config.agent?.tool_timeout_ms) || 0 });
    const ok = !result.startsWith(TOOL_ERROR_PREFIX);

    // ② 结果加工: 注入扫描 → 事件/轨迹落库 → 故障病历回灌 (均可能改写 result)
    result = this._processToolOutcome(name, args, callId, result, ok, t0);

    // ③ PostToolUse 钩子链 (可附加上下文, 追加在结果尾部)
    if (this.hooks && ok) {
      try {
        const h = await this.hooks.emit("PostToolUse", { tool: name, args, result, callId });
        // 2026-09-18 修复 (第二处): 原实现 map h.results 里的 r.additionalContext,
        //   但 results 条目结构是 { result: res }, 恒取到 undefined —— 收集结果实际在
        //   h.additionalContext (hooks/index.js 统一收集)。原特性从未生效。
        const extra = (Array.isArray(h?.additionalContext) ? h.additionalContext : [])
          .filter(Boolean).map(String).join("\n");
        if (extra) result = result + "\n" + extra;
      } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); }
    }
    this._emitToolDone(callId, name, args, ok, Date.now() - t0, result);
    return result;
  }

  // 准入链 (从 _runTool 抽出, 原 136 行中占 50 行): 钩子 + 权限, 返回 { ok, args } 或 { ok:false, error }
  async _admitToolCall(name, args, callId, t0) {
    // --- v3.0: PreToolUse 钩子链 (claude-code 语义: 可否决/可改参) ---
    if (this.hooks) {
      try {
        const h = await this.hooks.emit("PreToolUse", { tool: name, args, callId });
        if (h && h.blocked) {
          const msg = `[hook] 工具 ${name} 被 PreToolUse 钩子否决: ${h.reason || "无理由"}`;
          this.tracer.event("tool/hook-blocked", { tool: name, reason: h.reason });
          this._emitToolDone(callId, name, args, false, Date.now() - t0, msg);
          return { ok: false, error: TOOL_ERROR_PREFIX + msg };
        }
        if (h && h.args && typeof h.args === "object") args = h.args; // 钩子改参
      } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); } // 钩子自身异常不阻断主链
    }

    // --- v3.0: 权限引擎 (codex AskForApproval + SandboxPolicy + 规则链) ---
    if (this.permissions) {
      try {
        // plan 模式按会话传给引擎 (2026-10-05): sessionKey 从当前 trace 取 (chat/chatStream
        // 入口写入), 无 trace 的裸调用回落 "default" —— 与中断路由同一套口径。
        const permCtx = { callId, planEnabled: this.isPlanMode(currentTrace()?.sessionKey || "default") };
        const perm = await this.permissions.check(name, args, permCtx);
        if (perm.decision === "deny") {
          // modelHint (若引擎挂了) 原样附在拒绝消息后带给模型 —— plan 拒绝必须可行动
          // (standing rule: 模型无从自纠的拒绝只会诱发重试)。无 modelHint 的既有拒绝逐字节不变。
          const msg = `[permission] 工具 ${name} 被拒绝: ${perm.reason || "命中 deny 规则"}`
            + (perm.modelHint ? ` ${perm.modelHint}` : "");
          this.tracer.event("tool/perm-denied", { tool: name, reason: perm.reason });
          this._emitToolDone(callId, name, args, false, Date.now() - t0, msg);
          return { ok: false, error: TOOL_ERROR_PREFIX + msg };
        }
        if (perm.decision === "ask") {
          // B2: 审批缓存 (codex ApprovalStore 语义) — 会话内相同命令已批准过则不重复 ask
          // 仅命令类工具参与; 缓存 key = `${tool}:${normalizeCommand(command)}`
          // 命中 = 本次会话已显式批准, 视为放行; 拒绝/超时永不入缓存
          const cacheKey = this._approvalCacheKey(name, args);
          const cached = cacheKey && this.config.agent?.approval_cache !== false && this._approvalCache.get(cacheKey);
          let upd = null;
          let headlessDenied = false;
          if (cached) {
            this.tracer.event("approval/cache-hit", { tool: name, key: cacheKey });
            upd = {}; // 视为已批准
          } else if (!this.hasApprovalSurface() && this.config.agent?.approval_headless_wait !== true) {
            // headless 快速拒绝 (2026-10-04): 本进程没有任何能把审批递到人面前的入口,
            //   等满 approval_timeout_ms (默认 120s) 的结果必然是超时拒绝 —— 纯死等,
            //   既烧光任务时间预算 (taskbench delete-file 就这么失败的), 又只回一句
            //   "审批被拒绝或超时", 模型无从判断该换路子还是该报错。现在立即拒绝并在下面给出可执行的下一步。
            upd = null;
            headlessDenied = true;
            this.tracer.event("approval/headless-deny", { tool: name, reason: perm.reason });
          } else {
            upd = await this._requestApproval({ tool: name, args, reason: perm.reason });
            // 仅批准写入缓存 (拒绝/超时永不入缓存, 防止漏审命令被放行)
            // v3.2.3 (P2#12): 超上限先淘汰最早插入项 (Map 保持插入序, FIFO 淘汰足够 ——
            // 缓存语义是"会话内已批准过", 淘汰最旧批准只影响是否重复 ask, 不影响安全)
            if (upd && cacheKey) {
              if (this._approvalCache.size >= this._approvalCacheMax) {
                const oldest = this._approvalCache.keys().next().value;
                this._approvalCache.delete(oldest);
              }
              this._approvalCache.set(cacheKey, perm.reason || "");
            }
          }
          if (upd && typeof upd === "object" && upd.updatedInput) args = upd.updatedInput;
          if (!upd) {
            // 2026-10-05 (apply_patch 无目标补丁"已修复"幻觉复盘): 权限层对"补丁确定不了
            // 落点"这类请求格式错误会挂 modelHint (可行动的修法文案)。headless 拒绝消息
            // 原样带上, 模型才能自纠改写; 无 modelHint 的工具 (run_command/delete_file/rm)
            // 消息与此前逐字节相同, 审批行为不变。
            const headlessBase = `[permission] 工具 ${name} 需要人工审批, 但当前进程没有审批入口 (无 Web UI/服务在听), 已直接拒绝。`;
            const msg = headlessDenied
              ? (perm.modelHint
                  ? headlessBase + perm.modelHint
                  : headlessBase + `请改用无需审批的等价做法; 确需该操作时由用户启动 ppx-serve 打开 Web UI 批准, `
                    + `或调整 config (agent.approval_mode / security.allow_all)。不要重复发起同一请求。`)
              : `[permission] 工具 ${name} 审批被拒绝或超时`;
            this.tracer.event("tool/perm-rejected", { tool: name, headless: headlessDenied });
            this._emitToolDone(callId, name, args, false, Date.now() - t0, msg);
            return { ok: false, error: TOOL_ERROR_PREFIX + msg };
          }
        }
      } catch (e) {
        // 2026-10-03 修复 (P1): 原实现吞异常后放行 (fail-open) —— 权限引擎自己崩了
        // 防线反而全开, 与 permissions 内核 fail-closed (应答者异常 → deny) 口径相反。
        // 改为 fail-closed: 引擎异常 = 防线失效, 拒绝执行并给可判读错误。
        const msg = `[permission] 权限引擎异常, 已拒绝执行工具 ${name}: ${e && typeof e.message === "string" ? e.message : String(e)}`;
        this.tracer.event("tool/perm-error", { tool: name });
        this._emitToolDone(callId, name, args, false, Date.now() - t0, msg);
        return { ok: false, error: TOOL_ERROR_PREFIX + msg };
      }
    }
    return { ok: true, args };
  }

  // 结果加工 (从 _runTool 抽出): 注入扫描 → 事件/轨迹 → 故障病历回灌; 返回可能被改写的 result
  _processToolOutcome(name, args, callId, result, ok, t0) {
    // 提示注入防线 (2026-10-03 红队驱动): 工具输出 = 不可信数据。
    // 疑似注入 → 原文外包"不可信"标注 + 安全事件上 tracer (数据不删, 指令不执行语义靠标注传达给模型)。
    try {
      // 2026-10-04 修复: 原 `!result.startsWith("{")` 把 JSON 结果整体跳过, 而工具输出绝大多数
      //   是 JSON.stringify —— 注入藏在字符串值里时零防护。scanToolResult 会解码后再扫一遍叶子。
      if (ok && typeof result === "string" && result.length > 20) {
        const scan = scanToolResult(result);
        if (scan.suspicious) {
          reportSuspicious(name, scan, { tracer: this.tracer });
          result = wrapUntrusted(name, result, scan);
        }
      }
    } catch { /* 扫描异常不阻断工具结果 */ }
    if (name === "spawn_agent") this.tracer.event("agent/spawn", { args });
    this.bus?.emit("tool/result", {
      name,
      callId,
      ok,
      args,
      durationMs: Date.now() - t0,
      error: ok ? null : result.slice(0, 300),
    }, { source: "agent._runTool" });
    this.traces.record({
      tool: name,
      args,
      result: result.slice(0, 800),
      ok,
      durationMs: Date.now() - t0,
      error: ok ? null : result,
    });

    // --- 故障病历闭环 (2026-10-03 接线: 该模块此前"能力就绪、链路未接", 零消费) ---
    // 写: 本次失败落成结构化病历 (工具 / 错误文本 / 归类 / trace 引用)
    // 读: 检索历史同类故障, 把"已知根因 + 修法"附在错误结果之后, 模型不必从零推理
    // 顺序: 先 search 再 record —— 否则本次失败会命中自己
    if (!ok && this.failures) {
      try {
        const errText = String(result).slice(0, 300);
        const past = this.failures.search({ tool: name, error: errText, limit: 2 });
        const ep = this.failures.record({ tool: name, error: errText, category: classifyFailure(errText), traceRef: callId });
        // 有根因/修法档案的直接给结论; 只有原始错误的给"复发计数"信号
        const withFix = past.filter((p) => p.fix || p.rootCause);
        if (withFix.length) {
          const lines = withFix.map((p) => `- [${p.tool}/${p.category}] ${p.rootCause || p.error}${p.fix ? ` → 修法: ${p.fix}` : ""}`);
          result = result + "\n【历史同类故障·供参考】\n" + lines.join("\n");
          this.tracer.event("failure/history-hit", { tool: name, hits: lines.length, mode: "prescription", episodeId: ep.id });
        } else if (past.length) {
          result = result + `\n【复发警告】同类失败历史已有 ${past.length} 次记录 (工具 ${name}, 归类 ${ep.category}), 请勿重复相同调用, 换策略或先排查环境。`;
          this.tracer.event("failure/history-hit", { tool: name, hits: past.length, mode: "repeat-warning", episodeId: ep.id });
        }
      } catch { /* 病历读写异常不阻断工具结果 */ }
    }
    return result;
  }

  // v3.0: 统一 done 事件发射 (原内联三处, 收敛为一个私有方法)
  _emitToolDone(callId, name, args, ok, durationMs, result) {
    this._emitTool({ type: "done", id: callId, tool: name, args, ok, durationMs, result: String(result == null ? "" : result).slice(0, 300), ts: Date.now() });
  }

  // 审批可达面登记 (2026-10-04): HTTP/Web UI 通道 connect 时登记, disconnect 时注销。
  registerApprovalSurface(tag) { this._approvalSurfaces.add(String(tag)); }
  unregisterApprovalSurface(tag) { this._approvalSurfaces.delete(String(tag)); }
  hasApprovalSurface() { return this._approvalSurfaces.size > 0; }

  // "进程里有活人能接住反问" 的更精确谓词 (2026-10-05, clarify 无应答兜底):
  // hasApprovalSurface 只覆盖挂了 Web UI 的进程; src/cli.js 的终端聊天有人但从不登记审批面
  // (审批在该进程本来就走 headless 快拒, 不能为 clarify 放宽)。clarify 用本谓词,
  // 审批链路继续用 hasApprovalSurface, 两口径互不影响。
  markHumanChannel(on = true) { this._humanChannel = !!on; }
  hasHumanChannel() { return this.hasApprovalSurface() || this._humanChannel === true; }

  // v3.0 (codex approval flow): 产生审批请求并等待 Web UI/通道裁决
  // 返回: { updatedInput? } 表示批准; null 表示拒绝/超时
  _requestApproval({ tool, args, reason }) {
    return new Promise((resolve) => {
      const id = `ap_${++this._approvalSeq}_${Date.now().toString(36)}`;
      const kind = /run_command|shell|exec|bash/.test(tool) ? "bash"
        : /edit|write|apply_patch|create_file/.test(tool) ? "edit"
        : /plan/.test(tool) ? "plan" : "tool";
      const summary = args?.command || args?.cmd || args?.path || args?.file_path || JSON.stringify(args || {}).slice(0, 160);
      const req = { id, kind, tool, args, summary: String(summary || ""), reason: reason || "", ts: Date.now() };
      const timeoutMs = Number(this.config.agent?.approval_timeout_ms) || 120000;
      const entry = { req, resolve, timer: null };
      entry.timer = setTimeout(() => {
        this._pendingApprovals.delete(id);
        resolve(null); // 超时视为拒绝 (codex: 等待审批超时不静默放行)
      }, timeoutMs);
      this._pendingApprovals.set(id, entry);
      // 事件外投: SSE onApproval / tracer / 协议总线
      this.tracer.event("approval/requested", { id, tool, kind });
      this.protocolBus?.eq?.push?.({ type: "APPROVAL_REQUESTED", payload: req });
      this.bus?.emit("approval/requested", req, { source: "agent.approval" });
    });
  }

  // v3.0: 审批裁决入口 (HTTP POST /api/approvals/:id 调用)
  // 返回 true 表示存在该审批且已裁决
  resolveApproval(id, decision) {
    const entry = this._pendingApprovals.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this._pendingApprovals.delete(id);
    // 2026-10-07 (P2-14): decision 新增 "always" —— codex 的 "always allow this command" 语义:
    //   批准本次, 并把该命令写入会话审批缓存 (与 _runTool 内命中缓存的 key 同源), 此后同会话
    //   相同命令不再弹审批卡。仅命令类工具能算出 key (见 _approvalCacheKey), 其余等价于 approve。
    const approved = decision === "approve" || decision === "always";
    if (decision === "always" && entry.req) {
      const key = this._approvalCacheKey(entry.req.tool, entry.req.args);
      if (key) {
        if (this._approvalCache.size >= this._approvalCacheMax) {
          const oldest = this._approvalCache.keys().next().value;
          this._approvalCache.delete(oldest);
        }
        this._approvalCache.set(key, entry.req.reason || "always");
      }
    }
    this.tracer.event("approval/resolved", { id, decision });
    this.protocolBus?.eq?.push?.({ type: "APPROVAL_RESOLVED", payload: { id, decision } });
    entry.resolve(approved ? {} : null);
    return true;
  }

  // v3.0: 待审批清单 (HTTP GET /api/approvals/pending)
  pendingApprovals() {
    return [...this._pendingApprovals.values()].map((e) => e.req);
  }

  // LLM + 工具调用循环 (带 provider 回退)
  // 重构第一刀 (2026-09-14): 循环驱动/探索熔断/重复检测/溢出降档/错误重试
  // 全部收敛到 src/core/policy.js runToolLoop, 此处只注入依赖, 策略可独立测试/替换。
  async _llmWithTools(seedMessages, llmInstance = this.llm) {
    return runToolLoop({
      seedMessages,
      // 2026-10-06 交接: 这一层是 runToolLoop 的唯一调用点, 也是唯一能"看得见每次 apiChat 返回"
      // 的位置 —— 包一层只观察轮内 assistant 中间草稿 (含被后置校验丢弃的错答), 返回值原样透传。
      llm: this._withDraftCapture(llmInstance),
      tools: this.toolsEnabled ? this.tools.toOpenAI() : [],
      config: this.config,
      // v3.0.1 (P1#3): 从 ALS trace 取当前会话 key, 只响应该会话的中断 (并发不串台)
      isInterrupted: () => this.isInterrupted(currentTrace()?.sessionKey),
      onStep: (ev) => this._emitStep(ev),
      runTool: (name, args) => this._runTool(name, args),
      shrinkMessages: (messages, budget) => this._shrinkMessagesForOverflow(messages, budget),
      histTokenCap: () => this._histTokenCap(),
      onEvent: (type, payload) => { this._onPolicyEvent(type, payload); this.tracer.event(type, payload); },
      // v1.6.0 第四刀: 超时重试决策 (幂等才重试) + 超时预算查询 (事件采集)
      isIdempotentTool: (name) => this._toolIdempotent(name),
      toolTimeoutOf: (name) => this._toolTimeoutOf(name),
      // 回合后置条件闸门 (2026-10-05): 只交付"看得见的事实", 开关/预算由 ToolLoopPolicy 读 config。
      //   这里刻意只传 rootDir + 能力查询闭包 —— 不在本文件写 config.x.y 字面量, 配置一致性
      //   反查因此不受扰动; exec 留空即用内置 node --check, 测试可注入假 exec 计数 spawn。
      postCondition: this._postConditionCtx(),
    });
  }

  // 后置校验上下文: 校验器需要 (1) 工作区根 (2) 工具能力元数据, 拿不到就整段不启用 (gate=null)。
  // 全程 try 包裹: 闸门取上下文失败绝不能变成对话不可用 (fail-open, 与 policy 侧同则)。
  _postConditionCtx() {
    try {
      if (!this.root) return null;
      const tools = this.tools;
      return {
        rootDir: this.root,
        capabilityOf: typeof tools?.getCapability === "function"
          ? (name) => { try { return tools.getCapability(name); } catch { return null; } }
          : null,
      };
    } catch { return null; }
  }

  // 政策事件回流: 默认转 tracer 埋点; 对会沉淀智力的关键事件 (B3 反思闸门拦停) 额外写入经验库
  // 反思闭环: 硬拒绝类失败不只"这次不重试", 还自动记住"以后不这么干"。
  //   幂等: Experience.learn 本身去重 (同 lesson 命中 uses+1), 高频触发只会强化不会写放大。
  _onPolicyEvent(type, payload = {}) {
    try {
      if (type === "tool/self_review_stop" && this.experience) {
        this.experience.learn({
          task: "工具调用被反思闸门拦停",
          outcome: "硬拒绝类错误 (黑名单拦截/审批被拒/权限拒绝/DENY_HINT), 盲目重试或改写命令会绕过安全闸门",
          lesson: "硬拒绝类错误不应重试或改写命令绕过 — 停下说明原因或请用户调整 security 配置。工具: " + String(payload?.reason || ""),
          tags: ["auto-self-review", "tool-denied"],
        });
      }
    } catch { /* 经验沉淀失败不阻断主链 (不因记教训崩掉干活) */ }
  }

  // 工具是否幂等 (可安全超时重试): 读取工具元数据, 未声明默认 true (只读/查询类)
  _toolIdempotent(name) {
    try {
      const m = this.tools && typeof this.tools.metaOf === "function" ? this.tools.metaOf(name) : null;
      return m ? !!m.idempotent : true;
    } catch { return true; }
  }

  // 工具超时预算 (ms, 0/无声明 = 用全局默认; 事件采集用)
  _toolTimeoutOf(name) {
    try {
      const m = this.tools && typeof this.tools.metaOf === "function" ? this.tools.metaOf(name) : null;
      return m ? (m.timeoutMs > 0 ? m.timeoutMs : (Number(this.config.agent?.tool_timeout_ms) || 0)) : (Number(this.config.agent?.tool_timeout_ms) || 0);
    } catch { return Number(this.config.agent?.tool_timeout_ms) || 0; }
  }

  // 工具原始结果 → 人类可读文本 (仅供 _localIntent 直接回给用户时使用)
  // v1.0.8 修复 (P2-1): 原实现 `return \`[工具] ${await this.tools.call(...)}\`` 直接拼字符串,
  //   把内部标记 `[工具]`、错误前缀与原始 JSON (如 {"ok":true,"id":"..."}) 原封不动喷给用户。
  //   这一层做"外向化": 错误 → 可读失败语; JSON → 抽取载荷字段; 数组 → 逐项罗列; 其余原样。
  //   注意: 这是**用户可见文本**的专用通道, 模型侧上下文里的工具结果不走这里 (保持原始保真)。
  _humanToolResult(raw) {
    const s = String(raw ?? "").trim();
    if (!s) return "(没有返回内容)";
    if (s.startsWith(TOOL_ERROR_PREFIX)) {
      return "没办成: " + s.slice(TOOL_ERROR_PREFIX.length).trim();
    }
    if (s.startsWith("{") || s.startsWith("[")) {
      let obj;
      try { obj = JSON.parse(s); } catch { return s; }
      if (Array.isArray(obj)) {
        return obj.length
          ? obj.map((x) => (typeof x === "string" ? x : (x && (x.name || x.path || x.title)) || JSON.stringify(x))).join("\n")
          : "(空)";
      }
      if (obj && typeof obj === "object") {
        if (obj.error) return "没办成: " + String(obj.error);
        for (const k of ["text", "content", "message", "result", "data", "output"]) {
          const v = obj[k];
          if (typeof v === "string" && v.trim()) return v;
        }
      }
      return s; // 结构无法识别: 原样返回, 不丢信息
    }
    return s;
  }

  // 离线工具路由: 无 LLM 时识别简单工具指令
  // ---- 内核自主决策: 本地意图预判层 (P2-7) ----
  // 高置信简单指令(问候/时间/记忆/明确工具)本地处理, 不调 LLM, 省成本更快
  async _localIntent(userMsg) {
    const m = String(userMsg).trim();
    // 纯问候/告别/感谢 (短句, 高置信)
    const greet = /^(你好|您好|嗨|哈喽|hello|hi|在吗|早上好|晚上好|下午好|再见|拜拜|谢谢|感谢|辛苦了|good\s*(mom|afternoon|evening)|thanks?|bye)\s*[!。？?]*$/i;
    if (greet.test(m)) {
      if (/再见|拜拜|bye/i.test(m)) return "再见兄弟, 有事随时喊我。";
      if (/谢谢|感谢|辛苦/i.test(m)) return "客气啥, 应该的。";
      return "在的兄弟, 说。";
    }
    // 时间/日期
    if (/^(现在)?(几点|时间|日期|几号|今天|星期几)[!?。？]*$/i.test(m)) {
      return `现在是 ${this._humanToolResult(await this.tools.call("get_time", {}))}`;
    }
    // 记忆查询: 你记得XXX / 上次聊过XXX (P1: LLM 查询扩展 + RRF 融合补语义召回)
    if (/^(你)?(记得|还记得|上次聊过|关于)[:：]?\s*(.+)/i.test(m)) {
      const q = m.replace(/^(你)?(记得|还记得|上次聊过|关于)[:：]?\s*/i, "").trim();
      const res = await this._memoryQuery(q || m, { limit: 3 });
      return res.length ? "我记得:\n" + res.map(r => `- ${r.content}`).join("\n") : `(记忆里没找到关于"${q || m}"的)`;
    }
    // 记住 XX
    const add = m.match(/^记住[:：]\s*(.+)$/i);
    if (add) {
      const content = add[1].trim();
      const r = String(await this.tools.call("memory_add", { content }) ?? "");
      if (r.startsWith(TOOL_ERROR_PREFIX) || /"error"\s*:/.test(r)) return "没记上: " + this._humanToolResult(r);
      return `好, 记下了: ${content}`;
    }
    // 读文件 / 列目录 (明确工具指令)
    const read = m.match(/^读文件\s+(.+)$/i);
    if (read) return this._humanToolResult(await this.tools.call("read_file", { path: read[1].trim() }));
    const list = m.match(/^列出?\s+(\S+)?$/i);
    if (list) return this._humanToolResult(await this.tools.call("list_dir", { path: list[1] || "." }));
    return null;
  }

  // ---- Session Replay: 从 l0 原始日志恢复某会话历史 (跨天/崩溃续跑) ----
  replaySession(sessionKey = "default", { days = 7, limit = 40 } = {}) {
    const msgs = [];
    const now = new Date();
    for (let d = days - 1; d >= 0; d--) {
      const day = logicalDay(new Date(now.getTime() - d * 86400000));
      const recs = this.l0.read(day, 2000);
      for (const r of recs) {
        if (r.sessionKey !== sessionKey) continue;
        if (r.role === "user" || r.role === "assistant") msgs.push({ role: r.role, content: r.content, ts: r.timestamp });
      }
    }
    msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return msgs.slice(-limit).map(({ role, content }) => ({ role, content }));
  }

  // 离线工具路由已并入 _localIntent (超集), 不再单独保留

  // 工具名清单 (给 verifyLesson 做幻觉接地)
  _toolNames() {
    try {
      if (this.tools && typeof this.tools.listDetailed === "function") return this.tools.listDetailed().map((t) => t.name);
      if (this.tools && typeof this.tools.names === "function") return this.tools.names();
    } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); }
    return [];
  }

  // 用户主动经验学习 (实现已迁 memory-service, 此处分发)
  _learnFromTurn(userMsg, reply) {
    return this.memorySvc.learnFromTurn(userMsg, reply);
  }

  // P3: 自我进化闭环 - 失败→经验 (实现已迁 learning-service, 此处分发保持公共 API)
  async refine({ limit = 20 } = {}) {
    return this.learningSvc.refine({ limit });
  }

  // P2: 自我进化闭环 (下) - 成功→技能 (实现已迁 learning-service, 此处分发保持公共 API)
  async refineSkill({ limit = 50, minFreq = 2 } = {}) {
    return this.learningSvc.refineSkill({ limit, minFreq });
  }

  // 用中自进化 (实现已迁 learning-service, 此处分发保持公共 API)
  async upgradeSkill(id, { minUses = 3, limit = 40 } = {}) {
    return this.learningSvc.upgradeSkill(id, { minUses, limit });
  }

  // L2 场景归档 (实现已迁 memory-service, 此处分发)
  _archiveScenes() {
    return this.memorySvc.archiveScenes();
  }

  // 可观测: 聚合各层状态 (记忆 L0-L3 / 轨迹 / 工具 / 经验 / 自愈)
  // 顶层展平 traces.stats() 字段 (count/failed/failRate/slowTools), 向后兼容 web 前端
  // v3.2.3 (P2#17): TTL 缓存外壳 —— Web 前端高频轮询 /api/stats 时不再每次同步聚合
  // 全量 JSONL 与工具清单; 默认 2000ms, `agent.stats_cache_ms=0` 关闭 (逐请求聚合旧行为)。
  // 返回缓存对象为只读约定, 调用方不应原地修改 (与旧行为一致: 每次都是新对象)
  stats() {
    const ttl = Math.max(0, Number(this.config.agent?.stats_cache_ms ?? 2000));
    if (ttl > 0 && this._statsCache && Date.now() - this._statsCacheAt < ttl) return this._statsCache;
    const s = this._statsUncached();
    if (ttl > 0) { this._statsCache = s; this._statsCacheAt = Date.now(); }
    return s;
  }

  _statsUncached() {
    const sessions = this.sessionStore ? this.sessionStore.list() : [];
    const eventsTotal = sessions.reduce((a, s) => a + (s.count || 0), 0);
    const tools = this.tools ? this.tools.listDetailed() : [];
    return {
      ...(this.traces && typeof this.traces.stats === "function" ? this.traces.stats() : {}),
      agent: {
        name: this.config.agent?.name || "ppx",
        mode: this.config.agent?.mode || "react",
        llm: this.llm ? (this.llm.backend || this.llm.model || "configured") : "none",
      },
      memory: {
        l0: { events_total: eventsTotal, sessions: sessions.length },
        l1: this.facts && this.facts.stats ? this.facts.stats() : {},
        l2: this.scenes && this.scenes.count ? { scenes: this.scenes.count() } : {},
        l3: this.personaStore && this.personaStore.stats ? this.personaStore.stats() : {},
        ...(this.memory && this.memory.stats ? this.memory.stats() : {}),
      },
      tools: {
        total: tools.length,
        enabled: tools.filter((t) => t.enabled).length,
        list: tools.map((t) => ({ name: t.name, enabled: t.enabled, category: t.category })),
      },
      // 策略订阅者熔断状态 (2026-09-17 接入 circuit-breaker 后可观测): 只列非闭合项, 正常时为空数组
      policyGuard: this.tools && typeof this.tools.policyStatus === "function"
        ? this.tools.policyStatus().filter((s) => s.state && s.state !== "closed")
        : [],
      skills: this.skills && typeof this.skills.list === "function"
        ? this.skills.list().map((s) => ({ id: s.id, description: s.description }))
        : [],
      mcp: this._mcp ? { connected: true, count: this._mcp.count || 0 } : { connected: false, count: 0 },
      experience: this.experience ? { lessons: this.experience.lessons.length } : {},
      health: this.health || null,
    };
  }

  // 主动任务生成 (ANS 自主性): 扫描 L1 记忆里的待办/偏好, 生成主动提醒 (委托 ans/proactive 模块)
  // 返回可直接投递的文本 (保持兼容); 结构化数据见 startProactiveTicker 回调的 payload
  async proactiveSuggest() {
    const out = await suggestProactive(this);
    return out ? out.text : null;
  }

  // 标记待办完成 (ANS): 之后不再主动提醒 (窗口去重 + 完成跟踪)
  proactiveMarkDone(id) {
    return markTaskDone(this, id);
  }

  // 启动主动任务生成定时器 (config.agent.proactive.enabled 才启用)
  // 回调契约: cb(payload) → { ts, items: [{content, importance, source, id}], text }
  startProactiveTicker(cb) {
    const cfg = this.config.agent?.proactive;
    if (!cfg || !cfg.enabled) return null;
    const ms = Number(cfg.interval_ms) || 3600000;
    // 2026-09-18 修复 (P2): suggestProactive 耗时超过 interval 时会重叠执行 (扫描/LLM 调用堆积),
    //   加防重入闸门: 上一轮未结束直接跳过本轮。
    let _proactiveRunning = false;
    this._proactiveTimer = setInterval(async () => {
      if (_proactiveRunning) return;
      _proactiveRunning = true;
      try {
        const payload = await suggestProactive(this);
        if (payload && typeof cb === "function") { try { cb(payload); } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); } }
      } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); } finally { _proactiveRunning = false; }
    }, ms);
    info(`[proactive] 主动任务生成已启动 (每 ${Math.round(ms / 60000)} 分钟)`);
    return this._proactiveTimer;
  }

  stopProactiveTicker() {
    if (this._proactiveTimer) { clearInterval(this._proactiveTimer); this._proactiveTimer = null; }
  }

  // 接入 MCP 服务器: 连接 + 注册工具到 catalog (可选能力, 显式调用)
  // servers 缺省用 config.mcp.servers; 返回注册的工具数
  async connectMcp(servers = null) {
    const list = servers || (this.config.mcp && this.config.mcp.servers) || [];
    if (!list.length) return 0;
    const r = await registerMcpTools(this.tools, list);
    this._mcp = r;
    return r.count;
  }

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
      "未检测到任何可用模型。皮皮虾默认本地优先(agent.model_preference=local), 需至少满足一项:\n" +
      "  1) 启动本地模型服务 (LM Studio 等, 127.0.0.1 即识别) **并把 model 改成该服务里真实存在的模型名**\n" +
      "  2) 配置云端大模型 API key: OPENAI_API_KEY | DEEPSEEK_API_KEY | VOLCENGINE_API_KEY(需填 endpoint) | DASHSCOPE_API_KEY\n" +
      "  3) 或显式设 agent.model_preference=cloud 后走云端 key\n" +
      "详见 README「快速开始」模型接入节。"
    );
  }
  // 热重载提供方: 从 config/ppx.json 重建 LLM 客户端列表
  reloadProviders() {
    this.config = this._loadConfig(null);
    this.llm = resolveLLM(this.config);
    this.allProviders = resolveAllLLMs(this.config);
    // v3.0.1 (P1#7): 热重载产生的是全新客户端实例, 必须重新包装使用统计,
    // 否则旧包装随旧实例废弃, 新实例的 chat 调用不再计数 (usageStats 静默失效)
    this._installUsageTracking();
    info(`[providers] 热重载完成: ${this.allProviders.length} 个客户端`);
    return { llm: this.llm ? (this.llm.backend || this.llm.model) : null, count: this.allProviders.length };
  }

  // 热重载通用设置 (用户名/安全/agent 预设): 重新加载 config + 更新内存字段
  // 不重建 LLM 客户端 (settings 不涉及 provider), 只让 user.name/security/agent 生效
  reloadSettings() {
    this.config = this._loadConfig(null);
    this.userName = this.config.user?.name || "兄弟";
    this.ctx.provide("userName", this.userName);
    // tools.enabled 热重载 (2026-10-04): 该开关此前只在构造期读一次 (plugin/builtin.js 的
    //   ctx.provide("toolsEnabled")), 设置里关掉工具总开关后当前进程仍继续给 LLM 挂工具、跑工具循环。
    this.toolsEnabled = this.config.tools?.enabled !== false;
    this.ctx.provide("toolsEnabled", this.toolsEnabled);
    // 应用 tools.disabled 变更 (设置 UI 启停工具后立即生效)
    this._applyDisabledTools();
    this._applyToolExposure(); // 披露策略也随设置热重载 (progressive/core 可在线调整)
    info(`[settings] 热重载完成: 用户=${this.userName}, 模式=${this.config.agent?.mode || "react"}`);
    return { userName: this.userName, mode: this.config.agent?.mode || "react" };
  }

  // 应用 config.tools.disabled: 禁用列表中的工具 (启停工具 UI 写盘后生效)
  _applyDisabledTools() {
    try {
      const disabled = Array.isArray(this.config.tools?.disabled) ? this.config.tools.disabled : [];
      if (!disabled.length) return;
      let n = 0;
      for (const name of disabled) {
        try { if (this.tools.disable(name)) n += 1; } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); }
      }
      if (n) info(`[tools] 已禁用 ${n} 个工具: ${disabled.join(", ")}`);
    } catch { /* 工具未就绪时静默跳过 */ }
  }

  // 应用工具披露策略 (2026-10-03, 上下文工程): 只把核心工具的完整 schema 发给 LLM, 其余按需加载。
  // 与 enabled 正交: 未披露的工具仍可被 catalog.call 调用 (内部链路/测试不受影响), 只是不进 tools 参数。
  // 动机: 64 工具的 JSON schema 是一笔可观开销, 而单个任务通常只用 3–5 个。
  _applyToolExposure() {
    try {
      const cfg = this.config.tools || {};
      if (cfg.progressive === false) {
        this.tools.setExposure(null); // 旧行为: 全量披露
        return;
      }
      const core = Array.isArray(cfg.core) && cfg.core.length ? cfg.core : null;
      if (!core) {
        this.tools.setExposure(null);
        return;
      }
      const known = new Set(this.tools.list());
      const effective = core.filter((n) => known.has(n));
      this.tools.setExposure(effective);
      const hidden = this.tools.hiddenFromLLM().length;
      if (hidden) info(`[tools] 渐进披露: ${effective.length} 个核心工具进 LLM schema, 其余 ${hidden} 个按需加载`);
    } catch { /* 工具未就绪时静默跳过 */ }
  }

  // ZCode 使用统计对齐: 包装所有 provider 的 chat/apiChat, 累计 token/调用次数 (零侵入)
  _installUsageTracking() {
    const clients = new Set([...(this.allProviders || []), this.llm].filter(Boolean));
    for (const c of clients) {
      if (!c || c.__ppxUsageWrapped) continue;
      c.__ppxUsageWrapped = true;
      for (const meth of ["apiChat", "chat"]) {
        if (typeof c[meth] !== "function") continue;
        const orig = c[meth].bind(c);
        c[meth] = async (msgs, opts) => {
          const r = await orig(msgs, opts);
          try {
            const u = r?.usage;
            const tk = (u?.total_tokens ?? (u?.prompt_tokens || 0) + (u?.completion_tokens || 0)) || 0;
            this.usageStats.calls++;
            this.usageStats.tokens += tk;
            const m = c.model || "unknown";
            this.usageStats.byModel[m] ??= { calls: 0, tokens: 0, cost: 0 };
            this.usageStats.byModel[m].calls++;
            this.usageStats.byModel[m].tokens += tk;
            // 成本折算 (2026-10-03l): 内置价格表前缀匹配, config.budget.model_prices 可覆盖;
            // 未知模型 cost 记 0 (不编数字), 想纳入预算就显式配价格
            let cost = 0;
            try { cost = estimateCost(m, u || {}, this.config?.budget?.model_prices); } catch { /* 价格异常不影响主链 */ }
            if (cost > 0) {
              this.usageStats.cost = Math.round(((this.usageStats.cost || 0) + cost) * 1e6) / 1e6;
              this.usageStats.byModel[m].cost = Math.round(((this.usageStats.byModel[m].cost || 0) + cost) * 1e6) / 1e6;
              this._checkBudget();
            }
            // 周期落盘 (2026-10-03m): 崩溃不丢账 —— 每满 10 次调用落一次,
            // 长跑进程被 kill 时 usage-stats.json 最多丢 9 笔而非全量 (退出另有兑底)
            if (this.usageStats.calls % 10 === 0) {
              this._flushUsageStats();
            }
          } catch { /* 统计失败不阻塞调用 */ }
          return r;
        };
      }
    }
  }

  // 支出预算判定 (2026-10-03l): config.budget.usd (USD, 0/缺省 = 不限), 达限后置位。
  // 闸门只拦 chat/chatStream 用户入口 (后台 refine/记忆提炼是小额, 不拦以免自学习链路断粮);
  // 按进程累计, 重启归零 —— 跨进程持久预算属外部计量职责, 这里诚实不做。
  _checkBudget() {
    const cap = Number(this.config?.budget?.usd);
    if (!Number.isFinite(cap) || cap <= 0 || this._budgetExceeded) return;
    if ((this.usageStats.cost || 0) < cap) return;
    this._budgetExceeded = true;
    this.tracer?.event("budget/exceeded", { cost: this.usageStats.cost, budgetUsd: cap });
    this.bus?.emit("budget/exceeded", { cost: this.usageStats.cost, budgetUsd: cap }, { source: "agent._checkBudget" });
  }

  // 预算耗尽的用户可见文案
  _budgetMessage() {
    const cap = Number(this.config?.budget?.usd);
    return `[预算耗尽] 本进程累计支出 $${(this.usageStats.cost || 0).toFixed(4)} 已达上限 $${(Number.isFinite(cap) ? cap : 0).toFixed(2)}，已停止继续调用模型。调整 config/ppx.json 的 budget.usd（0 或删除 = 不限）后重启生效。`;
  }

  // 使用统计落盘 (ZCode 使用统计对齐): data/usage-stats.json (含 cost 金额维度 + 预算上限快照)
  // 2026-10-03m: 从 shutdown 抽出供周期落盘复用 (周期性 + 退出兑底双保险)
  _flushUsageStats() {
    try {
      const usagePayload = { updated: new Date().toISOString(), ...this.usageStats };
      const cap = Number(this.config?.budget?.usd);
      if (Number.isFinite(cap) && cap > 0) usagePayload.budget_usd = cap;
      fs.writeFileSync(path.join(this.dataDir, "usage-stats.json"), JSON.stringify(usagePayload, null, 2));
      this._usageLastFlush = Date.now();
    } catch { /* 落盘失败不阻塞主链 */ }
  }

  // 退出收尾 (2026-10-04 改为 async): 军团子进程的回收本身是异步的 (优雅 shutdown + 宽限 kill),
  //   原先 fire-and-forget ⇒ 紧随其后的 process.exit(0) 直接把回收掐掉, 每个退出都留下一堆孤儿 node 进程。
  //   同步步骤全部提前完成, 唯一 await 放在最后, 因此忽略返回值的调用方行为不变。
  async shutdown() {
    this.stopProactiveTicker();
    // 使用统计落盘 (退出兑底; 长跑期间已有周期落盘, 此处只补尾部增量)
    this._flushUsageStats();
    this._mcp?.close?.();
    // 释放内嵌数据库句柄 (SQLite 后端必需: 不关会导致文件被占用, 无法迁移/清理)
    try { this.facts?.close?.(); } catch { /* JSON 后端无 close, 静默跳过 */ }
    // 2026-10-03: WAL 模式落盘兜底 —— 未达阈值的增量在退出前 compact 进快照 (防进程退出丢增量)
    try { this.facts?.flush?.(); } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); }
    this.memory._saveState?.();
    // 2026-10-06 交接: 轮内草稿是纯内存暂存, 退出前清空 (未落库的轮次不留孤儿桶 —— 它没有下一轮来排空)
    try { this._draftPending?.clear?.(); } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); }
    this.scheduler?.shutdown?.(); // ⑤/②: 清定时器防进程挂起
    this.healer.markClean();
    // v1.0.8: 清理军团子进程 (spawn_agent 派生的 worker), 防后台残留
    if (this._legion && typeof this._legion.shutdownAll === "function" && this._legion.list?.().length) {
      try { await this._legion.shutdownAll(); } catch (e) { debug(`[agent/index] 已忽略异常: ${e && e.message ? e.message : e}`); }
    }
  }
}

// 重构 (2026-09-15): 历史/上下文管理 + 提示词构建以 mixin 方式挂回 prototype
// (行为与拆前完全一致, 实例方法与调用方不受影响; 测试走 agent._xxx 不感知拆分)
Object.assign(PPXAgent.prototype, contextMethods, promptMethods);

ensureUTF8Console();
if (process.argv[1] && process.argv[1].endsWith("src/agent/index.js")) {
  const agent = new PPXAgent();
  console.log(`皮皮虾 就绪 | 记忆:${agent.facts.count()}条 | 工具:${agent.tools.list().join(",")} | 自愈:${agent.health.fixes.length ? "修复" + agent.health.fixes.length + "项" : "OK"}`);
  process.stdin.on("data", async (d) => {
    const line = d.toString().trim();
    if (["quit", "exit"].includes(line)) { await agent.shutdown(); process.exit(0); }
    const r = await agent.chat(line);
    console.log("\n" + r + "\n");
  });
}
