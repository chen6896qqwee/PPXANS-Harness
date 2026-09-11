// src/plugin/builtin.js - 皮皮虾内置插件集 (一切皆插件)
// 借鉴 deepseek-harness 的 "everything is a plugin": 每个模块是一个插件, 通过 ctx.provide 注册服务。
// 装配顺序即依赖顺序 (依赖在前), 任何插件都可被用户插件替换或扩展。
import path from "node:path";
import { Healer } from "../selfheal/healer.js";
import { Persona } from "../persona/index.js";
import { FactStore, MemoryTicker, Experience, L0Recorder, SceneStore, PersonaStore } from "../memory/index.js";
import { SessionStore } from "../memory/session.js";
import {
  ToolCatalog, registerBuiltinTools, registerAdvancedTools, Scheduler,
  registerMethodTools, registerSelfmodTools, registerCustomTools, registerDocumentTools,
} from "../tools/index.js";
import { embedderFromConfig } from "../llm/embedder.js";
import { LocalShellProvider } from "../seam/shell.js";
import { registerDelegateTools } from "../tools/delegate.js";
import { Traces } from "../utils/trace.js";
import { RuntimeBus } from "../bus/runtime-bus.js";
export { isUsableProvider, resolveLLM, resolveAllLLMs } from "../llm/router.js";
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
  const healer = new Healer(ctx.consume("root"));
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
  ctx.provide("facts", new FactStore(ctx.consume("dataDir"), config.memory || {}));
};

export const experiencePlugin = (ctx) => {
  // 经验库走全局共享目录 (ANS 全局记忆): 跨 agent 共享经验, 写入用文件锁防并发覆盖
  ctx.provide("experience", new Experience(ctx.consume("globalDataDir") || ctx.consume("dataDir")));
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

export const toolsPlugin = (ctx) => {
  const root = ctx.consume("root");
  const dataDir = ctx.consume("dataDir");
  const config = ctx.consume("config");
  const facts = ctx.consume("facts");
  const memory = ctx.consume("memory");
  const tools = new ToolCatalog();
  registerBuiltinTools(tools, { rootDir: root, facts, memory });
  const scheduler = new Scheduler(dataDir);
  ctx.provide("scheduler", scheduler);
  registerAdvancedTools(tools, { dataDir, scheduler, onMemoryNote: (note) => facts.add(note, { source: "schedule" }) });
  registerMethodTools(tools);
  registerSelfmodTools(tools, { skillsDir: path.join(root, "skills") });
  // 用户自定义工具 (不改源码扩展能力)
  const customDir = path.join(root, (config.tools && config.tools.custom_dir) || "custom-tools");
  registerCustomTools(tools, customDir);
  // 文档加载器 (RAG: read_document / ingest_document)
  registerDocumentTools(tools, { rootDir: root });
  // 向量化: 配了 config.embedding 则自动注入 embedder, 检索切 dense+BM25 RRF; 否则纯 BM25 兜底
  const embedder = embedderFromConfig(config);
  if (embedder) facts.setEmbedder(embedder);
  // 多 agent 自主协作: spawn_agent 工具 (agent 自主派生子 agent 分工)
  registerDelegateTools(tools, {});
  // Shell 能力 seam: 命令执行解耦为可替换 provider (本地/未来沙箱/Docker)
  ctx.provide("shell", new LocalShellProvider());
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

// 默认内置插件装配顺序 (依赖在前)
export const builtinPlugins = [
  busPlugin, // ②循环系: 全局总线必须最先 (依赖在前)
  healerPlugin,
  personaPlugin,
  factsPlugin,
  experiencePlugin,
  sessionPlugin,
  memoryPlugin,
  llmPlugin,
  memoryLayersPlugin,
  tracesPlugin,
  toolsPlugin,
  modePlugin,
];
