// src/agent/bootstrap.js - 七段装配/事件队列/配置加载 (从 index.js 拆出, mixin 挂回 prototype)
import { noteCatch } from "../utils/catch-log.js";
import fs from "node:fs";
import path from "node:path";

import { Context, compose, loadPlugins } from "../plugin/index.js";
import { builtinPlugins } from "./plugins/builtin.js";
import { v3Plugins } from "./plugins/v3.js";
import { EventTracer } from "../core/trace.js";
import { setRunSink } from "../core/run-context.js";
import { MemoryService } from "../services/memory-service.js";
import { LearningService } from "../services/learning-service.js";
import { loadConfig } from "../config/index.js";
import { info, warn } from "../utils/logger.js";
import { WorkStack } from "../session/workstack.js";
import { builtinRules, compileUserRules } from "../intent/funnel.js";
import { IntentFunnelState } from "../intent/state.js";
import { Auditor } from "../audit/verifier.js";
import { Lifecycle } from "../ans/lifecycle.js";
import { record as rewardRecord } from "../ans/reward.js";
import { scan as evictionScan } from "../memory/eviction.js";
import { installGuard, installGuardOnCatalog } from "../ans/guard.js";
import { categorizeFailure } from "../evolve/delta-producer.js";
import { installEvolutionLoop } from "../evolve/loop.js";
import { SkillLoader } from "../skills/loader.js";
import { SkillRegistry, skillRootsFromConfig, configDisabledSkills } from "../skills/registry.js";
import { createPackCatalog } from "../orchestrator/expert-pack.js";
import { EvolutionEngine } from "../evolve/trigger.js";
import { createWorkStore, createWorkService } from "../workgraph/index.js";

import { turnObservationMethods } from "./turn-observation.js";

