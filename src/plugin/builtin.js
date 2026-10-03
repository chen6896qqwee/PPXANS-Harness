// src/plugin/builtin.js - 皮皮虾内置插件集 (一切皆插件)
// 借鉴 deepseek-harness 的 "everything is a plugin": 每个模块是一个插件, 通过 ctx.provide 注册服务。
// 装配顺序即依赖顺序 (依赖在前), 任何插件都可被用户插件替换或扩展。
import path from "node:path";
import { info, warn } from "../utils/logger.js";
import { Healer } from "../selfheal/healer.js";
import { Persona } from "../persona/index.js";
import { FactStore, SqliteFactStore, MemoryTicker, Experience, L0Recorder, SceneStore, PersonaStore, LegionBoard } from "../memory/index.js";
import { SessionStore } from "../memory/session.js";
import {
  ToolCatalog, registerBuiltinTools, registerAdvancedTools, Scheduler,
  registerMethodTools, registerSelfmodTools, registerCustomTools, registerDocumentTools,
  registerGovernanceTools,
  registerVoiceTools,
  registerSandboxTools,
  registerVadTools,
} from "../tools/index.js";
import { embedderFromConfig } from "../llm/embedder.js";
import { LocalShellProvider } from "../seam/shell.js";
import { registerDelegateTools } from "../tools/delegate.js";
import { Traces } from "../utils/trace.js";
import { AuditLog } from "../audit/audit-chain.js";
import { RuntimeBus } from "../bus/runtime-bus.js";
import { PlaybookStore } from "../evolve/playbook.js";
import { MemoryHealthMonitor } from "../services/memory-health.js";
import { FailureEpisodeStore } from "../memory/failure-episode.js";
import { CanvasStore } from "../memory/canvas.js";
import { AssetHub } from "../memory/asset-hub.js";
import { exportMemorySnapshot, mergeSnapshotBack, hasSnapshot } from "../memory/fork.js";
// v3.0 (codex 对齐): 新工具 (repo_map/apply_patch/review_code/goal_board)
import { registerV3Tools } from "../tools/v3.js";
// v3.0.1 (GitHub 主流 Agent 对标): git 集成工具 (aider/Claude Code/OpenHands 标配, 带硬护栏)
import { registerGitTools } from "../tools/git.js";

// fork 工具 (供 ctx.consume("fork") 取用)
const forkTools = { exportMemorySnapshot, mergeSnapshotBack, hasSnapshot };
// LLM 路由: import 本地绑定 + re-export 向后兼容 (v2.5.0 修复: 仅 export-from 不产生本地绑定,
// 导致 llmPlugin 里 resolveLLM/resolveAllLLMs 未定义, 插件装配被隔离且 LLM 实际未注入)
import { isUsableProvider, resolveLLM, resolveAllLLMs } from "../llm/router.js";
export { isUsableProvider, resolveLLM, resolveAllLLMs };
import { ModeRegistry, registerDefaultModes } from "../mode/index.js";
import { planExecExecutor } from "../mode/plan-exec.js";
import { routerExecutor } from "../mode/router.js";
import { blackboardExecutor } from "../mode/blackboard.js";
import { graphExecutor } from "../mode/graph.js";
import { legionExecutor } from "../mode/legion.js";

// ---- LLM 路由 (唯一真相源已迁至 src/llm/router.js, 此文件仅 re-export 向后兼容) ----
// router.js 负责: 占位死配置过滤 / 云端真key优先 / 本地零配置兜底 / 健康排序 / PPX_PROVIDER 强制
// 此处保留导出名, agent/热重载/插件继续用 builtin.resolveLLM 等旧引用。

// ---- 内置插件: 每个 (ctx) => void, 用 ctx.provide 注册服务 ----


export const busPlugin = (ctx) => {
  // ②循环系: 全局 Runtime 总线。必须最先装配, 其他插件可 ctx.consume("bus") 挂订阅/注册命令。
  const bus = new RuntimeBus();
  ctx.provide("bus", bus);
  // 状态槽: sessionKey 归属 (给观测/审计看当前活跃会话)
  bus.set("bootedAt", Date.now());
  return bus;
};

export const healerPlugin = (ctx) => {
  // v1.0.8 修复 (P1-2): 必须传真实数据目录, 否则自愈体检/崩溃标记会落到 root/data 硬编码路径,
  // 在 PPX_DATA_DIR 自定义时与真实数据目录分叉 (详见 selfheal/healer.js 注释)。
  const healer = new Healer(ctx.consume("root"), ctx.consume("dataDir"));
  healer.markDirty();
  const health = healer.heal();
  ctx.provide("healer", healer);
  ctx.provide("health", health);
};

