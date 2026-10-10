// src/agent/index.js - Agent 引擎 (皮皮虾核心) v0.2 含工具调用
import { ensureUTF8Console } from "../utils/winutf8.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { TOOL_ERROR_PREFIX } from "../tools/index.js";
import { normalizeCommand } from "../tools/command-guard.js";
import { explainError } from "../utils/public-error.js";
import { selfCheckReply, sanitizeReply } from "../core/selfcheck.js";
import { toolResultStatus, toolResultContent, toolOutcome } from "../core/tool-result.js";
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
import { maskPIIOutput } from "../utils/pii-output.js";
import { loadConfig } from "../config/index.js";
import { info, warn, error, debug } from "../utils/logger.js";
// 2026-10-10 修复 (P0-1): 成本折算依赖 estimateCost, 但此前只有调用、没有 import ——
// 每次记账抛 ReferenceError 又被同行空 catch 吞掉, 导致 金额统计/按模型分账/预算闸门/周期落盘
// 四条链路 100% 静默失效。补上import 并把 catch 改为留痕, 防止再次"加了功能但没接线"。
import { estimateCost, usageTokens } from "../llm/pricing.js";
import { Context, compose, loadPlugins } from "../plugin/index.js";
import { builtinPlugins, resolveLLM, resolveAllLLMs, isUsableProvider } from "../plugin/builtin.js";
// v3.0 (codex 对齐): 新层插件 (permissions/hooks/commands/evidence/protocol)
import { v3Plugins } from "../plugin/v3.js";
// P2-3: 占位符判定与路由共用唯一真相源, 避免"启动告警"和"实际选模型"两套口径漂移
import { isPlaceholder, hasPlaceholderField } from "../config/placeholder.js";
import { registerMcpTools } from "../mcp/index.js";
import { Auditor } from "../audit/verifier.js";
// ANS 独立模块 (可更换): 价值对齐 / 自主任务生成 / 生命周期
import { Lifecycle } from "../ans/lifecycle.js";
import { suggestProactive, markTaskDone } from "../ans/proactive.js";
import { record as rewardRecord, status as rewardStatus } from "../ans/reward.js";
import { scan as evictionScan, status as evictionStatus } from "../ans/eviction.js";
import { installGuard, guardStatus, installGuardOnCatalog } from "../ans/guard.js";
import { scanInjection, wrapUntrusted, reportSuspicious, stripProtoKeys } from "../security/injection.js";
import { SkillLoader } from "../skills/loader.js";
import { SkillRegistry, skillRootsFromConfig } from "../skills/registry.js";
import { createPackCatalog } from "../orchestrator/expert-pack.js";
import { EvolutionEngine } from "../selfheal/evolve.js";
// 重构 (2026-09-15): 历史/上下文管理 + 提示词构建从 PPXAgent 类抽出为 mixin
// (context.js: 历史裁剪/token 预算/会话压缩; prompts.js: 技能清单/核心价值/DSML/画像/多模态)
import { contextMethods } from "./context.js";
import { promptMethods } from "./prompts.js";
// 工具证据进上下文 + 压缩保真 + 免模型确定性重置 (2026-10-10 补, 覆盖 context 旧版)
import { evidenceMethods } from "./evidence.js";

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
    // 重构第三刀: 结构化事件流 (记忆升降级/工具失败/spawn/自愈触发), 独立于工具轨迹
    this.tracer = new EventTracer(this.dataDir);
    this.bus = this.ctx.consume("bus");
    this.tools = this.ctx.consume("tools");
    this.scheduler = this.ctx.consume("scheduler");
    this.toolsEnabled = this.ctx.consume("toolsEnabled");
    // v3.0 (codex 对齐): 权限引擎 / 钩子链 / 命令注册表 / 目标看板 / 协议总线
    this.hooks = this.ctx.consume("hooks");
    this.permissions = this.ctx.consume("permissions");
    this.commands = this.ctx.consume("commands");
    this.goalBoard = this.ctx.consume("goalBoard");
    this.protocolBus = this.ctx.consume("protocolBus");
    // 2026-10-10: playbook 引擎接线 —— 之前只 provide 无消费方 (引擎就绪、链路未接)。
    this.playbook = this.ctx.consume("playbook");
    // PWF 任务指针钩子 (2026-10-06 吸收 codex-task-pointer): PreCompact 时把"下一步/进行中"
    // 写入 .ppx/plan/progress.md, 压缩后 agent 从指针恢复现场 (计划在磁盘, 不在上下文)
    if (this.hooks && this.root) {
      this.hooks.on("PreCompact", async () => {
        try {
          const { writeTaskPointer } = await import("../planning/pwf.js");
          writeTaskPointer(this.root, {});
        } catch { /* 指针失败不阻断压缩 */ }
      });
    }
    // ZCode 工具能力门接线 (2026-10-02 吸收): 工具声明式能力 → 权限引擎
    //   开关: config.agent.capability_gate (默认开); auto_approve_high_risk (默认关)
    //   ⚠ 必须在 permissions/tools 都消费之后 (2026-10-03 自测发现: 原先放在消费前被静默跳过)
    if (this.permissions && this.tools && typeof this.tools.getCapability === "function") {
      this.permissions.getCapability = (n) => this.tools.getCapability(n);
      this.permissions.capabilityGate = this.config.agent?.capability_gate !== false;
      this.permissions.autoApproveHighRisk = !!this.config.agent?.auto_approve_high_risk;
    }
    // ZCode 使用统计对齐 (2026-10-02): 会话级 token/调用次数记账 (零侵入包装 provider)
    this.usageStats = { calls: 0, failedCalls: 0, tokens: 0, cost: 0, knownCost: 0,
      unknownCostCalls: 0, missingUsageCalls: 0, byModel: {} };
    this._installedAt = Date.now();
    this._lastUsageFlushCalls = 0; // 周期落盘水位 (每 N 次调用落一次盘)
    this._budgetExceeded = false;  // 达到 budget.usd 后置位, 拦截后续模型调用
    this._installUsageTracking();
    // 待审批映射 (codex approval flow): id -> { req, resolve, timer }
    this._pendingApprovals = new Map();
    this._approvalSeq = 0;
    this._approvalSurfaces = new Set(); // 具名审批面登记 (Web "http" / CLI "cli" …)
    this._humanChannel = false;          // CLI 人类在场标记 (无审批面但有人能答话)
    // B2: 审批缓存 (codex ApprovalStore 语义) — 会话内相同命令批准后不重复 ask
    // key = `${tool}:${normalizeCommand(command)}`; 只存批准结果, 拒绝/超时不入缓存
    this._approvalCache = new Map();
    // plan 模式 (2026-10-05 /plan /do 死命令修复): 按会话存储的计划态集合
    // (sessionKey -> 是否在计划模式)。与引擎级 permissions.planEnabled 是两条轨道:
    //   会话级走 /plan /do 或 HTTP 带 sessionKey; 引擎级走 HTTP 不带 sessionKey 的兜底开关。
    this._planSessions = new Set();
  }

  // ---- 装配阶段 3: ANS 自治接线 (免疫闸门 / Reward 闭环 / 排泄自治) ----
  _wireANS() {
    // ⑧ 免疫系: 全局闸门挂到总线命令通道 (拦截+审计)
    this.__guard = installGuard(this, { allowList: this.config.agent?.guardAllowList || [] });
    // ⑦ Reward 闭环: 订阅总线工具成败, 自动更新行为倾向 (EWMA)
    this.bus?.on("tool/result", (ev) => {
      const { name, ok } = ev.payload || {};
      if (name) { try { rewardRecord(this, { tool: name, ok: !!ok }); } catch {} }
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
      if (!hasE) this.scheduler?.add({ name: "eviction-daily", cron: "02:00", type: "daily", action: () => { try { evictionScan(this); } catch {} } });
    } catch {}
    // 首次启动跑一次排遗扫描 (预热治理状态)
    try { evictionScan(this); } catch {}
    this._warnMissingCloudApi(); // 发布首启引导: 未配云端 key 时明确提示
  }

  // ---- 装配阶段 4: 单轮对话运行态 (通知/中断/工具事件) ----
  _initTurnState() {
    this._notifyCb = null;
    this._onToolEvent = null; // 工具事件回调
    this._toolCallSeq = 0; // 工具调用序号: 给 start/done 事件生成唯一 id, 供 UI 精确配对
    this._interrupted = false;
    this._lastTurnUsedTools = false;
    // 本轮流式/工具运行态 (2026-10-04 Task#3 接线):
    //   _turnsUsedTools: 会话级"本轮是否用过工具"标记 (随本轮收口清除, 不留残留)
    //   _streamAborts:   会话级流式 AbortController 句柄 (interrupt 立即掐断上游请求, 用完即回收)
    this._turnsUsedTools = new Map();
    this._streamAborts = new Map();
    // 轮内中间草稿暂存桶 (sessionKey -> [{text, tools}]): 工具循环里每轮模型回包的内容先攒着,
    //   落库时交给 memory.recordTurn 写进 memory/turns 可重建上下文; 异常轮由 finally 收口清空。
    this._draftPending = new Map();
    this._lastFallback = null; // P2-2: 最近一次 provider 降级事实 (在本轮内有效, 用完即清)
    this._mcp = null; // MCP 连接句柄 (connectMcp 后赋值)
    this._proactiveTimer = null; // 主动任务生成定时器
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
    // 2026-10-09: 同时装配 skillRegistry —— orchestration.js / skill-hub.js 一直在读
    //   `agent.skillRegistry` (skill_coverage / capability_matrix 依赖), 但此前从无任何地方 provide 过,
    //   于是这两个工具恒返回「技能注册表未装配」。这里复用同一个 loader (不改变 this.skills 的既有行为),
    //   只额外挂上按配置推导的 roots 供覆盖率统计使用。
    try {
      this.skills = new SkillLoader(path.join(this.root, "skills"));
      this.skillRegistry = new SkillRegistry({ loader: this.skills, roots: skillRootsFromConfig(this.config, this.root) });
    } catch {
      this.skills = null;
      this.skillRegistry = null;
    }
    // 专家包目录 (2026-10-10 接线): team_room_open / expert_pack_* / delegate 的 expert 参数
    //   都在读 agent.expertPacks —— 但此前从无任何地方装配过它, 于是"专家包 id 解析"恒为空
    //   (team-room 工具只能解析到内置 EXPERTS 名册里的 id)。这里按 config 推导 roots (内置
    //   experts/ 打底 → 用户库 → 项目附加) 装配一次, 与 skillRegistry 同一手法。
    try {
      this.expertPacks = createPackCatalog(this.config, this.root);
    } catch {
      this.expertPacks = null;
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
    });
    // 注入 LLM 摘要器/提炼器 (依赖 service, 装配后注入)
    this.memory.summarizer = (raw) => this.memorySvc.summarizeMemory(raw);
    this.memory.setExtractor((u, a, related) => this.memorySvc.extractMemory(u, a, related));
  }

  // ---- 装配阶段 7: 启动动作 (禁用工具 / MCP 自动连接 / 首次画像) ----
  _initStartup() {
    // 应用 tools.disabled: 从 config/ppx.json 读取需禁用的工具, 启动时禁用 (设置 UI 写盘生效)
    this._applyDisabledTools();

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
  notify(message) { if (this._notifyCb) { try { this._notifyCb(String(message)); } catch (e) {} } }
  // 中断: 置位中断标记 + 立即掐断在途流式请求 (否则上游继续吐字, 用户白等/白计费)。
  //   无参 = 掐断全部会话在途流; 带 sessionKey = 只掐断该会话 (多路复用 Web 端用)。
  interrupt(sessionKey) {
    this._interrupted = true;
    if (!this._streamAborts) return;
    if (sessionKey) {
      const ac = this._streamAborts.get(sessionKey);
      if (ac) { try { ac.abort(); } catch {} }
      return;
    }
    for (const ac of this._streamAborts.values()) { try { ac.abort(); } catch {} }
  }
  clearInterrupt() { this._interrupted = false; }

  // 只读模式 (SDD 审查者, 吸收 Superpowers): 禁用一切修改/执行类工具, 只能读/查
  // 供 spawn_agent review 循环的审查者角色 (worker 经 PPX_AGENT_READONLY=1 触发)
  enableReadonlyMode() {
    const disabled = [
      "run_command", "write_file", "code_act", "create_skill",
      "memory_add", "add_schedule",
      "scene_create", "scene_describe", "spawn_agent", "refine_skill",
      "refine", // v1.0.8: refine 会写经验库, 只读审查者也不应触发
    ];
    for (const t of disabled) { try { this.tools.disable(t); } catch {} }
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

  // 重置某会话历史 (新会话): 删除事件日志 + 清计划态 (全新会话不得幸存旧 plan)
  resetSession(sessionKey) {
    const key = sessionKey || "default";
    this.sessionStore.delete(key);
    this._planSessions.delete(key);
  }

  // ---- plan 模式状态 (按会话, 2026-10-05) ----
  isPlanMode(sessionKey) { return this._planSessions.has(sessionKey || "default"); }
  setPlanMode(sessionKey, on) {
    const key = sessionKey || "default";
    if (on) this._planSessions.add(key); else this._planSessions.delete(key);
    return this;
  }
  planModeSessions() { return [...this._planSessions]; }

  // 认领 /plan /do 命令 intent (其余命令/非法输入返回 null, 不劫持链路)。
  // 由 chat 在进入 LLM 前调用 —— 命中即翻转状态并直接回文案, 不调 LLM。
  _consumePlanCommand(userMsg, sessionKey) {
    if (!this.commands || typeof this.commands.execute !== "function") return null;
    let intent;
    try { intent = this.commands.execute(String(userMsg), { sessionKey }); } catch { return null; }
    if (intent && intent.type === "intent"
      && (intent.action === "enter_plan_mode" || intent.action === "exit_plan_mode")) {
      return intent;
    }
    return null;
  }

  // 工具准入链 (唯一真相源, 2026-10-10 收敛): plan 模式 + 权限引擎 (deny/ask/allow) 全在此。
  //   此前 plan 判定住在这里、权限判定却内联在 _runTool —— 测试调 _admitToolCall、生产走内联,
  //   两侧各修各的 (正是"测试与产品路径不是同一个"的漂移源)。现 _runTool 也调用本方法。
  //   返回 { ok, error?, args? }:
  //     ok=true  → 放行 (args 可能是审批改参后的新对象)
  //     ok=false → error 为面向模型的可判读理由 (不带 TOOL_ERROR_PREFIX, 由调用方加)
  // 安全不变量: 引擎异常一律 **fail-closed** (拒绝执行) —— 引擎崩了防线不能全开。
  async _admitToolCall(name, args, callId, t0) {
    void t0;
    const sessionKey = currentTrace()?.sessionKey || "default";

    // 1) plan 模式直判: 不依赖引擎装配, 引擎缺失时 plan 语义仍生效 (只读非破坏工具放行)
    if (this.isPlanMode(sessionKey)) {
      const cap = (this.tools && typeof this.tools.getCapability === "function")
        ? this.tools.getCapability(name)
        : null;
      if (!(cap && cap.readOnly && !cap.destructive)) {
        return {
          ok: false,
          error: `plan 模式: 只允许只读非破坏工具, "${name}" 被拒绝。请先用 /do 退出计划模式, 或先产出计划交用户审阅。`,
        };
      }
    }

    // 2) 权限引擎 (deny/ask/allow)
    if (!this.permissions) return { ok: true, args };
    let perm;
    try {
      perm = await this.permissions.check(name, args, { callId, planEnabled: this.isPlanMode(sessionKey) });
    } catch (e) {
      // fail-closed: 引擎异常 = 无法判定 = 拒绝 (原实现 catch{} fail-open, 引擎崩了工具全放行)
      this.tracer.event("tool/perm-error", { tool: name, error: String(e?.message || e) });
      return { ok: false, error: `[permission] 权限引擎异常, 已拒绝执行 (fail-closed): ${e?.message || e}` };
    }
    if (!perm || typeof perm !== "object" || Array.isArray(perm) || !["allow", "deny", "ask"].includes(perm.decision)) {
      this.tracer.event("tool/perm-error", { tool: name, error: "invalid permission decision" });
      return { ok: false, error: "[permission] 权限引擎返回无效决策, 已拒绝执行 (fail-closed)" };
    }
    if (perm.decision === "deny") {
      this.tracer.event("tool/perm-denied", { tool: name, reason: perm.reason });
      return { ok: false, error: `[permission] 工具 ${name} 被拒绝: ${perm.reason || "命中 deny 规则"}` };
    }
    if (perm.decision === "ask") {
      // headless: 没有审批面 → 不能把 ask 挂起等人, 直接拒绝。
      // 拒绝消息带 modelHint (点名三种合法写法 + 实际收到的内容), 让模型能自纠而不是僵住。
      if (!this.hasApprovalSurface()) {
        // 无人环境的显式放行开关 (基准 / 无人批处理): config.agent.approval_headless = "auto-approve"
        //   时视为已批准。默认 (未声明) 仍走下面的快拒 —— 防线默认收紧, 放行必须显式声明。
        if (this.config?.agent?.approval_headless === "auto-approve") {
          this.tracer.event("tool/perm-approved-headless", { tool: name, reason: perm.reason, mode: "auto-approve" });
          return { ok: true, args };
        }
        const parts = [`[permission] 工具 ${name} 需要人工确认, 但当前进程没有审批入口 (headless 模式), 已拒绝执行`];
        if (perm.reason) parts.push(`理由: ${perm.reason}`);
        if (perm.modelHint) parts.push(perm.modelHint);
        // 可执行的下一步 (否则模型只会原地重试同一条命令, 直到轮次耗尽):
        //   要么换一个能挂审批面的入口, 要么把该工具显式放行后再重试。
        parts.push("可执行的下一步: ①改用带审批面的入口重跑 (ppx-serve / Web 端 ppx-web, 或 CLI 交互式确认); ②或在配置里把该工具显式放行 (config.agent.approval_mode = \"allow\" 或加入 permissions allow 规则) 后重试; ③或换用一个不需要审批的只读工具完成同样的事。");
        this.tracer.event("tool/perm-denied-headless", { tool: name, reason: perm.reason });
        return { ok: false, error: parts.join("\n") };
      }
      // B2: 审批缓存 (codex ApprovalStore 语义) — 会话内相同命令已批准过则不重复 ask
      // 仅命令类工具参与; 缓存 key = `${tool}:${normalizeCommand(command)}`
      // 命中 = 本次会话已显式批准, 视为放行; 拒绝/超时永不入缓存
      const cacheKey = this._approvalCacheKey(name, args);
      const cached = cacheKey && this.config.agent?.approval_cache !== false && this._approvalCache.get(cacheKey);
      let upd = null;
      if (cached) {
        this.tracer.event("approval/cache-hit", { tool: name, key: cacheKey });
        upd = {}; // 视为已批准
      } else {
        upd = await this._requestApproval({ tool: name, args, reason: perm.reason });
        if (upd && cacheKey) this._approvalCache.set(cacheKey, perm.reason || "");
      }
      if (upd && typeof upd === "object" && upd.updatedInput) args = upd.updatedInput;
      if (!upd) {
        this.tracer.event("tool/perm-rejected", { tool: name });
        return { ok: false, error: `[permission] 工具 ${name} 审批被拒绝或超时` };
      }
    }
    return { ok: true, args };
  }

  // 对话主入口 (含工具调用循环)
  async chat(userMsg, { persist = true, sessionKey = "default", mode = null } = {}) {
    // 重构第三刀: 入口生成 traceId, 记忆/工具/学习子调用自动继承 (AsyncLocalStorage)
    return runWithTrace(async () => {
    this.clearInterrupt(); // 新一轮对话开始, 复位上一轮的中断状态
    // 2026-10-10 修复 (P0-1 孪生): _budgetBlocked() 此前定义了却无任何调用方 —— 预算闸门
    //   即使置位也拦不住下一次 chat。闸门必须在"入口"处消费, 在花任何 token 之前。
    const blocked = this._budgetBlocked();
    if (blocked) return blocked;
    this.bus?.emit("chat/user", { userMsg, sessionKey }, { source: "agent.chat" });
    this._lastFallback = null; // P2-2: 只关心"本轮"是否降级, 先清上次残留
    // plan 模式命令入口: /plan /do 命中即翻转会话计划态并直接回文案, 不调 LLM
    const planIntent = this._consumePlanCommand(userMsg, sessionKey);
    if (planIntent) {
      if (planIntent.action === "enter_plan_mode") {
        this.setPlanMode(sessionKey, true);
        return "已进入计划模式: 后续工具调用仅允许只读操作, 请先产出计划交用户审阅; 输入 /do 退出计划模式开始执行。";
      }
      // exit_plan_mode
      if (this.isPlanMode(sessionKey)) {
        this.setPlanMode(sessionKey, false);
        return "已退出计划模式, 恢复执行。";
      }
      return "当前会话不在计划模式, 无需退出。";
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

    const usedTools = this._lastTurnUsedTools;
    this._lastTurnUsedTools = false;
    this._turnsUsedTools?.delete(sessionKey);
    if (this._notifyCb && usedTools) this.notify("[done] 任务完成 (工具执行)。");

    // 最终回答自检 (2026-10-09): 这是整条链路上唯一面向"用户可见文本"的闸门。
    // 确定性判定 (零 LLM 成本): 空回复 / 内部错误外泄 / 未渲染工具信封 / 裸 JSON。
    // 其中"内部错误外泄"会就地净化 (内部细节对用户无价值且有害), 其余只记录与告警, 不擅自改写。
    if (this.config?.agent?.self_check !== false) {
      try {
        const report = selfCheckReply(reply, { usedTools });
        if (!report.ok) {
          const codes = report.issues.map((i) => i.code).join(",");
          warn("回答自检未通过:", codes);
          this.bus?.emit("agent/selfcheck", { codes, issues: report.issues, sessionKey }, { source: "agent.selfcheck" });
          reply = sanitizeReply(reply, report);
        }
      } catch { /* 自检本身异常不得阻断主链路 */ }
    }

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
    if (this._lastFallback) {
      const fb = this._lastFallback;
      this._lastFallback = null;
      reply = String(reply ?? "") + this._fallbackNotice(fb);
      this.notify(`[降级] ${fb.from} → ${fb.to}`);
    }
    return this._maskReplyPII(reply);
    }, { sessionKey, channel: "chat", userMsg: String(userMsg).slice(0, 200) });
  }

  // PII 回复掩码 (2026-10-09, 合规敏感部署): security.pii_reply_mask=true 时对**用户可见回复**
  //   做脱敏 (邮箱/手机/证件号/凭证 → [REDACTED])。只作用于对外输出 —— 落库与会话历史里仍是模型
  //   原文 (掩码不该让记忆层失真)。默认 false, 不破坏开发工作流。脱敏异常时隐藏输出。
  _maskReplyPII(reply, enabled = this.config?.security?.pii_reply_mask === true) {
    return enabled ? maskPIIOutput(reply) : reply;
  }
  // 单轮落库公共路径 (chat / chatStream 共用, 2026-09-18 重构去重):
  //   会话事件日志追加 → L0/L1 记忆写入 → (可选) 记忆升降级协调 (L2 归档/经验学习/L3 画像刷新)
  // 注意: 写入的始终是"模型原文" —— 用户可见的降级提示由调用方在落库之后再拼接。
  // 2026-10-10: 同时把"本轮证据 + 轮内中间草稿"交给 memory.recordTurn, 落进 memory/turns 的
  //   可重建上下文档。桶在进入本方法时立即排空 —— 即便 recordTurn 抛错, 本轮残渣也不留给下一轮。
  async _persistTurn(sessionKey, userMsg, assistantText, { afterTurn = false } = {}) {
    const k = sessionKey || "default";
    const drafts = this._takeDrafts(k);
    const pending = (this._evidencePending && this._evidencePending.get(k)) || [];
    // 采集器把 call/result 合并成一条 (按 callId); 归档层按 e.type 分类, 故此处拆回
    // "tool/call + tool/result" 两条; args 序列化为 JSON 字符串 (可读载体, 投影侧再 parse)。
    const evidence = this._evidenceForArchive(pending);
    this._pushTurn(k, String(userMsg), assistantText, pending);
    await this.memory.recordTurn(userMsg, assistantText, { drafts, evidence, sessionKey: k });
    if (afterTurn) {
      this.bus?.emit("memory/record", { userMsg, reply: assistantText }, { source: "agent.chat" });
      this.memorySvc.afterTurn(userMsg, assistantText);
    }
  }

  // 把采集器的合并条目展开成带 type 的归档条目 (memory/turns 消费)
  _evidenceForArchive(pending) {
    const out = [];
    for (const e of (Array.isArray(pending) ? pending : [])) {
      if (!e || typeof e !== "object") continue;
      if (e.type) { out.push(e); continue; }
      const callId = e.callId != null ? String(e.callId) : undefined;
      let argsTxt = "";
      if (e.args && typeof e.args === "object") { try { argsTxt = JSON.stringify(e.args); } catch { argsTxt = ""; } }
      else if (typeof e.args === "string") argsTxt = e.args;
      out.push({ type: "tool/call", tool: e.tool, callId, args: argsTxt });
      out.push({
        type: "tool/result", tool: e.tool, callId,
        ok: e.ok !== false, durationMs: e.durationMs || 0,
        result: e.result ?? e.extra ?? "", error: e.error ?? null,
      });
    }
    return out;
  }

  // 取走并清空某会话的轮内草稿桶 (幂等: 不存在即空数组)
  _takeDrafts(sessionKey) {
    const k = sessionKey || "default";
    if (!this._draftPending) return [];
    const arr = this._draftPending.get(k) || [];
    this._draftPending.delete(k);
    return arr;
  }

  // 记录一条轮内中间草稿 (只留文本 + 工具名, 不留工具入参值): 由工具循环的 onAssistantMsg 回调驱动
  _recordDraft({ content = "", toolCalls = [], sessionKey = null } = {}) {
    const text = String(content || "").replace(/\r/g, "").trim();
    if (!text) return;
    if (!this._draftPending) this._draftPending = new Map();
    const k = sessionKey || currentTrace()?.sessionKey || this._activeSessionKey || "default";
    const arr = this._draftPending.get(k) || [];
    const tools = (Array.isArray(toolCalls) ? toolCalls : [])
      .map((tc) => tc?.function?.name || tc?.name)
      .filter(Boolean);
    // 条数封顶 (与 memory-ticker.TURN_ARCHIVE_ITEMS 同量级): 防长跑轮次把桶撑爆
    arr.push({ text, tools });
    if (arr.length > 24) arr.splice(0, arr.length - 24);
    this._draftPending.set(k, arr);
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

  // 立即手动触发一次记忆治理扫描 (冗余识别 + 冷热分层)
  runMemoryEviction() {
    return evictionScan(this);
  }

  // TTL 治理 (G5, 2026-10-10 接线): 超过 config.memory.ttl_days 未访问的条目**软归档** (可回滚)。
  //   ttl_days=0/缺省 = 完全关闭 TTL 治理 (显式 disabled, 不是静默什么都不做)。
  //   与 runMemoryEviction 的分工: 那个是容量/冗余治理 (硬删), 这个是时效治理 (软归档)。
  sweepMemoryTtl() {
    const ttl = Number(this.config?.memory?.ttl_days ?? 0);
    if (!ttl || ttl <= 0) return { swept: 0, disabled: true };
    try {
      const r = this.facts.sweepExpired({ ttlDays: ttl }) || {};
      return { swept: Number(r.swept) || 0, ttlDays: ttl };
    } catch (e) {
      this.debug?.(`[memory] TTL 治理失败: ${e?.message || e}`);
      return { swept: 0, error: String(e?.message || e) };
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
    // PII can span provider chunks. In masking mode, release only a complete masked reply.
    const maskPII = this.config?.security?.pii_reply_mask === true;
    const emitReply = (text) => {
      const safe = this._maskReplyPII(text, maskPII);
      if (onDelta && safe) onDelta(safe);
      return safe;
    };
    if (!this.llm) return emitReply(await this.chat(userMsg, { sessionKey }));
    // 2026-10-10 修复 (P0-1 孪生): 流式入口同样消费预算闸门 —— 超限时不得再发上游请求,
    //   并把提示同时推给 onDelta (否则前端只会看到空白流)。
    const blocked = this._budgetBlocked();
    if (blocked) return emitReply(blocked);
    this.clearInterrupt(); // 新一轮对话开始, 复位中断状态
    // 内核自主决策: 高置信简单指令本地处理
    const local = (this.config.agent?.localIntent !== false) ? await this._localIntent(userMsg) : null;
    if (local) {
      this._turnsUsedTools.delete(sessionKey);
      return emitReply(local);
    }
    const system = this._context(userMsg);
    const history = await this._loadHistory(sessionKey);
    const messages = [{ role: "system", content: system }, ...history, { role: "user", content: this._userContent(userMsg) }];

    // 多模态路由: 消息含图片时优先 vision provider (否则图片发到文本后端无意义)
    const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c && c.type === "image_url"));
    const activeLLM = hasImage ? (this._visionLLM() || this.llm) : this.llm;

    // 挂工具事件透传 (供 onTool 推送)
    const prevCb = this._onToolEvent;
    if (onTool) this._onToolEvent = (ev) => { try { onTool(this._maskReplyPII(ev, maskPII)); } catch {} };
    // 挂 step 事件透传 (供 onStep 推送推理轮次)
    const prevStepCb = this._onStepEvent;
    if (onStep) this._onStepEvent = (ev) => { try { onStep(this._maskReplyPII(ev, maskPII)); } catch {} };

    // 流式中断句柄 (2026-10-04 Task#3): interrupt(sessionKey) 立即掐断上游请求 ——
    //   已吐出的增量保留, 绝不降级重发 (那是二次计费 + 重复输出)。
    const ac = new AbortController();
    this._streamAborts.set(sessionKey, ac);
    let partial = "";
    let reply;
    const toolsInTurn = this.toolsEnabled;
    try {
      // 无工具开启: 直连后端可逐字流式 (恢复打字机效果); 有工具时走工具循环保轨迹完整 [复审 P2]
      if (!toolsInTurn && activeLLM.supportsStream) {
        reply = await activeLLM.streamChat(messages, {
          onDelta: (d) => { partial += d; if (!maskPII && onDelta) onDelta(d); },
          signal: ac.signal,
        });
        if (maskPII) emitReply(reply);
      } else {
        reply = await this._llmWithFallback(messages);
        emitReply(reply);
      }
    } catch (e) {
      // 判定"用户叫停"而非"上游真故障": AbortError / 已置中断位 / 句柄已 abort
      const isAbort = e?.name === "AbortError" || this._interrupted || ac.signal.aborted;
      if (isAbort) {
        warn("chatStream 被中断, 保留已生成部分 (不降级重发):", String(e?.message || e));
        reply = partial;
        if (maskPII) emitReply(reply);
      } else {
        warn("chatStream 失败:", e.message);
        // persist:false —— 落库统一交给本函数末尾的 _persistTurn 完成,
        //   否则降级路径既在 chat 内落一次、又在末尾落一次 = 会话凭空多一轮 (P1#7 双写)。
        // A tool may have committed before the model failed. Never start a fresh
        // task here; provider handoff already retained the turn's receipts.
        reply = toolsInTurn
          ? LLM_FAILED_HINT(e)
          : await this.chat(userMsg, { sessionKey, persist: false });
        emitReply(reply);
      }
    } finally {
      this._onToolEvent = prevCb;
      this._onStepEvent = prevStepCb;
      this._streamAborts.delete(sessionKey); // abort 句柄必须回收, 不留残留
    }
    // 落库用模型原文 (剥掉本轮降级提示), 与 chat 共用同一路径; afterTurn 与 chat 对齐 ——
    //   流式轮次同样触发 L2 归档 / 经验学习 / L3 画像刷新 (2026-10-04 Task#3)。
    await this._persistTurn(sessionKey, userMsg, this._stripFallbackNotice(reply), { afterTurn: true });
    this._lastFallback = null; // 降级提示不影响后续轮次
    this._turnsUsedTools.delete(sessionKey); // 本轮收口: 清除工具使用标记
    return this._maskReplyPII(reply, maskPII);
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
      try {
        // 健康探测 TTL 缓存 (2026-10-03m): 高频对话每轮全量探活会串行等一整轮网络往返。
        //   TTL 内复用上次结果 (config.agent.health_cache_ms, 默认 30s); 过期即重新探测。
        //   缓存只影响"要不要探", 不影响"探出来怎样" —— 不健康 provider 的跳过语义不变。
        const ttl = Number(this.config.agent?.health_cache_ms ?? 30000);
        const cache = (this._healthCache ||= new Map());
        const now = Date.now();
        const states = await Promise.all(clients.map(async (c) => {
          if (!c.health) return true;
          const hit = cache.get(c);
          if (hit && (now - hit.ts) < ttl) return hit.ok;
          let ok = true;
          try { ok = !!(await c.health()); } catch { ok = false; }
          cache.set(c, { ok, ts: Date.now() });
          return ok;
        }));
        const healthy = clients.filter((_, i) => states[i]);
        if (healthy.length) clients = healthy;
        else info("所有 provider 健康探测失败, 按原配置顺序尝试兜底");
      } catch (e) {
        warn("health 探测异常, 按原顺序回退:", e.message);
      }
    }
    let lastErr = null;
    // v1.0.8 修复 (P2-2): 记录"本轮发生了降级切换"这一事实并对外广播。
    //   原实现只在日志里 warn 一句, 用户侧完全静默 —— 拿到的是备用模型的回答却无从感知。
    //   注意: **不改动返回值** (回退语义本身保持透明, chaos 测试锁死了成功时返回原始文本)。
    const failed = [];
    const loopState = {}; // One logical turn, shared receipts across providers.
    for (const client of clients) {
      try {
        loopState.resuming = failed.length > 0;
        const out = await this._llmWithTools(seedMessages, client, loopState);
        if (failed.length) {
          this._lastFallback = {
            from: failed[0].model,
            to: client.model,
            reason: failed[0].message,
            chain: failed.map((f) => f.model),
            ts: Date.now(),
          };
          this.bus?.emit("llm/fallback", this._lastFallback, { source: "agent._llmWithFallback" });
          warn(`provider 降级: ${this._lastFallback.from} 不可用 → 已切至 ${client.model} (${failed[0].message})`);
        }
        return out;
      } catch (e) {
        // Changing models is safe only at a model-request boundary. A tool may
        // already have committed when another layer throws; do not replay it.
        if (loopState.messages && !e?.ppxModelRequestFailure) throw e;
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
    // 2026-10-09: 判定逻辑收敛到 utils/public-error (与硬失败路径 LLM_FAILED_HINT 共用),
    //   原先这里与 core/policy 各写一套, 是"两条路径口径不一致"的根因。
    return explainError(msg);
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
  async _runTool(name, args, { receipt = false } = {}) {
    const t0 = Date.now();
    const refused = (content) => receipt ? toolOutcome(content, { ...toolResultStatus(content), dispatched: false }) : content;
    this._lastTurnUsedTools = true;
    // 会话级"本轮用过工具"标记 (chat/chatStream 收口时按会话清除) —— 供军团进度上报/可视区分。
    this._turnsUsedTools?.set(currentTrace()?.sessionKey || this._activeSessionKey || "default", true);
    // 原型污染消毒: 剥离 __proto__/constructor/prototype 键 (LLM JSON 可携带恶意键)
    const stripped = stripProtoKeys(args);
    if (stripped.stripped.length) {
      this.tracer.event("security/proto-stripped", { tool: name, keys: stripped.stripped });
      args = stripped.clean;
    }
    const callId = `t${++this._toolCallSeq}-${t0.toString(36)}`;

    // --- v3.0: PreToolUse 钩子链 (claude-code 语义: 可否决/可改参) ---
    if (this.hooks) {
      try {
        const h = await this.hooks.emit("PreToolUse", { tool: name, args, callId });
        if (h && h.blocked) {
          const msg = `[hook] 工具 ${name} 被 PreToolUse 钩子否决: ${h.reason || "无理由"}`;
          this.tracer.event("tool/hook-blocked", { tool: name, reason: h.reason });
          this._emitToolDone(callId, name, args, false, Date.now() - t0, msg);
          return refused(TOOL_ERROR_PREFIX + msg);
        }
        if (h && h.args && typeof h.args === "object") args = h.args; // 钩子改参
      } catch {} // 钩子自身异常不阻断主链
    }

    // --- v3.0: 权限引擎 (codex AskForApproval + SandboxPolicy + 规则链) ---
    // 2026-10-10: 准入判定统一收敛到 _admitToolCall (plan 模式 + 权限引擎 + 审批缓存),
    //   消除"测试调 _admitToolCall / 生产走内联"的双份实现漂移; 引擎异常 fail-closed。
    {
      const admit = await this._admitToolCall(name, args, callId, t0);
      if (admit && admit.args && typeof admit.args === "object") args = admit.args;
      if (!admit.ok) {
        this._emitToolDone(callId, name, args, false, Date.now() - t0, admit.error);
        return refused(TOOL_ERROR_PREFIX + admit.error);
      }
    }

    this.bus?.emit("tool/call", { name, args, callId }, { source: "agent._runTool" });
    if (this._onToolEvent) { try { this._onToolEvent({ type: "start", id: callId, tool: name, args, ts: Date.now() }); } catch {} }
    // let 而非 const: PostToolUse 钩子的 additionalContext 会追加到结果尾部
    // (2026-09-18 修复: 原为 const, 钩子追加时抛 "Assignment to constant variable" 被 catch {} 静默吞掉,
    //  additionalContext 特性从未生效)
    let outcome = null;
    let result = await this.tools.call(name, args, {
      agent: this, timeoutMs: Number(this.config.agent?.tool_timeout_ms) || 0,
      // Freeze the arguments used by the catalog before post-tool observers
      // can change them. A proposal may have been rewritten by a hook/approval.
      onOutcome: (status) => { outcome = { ...status, executedArgs: structuredClone(args) }; },
    });
    outcome ||= toolResultStatus(result);
    const ok = outcome.ok;
    // 提示注入防线 (2026-10-03 红队驱动): 工具输出 = 不可信数据。
    // 疑似注入 → 原文外包"不可信"标注 + 安全事件上 tracer (数据不删, 指令不执行语义靠标注传达给模型)。
    try {
      if (ok && typeof result === "string" && result.length > 20 && !result.startsWith("{")) {
        const scan = scanInjection(result);
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

    // --- v3.0: PostToolUse 钩子链 (可附加上下文, 追加在结果尾部) ---
    if (this.hooks && ok) {
      try {
        const h = await this.hooks.emit("PostToolUse", { tool: name, args, result, callId });
        // 2026-09-18 修复 (第二处): 原实现 map h.results 里的 r.additionalContext,
        //   但 results 条目结构是 { result: res }, 恒取到 undefined —— 收集结果实际在
        //   h.additionalContext (hooks/index.js 统一收集)。原特性从未生效。
        const extra = (Array.isArray(h?.additionalContext) ? h.additionalContext : [])
          .filter(Boolean).map(String).join("\n");
        if (extra) result = result + "\n" + extra;
      } catch {}
    }
    this._emitToolDone(callId, name, args, ok, Date.now() - t0, result);
    return receipt ? toolOutcome(result, outcome) : result;
  }

  // v3.0: 统一 done 事件发射 (原内联三处, 收敛为一个私有方法)
  _emitToolDone(callId, name, args, ok, durationMs, result) {
    if (this._onToolEvent) { try { this._onToolEvent({ type: "done", id: callId, tool: name, args, ok, durationMs, result: String(result == null ? "" : result).slice(0, 300), ts: Date.now() }); } catch {} }
  }

  // v3.0 (codex approval flow): 产生审批请求并等待 Web UI/通道裁决
  // 返回: { updatedInput? } 表示批准; null 表示拒绝/超时
  // 审批面 (2026-10-09 补): 是否存在"能把 ask 递到人面前"的入口。
  // headless (CLI 批处理 / 测试 / 无人值守) 没有审批面 —— 此时 ask 必须直接拒绝,
  // 且拒绝消息要带上可自纠的 modelHint, 否则模型既改不了也换不了路子, 只会幻觉"已修复"。
  hasApprovalSurface() {
    if (typeof this._onApprovalEvent === "function" || typeof this._approvalSurface === "function") return true;
    return !!(this._approvalSurfaces && this._approvalSurfaces.size);
  }
  // 注册外部审批面 (Web/CLI/渠道)。
  //   传函数 = 审批事件回调 (旧用法, 兼容保留, 返回解绑函数);
  //   传字符串 = 登记一个具名审批面 (Web 端 "http" / CLI "cli" 等), 供 hasApprovalSurface
  //   做"是否存在能把 ask 递到人面前的入口"的判定 —— 多个面可并存, 用 Set 去重。
  registerApprovalSurface(fn) {
    if (typeof fn === "function") {
      this._approvalSurface = fn;
      return () => { this._approvalSurface = null; };
    }
    if (!this._approvalSurfaces) this._approvalSurfaces = new Set();
    const name = String(fn || "default");
    this._approvalSurfaces.add(name);
    return () => { this._approvalSurfaces.delete(name); };
  }
  // 注销审批面 (具名版): 传名字则只注销该面, 不传则清空全部。
  unregisterApprovalSurface(name = null) {
    if (!this._approvalSurfaces) this._approvalSurfaces = new Set();
    if (name == null) this._approvalSurfaces.clear();
    else this._approvalSurfaces.delete(String(name));
    this._approvalSurface = null;
  }

  // 人类在场标记 (CLI 聊天等"有人但无审批面"的形态): 与审批面【分开】维护 ——
  //   CLI 有终端用户能答话, 但审批仍走 headless 快拒 (没有可点击的审批入口),
  //   两个口径互不污染。供 clarify 判定"问题有没有人能接"。
  markHumanChannel(flag = true) {
    this._humanChannel = !!flag;
  }
  // 是否存在"能把问题递到人面前"的通道: 审批面 OR CLI 人类标记。
  // 都没有 = headless (批处理/测试/无人值守) —— 此时 clarify 不得反问, 应给推进指引。
  hasHumanChannel() {
    return this.hasApprovalSurface() || this._humanChannel === true;
  }

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
      if (this._onApprovalEvent) { try { this._onApprovalEvent(req); } catch {} }
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
    // "always" = 本会话内同类命令永久放行 (codex ApprovalStore 语义): 视为批准 + 写入审批缓存,
    //   后续同 key 不再询问。仅命令类工具参与缓存 (与非命令工具无 key 一致)。
    const approved = decision === "approve" || decision === "always";
    if (approved && decision === "always" && entry.req?.tool) {
      const key = this._approvalCacheKey(entry.req.tool, entry.req.args || {});
      if (key) this._approvalCache.set(key, entry.req?.reason || "always");
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
  async _llmWithTools(seedMessages, llmInstance = this.llm, loopState = null) {
    return runToolLoop({
      seedMessages,
      llm: llmInstance,
      tools: this.toolsEnabled ? this.tools.toOpenAI() : [],
      config: this.config,
      isInterrupted: () => this._interrupted,
      onStep: (ev) => { if (this._onStepEvent) { try { this._onStepEvent(ev); } catch {} } },
      // 轮内中间草稿采集 (2026-10-10): 每轮模型回包内容进草稿桶, 落库时并入 memory/turns
      onAssistantMsg: (ev) => this._recordDraft(ev),
      runTool: (name, args) => this._runTool(name, args, { receipt: true }),
      shrinkMessages: (messages, budget) => this._shrinkMessagesForOverflow(messages, budget),
      histTokenCap: () => this._histTokenCap(),
      onEvent: (type, payload) => { this._onPolicyEvent(type, payload); this.tracer.event(type, payload); },
      // v1.6.0 第四刀: 超时重试决策 (幂等才重试) + 超时预算查询 (事件采集)
      isIdempotentTool: (name) => this._toolIdempotent(name),
      isReadOnlyTool: (name) => this.tools?.getCapability?.(name)?.readOnly === true,
      canonicalizeToolArgs: (name, args) => {
        const cap = this.tools?.getCapability?.(name);
        if (cap?.readOnly || cap?.sideEffect !== "workspace" || !args || typeof args !== "object" || Array.isArray(args)) return args;
        const properties = this.tools?.metaOf?.(name)?.parameters?.properties || {};
        const canonical = { ...args };
        // Only declared workspace path fields participate. Commands, patch
        // contents and unrelated business data keep their literal identity.
        for (const key of ["path", "file_path"]) {
          if (properties[key]?.type !== "string" || typeof args[key] !== "string") continue;
          const resolved = path.resolve(this.root, args[key]);
          canonical[key] = process.platform === "win32" ? resolved.toLowerCase() : resolved;
        }
        return canonical;
      },
      toolTimeoutOf: (name) => this._toolTimeoutOf(name),
      // 回合级后置校验闸门 (2026-10-05): 收尾前 harness 自己跑确定性检查, 不过则经 steering
      // 通道把失败喂回模型 (修正机会 ≤2), 用尽诚实上报。rootDir 缺省时不启用。
      postCondition: {
        rootDir: this.root,
        capabilityOf: (n) => (this.tools && this.tools.getCapability ? this.tools.getCapability(n) : null),
      },
      loopState,
    });
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
      return `现在是 ${this._humanToolResult(await this._runTool("get_time", {}))}`;
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
      const r = String(await this._runTool("memory_add", { content }) ?? "");
      if (!toolResultStatus(r).ok) return "没记上: " + this._humanToolResult(r);
      return `好, 记下了: ${content}`;
    }
    // 读文件 / 列目录 (明确工具指令)
    const read = m.match(/^读文件\s+(.+)$/i);
    if (read) {
      const result = await this._runTool("read_file", { path: read[1].trim() }, { receipt: true });
      return toolResultStatus(result).ok ? String(toolResultContent(result)) : this._humanToolResult(toolResultContent(result));
    }
    const list = m.match(/^列出?\s+(\S+)?$/i);
    if (list) return this._humanToolResult(await this._runTool("list_dir", { path: list[1] || "." }));
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
    } catch {}
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
  stats() {
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
        if (payload && typeof cb === "function") { try { cb(payload); } catch {} }
      } catch {} finally { _proactiveRunning = false; }
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
      "  2) 配置云端大模型 API key: OPENAI_API_KEY | DEEPSEEK_API_KEY | DASHSCOPE_API_KEY\n" +
      "  3) 或显式设 agent.model_preference=cloud 后走云端 key\n" +
      "详见 README「快速开始」模型接入节。"
    );
  }
  // 热重载提供方: 从 config/ppx.json 重建 LLM 客户端列表
  reloadProviders() {
    this.config = this._loadConfig(null);
    this.llm = resolveLLM(this.config);
    this.allProviders = resolveAllLLMs(this.config);
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
    // 应用 tools.disabled 变更 (设置 UI 启停工具后立即生效)
    this._applyDisabledTools();
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
        try { if (this.tools.disable(name)) n += 1; } catch {}
      }
      if (n) info(`[tools] 已禁用 ${n} 个工具: ${disabled.join(", ")}`);
    } catch { /* 工具未就绪时静默跳过 */ }
  }

  // ZCode 使用统计对齐: 包装所有 provider 的 chat/apiChat, 累计 token/调用次数/金额 (零侵入)
  // 2026-10-10: 追加金额折算 (cost) 与预算闸门 (usageStats 只有 token 不算成本控制)。
  _installUsageTracking() {
    const clients = new Set([...(this.allProviders || []), this.llm].filter(Boolean));
    for (const c of clients) {
      if (!c || c.__ppxUsageWrapped) continue;
      c.__ppxUsageWrapped = true;
      for (const meth of ["apiChat", "chat", "streamChat"]) {
        if (typeof c[meth] !== "function") continue;
        const orig = c[meth].bind(c);
        c[meth] = async (msgs, opts) => {
          let streamedUsage = null;
          let streamedModel = c.model;
          const callOpts = meth === "streamChat" ? { ...(opts || {}), onUsage: (u, metadata) => {
            streamedUsage = u;
            streamedModel = metadata?.model || c.model;
            opts?.onUsage?.(u, metadata);
          } } : opts;
          try {
            const r = await orig(msgs, callOpts);
            this._accountModelUsage(r?.model || streamedModel, r?.usage ?? streamedUsage, false);
            return r;
          } catch (e) {
            // Failed requests can have been billed; absent provider usage is unknown, never free.
            this._accountModelUsage(c.model, e?.usage ?? streamedUsage, true);
            throw e;
          }
        };
      }
    }
  }

  _accountModelUsage(model, usage, failed = false) {
    try {
      const m = model || "unknown";
      const measuredTokens = usageTokens(usage);
      const hasUsage = measuredTokens != null;
      const tokens = measuredTokens ?? 0;
      const cost = hasUsage ? estimateCost(m, usage, this.config.budget?.model_prices) : null;
      const totals = this.usageStats;
      totals.byModel[m] ??= { calls: 0, failedCalls: 0, tokens: 0, cost: 0,
        knownCost: 0, unknownCostCalls: 0, missingUsageCalls: 0 };
      for (const bucket of [totals, totals.byModel[m]]) {
        bucket.calls++;
        bucket.failedCalls = (bucket.failedCalls || 0) + Number(failed);
        bucket.tokens += tokens;
        bucket.missingUsageCalls = (bucket.missingUsageCalls || 0) + Number(!hasUsage);
        bucket.unknownCostCalls = (bucket.unknownCostCalls || 0) + Number(cost == null);
        bucket.knownCost = Math.round(((bucket.knownCost ?? bucket.cost ?? 0) + (cost ?? 0)) * 1e9) / 1e9;
        bucket.cost = bucket.unknownCostCalls ? null : bucket.knownCost;
      }
      this._afterUsageAccounted();
    } catch (e) {
      debug(`[usage] 记账失败 (不阻塞调用): ${e?.message || e}`);
    }
  }

  // 每次记账后的动作: ① 更新预算闸门 ② 周期落盘 (长跑进程被 kill 时不丢账)
  _afterUsageAccounted() {
    const limit = Number(this.config.budget?.usd) || 0;
    // usd=0 或缺省 = 不限 (不置位, 不拦截)
    if (limit > 0 && (this.usageStats.knownCost ?? this.usageStats.cost ?? 0) >= limit) this._budgetExceeded = true;
    // 每 10 次调用落一次盘 (无需 shutdown 也有账可查); 失败不阻塞
    if (this.usageStats.calls - this._lastUsageFlushCalls >= 10) this._flushUsageStats();
  }

  // 使用统计落盘 (周期 + shutdown 共用)。失败静默 (不阻塞对话/退出)。
  _flushUsageStats() {
    try {
      const budgetUsd = Number(this.config.budget?.usd) || 0;
      const payload = {
        updated: new Date().toISOString(),
        ...this.usageStats,
      };
      // usd=0 视为不限, 不写入 budget_usd (未生效的预算不假装生效)
      if (budgetUsd > 0) payload.budget_usd = budgetUsd;
      fs.writeFileSync(path.join(this.dataDir, "usage-stats.json"), JSON.stringify(payload, null, 2));
      this._lastUsageFlushCalls = this.usageStats.calls;
      return true;
    } catch {
      return false;
    }
  }

  // 预算耗尽提示 (chat / chatStream 共用, 保证文案与入口口径一致)
  _budgetExhaustedReply() {
    const limit = Number(this.config.budget?.usd) || 0;
    const known = this.usageStats.knownCost ?? this.usageStats.cost ?? 0;
    return `[预算耗尽] 本次会话已知累计成本 $${known.toFixed(6)} 已达上限 $${limit} `
      + `(config budget.usd), 已停止调用模型。请调高 budget.usd 或清空预算后继续。`;
  }

  // 预算闸门: 已超限则返回提示文本, 未超限返回 null (调用方据此决定是否继续)
  _budgetBlocked() {
    return this._budgetExceeded ? this._budgetExhaustedReply() : null;
  }

  // 关闭 agent。
  // 2026-10-10 (L2): 改为**异步**并 await 军团子进程回收完成 —— 原实现同步 fire-and-forget,
  //   调用方 (worker 的 shutdown 分支 / CLI 退出) 可能在子 worker 收尾前就 process.exit,
  //   留下孤儿进程。返回 Promise 后调用方可选择 await (旧调用方不 await 也兼容)。
  async shutdown() {
    this.stopProactiveTicker();
    // 使用统计落盘 (ZCode 使用统计对齐): data/usage-stats.json
    try {
      fs.writeFileSync(path.join(this.dataDir, "usage-stats.json"),
        JSON.stringify({ updated: new Date().toISOString(), ...this.usageStats }, null, 2));
    } catch { /* 落盘失败不阻塞退出 */ }
    this._mcp?.close?.();
    // v1.0.8: 清理军团子进程 (spawn_agent 派生的 worker), 防后台残留
    if (this._legion && typeof this._legion.shutdownAll === "function") {
      try { await this._legion.shutdownAll(); } catch { /* 回收失败不阻塞退出 */ }
    }
    this.memory._saveState?.();
    this.scheduler?.shutdown?.(); // ⑤/②: 清定时器防进程挂起
    this.healer.markClean();
  }
}

// 重构 (2026-09-15): 历史/上下文管理 + 提示词构建以 mixin 方式挂回 prototype
// (行为与拆前完全一致, 实例方法与调用方不受影响; 测试走 agent._xxx 不感知拆分)
// 2026-10-10: evidenceMethods 置于 contextMethods **之后** —— 它覆盖 _pushTurn/_getSession/_maybeCompact,
//   把工具证据进上下文 + 压缩保真接进主链 (contextMethods 的旧版只认 user/assistant = 结构性失忆)。
Object.assign(PPXAgent.prototype, contextMethods, promptMethods, evidenceMethods);

ensureUTF8Console();
if (process.argv[1] && process.argv[1].endsWith("src/agent/index.js")) {
  const agent = new PPXAgent();
  console.log(`皮皮虾 就绪 | 记忆:${agent.facts.count()}条 | 工具:${agent.tools.list().join(",")} | 自愈:${agent.health.fixes.length ? "修复" + agent.health.fixes.length + "项" : "OK"}`);
  process.stdin.on("data", async (d) => {
    const line = d.toString().trim();
    if (["quit", "exit"].includes(line)) { agent.shutdown(); process.exit(0); }
    const r = await agent.chat(line);
    console.log("\n" + r + "\n");
  });
}