export const bootstrapMethods = {
  ...turnObservationMethods,


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
},

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
  // 架构优化 ②(2026-11-13): run 血缘出口接到事件流 —— 派生子 run 的 parentRunId
  //   落 events-*.jsonl (run/child), 与审计条目的 runId 同一口径, 一条命令可回溯全链。
  setRunSink((type, payload) => this.tracer.event(type, payload));
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
  // 2026-10-24: 故障病历消费 —— 工具失败时写 episode (写端在 _wireANS), refine 时检索。
  this.failures = this.ctx.consume("failures");
  // 2026-10-24 (R3): 审计链绑定到 agent —— 此前只注入 tools (audit_verify 工具用),
  //   agent 层拿不到 stats()/health(), 可观测性断了一截 (真模型 e2e 发现)。
  this.audit = this.ctx.consume("audit");
  // PWF 任务指针钩子 (设计溯源 docs/PROVENANCE.md#codex): PreCompact 时把"下一步/进行中"
  // 写入 .ppx/plan/progress.md, 压缩后 agent 从指针恢复现场 (计划在磁盘, 不在上下文)
  if (this.hooks && this.root) {
    this.hooks.on("PreCompact", async () => {
      try {
        const { writeTaskPointer } = await import("../session/pwf.js");
        writeTaskPointer(this.root, {});
      } catch (e) { noteCatch("src/agent/bootstrap.js#writeTaskPointer", e); /* 指针失败不阻断压缩 */ }
    });
  }
  // ZCode 工具能力门接线 (设计溯源 docs/PROVENANCE.md#zcode): 工具声明式能力 → 权限引擎
  //   开关: config.agent.capability_gate (默认开); auto_approve_high_risk (默认关)
  //   ⚠ 必须在 permissions/tools 都消费之后 (2026-10-03 自测发现: 原先放在消费前被静默跳过)
  if (this.permissions && this.tools && typeof this.tools.getCapability === "function") {
    this.permissions.getCapability = (n) => this.tools.getCapability(n);
    this.permissions.capabilityGate = this.config.agent?.capability_gate !== false;
    this.permissions.autoApproveHighRisk = !!this.config.agent?.auto_approve_high_risk;
  }
  // ZCode 使用统计对齐 (2026-10-02): 会话级 token/调用次数记账 (零侵入包装 provider)
  // 2026-10-30: 增 promptTokens / cacheHitTokens 两个累计字段 —— 底部状态条要显示
  //   "累计 tok · 缓存命中 %", 而原来只累计 total, 算不出命中率。
  //   「使用统计」页要按天/按模型画趋势与占比, 只有累计值就攒不出折线。
  // 2026-11-12: 增 unpriced —— 无内置价格的云端模型按 $0 记账, 必须留痕
  //   (否则预算闸门对"新模型/私有网关"完全失明)。
  this.usageStats = { calls: 0, tokens: 0, cost: 0, promptTokens: 0, cacheHitTokens: 0, byModel: {}, days: {}, unpriced: {}, lastCallAt: null, lastCostAt: null };
  this._installedAt = Date.now();
  this._lastUsageFlushCalls = 0; // 周期落盘水位 (每 N 次调用落一次盘)
  this._budgetExceeded = false;  // 达到 budget.usd 后置位, 拦截后续模型调用
  // 2026-10-30: 从 usage-stats.json 恢复累计账本。
  //   此前这个文件**只写不读** —— 每次重启盘点归零, 于是"累计 3.2M tok / 缓存命中 96%"
  //   这类指标永远攒不起来 (面板上刚涨到有意义的量就归零)。恢复只读累计字段,
  //   不恢复 budget 判定 (预算以当前 config 为准, 旧的 budget_usd 不作数)。
  this._loadUsageStats();
  this._installUsageTracking();
  // 待审批映射 (codex approval flow): id -> { req, resolve, timer }
  this._pendingApprovals = new Map();
  this._approvalSeq = 0;
  this._approvalSurfaces = new Set(); // 具名审批面登记 (Web "http" / CLI "cli" …)
  // 回合内提问 (2026-11-02 吸收 DeepSeek-Bot ask_user_question): id -> { req, resolve, timer }
  // 与审批分开: 审批无人应答要 fail-closed 拒绝, 提问无人应答要 fail-open 交给模型继续。
  this._pendingQuestions = new Map();
  this._questionSeq = 0;
  this._onQuestionEvent = null;
  this._humanChannel = false;          // CLI 人类在场标记 (无审批面但有人能答话)
  // B2: 审批缓存 (codex ApprovalStore 语义) — 会话内相同命令批准后不重复 ask
  // key = `${tool}:${原样命令}` (仅 trim); 只存批准结果, 拒绝/超时不入缓存
  this._approvalCache = new Map();
  // 永久允许 (2026-11-03): 用户「记住」的命令落盘, 启动时并回内存缓存。
  //   文件损坏/缺失不阻塞启动 —— 退化为"没有永久规则", 该问的照旧问。
  this._approvalStore = this._loadPersistentApprovals();
  for (const key of this._approvalStore.keys()) this._approvalCache.set(key, "persisted");
  // plan 模式 (2026-10-05 /plan /do 死命令修复): 按会话存储的计划态集合
  // (sessionKey -> 是否在计划模式)。与引擎级 permissions.planEnabled 是两条轨道:
  //   会话级走 /plan /do 或 HTTP 带 sessionKey; 引擎级走 HTTP 不带 sessionKey 的兜底开关。
  this._planSessions = new Set();
},