export const personaPlugin = (ctx) => {
  ctx.provide("persona", new Persona(ctx.consume("root")));
};

export const factsPlugin = (ctx) => {
  const config = ctx.consume("config");
  const dataDir = ctx.consume("dataDir");
  // 记忆后端选择 (2026-10-03): "json" (默认, 向后兼容) | "sqlite" (内嵌库, FTS5+WAL) | "auto" (优先 sqlite)
  // 选 sqlite 的收益: 增量写 (实测 800 条 18.7x 更快, JSON 版每次 add 都全量重写)、
  //   事务级并发安全 (无文件锁忙等)、崩溃可恢复 (WAL)、数据量增大时检索不退化 (JSON 版全量重扫)。
  // 代价: 文件体积更大 (FTS 索引+WAL), 依赖 Node >= 22.5 的 node:sqlite (不可用会自动回落 JSON)。
  const backend = String(config.memory?.backend || "json").toLowerCase();
  let facts = null;
  if (backend === "sqlite" || backend === "auto") {
    try {
      facts = new SqliteFactStore(dataDir, config.memory || {});
      info(`[memory] 记忆后端: SQLite 内嵌库 (FTS5=${facts.ftsReady}, WAL)`);
    } catch (e) {
      warn(`[memory] SQLite 后端不可用, 回落 JSON: ${e.message}`);
    }
  }
  if (!facts) {
    // 2026-10-03 深度优化 (P2 写放大): 主链路默认开启 FactStore WAL 增量落盘 ——
    // 原默认每次变更全量原子重写 facts.json (高频对话下写放大显著, SQLite 注释自认 18.7x 差距)。
    // WAL 模式: 变更走追加日志, 达阈值才 compact 全量写。仅主链路开启 (轻量构造/测试保持旧行为);
    // config.memory.wal 可显式关。agent.shutdown 时 flush 兜底。
    facts = new FactStore(dataDir, { wal: true, walThreshold: 50, ...(config.memory || {}) });
    if (backend === "sqlite") warn("[memory] 显式指定了 sqlite 后端但不可用, 已回落 JSON");
  }
  ctx.provide("facts", facts);
};

export const experiencePlugin = (ctx) => {
  // 经验库走全局共享目录 (ANS 全局记忆): 跨 agent 共享经验, 写入用文件锁防并发覆盖
  ctx.provide("experience", new Experience(ctx.consume("globalDataDir") || ctx.consume("dataDir")));
};

export const legionBoardPlugin = (ctx) => {
  // 军团共享记忆板 (2026-10-02): 走全局共享目录, 主 agent 与 worker 实时互通
  ctx.provide("legionBoard", new LegionBoard(ctx.consume("globalDataDir") || ctx.consume("dataDir")));
};

export const sessionPlugin = (ctx) => {
  const config = ctx.consume("config");
  const sessions = new SessionStore(ctx.consume("dataDir"));
  // 启动时清理过期会话 (config.memory.session_max_age_days, 默认 30; 0/负=不清理)
  const maxAge = Number(config.memory?.session_max_age_days ?? 30);
  if (maxAge > 0) {
    const removed = sessions.pruneOld({ maxAgeDays: maxAge });
    if (removed.length) info(`[sessions] 清理过期会话 ${removed.length} 个: ${removed.join(", ")}`);
  }
  ctx.provide("sessions", sessions);
};

export const memoryPlugin = (ctx) => {
  const facts = ctx.consume("facts");
  const sessions = ctx.consume("sessions");
  ctx.provide("memory", new MemoryTicker(ctx.consume("dataDir"), facts, null, sessions));
};

export const llmPlugin = (ctx) => {
  const config = ctx.consume("config");
  ctx.provide("llm", resolveLLM(config));
  ctx.provide("allProviders", resolveAllLLMs(config));
};

export const memoryLayersPlugin = (ctx) => {
  const sessions = ctx.consume("sessions");
  const dataDir = ctx.consume("dataDir");
  const userName = ctx.consume("userName") || "兄弟";
  ctx.provide("l0", new L0Recorder(sessions, dataDir));
  ctx.provide("scenes", new SceneStore(dataDir));
  ctx.provide("personaStore", new PersonaStore(dataDir, { userName }));
};

