// src/agent/index.js - Agent 引擎 (皮皮虾核心) v0.2 含工具调用
//
// 2026-11-14 (战役遗留项 #6): 类体只保留"引擎壳" —— 构造装配 / 会话路由访问器 /
//   通知回调 / 只读模式。单轮执行面 (_chatCore/chatAsync) 在 ./turn-runner.js,
//   同会话并发面 (chat 路由/合并车道/中断/回放缓存) 在 ./lane-merger.js,
//   两者以 plain-object mixin 挂回本文件的原型装配 (与 work.js 三路拆分同款惯例)。
import { noteCatch } from "../utils/catch-log.js";
import { ensureUTF8Console } from "../boot/winutf8.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 重构第一刀 (2026-09-14): 工具循环执行策略抽至 src/agent/loop/policy.js
// (探索熔断/重复检测/溢出降档/错误重试/结果裁剪/循环驱动), 重新导出保持测试与外部兼容
// 2026-11-14: LLM_FAILED_HINT 消费迁至 turn-runner.js, 本文件经 re-export 保持模块图边
// 重构第三刀 (2026-09-14): 结构化事件流 traceId 贯穿 (AsyncLocalStorage), 关键路径埋点
import { currentTrace } from "../core/trace.js";
export { isOverflowError as _isOverflowError, trimToolResult, toToolContent } from "./loop/policy.js";
// v5.0 合并批逐条回信: 纯函数实现迁至 lane-merger.js (与合并车道同文件), 导入点不变
export { splitSegmentedReply } from "./lane-merger.js";
import { resolveDataDir } from "../utils/datadir.js";

// 重构 (2026-09-15): 历史/上下文管理 + 提示词构建从 PPXAgent 类抽出为 mixin
// (context.js: 历史裁剪/token 预算/会话压缩; prompts.js: 技能清单/核心价值/DSML/画像/多模态)
import { contextMethods } from "./context.js";
import { promptMethods } from "./prompts.js";
// 工具证据进上下文 + 压缩保真 + 免模型确定性重置 (2026-10-10 补, 覆盖 context 旧版)
import { evidenceMethods } from "./evidence.js";
// 2026-11-02: 单体拆分 (3124 → ~1100 行), 装配/计划/命令/工单/用量/审批按关注点分离为 mixin
import { bootstrapMethods } from "./bootstrap.js";
import { planMethods } from "./plan.js";
import { commandsMethods } from "./commands.js";
import { workMethods } from "./work.js";
import { usageMethods } from "./usage.js";
import { approvalMethods } from "./approval.js";
import { approvalMemoryMethods } from "./approval-memory.js";
import { admitMethods } from "./tool-admit.js";
import { questionMethods } from "./questions.js";
import { streamMethods } from "./stream.js";
import { turnRecordMethods } from "./turn-record.js";
import { fallbackMethods } from "./fallback.js";
// 2026-11-03: 生命周期/可观测/退出收口下沉为 runtime mixin (行为不变, 压 600 行阈值)
import { runtimeMethods } from "./runtime.js";
// 2026-11-14 (战役遗留项 #6): 单轮执行面 / 同会话并发面 从类体拆出为 mixin
import { turnRunnerMethods } from "./turn-runner.js";
import { laneMergerMethods } from "./lane-merger.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 会话历史条数/token 预算已迁到 config.memory (max_history_items / history_token_budget)
// (上下文窗口常量 DEFAULT_CONTEXT_WINDOW / DEFAULT_CONTEXT_RATIO 与辅助 LLM 超时 AUX_LLM_TIMEOUT_MS
//  已随历史管理迁至 src/agent/context.js)
// (工具循环阈值 DEFAULT_MAX_TOOL_ROUNDS / EXPLORE_TOOLS 等已迁至 src/agent/loop/policy.js)

// (工具结果裁剪 trimToolResult / 溢出判定 isOverflowError / LLM 失败提示 LLM_FAILED_HINT
//  已迁至 src/agent/loop/policy.js, 本文件经 re-export 保持兼容)
// (多模态视觉 content 注入 visionUserContent 已迁至 src/agent/prompts.js)
// (v5.0 分段回信纯函数 splitSegmentedReply 已迁至 lane-merger.js, re-export 保持导入点)