// ---- 装配阶段 3: ANS 自治接线 (免疫闸门 / Reward 闭环 / 排泄自治) ----
_wireANS() {
  // ⑧ 免疫系: 全局闸门挂到总线命令通道 (拦截+审计)
  this.__guard = installGuard(this, { allowList: this.config.agent?.guardAllowList || [] });
  // ⑦ Reward 闭环: 订阅总线工具成败, 自动更新行为倾向 (EWMA)
  this.bus?.on("tool/result", (ev) => {
    const { name, ok } = ev.payload || {};
    if (name) { try { rewardRecord(this, { tool: name, ok: !!ok }); } catch (e) { noteCatch(e); } }
    // 2026-10-24: 失败病历写入端接线 —— 此前 FailureEpisodeStore 全仓无写入方。
    //   每次工具失败记一条结构化 episode (确定性分类), 供 refine 提炼时检索相似病历。
    //   写失败只出声不阻断 (病历是增强信号, 不是主链)。
    if (ok === false && name && this.failures) {
      try {
        const errText = String(ev.payload.error || "");
        this.failures.record({
          tool: name,
          error: errText.slice(0, 500),
          category: categorizeFailure(errText),
          traceRef: ev.payload.callId ? `call:${ev.payload.callId}` : null,
        });
      } catch (e) { noteCatch(e); /* 病历失败不阻断 */ }
    }
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
    if (!hasE) this.scheduler?.add({ name: "eviction-daily", cron: "02:00", type: "daily", action: () => { try { evictionScan(this); } catch (e) { noteCatch(e); } } });
  } catch (e) { noteCatch(e); }
  // 首次启动跑一次排遗扫描 (预热治理状态)
  try { evictionScan(this); } catch (e) { noteCatch(e); }
  this._warnMissingCloudApi(); // 发布首启引导: 未配云端 key 时明确提示
},

// 装配阶段 4 (单轮运行态) 与轮观测 (Turn 投影/SQ/EQ) 已拆到 ./turn-observation.js,
// 由下方 bootstrapMethods 展开接入。

// ---- 装配阶段 5: 长期状态引擎 (生命周期 / 进化 / 审计 / 技能) ----
_initEngines() {
  // 生命周期 (ANS 独立模块): born → growing → mature → evolving / reproducing
  // v1.0.7 持久化: 状态落盘 data/memory/lifecycle.json, 跨进程/重启不归零 (P1)
  this.lifecycle = new Lifecycle({ file: path.join(this.dataDir, "memory", "lifecycle.json") });
  this.evolve = new EvolutionEngine(this, this.config.agent?.evolve || {});
  // Auditor (P0①): 唯一“已验证写回”通道 + 已验证账本 (data/audit/verified.json)
  this.auditor = new Auditor({ ledgerPath: path.join(this.dataDir, "audit", "verified.json") });
  // 方法技能目录 (设计溯源 docs/PROVENANCE.md#superpowers): 供 _context 注入技能清单, LLM 按需 load_skill
  // 2026-10-09: 同时装配 skillRegistry —— orchestration.js / skill-hub.js 一直在读
  //   `agent.skillRegistry` (skill_coverage / capability_matrix 依赖), 但此前从无任何地方 provide 过,
  //   于是这两个工具恒返回「技能注册表未装配」。这里复用同一个 loader (不改变 this.skills 的既有行为),
  //   只额外挂上按配置推导的 roots 供覆盖率统计使用。
  // 2026-10-31 (队列⑥): 多根装配落地 —— 此前 new SkillLoader(<root>/skills) 只扫内置单根,
  //   用户级 (~/.ppx/skills) 与项目级 (.ppx/skills) 技能在 agent 主路径 (技能清单注入 /
  //   load_skill / 覆盖率) **永远不可见**, skillRootsFromConfig 只喂了 registry 的 sources 汇报。
  //   现在读写同一份多根 roots (项目 > 用户 > 内置), 与 toolsPlugin 的 selfmod 同口径。
  try {
    this.skillRoots = skillRootsFromConfig(this.config, this.root);
    this.skills = new SkillLoader({ roots: this.skillRoots, maxDepth: this.config?.skills?.max_depth });
    // 技能管理页停用清单 (config.skills.disabled): 停用 = 提示注入/load_skill 不可见,
    //   元数据仍可列出以便在管理页恢复。loader 与 registry 读同一份清单 (env 评测过滤也并入)。
    const disabledSkills = configDisabledSkills(this.config);
    this.skills.setDisabled(disabledSkills);
    this.skillRegistry = new SkillRegistry({ loader: this.skills, roots: this.skillRoots, disabledSkills });
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
},

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
    // 2026-10-24 进化闭环: playbook 收经验 delta, failures 供提炼时检索相似病历
    playbook: this.playbook || null,
    failures: this.failures || null,
  });
  // 注入 LLM 摘要器/提炼器 (依赖 service, 装配后注入)
  this.memory.summarizer = (raw) => this.memorySvc.summarizeMemory(raw);
  this.memory.setExtractor((u, a, related) => this.memorySvc.extractMemory(u, a, related));

  // ---- 跨轮任务栈 (2026-10-30, P1: 「我正在干什么」) ----
  // 每轮 _context 都从人格/画像/记忆重新拼"我是谁", 却没有"手头这件事"的持久层。
  // 这里是那一层: 落在 <dataDir>/workstack.json, 跨轮/跨会话/压缩后都活着。
  // 装配失败不阻断启动 (退化 = 没有任务栈记忆, 其余功能不受影响)。
  try {
    this.workStack = new WorkStack(this.dataDir);
  } catch (e) {
    this.workStack = null;
    warn(`[workstack] 初始化失败 (任务栈不可用): ${e?.message || e}`);
  }

  // ---- 回合内计划工件 (v5.0 P2.3): update_plan 工具的状态后端 ----
  // 实例由 toolsPlugin 创建并 provide; 这里 consume 同一单例 (与 spill 同款口径)。
  // 缺席 (插件未装配) = update_plan 工具自报未初始化, 其余不受影响。
  try {
    this.planLive = this.ctx?.consume?.("planLive") || null;
  } catch {
    this.planLive = null;
  }

  // ---- 工单账本 (2026-11-02 三期第二批): 准入即建单, 执行即指派, 终态可查 ----
  // 与跨轮任务栈 (workStack, 「我正在干什么」的短文本指针) 不同: 这里是**事件事实**,
  // 每次受理/指派/完成/失败/取消都落 JSONL, 跨重启折叠。装配失败不阻断启动。
  this.workStore = null;
  this.work = null;
  const wcfg = this.config.agent?.work_graph || {};
  if (wcfg.enabled !== false) {
    try {
      this.workStore = createWorkStore({
        dir: path.join(this.dataDir, "workgraph"),
        maxTickets: Number(wcfg.max_tickets) > 0 ? Number(wcfg.max_tickets) : 2000,
        retentionDays: Number(wcfg.retention_days) >= 0 ? Number(wcfg.retention_days) : 14,
        compactAt: Number(wcfg.compact_at) > 0 ? Number(wcfg.compact_at) : 5000,
        dedupeMs: Number(wcfg.dedupe_ms) >= 0 ? Number(wcfg.dedupe_ms) : 30000,
        // Step 7: 只在显式开启续跑时写检查点 (关闭 = 不建目录、不写盘, 默认行为不变)。
        //   依赖 resume_started: 不自动恢复 working 工单就没人消费检查点。
        checkpoints: wcfg.resume_started === true && wcfg.resume_checkpoint === true,
        // Step 9: 事实存储后端 (jsonl 默认 / sqlite)。只换落盘方式, 折叠与语义不变。
        stateBackend: wcfg.state_backend || "jsonl",
      });
      this.work = createWorkService({
        store: this.workStore,
        log: { warn },
        // 事件直达 EQ: ticketId 挂顶层引用键, Web UI/watchdog/测试可按工单归组订阅
        onEvent: (type, payload, ref) => {
          this._eqPushRef?.(type, payload, { cause: "workgraph", ...ref });
          // 审计链生命周期事件 (2026-11-05, 调度闭环收口 ⑤): Router 的每一次建单/分派/
          //   收口与工具调用一样进 SHA-256 哈希链 —— 审计轨迹从"工具调用链"升级为
          //   "覆盖调度全生命周期" (Super-agent §审计事件化)。只入白名单事实字段,
          //   text/result 不入链 (防泄密防膨胀); assignment_progress 是 500ms 窗口的
          //   高频观测事件而非生命周期事实, 不入链。关闭: config.audit.lifecycle_events=false。
          //   审计写入失败不阻断 EQ (append 内部已有降级口径)。
          if (type !== "assignment_progress"
            && this.audit && typeof this.audit.appendEvent === "function"
            && this.config?.audit?.lifecycle_events !== false) {
            try {
              this.audit.appendEvent({
                event: type,
                fields: {
                  ticketId: payload?.ticketId ?? null,
                  assignmentId: payload?.assignmentId ?? null,
                  status: payload?.status ?? null,
                  worker: payload?.worker ?? null,
                  origin: payload?.origin ?? null,
                  route: payload?.route ?? null,
                  outcome: payload?.outcome ?? null,
                  sessionKey: payload?.sessionKey ?? null,
                },
              });
            } catch (e) { noteCatch(e); /* 审计写入失败不阻断事件流, EQ 已先行推送 */ }
          }
        },
      });
      // 启动恢复: 上一进程遗留的在途工单只标记 interrupted, 绝不静默重跑。
      // 两个显式例外 (都默认关):
      //   - resume_unstarted: **从未 begin 的 admitted** —— 没有执行事实, 因而没有副作用;
      //   - resume_started (Step 6): **working 且 replaySafe=true** —— 开跑过的工具全为
      //     只读/显式幂等, 整轮重放不会翻倍副作用; 有副作用的非幂等工具在**执行前**已标脏,
      //     所以"没标脏"是一个写前事实, 不是执行后的猜测。waiting 不在范围内。
      // 二者都只进队列, 等通道就绪后由 startServer 调 resumeUnstartedTickets() 显式重跑。
      this._workResumeQueue = [];
      if (String(wcfg.recover || "mark") !== "off") {
        const rec = this.work.recover({
          reason: "process_restart",
          resumeUnstarted: wcfg.resume_unstarted === true,
          resumeStarted: wcfg.resume_started === true,
          resumeMaxAgeMs: Number(wcfg.resume_max_age_ms) > 0 ? Number(wcfg.resume_max_age_ms) : undefined,
          resumeLimit: Number(wcfg.resume_limit) >= 0 ? Number(wcfg.resume_limit) : undefined,
        });
        if (rec.interrupted > 0) {
          warn(`[workgraph] ${rec.interrupted} 个未收口工单已标记 interrupted (查看 /work, 重跑 /work requeue <id>)`);
        }
        if (rec.resumable?.length) {
          this._workResumeQueue = rec.resumable;
          const replay = rec.resumable.filter((t) => t.resumeKind === "replay").length;
          warn(`[workgraph] ${rec.resumable.length} 个工单待通道就绪后自动恢复 (未开跑 ${rec.resumable.length - replay} / 无副作用重放 ${replay})`);
        }
        if (rec.stale > 0) {
          warn(`[workgraph] ${rec.stale} 个工单超龄/超限, 未自动恢复 (用 /work requeue <id> 显式重跑)`);
        }
      }
    } catch (e) {
      this.work = null;
      this.workStore = null;
      warn(`[workgraph] 初始化失败 (工单账本不可用, 其余功能不受影响): ${e?.message || e}`);
    }
  }

  // ---- 分层漏斗意图识别 (v4.2): 会话状态 + L1 规则表 ----
  // 装配失败不阻断启动 (退化 = 没有漏斗, 全部流量走 LLM 兜底层, 行为等同旧版)。
  try {
    this.intentState = new IntentFunnelState(this.dataDir);
  } catch (e) {
    this.intentState = null;
    warn(`[intent] 漏斗状态初始化失败 (层统计不可用): ${e?.message || e}`);
  }
  // L1 规则表: 内置白名单 (冻结, 做减法) + .ppx/intent-rules.json 用户扩展 (上限 64, 通配拒绝)
  this._intentRules = builtinRules();
  try {
    const rulesPath = path.join(this.root, ".ppx", "intent-rules.json");
    if (fs.existsSync(rulesPath)) {
      const parsed = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
      const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.rules) ? parsed.rules : []);
      const { rules, errors } = compileUserRules(list);
      this._intentRules = this._intentRules.concat(rules);
      for (const err of errors) warn("[intent-rules] 跳过无效规则:", err);
      if (rules.length) info(`[intent-rules] 已加载 ${rules.length} 条用户扩展规则`);
    }
  } catch (e) {
    warn("[intent-rules] 加载失败 (仅用内置规则):", e?.message || e);
  }
  // L2 分流提示块/本轮 wire 文本: 按会话键隔离 (2026-11-01 修复: 原为实例级单值字段, 而
  //   _withSessionLock 只做同会话互斥 —— 两个会话并发各跑一轮时, 后到轮的 arm 会覆盖先到轮
  //   的字段, 先到轮在 _loadHistory 的 await 窗口后把别人的提示块烘进自己的 wire、把别人的
  //   user 消息落进自己的会话历史)。键为 sessionKey || "default", 轮末由消费方删除。
  this._turnIntentHints = new Map(); // sessionKey -> L2 分流提示块 (本轮注入 user 尾部, 轮末回收)
  this._turnHistoryTexts = new Map(); // sessionKey -> 本轮 user 消息的 wire 形态 (含提示块, 会话历史按它落库)
  this._turnFileRefs = new Map(); // sessionKey -> @ 引用文件资料块 (本轮注入 user wire, 不参与记忆抽取, 轮末回收)
  // Step 7 断点续执行: 仅 replay 轮使用。hint 进 user wire 尾部, memo 供 _runTool 复用已完成步骤。
  this._turnResumeHints = new Map(); // sessionKey -> 续跑上下文说明
  this._turnResumeMemos = new Map(); // sessionKey -> Map(checkpointKey -> {ok, result, tool})
},