export const tracesPlugin = (ctx) => {
  ctx.provide("traces", new Traces(ctx.consume("dataDir")));
};

export const auditPlugin = (ctx) => {
  // 审计哈希链 (吸收自 ppx-v2): append-only + SHA-256 链式防篡改账本。
  // 与 core/trace.js 的事件流互补 —— trace 面向"可观测", audit 面向"可追责/防篡改"。
  // config.audit.enabled === false 时关闭 (供性能敏感场景), 默认开启。
  const config = ctx.consume("config");
  if (config?.audit?.enabled === false) {
    ctx.provide("audit", null);
    return null;
  }
  const audit = new AuditLog(ctx.consume("dataDir"));
  ctx.provide("audit", audit);
  return audit;
};

export const toolsPlugin = (ctx) => {
  const root = ctx.consume("root");
  const dataDir = ctx.consume("dataDir");
  const config = ctx.consume("config");
  const facts = ctx.consume("facts");
  const memory = ctx.consume("memory");
  const tools = new ToolCatalog();
  registerBuiltinTools(tools, { rootDir: root, facts, memory });
  // 2026-09-18: onFire 兜底 —— 重启恢复的持久化任务无 action 闭包, 触发时按 job.name 还原行为
  const scheduler = new Scheduler(dataDir, { onFire: (job) => facts.add(`定时任务触发: ${job?.name || "?"}`, { source: "schedule" }) });
  ctx.provide("scheduler", scheduler);
  registerAdvancedTools(tools, { dataDir, scheduler, onMemoryNote: (note) => facts.add(note, { source: "schedule" }) });
  registerMethodTools(tools);
  registerSelfmodTools(tools, { skillsDir: path.join(root, "skills") });
  // 用户自定义工具 (不改源码扩展能力)
  const customDir = path.join(root, (config.tools && config.tools.custom_dir) || "custom-tools");
  registerCustomTools(tools, customDir);
  // 文档加载器 (RAG: read_document / ingest_document)
  registerDocumentTools(tools, { rootDir: root });
  // 语音能力 (ASR voice_transcribe / TTS voice_speak): 走 OpenAI 兼容端点, 零依赖
  // v3.1: voice.asr 支持 backend:"local" (nodejs-whisper 可选依赖, 离线转写)
  registerVoiceTools(tools, { config, rootDir: root });
  // v3.1 新能力: 内置 JS 沙箱执行器 (CodeAct, 零依赖) + 语音活动检测 (VAD)
  registerSandboxTools(tools, { rootDir: root });
  registerVadTools(tools, { rootDir: root });
  // 向量化: 配了 config.embedding 则自动注入 embedder, 检索切 dense+BM25 RRF; 否则纯 BM25 兜底
  const embedder = embedderFromConfig(config);
  if (embedder) facts.setEmbedder(embedder);
  // 军团共享记忆板 (2026-10-02): 所有 agent (主 + worker) 实时共享知识
  const board = ctx.consume("legionBoard");
  // 多 agent 自主协作: spawn_agent 工具 (agent 自主派生子 agent 分工)
  // 传入军团记忆板: share_board 自动发布子任务结论 + 仲裁前自动读板
  registerDelegateTools(tools, { board });
  if (board) {
    const fromName = () => ctx.consume("agent")?.config?.agent?.name || "main";
    tools.register({
      name: "board_publish",
      description: "向军团共享记忆板发布一条知识/发现/结论, 所有 agent 实时可见。跨 agent 协作时用。",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "频道/主题 (如 数据分析/代码审查), 默认 general" },
          content: { type: "string", description: "要共享的内容" },
          tags: { type: "array", items: { type: "string" }, description: "检索标签, 可选" },
        },
        required: ["content"],
      },
      execute: async (args) => {
        try {
          const e = board.publish({ from: fromName(), topic: args.topic, content: args.content, tags: args.tags });
          return JSON.stringify({ ok: true, id: e.id });
        } catch (e) { return JSON.stringify({ error: e.message }); }
      },
    });
    tools.register({
      name: "board_query",
      description: "查询军团共享记忆板: 看其他 agent 发布的知识/发现/结论 (实时, 跨进程)。",
      parameters: {
        type: "object",
        properties: {
          q: { type: "string", description: "关键词 (匹配内容/主题/标签)" },
          topic: { type: "string", description: "按频道过滤, 可选" },
          from: { type: "string", description: "按发布者过滤, 可选" },
          limit: { type: "number", description: "返回条数, 默认 10" },
        },
      },
      execute: async (args) => {
        const rs = board.query(args);
        if (!rs.length) return "(记忆板暂无匹配内容)";
        return rs.map((r) => `- [${r.ts}] ${r.from}@${r.topic}: ${r.content}`).join("\n");
      },
    });
  }
  // Shell 能力 seam: 命令执行解耦为可替换 provider (本地/未来沙箱/Docker)
  ctx.provide("shell", new LocalShellProvider());
  // 审计哈希链接入工具执行收口 (未启用时为 null, catalog 内部零开销跳过)
  tools.setAudit(ctx.consume("audit"));
  // 记忆治理 + 审计校验 + 运维工具 (吸收自 ppx-v2, 共 10 个)
  registerGovernanceTools(tools, {
    rootDir: root,
    dataDir,
    facts,
    audit: ctx.consume("audit"),
    personaStore: ctx.consume("personaStore"),
    healer: ctx.consume("healer"),
    experience: ctx.consume("experience"),
  });
  // v3.0 (codex 对齐): repo_map / apply_patch / review_code / goal_board
  registerV3Tools(tools, { rootDir: root, agent: ctx.consume("agent") });
  // git 集成 (2026-10-01): status/diff/log/commit, 仅 add+commit, 禁 push/reset
  registerGitTools(tools, { rootDir: root });
  ctx.provide("tools", tools);
  ctx.provide("toolsEnabled", config.tools?.enabled !== false);
};

