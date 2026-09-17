// src/agent/index.js - Agent 引擎 (皮皮虾核心) v0.2 含工具调用
import { ensureUTF8Console } from "../utils/winutf8.js";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { TOOL_ERROR_PREFIX } from "../tools/index.js";
// 重构第一刀 (2026-09-14): 工具循环执行策略抽至 src/core/policy.js
// (探索熔断/重复检测/溢出降档/错误重试/结果裁剪/循环驱动), 重新导出保持测试与外部兼容
import { runToolLoop, LLM_FAILED_HINT } from "../core/policy.js";
// 重构第三刀 (2026-09-14): 结构化事件流 traceId 贯穿 (AsyncLocalStorage), 关键路径埋点
import { EventTracer, runWithTrace } from "../core/trace.js";
// 重构第二刀 (2026-09-14): 记忆升降级 + 自我学习收敛为独立服务, agent 只保留薄委托
import { MemoryService } from "../services/memory-service.js";
import { LearningService } from "../services/learning-service.js";
export { isOverflowError as _isOverflowError, trimToolResult, toToolContent } from "../core/policy.js";
import { logicalDay } from "../utils/store.js";
import { loadConfig } from "../config/index.js";
import { info, warn, error } from "../utils/logger.js";
import { Context, compose, loadPlugins } from "../plugin/index.js";
import { builtinPlugins, resolveLLM, resolveAllLLMs, isUsableProvider } from "../plugin/builtin.js";
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
import { SkillLoader } from "../skills/loader.js";
import { EvolutionEngine } from "../selfheal/evolve.js";
// 重构 (2026-09-15): 历史/上下文管理 + 提示词构建从 PPXAgent 类抽出为 mixin
// (context.js: 历史裁剪/token 预算/会话压缩; prompts.js: 技能清单/核心价值/DSML/画像/多模态)
import { contextMethods } from "./context.js";
import { promptMethods } from "./prompts.js";

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

    // 插件装配: ctx 预置基础服务, 按顺序装配内置 + 用户插件 (一切皆插件)
    // P2⑧: 顶层 ctx 为 full-access 基座 (内置插件可信), 用户插件默认 restricted
    this.ctx = new Context(null, { access: "full-access" });
    this.ctx.provide("root", root);
    this.ctx.provide("dataDir", this.dataDir);
    this.ctx.provide("globalDataDir", this.globalDataDir);
    this.ctx.provide("config", this.config);
    this.ctx.provide("userName", this.userName);
    this.ctx.provide("agent", this);
    // 装配顺序: 内置插件 → 用户插件目录(声明式) → 构造函数传入插件(编程式)
    const pluginsDir = path.join(root, this.config.plugins?.dir || "plugins");
    compose(this.ctx, [...builtinPlugins, ...loadPlugins(pluginsDir), ...plugins]);

    // 从 ctx 取服务, 设置公开属性 (向后兼容, 外部代码不变)
    this.healer = this.ctx.consume("healer");
    this.health = this.ctx.consume("health");
    this.persona = this.ctx.consume("persona");
    this.facts = this.ctx.consume("facts");
    this.experience = this.ctx.consume("experience");
    this.sessionStore = this.ctx.consume("sessions");
    this.memory = this.ctx.consume("memory");
    this.llm = this.ctx.consume("llm");
    this.allProviders = this.ctx.consume("allProviders");
    this.l0 = this.ctx.consume("l0");
    this.scenes = this.ctx.consume("scenes");
    this.personaStore = this.ctx.consume("personaStore");
    this.traces = this.ctx.consume("traces");
    // 重构第三刀: 结构化事件流 (记忆升降级/工具失败/spawn/自愈触发), 独立于工具轨迹
    this.tracer = new EventTracer(this.dataDir);
    this.bus = this.ctx.consume("bus");
    // ⑧ 免疫系: 全局闸门挂到总线命令通道 (拦截+审计)
    this.__guard = installGuard(this, { allowList: this.config.agent?.guardAllowList || [] });
    // ⑦ Reward 闭环: 订阅总线工具成败, 自动更新行为倾向 (EWMA)
    this.bus?.on("tool/result", (ev) => {
      const { name, ok } = ev.payload || {};
      if (name) { try { rewardRecord(this, { tool: name, ok: !!ok }); } catch {} }
    });
    this.tools = this.ctx.consume("tools");
    // P0 (2026-09-15): 免疫闸门接入工具执行收口 (修 MERGE-REPORT 遗留 P2 —— guard 之前只盖总线命令,
    // 工具走 catalog 绕过全局闸门)。共享同一 state: approveGuard 一次授权同时作用于总线+工具。
    try {
      this.__guardOnCatalog = installGuardOnCatalog(this.tools, this.__guard);
    } catch (e) {
      warn(`[guard] 工具收口接入失败: ${e.message}`);
    }
    this.scheduler = this.ctx.consume("scheduler");
    // ⑤排泄自治: 每日扫描长期记忆做冗余识别/冷热分层 (幂等注册, 不重复)
    try {
      const hasE = (this.scheduler?.list?.() || []).some((j) => j.name === "eviction-daily");
      if (!hasE) this.scheduler?.add({ name: "eviction-daily", cron: "02:00", type: "daily", action: () => { try { evictionScan(this); } catch {} } });
    } catch {}
    // 首次启动跑一次排遗扫描 (预热治理状态)
    try { evictionScan(this); } catch {}
    this.toolsEnabled = this.ctx.consume("toolsEnabled");
    this._warnMissingCloudApi(); // 发布首启引导: 未配云端 key 时明确提示

    // 主动通知 + 中断状态
    this._notifyCb = null;
    this._onToolEvent = null; // 工具事件回调
    this._toolCallSeq = 0; // 工具调用序号: 给 start/done 事件生成唯一 id, 供 UI 精确配对
    this._interrupted = false;
    this._lastTurnUsedTools = false;
    this._lastFallback = null; // P2-2: 最近一次 provider 降级事实 (在本轮内有效, 用完即清)
    this._mcp = null; // MCP 连接句柄 (connectMcp 后赋值)
    this._proactiveTimer = null; // 主动任务生成定时器
    // 生命周期 (ANS 独立模块): born → growing → mature → evolving / reproducing
    // v1.0.7 持久化: 状态落盘 data/memory/lifecycle.json, 跨进程/重启不归零 (P1)
    this.lifecycle = new Lifecycle({ file: path.join(this.dataDir, "memory", "lifecycle.json") });
    this.evolve = new EvolutionEngine(this, this.config.agent?.evolve || {});
    // Auditor (P0①): 唯一“已验证写回”通道 + 已验证账本 (data/audit/verified.json)
    this.auditor = new Auditor({ ledgerPath: path.join(this.dataDir, "audit", "verified.json") });
    // 方法技能目录 (Superpowers 吸收): 供 _context 注入技能清单, LLM 按需 load_skill
    try { this.skills = new SkillLoader(path.join(root, "skills")); } catch { this.skills = null; }

    // 重构第二刀: 记忆协调服务 + 自我学习服务 (依赖注入, llm 用闭包实时取当前 provider)
    this.memorySvc = new MemoryService({
      getLlm: () => this.llm,
      facts: this.facts,
      scenes: this.scenes,
      personaStore: this.personaStore,
      experience: this.experience,
      lifecycle: this.lifecycle,
      tracer: this.tracer,
    });
    this.learningSvc = new LearningService({
      getLlm: () => this.llm,
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
  interrupt() { this._interrupted = true; }
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

  // 重置某会话历史 (新会话): 删除事件日志
  resetSession(sessionKey) { this.sessionStore.delete(sessionKey || "default"); }

  // 对话主入口 (含工具调用循环)
  async chat(userMsg, { persist = true, sessionKey = "default", mode = null } = {}) {
    // 重构第三刀: 入口生成 traceId, 记忆/工具/学习子调用自动继承 (AsyncLocalStorage)
    return runWithTrace(async () => {
    this.clearInterrupt(); // 新一轮对话开始, 复位上一轮的中断状态
    this.bus?.emit("chat/user", { userMsg, sessionKey }, { source: "agent.chat" });
    this._lastFallback = null; // P2-2: 只关心"本轮"是否降级, 先清上次残留
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

    if (persist) {
      this._pushTurn(sessionKey, String(userMsg), reply);
      await this.memory.recordTurn(userMsg, reply);
      this.bus?.emit("memory/record", { userMsg, reply }, { source: "agent.chat" });
      // 记忆升降级协调器 (memory-service): L2 场景归档 + 用户主动经验学习 + L3 画像跨天刷新
      this.memorySvc.afterTurn(userMsg, reply);
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
    return reply;
    }, { sessionKey, channel: "chat", userMsg: String(userMsg).slice(0, 200) });
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

    let reply;
    try {
      // 无工具开启: 直连后端可逐字流式 (恢复打字机效果); 有工具时走工具循环保轨迹完整 [复审 P2]
      if (!this.toolsEnabled && activeLLM.supportsStream) {
        reply = await activeLLM.streamChat(messages, {
          onDelta: (d) => { onDelta && onDelta(d); },
        });
      } else {
        reply = await this._llmWithTools(messages, activeLLM);
        if (onDelta) onDelta(reply);
      }
    } catch (e) {
      warn("chatStream 失败, 降级非流式 chat:", e.message);
      reply = await this.chat(userMsg, { sessionKey });
      if (onDelta) onDelta(reply);
    } finally {
      this._onToolEvent = prevCb;
      this._onStepEvent = prevStepCb;
    }
    this._pushTurn(sessionKey, String(userMsg), this._stripFallbackNotice(reply));
    await this.memory.recordTurn(userMsg, this._stripFallbackNotice(reply));
    this._lastFallback = null; // 降级提示不影响后续轮次
    return reply;
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
        const states = await Promise.all(clients.map((c) => c.health ? c.health() : Promise.resolve(true)));
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
    for (const client of clients) {
      try {
        const out = await this._llmWithTools(seedMessages, client);
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

  // 统一工具执行入口 (http 原生 tool_calls + 文本工具调用修复) [P0#1]
  // v1.0.7: 移除未使用的 llmInstance 死参数, 所有工具执行统一走此入口 (trace/事件只此一份)
  // 2026-09-17 体检修复: start/done 事件带唯一 callId。
  //   原先 Web UI 只能按"工具名"匹配起止事件, 同一轮里出现两个 read_file 时,
  //   后到的事件会回填到前一张卡片上 (public/app.js 旧实现注释里也自述了这个缺陷)。
  async _runTool(name, args) {
    const t0 = Date.now();
    this._lastTurnUsedTools = true;
    const callId = `t${++this._toolCallSeq}-${t0.toString(36)}`;
    this.bus?.emit("tool/call", { name, args, callId }, { source: "agent._runTool" });
    if (this._onToolEvent) { try { this._onToolEvent({ type: "start", id: callId, tool: name, args, ts: Date.now() }); } catch {} }
    const result = await this.tools.call(name, args, { agent: this, timeoutMs: Number(this.config.agent?.tool_timeout_ms) || 0 });
    const ok = !result.startsWith(TOOL_ERROR_PREFIX);
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
    if (this._onToolEvent) { try { this._onToolEvent({ type: "done", id: callId, tool: name, args, ok, durationMs: Date.now() - t0, result: result.slice(0, 300), ts: Date.now() }); } catch {} }
    return result;
  }

  // LLM + 工具调用循环 (带 provider 回退)
  // 重构第一刀 (2026-09-14): 循环驱动/探索熔断/重复检测/溢出降档/错误重试
  // 全部收敛到 src/core/policy.js runToolLoop, 此处只注入依赖, 策略可独立测试/替换。
  async _llmWithTools(seedMessages, llmInstance = this.llm) {
    return runToolLoop({
      seedMessages,
      llm: llmInstance,
      tools: this.toolsEnabled ? this.tools.toOpenAI() : [],
      config: this.config,
      isInterrupted: () => this._interrupted,
      onStep: (ev) => { if (this._onStepEvent) { try { this._onStepEvent(ev); } catch {} } },
      runTool: (name, args) => this._runTool(name, args),
      shrinkMessages: (messages, budget) => this._shrinkMessagesForOverflow(messages, budget),
      histTokenCap: () => this._histTokenCap(),
      onEvent: (type, payload) => this.tracer.event(type, payload),
      // v1.6.0 第四刀: 超时重试决策 (幂等才重试) + 超时预算查询 (事件采集)
      isIdempotentTool: (name) => this._toolIdempotent(name),
      toolTimeoutOf: (name) => this._toolTimeoutOf(name),
    });
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
    this._proactiveTimer = setInterval(async () => {
      try {
        const payload = await suggestProactive(this);
        if (payload && typeof cb === "function") { try { cb(payload); } catch {} }
      } catch {}
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

  shutdown() {
    this.stopProactiveTicker();
    this._mcp?.close?.();
    // v1.0.8: 清理军团子进程 (spawn_agent 派生的 worker), 防后台残留
    if (this._legion && typeof this._legion.shutdownAll === "function") {
      try { this._legion.shutdownAll(); } catch {}
    }
    this.memory._saveState?.();
    this.scheduler?.shutdown?.(); // ⑤/②: 清定时器防进程挂起
    this.healer.markClean();
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
    if (["quit", "exit"].includes(line)) { agent.shutdown(); process.exit(0); }
    const r = await agent.chat(line);
    console.log("\n" + r + "\n");
  });
}