// ---- 装配阶段 7: 启动动作 (禁用工具 / MCP 自动连接 / 首次画像 / 进化循环) ----
_initStartup() {
  // 应用 tools.disabled: 从 config/ppx.json 读取需禁用的工具, 启动时禁用 (设置 UI 写盘生效)
  this._applyDisabledTools();
  // 应用 agent.tool_exposure: 默认 all (全量下发); core = 只下发核心名单 + 其余按需取 schema
  this._applyToolExposure();
  // 应用进程角色 (Router = 只分派不执行; 默认关闭)
  this._applyRouterRole();

  // 可选: 启动时自动连接 MCP 服务器 (config.mcp.auto_connect = true 时非阻塞连接)
  if (this.config.mcp?.auto_connect && this.config.mcp.servers?.length) {
    this.connectMcp()
      .then((n) => {
        if (n) info(`[mcp] 自动连接 ${n} 个 MCP 工具`);
        // 动态注册的工具晚于角色装配出现: Router 下重新收窄, 否则它们会绕过 disable 进入 schema
        if (this.role === "router") this._applyRouterRole();
      })
      .catch((e) => warn(`[mcp] 自动连接失败: ${e.message}`));
  }

  // 首次启动生成 L3 画像 (零依赖高频词统计, 同步快, 不调 LLM)
  this._maybeRefreshPersona();

  // 持续进化循环 (2026-10-25): learn→iterate→journal 每日编排。
  //   默认不开定时 (evolution_loop.enabled); agent._evolutionLoop 始终可用 (工具/CLI 复用)。
  try { installEvolutionLoop(this); } catch { /* 进化循环装配失败不阻断启动 */ }

  // Worker 热池预热 (v5.0 P2.1, 2026-11-07): agent.legion.pool_size > 0 且本进程不是
  //   worker 时, 后台预热常驻委派 worker —— spawn_agent 接管热进程免冷启动。
  //   池是加速器不是依赖: 预热失败静默降级; 进程退出随 agent.shutdown → shutdownAll 回收。
  try {
    const poolSize = Math.max(0, Number(this.config?.agent?.legion?.pool_size) || 0);
    if (poolSize > 0 && process.env.PPX_AGENT_ROLE !== "worker") {
      import("../orchestrator/legion.js").then(({ Legion }) => {
        if (this._legion) { this._legion.poolSize = poolSize; }
        else { this._legion = new Legion({ poolSize, maxConcurrent: Number(this.config?.agent?.legion?.max_concurrent_agents) || 8 }); }
        this._legion.warmPool({ globalDataDir: this.globalDataDir }).then((warmed) => {
          if (warmed.length) info(`[legion] worker 热池就绪: ${warmed.length}/${poolSize}`);
        }).catch(() => { /* 池预热失败 = 退回冷启动, 不阻断 */ });
      }).catch(() => { /* 动态导入失败不阻断启动 */ });
    }
  } catch { /* 热池装配失败不阻断启动 */ }
},

_loadConfig(configFile) {
  return loadConfig(this.root, configFile);
}
};