export const modePlugin = (ctx) => {
  const registry = new ModeRegistry();
  registerDefaultModes(registry);
  // 更多编排模式 (可插拔): plan-exec / router / blackboard / graph
  registry.register("plan-exec", planExecExecutor);
  registry.register("router", routerExecutor);
  registry.register("blackboard", blackboardExecutor);
  registry.register("graph", graphExecutor);
  registry.register("legion", legionExecutor);
  ctx.provide("modes", registry);
};

// P2⑧: 内置插件权限位 (函数外赋值, compose 调用前即可读)
//   tools/shell 属敏感服务 (SENSITIVE_SERVICES), 需 full-access
toolsPlugin.access = "full-access";

export const evolvePlugin = (ctx) => {
  // P1④⑤⑥: 进化系插件 —— Playbook 引擎 / 记忆健康监控 / 故障记忆
  // P2⑥⑦: 符号画布 / 会话 fork 基线
  //
  // ⚠ 接线状态 (2026-09-17 核对): 本插件注册的 6 个服务在 src/ 内**当前均无消费方**
  //   (grep consume("playbook"|"memoryHealth"|"failures"|"canvas"|"fork"|"assets") = 0 命中)。
  //   即: 构造它们只有极小的初始化开销, 但没有任何链路在读写 —— 属"能力就绪、未接线"。
  //   保留原因: 单测已覆盖, 且是后续进化的现成骨架。
  //   提醒: 读到本插件的服务不等于功能已生效; 接入消费方 (写入 + 注入) 后才算真正启用。
  const dataDir = ctx.consume("dataDir");
  ctx.provide("playbook", new PlaybookStore(dataDir));          // 预留: 语境 bullets 引擎
  ctx.provide("memoryHealth", new MemoryHealthMonitor());        // 预留: 记忆管线健康
  ctx.provide("failures", new FailureEpisodeStore(dataDir));     // 预留: 故障病历
  ctx.provide("canvas", new CanvasStore(dataDir));               // 预留: 符号画布
  ctx.provide("fork", forkTools);                                // 预留: 会话 fork 基线 (函数集, 供 spawn 流程调用)
  ctx.provide("assets", new AssetHub(dataDir));                  // P3⑩: 记忆资产中枢 (预留)
};

// 默认内置插件装配顺序 (依赖在前)
export const builtinPlugins = [
  busPlugin, // ②循环系: 全局总线必须最先 (依赖在前)
  healerPlugin,
  personaPlugin,
  factsPlugin,
  experiencePlugin,
  legionBoardPlugin, // 军团共享记忆板 (toolsPlugin 依赖, 必须在前)
  sessionPlugin,
  memoryPlugin,
  llmPlugin,
  memoryLayersPlugin,
  tracesPlugin,
  auditPlugin, // 审计哈希链 (toolsPlugin 依赖它注入 catalog, 必须在前)
  toolsPlugin,
  evolvePlugin, // P1: playbook / memoryHealth / failures (tools 之后, 依赖 dataDir)
  modePlugin,
];
