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
// 重构第一刀 (2026-09-14): 工具循环执行策略抽至 src/core/policy.js
// (探索熔断/重复检测/溢出降档/错误重试/结果裁剪/循环驱动), 重新导出保持测试与外部兼容
import { runToolLoop, LLM_FAILED_HINT, EMPTY_REPLY } from "../core/policy.js";
// 重构第三刀 (2026-09-14): 结构化事件流 traceId 贯穿 (AsyncLocalStorage), 关键路径埋点
import { EventTracer, runWithTrace, currentTrace } from "../core/trace.js";
// 重构第二刀 (2026-09-14): 记忆升降级 + 自我学习收敛为独立服务, agent 只保留薄委托
import { MemoryService } from "../services/memory-service.js";
import { LearningService } from "../services/learning-service.js";
export { isOverflowError as _isOverflowError, trimToolResult, toToolContent } from "../core/policy.js";
import { logicalDay } from "../utils/store.js";
import { scrubPII } from "../utils/pii.js";
import { loadConfig } from "../config/index.js";
import { info, warn, error, debug } from "../utils/logger.js";
// 2026-10-10 修复 (P0-1): 成本折算依赖 estimateCost, 但此前只有调用、没有 import ——
// 每次记账抛 ReferenceError 又被同行空 catch 吞掉, 导致 金额统计/按模型分账/预算闸门/周期落盘
// 四条链路 100% 静默失效。补上import 并把 catch 改为留痕, 防止再次"加了功能但没接线"。
import { estimateCost } from "../llm/pricing.js";
import { Context, compose, loadPlugins } from "../plugin/index.js";
import { builtinPlugins, resolveLLM, resolveAllLLMs, isUsableProvider } from "../plugin/builtin.js";
// v3.0 (codex 对齐): 新层插件 (permissions/hooks/commands/evidence/protocol)
import { v3Plugins } from "../plugin/v3.js";
// 2026-10-24 (R12): Turn 投影层 + SQ/EQ 事件常量 —— Turn 状态机此前从未被装配
// (projection.js 宣称"接入主链路"实为零消费悬空代码), SQ 也零生产者。本轮接线:
// chat/chatStream 每轮 begin→(SQ 提交 USER_TURN op)→end→(消费 op + EQ 推 TURN_* 事件)。
import { TurnProjection } from "../session/projection.js";
import { OpType, EventType } from "../protocol/index.js";
// P2-3: 占位符判定与路由共用唯一真相源, 避免"启动告警"和"实际选模型"两套口径漂移
import { isPlaceholder, hasPlaceholderField } from "../config/placeholder.js";
import { registerMcpTools } from "../mcp/index.js";
import { createTaskBoard } from "../mcp/tasks.js";
import { Auditor } from "../audit/verifier.js";
// ANS 独立模块 (可更换): 价值对齐 / 自主任务生成 / 生命周期
import { Lifecycle } from "../ans/lifecycle.js";
import { suggestProactive, markTaskDone } from "../ans/proactive.js";
import { record as rewardRecord, status as rewardStatus } from "../ans/reward.js";
import { scan as evictionScan, status as evictionStatus } from "../ans/eviction.js";
import { installGuard, guardStatus, installGuardOnCatalog } from "../ans/guard.js";
import { categorizeFailure } from "../evolve/delta-producer.js";
// 持续进化循环 (2026-10-25): learn→iterate→journal 每日编排 (config.agent.evolution_loop)
import { installEvolutionLoop } from "../evolve/loop.js";
import { estimateTokens } from "../utils/text.js";
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
    // 2026-10-24: 故障病历消费 —— 工具失败时写 episode (写端在 _wireANS), refine 时检索。
    this.failures = this.ctx.consume("failures");
    // 2026-10-24 (R3): 审计链绑定到 agent —— 此前只注入 tools (audit_verify 工具用),
    //   agent 层拿不到 stats()/health(), 可观测性断了一截 (真模型 e2e 发现)。
    this.audit = this.ctx.consume("audit");
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
    this.usageStats = { calls: 0, tokens: 0, cost: 0, byModel: {} };
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
        } catch { /* 病历失败不阻断 */ }
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
    // 2026-10-24: SessionStart/SessionStop 钩子接线 —— 此前两个事件全仓无 emit 点。
    //   _seenSessions 记录已 emit 过 SessionStart 的会话 (每会话一次, 首次对话触发)。
    this._seenSessions = new Set();
    // 2026-10-24 (R5): 会话重定向 (rewind/resume 的落地机制) + 同会话互斥锁。
    //   _sessionRedirect: 原始 key -> 分支 key —— chat/chatStream 入口解析, 后续对话
    //   自动落到 fork 出的新分支 (append-only 日志不做物理截断, 原会话保留可审计)。
    //   _sessionLocks: 同一 sessionKey 的并发轮次串行化 (防历史交错), 跨会话仍并行。
    this._sessionRedirect = new Map();
    this._sessionLocks = new Map();
    this._turnInProgress = false; // chatStream 降级进 _chatCore 时保留回放缓存 (防双执行)
    // 2026-10-24 (R12): Turn 投影层装配 —— 每轮对话的 Session→Task→Turn 生命周期观测。
    //   config.agent.turn_projection === false 时整体旁路 (投影 + SQ op + EQ 事件一起停)。
    this.turnProjection = new TurnProjection();
    if (this.config?.agent?.turn_projection === false) this.turnProjection.enabled = false;
  }

  // ---- 2026-10-24 (R12): 轮观测 begin/end —— Turn 投影 + SQ op + EQ 事件三件套 ----
  // begin: (清扫死轮遗留 op) → 投影开 turn + SQ 提交 USER_TURN op + EQ 推 TURN_STARTED。
  // end:   消费本 op (队列不留残留) + 消费已生效的 INTERRUPT op + 投影收口 + EQ 推 TURN_CLOSED/TURN_ABORTED。
  // 全程 try 包裹, 投影层永不影响主链路 (projection.js 既有约定)。
  // 2026-10-25 (SQ 真实化): begin 前先 TTL 清扫 —— 崩溃/断连轮次遗留的 op 不再永久
  //   占住队列 (队列只增不减 = 装饰性的根因之一); end 把中断轮积累的 INTERRUPT op
  //   一并消费掉 (控制 op 生命周期 = 提交 → 中断生效 → 轮收口消费, 全程在队可观测)。
  _turnObsBegin(sessionKey, userMsg, channel) {
    if (!this.turnProjection?.enabled) return null;
    let turnId = null;
    let seq = null;
    let opId = null;
    try {
      const t = this.turnProjection.begin(sessionKey, userMsg);
      if (t) { turnId = t.turnId; seq = t.seq; }
    } catch { /* 投影异常不阻断 */ }
    try {
      const bus = this.protocolBus;
      if (bus?.sq) {
        // 死轮遗留清扫: 超过 10 分钟仍未消费的非中断 op = 崩溃轮残留, 记事件后移除
        const stale = (typeof bus.sq.sweep === "function" && bus.sq.sweep(10 * 60 * 1000)) || [];
        for (const op of stale) {
          try { this.tracer?.event?.("protocol/stale_op_swept", { id: op.id, type: op.type, ageMs: op.ageMs }); } catch {}
        }
        opId = bus.sq.submit({
          type: OpType.USER_TURN,
          payload: { sessionKey, text: String(userMsg ?? "").slice(0, 2000) },
        });
        bus.eq?.push?.({ type: EventType.TURN_STARTED, payload: { sessionKey, turnId, opId, seq, channel } });
      }
    } catch { /* 总线异常不阻断 */ }
    try { this.bus?.emit?.("chat/turn/begin", { sessionKey, turnId, opId, seq, channel }, { source: "agent.turn" }); } catch { /* 观测事件不阻断 */ }
    return { opId, turnId };
  }

  _turnObsEnd(sessionKey, obs, status = "closed") {
    if (!obs || !this.turnProjection?.enabled) return;
    try {
      const bus = this.protocolBus;
      if (obs.opId && bus?.sq) bus.sq.consume(obs.opId); // 收口: 只消费本轮自己的 op
      // 已生效的中断 op 一并收口: INTERRUPT 提交即生效 (interrupt() 内置位+掐流),
      // 轮结束后把队列里积压的中断 op 清走, 队列回到"只剩各在轮 USER_TURN op"的真态。
      // consumeType 只动 INTERRUPT —— 并发会话的 USER_TURN op 不受影响 (各轮自己收口)。
      if (bus?.sq && typeof bus.sq.consumeType === "function") {
        const consumed = bus.sq.consumeType(OpType.INTERRUPT);
        if (consumed.length) {
          try { this.tracer?.event?.("protocol/interrupt_ops_consumed", { count: consumed.length }); } catch {}
        }
      }
      if (status === "aborted") this.turnProjection.abort?.(sessionKey);
      else this.turnProjection.complete?.(sessionKey);
      bus?.eq?.push?.({
        type: status === "aborted" ? EventType.TURN_ABORTED : EventType.TURN_CLOSED,
        payload: { sessionKey, turnId: obs.turnId, status },
      });
    } catch { /* 观测收口异常不阻断 */ }
    try { this.bus?.emit?.("chat/turn/end", { sessionKey, turnId: obs.turnId, status }, { source: "agent.turn" }); } catch { /* 观测事件不阻断 */ }
  }

  // 协议总线可观测快照 (供 /health 与诊断): SQ 积压 op 数 + EQ 序号水位。
  protocolStats() {
    const bus = this.protocolBus;
    if (!bus) return { sqPending: 0, eqSeq: 0 };
    let sqPending = 0;
    let eqSeq = 0;
    try { sqPending = Number(bus.sq?.size?.()) || 0; } catch {}
    try {
      const hist = bus.eq?.history?.() || [];
      eqSeq = hist.length ? hist[hist.length - 1].seq : 0;
    } catch {}
    return { sqPending, eqSeq };
  }

  // EQ 推事件的安全包装 (2026-10-25): 事件流永不阻断主链路; WAL 落盘等异常静默。
  _eqPush(type, payload) {
    try { this.protocolBus?.eq?.push?.({ type, payload }); } catch { /* 事件流异常不阻断 */ }
  }

  // EQ payload 紧凑预览: 事件会进 WAL 长期落盘, 大参数/大结果必须截断 (默认 200 字符)。
  _eqPreview(v) {
    try {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return (s || "").slice(0, 200);
    } catch { return String(v).slice(0, 200); }
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
      // 2026-10-24 进化闭环: playbook 收经验 delta, failures 供提炼时检索相似病历
      playbook: this.playbook || null,
      failures: this.failures || null,
    });
    // 注入 LLM 摘要器/提炼器 (依赖 service, 装配后注入)
    this.memory.summarizer = (raw) => this.memorySvc.summarizeMemory(raw);
    this.memory.setExtractor((u, a, related) => this.memorySvc.extractMemory(u, a, related));
  }

  // ---- 装配阶段 7: 启动动作 (禁用工具 / MCP 自动连接 / 首次画像 / 进化循环) ----
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

    // 持续进化循环 (2026-10-25): learn→iterate→journal 每日编排。
    //   默认不开定时 (evolution_loop.enabled); agent._evolutionLoop 始终可用 (工具/CLI 复用)。
    try { installEvolutionLoop(this); } catch { /* 进化循环装配失败不阻断启动 */ }
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
  // 2026-10-25 (SQ 真实化): 中断作为控制 op 走 SQ 队列 —— 此前 SQ 只有 USER_TURN
  //   提交-同轮消费一种形状 (装饰性队列)。现在 INTERRUPT op 入队 + EQ 推事件,
  //   由轮收口 (_turnObsEnd) 统一消费, 控制指令与用户回合共用同一条 FIFO 总线。
  interrupt(sessionKey) {
    this._interrupted = true;
    try {
      const bus = this.protocolBus;
      if (bus?.sq) {
        bus.sq.submit({ type: OpType.INTERRUPT, payload: { sessionKey: sessionKey || null } });
        bus.eq?.push?.({ type: EventType.TURN_ABORTED, payload: { sessionKey: sessionKey || null, cause: "interrupt" } });
      }
    } catch { /* 队列不可用不影响既有中断语义 */ }
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
    const orig = sessionKey || "default";
    // 2026-10-24 (R9 审计): 重定向感知 —— 回卷/恢复后实际会话在分支 key 上,
    //   直接删原始 key 会"删了旧的、分支还在", 用户重置无感知。先解析再删,
    //   并清空指向该会话的重定向 (回到原始命名空间); 陈旧的原始日志也一并删除。
    const key = this._redirectSession ? this._redirectSession(orig) : orig;
    this.sessionStore.delete(key);
    if (key !== orig) this.sessionStore.delete(orig);
    this._planSessions.delete(key);
    this._planSessions.delete(orig);
    for (const [k, v] of this._sessionRedirect || []) {
      if (k === orig || v === key || k === key) this._sessionRedirect.delete(k);
    }
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

  // 2026-10-24 (R3): 斜杠命令全量接线 —— 此前 13 条内置命令只有 /plan /do 被 chat 消费,
  //   其余 11 条的意图对象产出后无人执行 (dead dispatch, 审计实锤)。本方法是"集成层":
  //   registry 产意图 → agent 落地。返回 null = 非命令输入, 交回 LLM 主链;
  //   返回字符串 = 命令结果, 直接作为回复 (不进 LLM, 不落库 —— 控制面操作不污染对话历史)。
  async _executeCommand(userMsg, sessionKey) {
    if (!this.commands || typeof this.commands.parse !== "function") return null;
    const parsed = this.commands.parse(userMsg);
    if (!parsed) return null;
    const cmd = this.commands.get(parsed.cmd);
    if (!cmd) {
      return `未知命令: /${parsed.cmd}。可用: ${this.commands.list().map((c) => "/" + c.name).join("  ")}`;
    }
    let intent;
    try { intent = this.commands.execute(userMsg, { sessionKey }); } catch (e) {
      return `命令执行失败: ${e.message}`;
    }
    // /plan /do 由 _consumePlanCommand 在上游处理, 这里放行
    if (intent && intent.type === "intent"
      && (intent.action === "enter_plan_mode" || intent.action === "exit_plan_mode")) return null;
    if (!intent) return null;
    if (intent.type === "message") return String(intent.content || "");
    if (intent.type === "error") return String(intent.message || "命令失败");
    if (intent.type === "prompt") {
      // 用户命令 (.ppx/commands/*.md) = prompt 模板, $ARGUMENTS 填参后走 LLM 主链
      const filled = String(intent.template || "").replace(/\$ARGUMENTS/g, parsed.args || "").trim();
      return this.chat(filled, { sessionKey });
    }
    if (intent.type !== "intent") return null;

    const sk = sessionKey || "default";
    switch (intent.action) {
      case "new_session":
        this.resetSession(sk);
        // (R5) 清掉指向该会话的重定向 (重置即回到原始命名空间)
        for (const [k, v] of this._sessionRedirect || []) if (v === sk) this._sessionRedirect.delete(k);
        return `会话 ${sk} 已重置, 全新开始。`;
      case "rewind": {
        const r = this.rewindSession(sk, intent.turns);
        if (!r.ok) return `回退失败: ${r.reason}`;
        return `已回退最近 ${r.droppedTurns} 轮对话 → 新分支 ${r.newKey}。后续对话自动在分支上继续; 原会话保留可审计。`
          + `\n(注: 已写入的长期记忆不受回卷影响, 需要时用 memory_forget 管理。)`;
      }
      case "resume_session": {
        // (R5) 重定向语义: 直接把对话流切到目标会话 (原会话完整保留, 比 R3 的拷贝合并更干净)
        if (!intent.sessionId) {
          const recent = (this.sessionStore.list() || [])
            .filter((s) => !s.archived && s.key !== sk).slice(0, 8);
          return recent.length
            ? `最近会话:\n${recent.map((s) => `- ${s.key} (${s.count || 0} 条事件)`).join("\n")}\n用 /resume <会话名> 继续。`
            : "暂无其他历史会话。";
        }
        if (!this.sessionStore.has(intent.sessionId)) return `会话不存在: ${intent.sessionId}`;
        if (intent.sessionId === sk) return "当前已在该会话。";
        const map = this._sessionRedirect || (this._sessionRedirect = new Map());
        for (const [k, v] of map) if (v === sk) map.set(k, intent.sessionId);
        map.set(sk, intent.sessionId);
        return `会话已切换 → ${intent.sessionId} (${this.sessionStore.count(intent.sessionId)} 条事件)。后续对话在此继续, 原会话保留。`;
      }
      case "compact": {
        const r = await this._maybeCompact(sk);
        if (r && r.ok) return `已压缩会话 ${sk} (method=${r.method}, upToSeq=${r.upToSeq})。`;
        return "当前未达压缩阈值 (历史 token ≤ 1.5× 预算), 无需压缩。";
      }
      case "review": {
        if (!this.tools || !this.tools.has("review_code")) return "review_code 工具未装配。";
        return this.tools.call("review_code", { path: intent.target || "." }, { agent: this });
      }
      case "init_project": {
        const p = path.join(this.root, "PPX.md");
        if (fs.existsSync(p)) return `PPX.md 已存在 (${p}), 项目记忆继续沿用。`;
        fs.writeFileSync(p, [
          "# PPX.md — 项目记忆 (皮皮虾每次启动自动读取)",
          "",
          "## 构建与验证",
          "- 测试: `npm test` · 快检: `npm run verify`",
          "",
          "## 约定",
          "<!-- 在这里写下: 架构约定 / 代码风格 / 禁止事项 / 常用命令 -->",
          "",
        ].join("\n"));
        return `已创建 PPX.md (${p}) —— 写入项目约定后, 每次对话自动注入。`;
      }
      case "set_model": {
        const providers = this.allProviders || [];
        if (!intent.model) {
          return providers.length
            ? `可用模型:\n${providers.map((c) => `- ${c.model}${c === this.llm ? " (当前)" : ""}`).join("\n")}\n用 /model <名称> 切换。`
            : "无可用 provider (未配置或全部不可达)。";
        }
        const hit = providers.find((c) => c.model === intent.model || c.providerId === intent.model);
        if (!hit) return `未找到模型/provider: ${intent.model}。可用: ${providers.map((c) => c.model).join(", ") || "(无)"}`;
        this.llm = hit;
        return `会话内主模型已切换 → ${hit.model} (进程级, 不写配置文件; 持久切换请用设置界面)。`;
      }
      case "show_status": {
        const lines = [
          `模型: ${this.llm?.model || "(未配置)"}${(this.allProviders || []).length > 1 ? ` · 备选 ${this.allProviders.length - 1} 个` : ""}`,
          // (R17) 生命周期摘要化 —— 此前整段 JSON.stringify 直出, /status 里塞着
          //   bornAt 时间戳/ageMs 毫秒/recent 数组, 用户视角是噪音。
          (() => {
            const st = this.lifecycleStatus?.() || {};
            const bits = [`阶段 ${st.stage || "-"}`];
            if (st.chats != null) bits.push(`${st.chats} 次对话`);
            if (st.evolved) bits.push(`进化 ${st.evolved} 次`);
            return `生命周期: ${bits.join(" · ")}`;
          })(),
          `使用: ${this.usageStats.calls} 次调用 / ${this.usageStats.tokens} tokens / $${Number(this.usageStats.cost).toFixed(6)}`,
          `记忆: L1 事实 ${this.facts?.count?.() ?? "?"} 条 · 会话 ${this.sessionStore?.count?.(sk) ?? 0} 条事件`,
          `计划模式: ${this.isPlanMode(sk) ? "开 (/do 退出)" : "关"}`,
          `审计链: ${this.audit ? (this.audit.stats?.()?.detail || "就绪") : "未装配"}`,
          `自愈: ${this.health ? `${(this.health.fixes || []).length} 项修复记录` : "未装配"}`,
        ];
        return lines.join("\n");
      }
      case "memory": {
        if (String(intent.sub || "").toLowerCase() === "clear") {
          return "批量清空记忆请走治理通道: memory_forget (软删可回滚) / memory_clear_layer (按层)。斜杠命令不做不可逆删除。";
        }
        return `记忆概览: L1 事实 ${this.facts?.count?.() ?? "?"} 条。检索用 memory_search, 遗忘用 memory_forget (可回滚)。`;
      }
      case "list_skills": {
        const list = this.skills?.list?.() || [];
        return list.length
          ? `可用技能 (${list.length}):\n${list.map((s) => `- ${s.name || s.id}${s.description ? ` — ${String(s.description).slice(0, 60)}` : ""}`).join("\n")}`
          : "暂无技能。用 create_skill 创建, 或 refineSkill 从成功轨迹自动沉淀。";
      }
      case "agents": {
        if (String(intent.sub || "list") === "spawn") {
          return "派生子 agent 请使用 spawn_agent 工具 (支持多任务并行 / 差异化视角 / 仲裁聚合 / SDD 审查循环)。";
        }
        const list = this._legion?.list?.() || [];
        return list.length
          ? `军团在编 (${list.length}): ${list.map((a) => a.name).join(", ")}`
          : "军团未激活 (spawn_agent 首次调用时创建)。";
      }
      case "goal_board": {
        const sub = String(intent.sub || "list");
        if (sub === "add" || sub === "update") {
          return `${sub} 需要参数 (title/status/...), 请直接使用 goal_board 工具。`;
        }
        if (!this.tools || !this.tools.has("goal_board")) return "goal_board 工具未装配。";
        return this.tools.call("goal_board", { action: "list" }, { agent: this });
      }
      case "task_board": {
        // (R17) /task 命令落地: 侧栏提示"发送 /task 创建"此前指向不存在的命令。
        //   与 HTTP /api/tasks、MCP ppx.task.* 共享同一份 TaskBoard 落盘 (data/tasks.json)。
        const tb = this.getTaskBoard();
        const sub = String(intent.sub || "list");
        if (sub === "add") {
          const t = tb.create({ title: String(intent.arg || "未命名任务").slice(0, 120) });
          return `已创建任务 **${t.title}** (${t.id})。侧栏任务面板可见; /task done ${t.id} 完结, /task del ${t.id} 删除。`;
        }
        if (sub === "done") {
          const t = tb.complete(String(intent.arg || ""));
          return `任务 **${t.title}** (${t.id}) 已完结。`;
        }
        if (sub === "del") {
          const r = tb.delete({ id: String(intent.arg || "") });
          if (!r.ok) return `任务不存在: ${intent.arg}`;
          return `任务 ${intent.arg} 已删除。`;
        }
        const { tasks, counts } = tb.list();
        if (!tasks.length) return "任务面板为空。用法: /task add <标题> · /task · /task done <id> · /task del <id>";
        const lines = [`## 任务面板 (${counts.todo} 待办 · ${counts.running} 进行 · ${counts.done} 完成${counts.failed ? ` · ${counts.failed} 失败` : ""})`];
        for (const t of tasks.slice(0, 15)) {
          const step = t.steps.length ? ` — 步骤 ${t.steps.filter((x) => x.status === "done").length}/${t.steps.length}` : "";
          lines.push(`- [${t.status === "done" ? "x" : " "}] \`${t.id}\` **${t.title}** (${t.status})${step}`);
        }
        return lines.join("\n");
      }
      default:
        return null;
    }
  }

  // (R17) 共享任务面板实例: /task 命令、HTTP /api/tasks、MCP ppx.task.* 三方同源。
  getTaskBoard() {
    if (!this._taskBoardInst) this._taskBoardInst = createTaskBoard(this.root);
    return this._taskBoardInst;
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
    if (perm.decision === "deny") {
      this.tracer.event("tool/perm-denied", { tool: name, reason: perm.reason });
      return { ok: false, error: `[permission] 工具 ${name} 被拒绝: ${perm.reason || "命中 deny 规则"}` };
    }
    // 2026-10-24 (R14): MCP 外部工具审批闸门 —— 外部 MCP 服务器提供的工具是未审计的
    //   第三方代码, 名称不可能命中基于名字的 REQUIRES_APPROVAL_TOOLS 名单, ON_REQUEST
    //   模式下会静默放行 (真模型探测实锤: MCP 工具零审批执行)。现按 server 级 trusted
    //   开关 (config.mcp.servers[].trusted, 默认 false = 需审批) 升级为 ask, fail closed。
    //   UNLESS_TRUSTED 档已被"非白名单即问"覆盖 (不会走到这, perm 已是 ask); NEVER 档维持不问。
    if (perm.decision === "allow" && this.permissions?.approvalMode !== "never") {
      const def = this.tools?.metaOf?.(name);
      if (def && def.category === "mcp" && def.mcpTrusted !== true) {
        perm = { decision: "ask", reason: `MCP 外部工具 "${name}" 所在服务器未标记 trusted (config.mcp.servers[].trusted), 默认需审批` };
      }
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
  // 2026-10-24 (R5): 同会话互斥 —— 同一 sessionKey 的并发轮次串行化 (防历史交错/记忆双写),
  //   不同会话仍完全并行。锁不跨进程 (多进程共享 dataDir 的隔离靠独立 dataDir, 军团语义)。
  async chat(userMsg, opts = {}) {
    const sk = opts.sessionKey || "default";
    return this._withSessionLock(sk, () => this._chatCore(userMsg, opts));
  }

  // 同会话串行执行器: 前一轮未完成时排队 (Promise 链), 完成后自清理防 Map 膨胀
  async _withSessionLock(sk, fn) {
    const locks = this._sessionLocks || (this._sessionLocks = new Map());
    const prev = locks.get(sk) || Promise.resolve();
    const run = prev.then(fn, fn); // 前一轮失败不阻塞下一轮
    const tail = run.catch(() => {});
    locks.set(sk, tail);
    void tail.then(() => { if (locks.get(sk) === tail) locks.delete(sk); });
    return run;
  }

  // 2026-10-24 (R5): 会话重定向解析 —— rewind/resume 把对话流切到 fork 分支
  _redirectSession(sessionKey) {
    const sk = sessionKey || "default";
    return this._sessionRedirect?.get(sk) || sk;
  }

  // 会话回卷: 把当前会话回退最近 N 轮对话 (fork 到新分支, append-only 原会话保留)。
  // 返回 { ok, droppedTurns?, newKey?, reason? }。长期记忆 (L1+) 不受回卷影响 ——
  // 已提炼的记忆用 memory_forget 管理与会话回退解耦 (诚实语义, 不做假装的"全部撤销")。
  rewindSession(sessionKey, turns = 1) {
    const sk = this._redirectSession(sessionKey);
    const userTurns = this.sessionStore.replay(sk).filter((e) => e.type === "user/message");
    if (!userTurns.length) return { ok: false, reason: "没有可回退的对话轮" };
    const n = Math.max(1, Math.min(Number(turns) || 1, userTurns.length));
    const boundary = userTurns[userTurns.length - n].seq - 1; // 回到该轮 user 消息之前
    if (boundary < 0) return { ok: false, reason: "已处于会话起点, 无可回退内容" };
    const toKey = `${sessionKey}-rw-${Date.now().toString(36)}`;
    this.sessionStore.fork(sk, boundary, toKey);
    // 重定向链收敛: 当前 key → 新分支; 所有指向当前 key 的旧映射一并改指新分支
    const map = this._sessionRedirect || (this._sessionRedirect = new Map());
    for (const [k, v] of map) if (v === sk) map.set(k, toKey);
    map.set(sessionKey, toKey);
    return { ok: true, droppedTurns: n, newKey: toKey };
  }

  async _chatCore(userMsg, { persist = true, sessionKey = "default", mode = null, turnObs = null } = {}) {
    // 2026-10-24 (R9 审计): 重定向必须在 runWithTrace **之前**解析 —— trace 上下文的
    //   options 在调用时求值, 此前回调里的重赋值不会传进去, 导致 _admitToolCall 的
    //   计划态检查 / _turnsUsedTools / _recordDraft 全部读重定向前的旧会话 key
    //   (回卷/恢复后 /plan 形同虚设)。解析后传入, trace 携带真实会话。
    sessionKey = this._redirectSession(sessionKey);
    // 2026-10-24 (R12): 轮观测 begin —— Turn 投影开 turn + SQ 提交 USER_TURN op +
    //   EQ 推 TURN_STARTED。chatStream 降级进本函数时传入已有 obs (不重复开, 收口归它)。
    //   begin 放在所有早退 (预算/命令/计划) 之前: 控制面操作同样是用户轮, 不留悬空 turn。
    const ownObs = !turnObs;
    const obs = turnObs || this._turnObsBegin(sessionKey, userMsg, "chat");
    let _turnStatus = "closed";
    try {
    // 重构第三刀: 入口生成 traceId, 记忆/工具/学习子调用自动继承 (AsyncLocalStorage)
    return await runWithTrace(async () => {
    this.clearInterrupt(); // 新一轮对话开始, 复位上一轮的中断状态
    // 2026-10-24 (R2): 回退重放缓存按轮重置 (防双执行, 见 _runTool)。
    //   (R5) 流式降级进本函数时 _turnInProgress 为真 —— 缓存保留, 非幂等工具不双执行。
    if (!this._turnInProgress) {
      this._turnAttempt = 0;
      this._turnExecCache = new Map();
    }
    // 2026-10-10 修复 (P0-1 孪生): _budgetBlocked() 此前定义了却无任何调用方 —— 预算闸门
    //   即使置位也拦不住下一次 chat。闸门必须在"入口"处消费, 在花任何 token 之前。
    const blocked = this._budgetBlocked();
    if (blocked) return blocked;
    this.bus?.emit("chat/user", { userMsg, sessionKey }, { source: "agent.chat" });
    // 2026-10-24: SessionStart 钩子 (每会话一次): 会话恢复/新会话首次对话时触发,
    //   供外部钩子做会话级预热 (加载项目上下文/欢迎注入)。emit 异常不阻断主链。
    {
      const sk = sessionKey || "default";
      if (!this._seenSessions.has(sk)) {
        this._seenSessions.add(sk);
        try { this.hooks?.emit?.("SessionStart", { sessionKey: sk, source: "chat" })?.catch?.(() => {}); } catch { /* 不阻断 */ }
      }
    }
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
    // 2026-10-24 (R3): 斜杠命令全量接线 —— 命令结果直接作回复 (不进 LLM、不落库:
    //   控制面操作不污染对话历史)。返回 null = 非命令, 走 LLM 主链。
    if (!planIntent) {
      const cmdOut = await this._executeCommand(userMsg, sessionKey);
      if (cmdOut !== null) return this._maskReplyPII(String(cmdOut));
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
    if (this._notifyCb && usedTools) this.notify("[done] 任务完成 (工具执行)。");
    // 2026-10-24 (R9 审计): chat 通道同样要做会话工具标记收口 —— 此前只有 chatStream
    //   收口, chat 通道的条目永久残留 (长跑多会话下 Map 无界增长 + 语义陈旧)。
    this._turnsUsedTools?.delete(sessionKey);

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
    } catch (e) {
      _turnStatus = "aborted"; // 异常逃逸 = 本轮中止 (finally 收口, 不留悬空 open turn)
      throw e;
    } finally {
      if (ownObs) this._turnObsEnd(sessionKey, obs, _turnStatus);
    }
  }

  // PII 回复掩码 (2026-10-09, 合规敏感部署): security.pii_reply_mask=true 时对**用户可见回复**
  //   做脱敏 (邮箱/手机/证件号/凭证 → [REDACTED])。只作用于对外输出 —— 落库与会话历史里仍是模型
  //   原文 (掩码不该让记忆层失真)。默认 false, 不破坏开发工作流。非字符串/异常一律原样返回。
  _maskReplyPII(reply) {
    if (this.config?.security?.pii_reply_mask !== true) return reply;
    if (typeof reply !== "string" || !reply) return reply;
    try { return scrubPII(reply).cleaned || reply; } catch { return reply; }
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
  // 2026-10-24 (R5): 同会话互斥锁 + rewind/resume 重定向, 与 chat 同一套机制。
  async chatStream(userMsg, opts = {}) {
    const sk = opts.sessionKey || "default";
    return this._withSessionLock(sk, () => this._chatStreamCore(userMsg, opts));
  }

  async _chatStreamCore(userMsg, { sessionKey = "default", onDelta, onTool, onStep } = {}) {
    // (R9 审计) 与 _chatCore 同款: 重定向在 runWithTrace 之前解析, trace 携带真实会话
    sessionKey = this._redirectSession(sessionKey);
    // 2026-10-24 (R12): 轮观测 begin —— 与 chat 同款三件套, begin 在所有早退之前
    //   (命令/预算/无 llm 委托都算用户轮); 异常与用户中断由收口标 aborted。
    const obs = this._turnObsBegin(sessionKey, userMsg, "chatStream");
    let _turnStatus = "closed";
    try {
    // 重构第三刀: 入口生成 traceId (无 LLM 降级 chat 时嵌套新 trace, 独立可追踪)
    return await runWithTrace(async () => {
    // 2026-10-24 (R8) 修复: 斜杠命令接入流式通道 —— R3 只接了 chat, Web UI 走
    //   chatStream 发 /status /skills /rewind 会被当普通文本喂给 LLM (实测实锤)。
    //   语义与 _chatCore 完全一致: 命令命中 → 直接回文案 (经 onDelta 推给前端),
    //   不调 LLM、不落库。/plan /do 翻转计划态后同样直接返回。
    {
      const planIntent = this._consumePlanCommand(userMsg, sessionKey);
      if (planIntent) {
        if (planIntent.action === "enter_plan_mode") {
          this.setPlanMode(sessionKey, true);
          const msg = "已进入计划模式: 后续工具调用仅允许只读操作, 请先产出计划交用户审阅; 输入 /do 退出计划模式开始执行。";
          if (onDelta) onDelta(msg);
          return this._maskReplyPII(msg);
        }
        if (this.isPlanMode(sessionKey)) {
          this.setPlanMode(sessionKey, false);
          const msg = "已退出计划模式, 恢复执行。";
          if (onDelta) onDelta(msg);
          return this._maskReplyPII(msg);
        }
        const msg = "当前会话不在计划模式, 无需退出。";
        if (onDelta) onDelta(msg);
        return this._maskReplyPII(msg);
      }
      const cmdOut = await this._executeCommand(userMsg, sessionKey);
      if (cmdOut !== null) {
        if (onDelta) { try { onDelta(String(cmdOut)); } catch { /* 消费方异常不阻断 */ } }
        return this._maskReplyPII(String(cmdOut));
      }
    }
    if (!this.llm) return this.chat(userMsg, { sessionKey, turnObs: obs });
    // 2026-10-24 (R2): 流式轮同样重置回退重放缓存
    this._turnAttempt = 0;
    this._turnExecCache = new Map();
    // 2026-10-10 修复 (P0-1 孪生): 流式入口同样消费预算闸门 —— 超限时不得再发上游请求,
    //   并把提示同时推给 onDelta (否则前端只会看到空白流)。
    const blocked = this._budgetBlocked();
    if (blocked) { onDelta && onDelta(blocked); return blocked; }
    // 2026-10-24 (R4): SessionStart 追踪与 chat 对齐 —— 此前流式路径的会话不触发
    //   SessionStart 钩子 (钩子只对 chat 路径的会话可见)。
    {
      const sk = sessionKey || "default";
      if (!this._seenSessions.has(sk)) {
        this._seenSessions.add(sk);
        try { this.hooks?.emit?.("SessionStart", { sessionKey: sk, source: "chatStream" })?.catch?.(() => {}); } catch { /* 不阻断 */ }
      }
    }
    this.clearInterrupt(); // 新一轮对话开始, 复位中断状态
    // 内核自主决策: 高置信简单指令本地处理
    const local = (this.config.agent?.localIntent !== false) ? await this._localIntent(userMsg) : null;
    if (local) { onDelta && onDelta(local); return local; }
    const system = this._context(userMsg);
    const history = await this._loadHistory(sessionKey);
    const messages = [{ role: "system", content: system }, ...history, { role: "user", content: this._userContent(userMsg) }];

    // 多模态路由: 消息含图片时优先 vision provider (否则图片发到文本后端无意义)
    const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c && c.type === "image_url"));
    const activeLLM = hasImage ? (this._visionLLM() || this.llm) : this.llm;

    // 挂工具事件透传 (供 onTool 推送)
    const prevCb = this._onToolEvent;
    if (onTool) this._onToolEvent = (ev) => { try { onTool(ev); } catch {} };
    // 挂 step 事件透传 (供 onStep 推送推理轮次)
    const prevStepCb = this._onStepEvent;
    if (onStep) this._onStepEvent = (ev) => { try { onStep(ev); } catch {} };

    // 流式中断句柄 (2026-10-04 Task#3): interrupt(sessionKey) 立即掐断上游请求 ——
    //   已吐出的增量保留, 绝不降级重发 (那是二次计费 + 重复输出)。
    const ac = new AbortController();
    this._streamAborts.set(sessionKey, ac);
    let partial = "";
    let reply;
    this._turnInProgress = true; // (R5): 降级进 _chatCore 时保留回放缓存 (finally 收口)
    let emittedAny = false; // (R10): 本轮是否已流式吐过增量 (决定 done 后是否补发全文)
    try {
      // 2026-10-24 (R4): 流式全量接管 —— provider 支持流式时, 无工具走逐字流,
      //   有工具也走流式工具循环 (apiChatStream: 文本增量实时可见, 增量 tool_call 累积)。
      //   "带工具就整体退化为非流式"自此移除; 失败回退语义在 policy 内处理。
      // 2026-10-24 (R10): 接入 provider 回退链 —— 此前直连 _llmWithTools, 主模型宕机时
      //   流式用户要承受"整轮重来 + 退化为非流式"; 现在健康探测过滤 + 逐 provider
      //   流式尝试 (单 provider 内的流式失败仍由 policy 的 stream→非流式兜底)。
      if (activeLLM.supportsStream) {
        const emit = onDelta
          ? (d, meta) => { if (d) { partial += d; emittedAny = true; } try { onDelta(d, meta); } catch { /* 消费方异常不阻断 */ } }
          : null;
        if (this.toolsEnabled) {
          reply = await this._llmWithFallback(messages, emit, ac.signal);
        } else {
          reply = await activeLLM.streamChat(messages, { onDelta: emit, signal: ac.signal });
        }
      } else {
        reply = await this._llmWithFallback(messages, null, ac.signal);
      }
      // (R10) 回退链走的是非流式 provider (或全部流式失败后 policy 兜底) 时, 增量为空:
      //   补发一次全文, 防前端只见 done 事件不见正文。
      if (onDelta && !emittedAny && reply) { try { onDelta(reply); } catch {} }
    } catch (e) {
      // 判定"用户叫停"而非"上游真故障": AbortError / 已置中断位 / 句柄已 abort
      const isAbort = e?.name === "AbortError" || this._interrupted || ac.signal.aborted;
      if (isAbort) {
        warn("chatStream 被中断, 保留已生成部分 (不降级重发):", String(e?.message || e));
        _turnStatus = "aborted"; // (R12) 用户叫停 = 本轮中止, 收口如实记录
        reply = partial;
      } else {
        warn("chatStream 失败, 降级非流式 chat:", e.message);
        // persist:false —— 落库统一交给本函数末尾的 _persistTurn 完成,
        //   否则降级路径既在 chat 内落一次、又在末尾落一次 = 会话凭空多一轮 (P1#7 双写)。
        //   (R5): 走 _chatCore 直调 (本函数已持同会话锁, 再入 chat 会死锁); 已流式吐出
        //   过部分文本时插分隔标记, 防用户看到"半截 + 全文"拼接的重复内容;
        //   _turnInProgress 仍为真 → _chatCore 保留回放缓存, 非幂等工具不双执行。
        //   (R12): 传入本函数已开的 obs —— 降级不重复开 turn, 收口仍归本函数。
        if (partial && onDelta) { try { onDelta("\n\n[流式中断 → 已重新生成]\n\n"); } catch {} }
        reply = await this._chatCore(userMsg, { sessionKey, persist: false, turnObs: obs });
        if (onDelta) onDelta(reply);
      }
    } finally {
      this._onToolEvent = prevCb;
      this._onStepEvent = prevStepCb;
      this._streamAborts.delete(sessionKey); // abort 句柄必须回收, 不留残留
      this._turnInProgress = false; // (R5) 轮收口: 后续轮次照常重置回放缓存
    }
    // 落库用模型原文 (剥掉本轮降级提示), 与 chat 共用同一路径; afterTurn 与 chat 对齐 ——
    //   流式轮次同样触发 L2 归档 / 经验学习 / L3 画像刷新 (2026-10-04 Task#3)。
    // 2026-10-24 (R2): 落库前补 selfCheck 闸门 —— 此前只有 chat 有, 流式路径裸奔。
    //   注意 onDelta 已实时吐出增量, 这里的净化只修正"落库/回放/下轮上下文"里的版本
    //   (历史脏文本会持续污染后续轮次, 比单次展示问题更重)。
    // 2026-10-24 (R9 审计): usedTools 轮内捕获 —— 此处 chatStream 从不复位该标记,
    //   selfCheck 读到的是上一轮 (可能来自 chat 通道) 的陈旧值。与 chat 同款: 本轮读后即清。
    const usedTools = this._lastTurnUsedTools;
    this._lastTurnUsedTools = false;
    if (this.config?.agent?.self_check !== false) {
      try {
        const report = selfCheckReply(reply, { usedTools });
        if (!report.ok) {
          warn("chatStream 回答自检未通过:", report.issues.map((i) => i.code).join(","));
          this.bus?.emit("agent/selfcheck", { codes: report.issues.map((i) => i.code), issues: report.issues, sessionKey, channel: "chatStream" }, { source: "agent.chatStream" });
          reply = sanitizeReply(reply, report);
        }
      } catch { /* 自检异常不阻断主链 */ }
    }
    await this._persistTurn(sessionKey, userMsg, this._stripFallbackNotice(reply), { afterTurn: true });
    // 2026-10-24 (R10 审计#5): 流式用户此前永远看不到降级提示 —— chat 会把
    //   _fallbackNotice 拼到回复尾部, chatStream 只清空不告知。现对齐: 回复尾部
    //   拼提示 (落库的仍是模型原文, 上面 _stripFallbackNotice 已剥) + notify 推送。
    if (this._lastFallback) {
      const fb = this._lastFallback;
      reply = String(reply ?? "") + this._fallbackNotice(fb);
      this.notify(`[降级] ${fb.from} → ${fb.to}`);
    }
    this._lastFallback = null; // 降级提示不影响后续轮次
    this._turnsUsedTools.delete(sessionKey); // 本轮收口: 清除工具使用标记
    return this._maskReplyPII(reply);
      }, { sessionKey, channel: "chatStream" });
    } catch (e) {
      _turnStatus = "aborted";
      throw e;
    } finally {
      this._turnObsEnd(sessionKey, obs, _turnStatus);
    }
  }

  // 多 provider 回退: 依次尝试, 失败切下一个
  // 多 provider 并发健康探测 + 回退: 只对可用 provider 调用, 避免串行等待 180s 超时
  // 2026-10-24 (R10): onDelta/signal 透传 —— 流式通道 (chatStream) 从直连
  //   _llmWithTools 改为走本回退链: 主模型宕机时健康探测过滤 + 逐 provider 流式尝试,
  //   Web 用户不再承受"整轮重来 + 退化为非流式"。
  async _llmWithFallback(seedMessages, onDelta = null, signal = null) {
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
    let idx = 0;
    for (const client of clients) {
      const hasMore = idx < clients.length - 1;
      idx++;
      try {
        const out = await this._llmWithTools(seedMessages, client, onDelta, signal);
        // 2026-10-24 (R10): 空回复哨兵 —— provider "成功"返回但什么都没说 (空 content
        //   无 tool_calls), 还有备选时视同失败切换下一个, 不把"(无回复)"交付给用户。
        if (out === EMPTY_REPLY && hasMore) {
          failed.push({ model: client.model, message: "空回复 (无 content 且无 tool_calls)" });
          this._turnAttempt = (this._turnAttempt || 0) + 1;
          warn("provider 返回空回复, 切换下一个:", client.model);
          continue;
        }
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
        // 2026-10-24 (R12): 用户中断不是 provider 故障 —— 立即上抛, 不切下一个
        //   provider (否则叫停被回退链吞掉并换模型重跑 = 二次计费 + 无视用户取消)。
        if (e?.name === "AbortError" || e?.code === "ABORT_ERR" || this._interrupted || signal?.aborted) throw e;
        lastErr = e;
        failed.push({ model: client.model, message: e.message });
        // 2026-10-24 (R2): 进入下一次尝试 —— 非幂等工具的回放缓存自此开始消费 (防双执行)
        this._turnAttempt = (this._turnAttempt || 0) + 1;
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
  async _runTool(name, args) {
    const t0 = Date.now();
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

    // --- 2026-10-24 (R2): provider 回退重放防双执行 ---
    // 降级重放 (_llmWithFallback 换 provider 从头跑循环) 会重新遇到已执行过的工具调用。
    // 只读/幂等工具重跑无害; 非幂等工具 (写文件/发请求) 二次执行 = 真实副作用翻倍。
    // 方案: 每轮对话 (chat/chatStream 入口) 建回放缓存, 非幂等调用记 [工具|参数] → 结果;
    //   仅当本轮已发生降级 (_turnAttempt > 0) 时消费缓存 —— 正常轮内刻意重复调用不受影响。
    if (!this._toolIdempotent(name) && (this._turnAttempt || 0) > 0) {
      const key = name + "|" + JSON.stringify(args ?? null);
      const prev = this._turnExecCache?.get(key);
      if (prev && typeof prev.value === "string") {
        this.tracer.event("tool/replay-memo", { tool: name, callId });
        this._emitToolDone(callId, name, args, !prev.value.startsWith(TOOL_ERROR_PREFIX), 0, prev.value);
        return prev.value + "\n[回放缓存] 此调用在降级前的尝试中已真实执行过, 返回先前结果 (未重复执行)。若确需重复, 请改变参数后再试。";
      }
    }

    // --- v3.0: PreToolUse 钩子链 (claude-code 语义: 可否决/可改参) ---
    if (this.hooks) {
      try {
        const h = await this.hooks.emit("PreToolUse", { tool: name, args, callId });
        if (h && h.blocked) {
          const msg = `[hook] 工具 ${name} 被 PreToolUse 钩子否决: ${h.reason || "无理由"}`;
          this.tracer.event("tool/hook-blocked", { tool: name, reason: h.reason });
          this._emitToolDone(callId, name, args, false, Date.now() - t0, msg);
          return TOOL_ERROR_PREFIX + msg;
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
        return TOOL_ERROR_PREFIX + admit.error;
      }
    }

    this.bus?.emit("tool/call", { name, args, callId }, { source: "agent._runTool" });
    if (this._onToolEvent) { try { this._onToolEvent({ type: "start", id: callId, tool: name, args, ts: Date.now() }); } catch {} }
    // 2026-10-25 (EQ 事件面): TOOL_CALLED 进事件流 —— 此前 16 种事件类型只有 4 种有
    //   生产者, 工具事件只走 _onToolEvent 回调旁路, /events SSE 消费者看不到工具轨迹。
    //   现在 EQ 与回调双发 (回调供 UI 精确配对, EQ 供外部时间线消费), payload 控制在紧凑尺寸。
    this._eqPush(EventType.TOOL_CALLED, { tool: name, callId, sessionKey: currentTrace()?.sessionKey || null, argsPreview: this._eqPreview(args) });
    // let 而非 const: PostToolUse 钩子的 additionalContext 会追加到结果尾部
    // (2026-09-18 修复: 原为 const, 钩子追加时抛 "Assignment to constant variable" 被 catch {} 静默吞掉,
    //  additionalContext 特性从未生效)
    let result = await this.tools.call(name, args, { agent: this, timeoutMs: Number(this.config.agent?.tool_timeout_ms) || 0 });
    const ok = !result.startsWith(TOOL_ERROR_PREFIX);
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
    // 2026-10-24 (R3): 失败也触发 (claude-code 语义) —— 此前仅成功时 emit, 钩子永远
    //   看不到失败事件, 观测/审计型钩子对失败盲。payload 带 ok 供区分。
    if (this.hooks) {
      try {
        const h = await this.hooks.emit("PostToolUse", { tool: name, args, result, callId, ok });
        // 2026-09-18 修复 (第二处): 原实现 map h.results 里的 r.additionalContext,
        //   但 results 条目结构是 { result: res }, 恒取到 undefined —— 收集结果实际在
        //   h.additionalContext (hooks/index.js 统一收集)。原特性从未生效。
        const extra = (Array.isArray(h?.additionalContext) ? h.additionalContext : [])
          .filter(Boolean).map(String).join("\n");
        if (extra) result = result + "\n" + extra;
      } catch {}
    }
    this._emitToolDone(callId, name, args, ok, Date.now() - t0, result);
    // 2026-10-24 (R2): 非幂等工具的执行结果记入回放缓存 (本轮内有效), 供降级重放时防双执行
    if (!this._toolIdempotent(name)) {
      try {
        this._turnExecCache?.set(name + "|" + JSON.stringify(args ?? null), { value: result });
      } catch { /* 循环参数无法序列化时跳过缓存 */ }
    }
    return result;
  }

  // v3.0: 统一 done 事件发射 (原内联三处, 收敛为一个私有方法)
  _emitToolDone(callId, name, args, ok, durationMs, result) {
    if (this._onToolEvent) { try { this._onToolEvent({ type: "done", id: callId, tool: name, args, ok, durationMs, result: String(result == null ? "" : result).slice(0, 300), ts: Date.now() }); } catch {} }
    // 2026-10-25 (EQ 事件面): TOOL_OUTPUT 统一在此收口 —— 覆盖全部出口
    //   (成功/失败/钩子否决/权限拒绝/回放缓存), 与 TOOL_CALLED 经 callId 配对。
    this._eqPush(EventType.TOOL_OUTPUT, { tool: name, callId, ok, durationMs, resultPreview: this._eqPreview(result) });
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
      // (R13) 会话归属随 req 外投 —— 消费方 (UI/桥) 可按会话过滤审批卡片
      const req = { id, kind, tool, args, summary: String(summary || ""), reason: reason || "", ts: Date.now(), sessionKey: currentTrace()?.sessionKey || null };
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
  // 2026-10-24 (R4): onDelta/signal 透传 —— chatStream 的流式工具循环入口。
  async _llmWithTools(seedMessages, llmInstance = this.llm, onDelta = null, signal = null) {
    return runToolLoop({
      seedMessages,
      llm: llmInstance,
      tools: this.toolsEnabled ? this.tools.toOpenAI() : [],
      config: this.config,
      isInterrupted: () => this._interrupted,
      onDelta,
      signal,
      onStep: (ev) => { if (this._onStepEvent) { try { this._onStepEvent(ev); } catch {} } },
      // 轮内中间草稿采集 (2026-10-10): 每轮模型回包内容进草稿桶, 落库时并入 memory/turns
      onAssistantMsg: (ev) => this._recordDraft(ev),
      runTool: (name, args) => this._runTool(name, args),
      shrinkMessages: (messages, budget) => this._shrinkMessagesForOverflow(messages, budget),
      histTokenCap: () => this._histTokenCap(),
      onEvent: (type, payload) => { this._onPolicyEvent(type, payload); this.tracer.event(type, payload); },
      // v1.6.0 第四刀: 超时重试决策 (幂等才重试) + 超时预算查询 (事件采集)
      isIdempotentTool: (name) => this._toolIdempotent(name),
      toolTimeoutOf: (name) => this._toolTimeoutOf(name),
      // 2026-10-24: 循环内预算闸门 —— 每轮 LLM 调用前消费入口闸的判定 (_budgetBlocked
      // 返回非空 = 预算耗尽文案)。首轮跳过 (入口已查), 只拦"循环中途烧穿"的情形。
      budgetBlocked: () => this._budgetBlocked(),
      // 回合级后置校验闸门 (2026-10-05): 收尾前 harness 自己跑确定性检查, 不过则经 steering
      // 通道把失败喂回模型 (修正机会 ≤2), 用尽诚实上报。rootDir 缺省时不启用。
      postCondition: {
        rootDir: this.root,
        capabilityOf: (n) => (this.tools && this.tools.getCapability ? this.tools.getCapability(n) : null),
      },
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
      "还没有可用的模型 — 配置只要 1 分钟, 三选一:\n" +
      "  ① 交互式向导:  npm run setup        (选厂商 → 粘贴 Key → 自动探活)\n" +
      "  ② 一条命令:    ppx-setup --provider deepseek --key sk-xxx   (--list 看全部厂商)\n" +
      "  ③ 本地模型:    启动 LM Studio / Ollama 后重启皮皮虾, 默认端口即自动识别\n" +
      "Web 界面首页也有「配置模型」按钮。配好重启即生效。"
    );
  }
  // 热重载提供方: 从 config/ppx.json 重建 LLM 客户端列表
  reloadProviders() {
    this.config = this._loadConfig(null);
    this.llm = resolveLLM(this.config);
    this.allProviders = resolveAllLLMs(this.config);
    this._refreshAuxRouting();
    info(`[providers] 热重载完成: ${this.allProviders.length} 个客户端`);
    return { llm: this.llm ? (this.llm.backend || this.llm.model) : null, count: this.allProviders.length };
  }

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
          const r = await orig(msgs, opts);
          try {
            const isStream = meth === "streamChat";
            const u = isStream ? (r && typeof r === "object" ? r.usage : null) : r?.usage;            const tk = u
              ? ((u?.total_tokens ?? (u?.prompt_tokens || 0) + (u?.completion_tokens || 0)) || 0)
              // 无 usage (流式常态): prompt(序列化后的消息体) + 产出(返回文本) 分语言精估
              : estimateTokens(JSON.stringify(msgs ?? "")) + estimateTokens(isStream ? String(r ?? "") : "");
            // 2026-10-11: 记录最近一次 LLM usage 原样 (含 DeepSeek 的 prompt_cache_hit_tokens /
            //   prompt_cache_miss_tokens), 供 Web 状态条展示 "上下文长度 · 缓存命中" (HTTP done 事件透传)
            if (u) this.lastUsage = u;
            this.usageStats.calls++;
            this.usageStats.tokens += tk;
            const m = c.model || "unknown";
            // 金额折算: 价格表来自 config.budget.model_prices 覆盖 + 内置表 (pricing.js)
            const cost = estimateCost(m, u || {}, this.config.budget?.model_prices);
            this.usageStats.cost = Math.round((this.usageStats.cost + cost) * 1e9) / 1e9;
            this.usageStats.byModel[m] ??= { calls: 0, tokens: 0, cost: 0 };
            this.usageStats.byModel[m].calls++;
            this.usageStats.byModel[m].tokens += tk;
            this.usageStats.byModel[m].cost = Math.round(((this.usageStats.byModel[m].cost || 0) + cost) * 1e9) / 1e9;
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
  }

  // 每次记账后的动作: ① 更新预算闸门 ② 周期落盘 (长跑进程被 kill 时不丢账)
  _afterUsageAccounted() {
    const limit = Number(this.config.budget?.usd) || 0;
    // usd=0 或缺省 = 不限 (不置位, 不拦截)
    if (limit > 0 && this.usageStats.cost >= limit) this._budgetExceeded = true;
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
    return `[预算耗尽] 本次会话累计成本 $${this.usageStats.cost.toFixed(6)} 已达上限 $${limit} `
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
    // 2026-10-24: SessionStop 钩子接线 —— 供外部钩子做会话收尾观测。
    //   刻意 fire-and-forget (不 await): shutdown 原时序里紧跟着使用统计/记忆落盘,
    //   在这里插入 await 会推迟它们一个微任务, 与"调用方不等 shutdown 就删数据目录"
    //   的调用模式 (CLI 退出/测试) 相撞, 产生锁超时竞态。钩子链自带超时熔断, 自行收敛。
    try { this.hooks?.emit?.("SessionStop", { sessions: [...(this._seenSessions || [])] })?.catch?.(() => {}); } catch { /* 不阻塞退出 */ }
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