export class PPXAgent {
  constructor({ root = ROOT, configFile = null, plugins = [], dataDir = null, globalDataDir = null } = {}) {
    this.root = root;
    // dataDir 可覆盖: 显式参数 > PPX_DATA_DIR 环境变量 > 默认目录 (规则见 utils/datadir.js)
    this.dataDir = resolveDataDir(root, dataDir);
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

  // P2-2 降级事实的会话级视图 (2026-11-12): 底层存 _lastFallbackByKey, 读写按当前 trace 的
  //   sessionKey 路由。并发会话 A 的回退不再被会话 B 的收口读走/清掉 (旧实现单字段互踩)。
  get _lastFallback() {
    const k = currentTrace()?.sessionKey || "default";
    return (this._lastFallbackByKey && this._lastFallbackByKey.get(k)) || null;
  }
  set _lastFallback(v) {
    if (!this._lastFallbackByKey) this._lastFallbackByKey = new Map();
    const k = currentTrace()?.sessionKey || "default";
    if (!v) { this._lastFallbackByKey.delete(k); return; }
    if (this._lastFallbackByKey.size >= 128 && !this._lastFallbackByKey.has(k)) {
      const oldest = this._lastFallbackByKey.keys().next().value;
      if (oldest != null) this._lastFallbackByKey.delete(oldest);
    }
    this._lastFallbackByKey.set(k, v);
  }

  // 思考链同样按会话存放 (2026-11-12): worker 信封/诊断读"本会话"上一轮的推理,
  //   不再读到并发会话的草稿。
  get _lastReasoning() {
    const k = currentTrace()?.sessionKey || "default";
    return (this._lastReasoningByKey && this._lastReasoningByKey.get(k)) || "";
  }
  set _lastReasoning(v) {
    if (!this._lastReasoningByKey) this._lastReasoningByKey = new Map();
    const k = currentTrace()?.sessionKey || "default";
    this._lastReasoningByKey.set(k, String(v || ""));
    if (this._lastReasoningByKey.size > 128) {
      for (const key of this._lastReasoningByKey.keys()) {
        if (key !== k) { this._lastReasoningByKey.delete(key); break; }
      }
    }
  }

  // 默认数据目录规则已收敛到 utils/datadir.js (与 ppx doctor 共用, 防止两处漂移)

  // 主动通知 + 中断 API
  setNotify(cb) { this._notifyCb = typeof cb === "function" ? cb : null; }
  // 工具调用过程可视化 - 回调 (tool名, 参数, 耗时, 状态) 供 Web UI 推送
  setToolEvent(cb) { this._onToolEvent = typeof cb === "function" ? cb : null; }
  // turn/step 分层: 推理轮次事件 (每轮工具循环发一次 step), 供军团 worker 上报进度
  setStepEvent(cb) { this._onStepEvent = typeof cb === "function" ? cb : null; }
  notify(message) { if (this._notifyCb) { try { this._notifyCb(String(message)); } catch (e) { noteCatch("src/agent/index.js#notify", e); } } }

  // 只读模式 (SDD 审查者, 设计溯源 docs/PROVENANCE.md#superpowers): 禁用一切修改/执行类工具, 只能读/查
  // 供 spawn_agent review 循环的审查者角色 (worker 经 PPX_AGENT_READONLY=1 触发)
  // 2026-11-12 修复: 原实现是 11 个工具名的硬编码名单 —— `append_file` / `move_file` 等
  //   readOnly:false 的写工具不在名单里, 在 workspace-write 沙箱下被静默放行 (审查者子进程
  //   被注入后可改工作区)。改为按能力声明推导: 只有明确 readOnly===true 的才保留, 未声明
  //   (getCapability 保守推断) 与非只读一律禁用 —— 新增工具默认被挡住, 不靠名单同步。
  enableReadonlyMode() {
    for (const name of this.tools.list()) {
      const cap = this.tools.getCapability(name);
      if (cap && cap.readOnly === true) continue;
      try { this.tools.disable(name); } catch (e) { noteCatch(e); }
    }
    this.readonly = true;
    return this;
  }
}

// 重构 (2026-09-15): 历史/上下文管理 + 提示词构建以 mixin 方式挂回 prototype
// (行为与拆前完全一致, 实例方法与调用方不受影响; 测试走 agent._xxx 不感知拆分)
// 2026-10-10: evidenceMethods 置于 contextMethods **之后** —— 它覆盖 _pushTurn/_getSession/_maybeCompact,
//   把工具证据进上下文 + 压缩保真接进主链 (contextMethods 的旧版只认 user/assistant = 结构性失忆)。
// 2026-11-14: laneMergerMethods / turnRunnerMethods 为 index.js 类体原方法的整体搬迁,
//   与既有 mixin 无同名交集, 挂载顺序不影响语义 (排在 workMethods 之后便于溯源)。
Object.assign(
  PPXAgent.prototype,
  bootstrapMethods,
  planMethods,
  commandsMethods,
  workMethods,
  laneMergerMethods,
  turnRunnerMethods,
  usageMethods,
  admitMethods,
  approvalMethods,
  approvalMemoryMethods,
  questionMethods,
  contextMethods,
  promptMethods,
  evidenceMethods,
  runtimeMethods,
);

// 2026-11-03: 流式主链 / 落库归档 / provider 回退三块下沉为独立 mixin (行为不变)
for (const d of [streamMethods, turnRecordMethods, fallbackMethods]) Object.defineProperties(PPXAgent.prototype, d);

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
