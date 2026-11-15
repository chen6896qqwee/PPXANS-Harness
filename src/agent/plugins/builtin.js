// src/agent/plugins/builtin.js - 皮皮虾内置插件集 (一切皆插件)
// 设计溯源 docs/PROVENANCE.md#dsh 的 "everything is a plugin": 每个模块是一个插件, 通过 ctx.provide 注册服务。
// 装配顺序即依赖顺序 (依赖在前), 任何插件都可被用户插件替换或扩展。
import path from "node:path";
import { info, warn } from "../../utils/logger.js";
import { Healer } from "../../evolve/healer.js";
import { Persona } from "../../memory/persona.js";
import { FactStore, MemoryTicker, Experience, L0Recorder, SceneStore, PersonaStore, LegionBoard } from "../../memory/index.js";
import { SessionStore } from "../../memory/session.js";
import {
  ToolCatalog, registerBuiltinTools, registerAdvancedTools, Scheduler,
  registerMethodTools, registerSelfmodTools, registerCustomTools, registerDocumentTools,
  registerDesktopTools,
  registerGovernanceTools,
} from "../../tools/index.js";
// 链式召回 (2026-11-01 二期③): 超长工具结果全文归档 + context_read 续读工具
import { SpillStore } from "../../tools/spill.js";
import { registerContextTools } from "../../tools/context.js";
import { registerFacadeTools } from "../../tools/facade.js";
import { registerGrepTools } from "../../tools/grep.js";
import { registerLspTools } from "../../tools/lsp.js";
import { registerShellSessionTools } from "../../tools/shell-session.js";
import { PlanLive } from "../../session/plan-live.js";
import { registerPlanLiveTools } from "../../tools/plan-live.js";
import { registerBrowseTools } from "../../tools/browse.js";
import { embedderFromConfig } from "../../llm/embedder.js";
import { hashEmbed, HASH_EMBEDDER_ID } from "../../memory/hash-embedder.js";
import { LocalShellProvider, DockerShellProvider } from "../../seam/shell.js";
import { skillRootsFromConfig } from "../../skills/registry.js";
import { registerDelegateTools } from "../../tools/delegate.js";
// 自主迭代进化 (2026-10-25): 测试→诊断→补丁→验证→沉淀/回滚 的自改进闭环工具
import { registerSelfIterateTools, registerEvolutionStatusTool } from "../../tools/selfiterate.js";
// 自改代码 (2026-10-27): 补丁→边界→落盘→三关验证→绿留红滚→账本, 让皮皮虾能安全改自己的源码
import { registerSelfCodeTools } from "../../tools/selfcode.js";
import { Traces } from "../../utils/trace.js";
import { AuditLog, loadOrCreateHmacKey } from "../../audit/audit-chain.js";
import { RuntimeBus } from "../../bus/runtime-bus.js";
import { PlaybookStore } from "../../evolve/playbook.js";
import { FailureEpisodeStore } from "../../memory/failure-episode.js";
import { registerVoiceTools } from "../../tools/voice.js";
import { exportMemorySnapshot, mergeSnapshotBack, hasSnapshot } from "../../memory/fork.js";
// v3.0 (codex 对齐): 新工具 (repo_map/apply_patch/review_code/goal_board)
import { registerV3Tools } from "../../tools/v3.js";
// v3.0.1 (GitHub 主流 Agent 对标): git 集成工具 (aider/Claude Code/OpenHands 标配, 带硬护栏)
import { registerGitTools } from "../../tools/git.js";
// 2026-10-09 接线: 以下 6 个工具模块此前【只定义、从未装配】——
//   文件在 src/tools/ 里, 但没被任何插件注册进工具目录, 运行时一律报「未知工具」,
//   对应测试 (team-orchestration / orchestration-tools / expert-pack / plugin-dx 等) 长期失败。
import { registerTeamRoomTools } from "../../tools/team-room.js";
import { registerOrchestrationTools } from "../../tools/orchestration.js";
import { registerSkillHubTools } from "../../tools/skill-hub.js";
import { registerExpertHubTools } from "../../tools/expert-hub.js";
import { registerSandboxTools } from "../../tools/sandbox.js";
import { registerVadTools } from "../../tools/vad.js";

// fork 工具 (供 ctx.consume("fork") 取用)
const forkTools = { exportMemorySnapshot, mergeSnapshotBack, hasSnapshot };
// LLM 路由: import 本地绑定 + re-export 向后兼容 (v2.5.0 修复: 仅 export-from 不产生本地绑定,
// 导致 llmPlugin 里 resolveLLM/resolveAllLLMs 未定义, 插件装配被隔离且 LLM 实际未注入)
import { isUsableProvider, resolveLLM, resolveAllLLMs } from "../../llm/router.js";
export { isUsableProvider, resolveLLM, resolveAllLLMs };
import { ModeRegistry, registerDefaultModes } from "../modes/index.js";
// 2026-11-08 精简: plan-exec/router/blackboard/graph 四种模式是委派/军团路径的进程内子集复制品,
//   注册后无任何调用方 (config 默认 react, 全仓无 chat({mode:"graph"}) 等), 随模块移除;
//   legion 保留 (README 特性面 + 双测试覆盖 + hardening-2026-10-24 修复维护中)。
import { legionExecutor } from "../modes/legion.js";
import { noteCatch } from "../../utils/catch-log.js";

// ---- LLM 路由 (唯一真相源已迁至 src/llm/router.js, 此文件仅 re-export 向后兼容) ----
// router.js 负责: 占位死配置过滤 / 云端真key优先 / 本地零配置兜底 / 健康排序 / PPX_PROVIDER 强制
// 此处保留导出名, agent/热重载/插件继续用 builtin.resolveLLM 等旧引用。

// ---- 内置插件: 每个 (ctx) => void, 用 ctx.provide 注册服务 ----


const busPlugin = (ctx) => {
  // ②循环系: 全局 Runtime 总线。必须最先装配, 其他插件可 ctx.consume("bus") 挂订阅/注册命令。
  const bus = new RuntimeBus();
  ctx.provide("bus", bus);
  // 状态槽: sessionKey 归属 (给观测/审计看当前活跃会话)
  bus.set("bootedAt", Date.now());
  return bus;
};

const healerPlugin = (ctx) => {
  // v1.0.8 修复 (P1-2): 必须传真实数据目录, 否则自愈体检/崩溃标记会落到 root/data 硬编码路径,
  // 在 PPX_DATA_DIR 自定义时与真实数据目录分叉 (详见 evolve/healer.js 注释)。
  const healer = new Healer(ctx.consume("root"), ctx.consume("dataDir"));
  // 2026-11-13 (评测 P2-3): 先读上一次的标记, 再写本次的 dirty —— 旧顺序 markDirty 覆盖了
  //   死 pid, checkCrash 永远只能看到"当前 pid", 崩溃恢复实际从未生效。
  const crash = healer.checkCrash();
  healer.markDirty();
  const health = healer.heal();
  if (crash.crashed) warn(`[selfheal] 崩溃残留: ${crash.detail}`);
  if (crash.otherInstance) warn(`[selfheal] ${crash.detail}`);
  health.startupCrash = crash;
  ctx.provide("healer", healer);
  ctx.provide("health", health);
};

const personaPlugin = (ctx) => {
  ctx.provide("persona", new Persona(ctx.consume("root")));
};

const factsPlugin = (ctx) => {
  const config = ctx.consume("config");
  // 2026-11-08 精简: sqlite 记忆后端族 (sqlite-store/write/query/normalize/governance +
  //   backend-migrate, ~1.1k 行) 归档至 git 历史 —— 自 v2026-10-04 落地以来默认后端始终是
  //   JSON, sqlite 只有测试在跑, 却要求 JSON 与 sqlite 两套 governance/write/query 永久平行维护。
  //   显式配置 memory.backend=sqlite 现在会得到明确报错 (不再静默回退)。
  const backend = String(config?.memory?.backend || "").trim().toLowerCase();
  if (backend && backend !== "json") {
    throw new Error(`[memory] memory.backend="${backend}" 不受支持 (sqlite 后端已于 2026-11-08 归档; 仅支持 json / 缺省)`);
  }
  const facts = new FactStore(ctx.consume("dataDir"), config.memory || {});
  ctx.provide("facts", facts);
};

const experiencePlugin = (ctx) => {
  // 经验库走全局共享目录 (ANS 全局记忆): 跨 agent 共享经验, 写入用文件锁防并发覆盖
  ctx.provide("experience", new Experience(ctx.consume("globalDataDir") || ctx.consume("dataDir")));
};

const legionBoardPlugin = (ctx) => {
  // 军团共享记忆板 (2026-10-02): 走全局共享目录, 主 agent 与 worker 实时互通
  ctx.provide("legionBoard", new LegionBoard(ctx.consume("globalDataDir") || ctx.consume("dataDir")));
};

export const sessionPlugin = (ctx) => {
  const config = ctx.consume("config");
  // 2026-11-02 (L3 写盘批量化): 生产装配默认开启 write-behind —— 一轮对话的多条事件
  //   在下一个 setImmediate 合并为每 key 一次加锁/追加, 请求栈不再等待磁盘。
  //   memory.session_write_behind=false 可退回逐条同步落盘 (脚本/调试/极端耐久要求)。
  const writeBehind = config.memory?.session_write_behind !== false;
  const delayMs = Number(config.memory?.session_write_behind_delay_ms) || 0;
  const sessions = new SessionStore(ctx.consume("dataDir"), { writeBehind, writeBehindDelayMs: delayMs });
  if (typeof ctx.onDispose === "function") {
    // 关闭顺序早于进程退出: 任何插件 teardown 前先把手头的会话事件写完
    ctx.onDispose(() => { try { sessions.flushAll({ sync: true }); } catch (e) { noteCatch(e); /* 退出路径不抛 */ } });
  }
  // 启动时清理过期会话 (config.memory.session_max_age_days, 默认 30; 0/负=不清理)
  const maxAge = Number(config.memory?.session_max_age_days ?? 30);
  if (maxAge > 0) {
    const removed = sessions.pruneOld({ maxAgeDays: maxAge });
    if (removed.length) info(`[sessions] 清理过期会话 ${removed.length} 个: ${removed.join(", ")}`);
  }
  // 自动归档 (2026-10-11): config.memory.session_archive_days, 默认 7; 0/负=不归档。
  //   启动跑一次 + 每 6 小时跑一次 (interval unref: 不阻止进程优雅退出)。
  const archDays = Number(config.memory?.session_archive_days ?? 7);
  const runAutoArchive = () => {
    try {
      const done = sessions.autoArchive({ days: archDays });
      if (done.length) info(`[sessions] 自动归档 ${done.length} 个不活跃会话 (> ${archDays} 天): ${done.join(", ")}`);
    } catch (e) { info(`[sessions] 自动归档失败 (不阻塞): ${e?.message || e}`); }
  };
  if (archDays > 0) {
    runAutoArchive();
    const timer = setInterval(runAutoArchive, 6 * 3600 * 1000);
    if (typeof timer.unref === "function") timer.unref();
  }
  ctx.provide("sessions", sessions);
};

export const memoryPlugin = (ctx) => {
  const facts = ctx.consume("facts");
  const sessions = ctx.consume("sessions");
  ctx.provide("memory", new MemoryTicker(ctx.consume("dataDir"), facts, null, sessions));
};

// 记忆后端插槽 (2026-10-09 补 —— 轻内核缺口 2 第一步)
// 默认实现是 MemoryTicker (本地 JSON)。想让记忆落到外部后端 (Qdrant/Redis/…) 时,
// 插件按约定注册工厂: ctx.provide("memoryBackend:<name>", (services) => instance),
// 然后把 config.memory.backend 设为 <name> 即可切换 —— 内核不需要知道任何具体后端。
// fail-safe 三条 (缺工厂 / 工厂抛错 / 显式默认) 一律保留 MemoryTicker, 绝不因为插槽问题让记忆不可用。
export function applyMemoryBackend(ctx, config = {}) {
  const backend = config?.memory?.backend;
  // json/sqlite/auto 是 FactStore 自己的存储层语义, 与"记忆实现插槽"无关, 不触发切换
  if (!backend || backend === "default" || backend === "json" || backend === "sqlite" || backend === "auto") return;
  const factory = ctx.consume(`memoryBackend:${backend}`);
  if (typeof factory !== "function") return;   // 工厂缺失 → 保留默认
  try {
    const instance = factory({
      dataDir: ctx.consume("dataDir"),
      facts: ctx.consume("facts"),
      sessions: ctx.consume("sessions"),
      userName: ctx.consume("userName"),
    });
    if (instance) ctx.provide("memory", instance);
  } catch {
    // 工厂抛错 → 保留默认实现, 不向上传播 (插槽坏了不该让整个 agent 起不来)
  }
}

const llmPlugin = (ctx) => {
  const config = ctx.consume("config");
  ctx.provide("llm", resolveLLM(config));
  ctx.provide("allProviders", resolveAllLLMs(config));
};

const memoryLayersPlugin = (ctx) => {
  const sessions = ctx.consume("sessions");
  const dataDir = ctx.consume("dataDir");
  const userName = ctx.consume("userName") || "兄弟";
  ctx.provide("l0", new L0Recorder(sessions, dataDir));
  ctx.provide("scenes", new SceneStore(dataDir));
  ctx.provide("personaStore", new PersonaStore(dataDir, { userName }));
};

const tracesPlugin = (ctx) => {
  ctx.provide("traces", new Traces(ctx.consume("dataDir")));
};

export const auditPlugin = (ctx) => {
  // 审计哈希链 (承接自 ppx-v2): append-only + SHA-256 链式防篡改账本。
  // 与 core/trace.js 的事件流互补 —— trace 面向"可观测", audit 面向"可追责/防篡改"。
  // config.audit.enabled === false 时关闭 (供性能敏感场景), 默认开启。
  // 2026-10-24: HMAC 锚点 —— 密钥在数据目录之外 (env PPX_AUDIT_HMAC_KEY > <root>/.ppx/audit-hmac-key),
  //   防"能写 data/ 的进程整链重算"。取不到密钥时退回裸哈希链 (检测仍在, 防改降级), 不阻断。
  const config = ctx.consume("config");
  if (config?.audit?.enabled === false) {
    ctx.provide("audit", null);
    return null;
  }
  const hmacKey = loadOrCreateHmacKey(ctx.consume("root"));
  const audit = new AuditLog(ctx.consume("dataDir"), { hmacKey });
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
  registerBuiltinTools(tools, { rootDir: root, facts, memory, dataDir });
  // 架构优化 ⑥(2026-11-13): 内容检索工具 —— 借 rg / git grep 这些成熟轮子,
  //   内置扫描只做兜底。此前只有"按文件名 glob", 搜内容得让模型拼 run_command。
  registerGrepTools(tools, { rootDir: root });
  // 架构优化 ⑧(2026-11-13): 常驻 shell —— cd / export / venv 在后续命令里继续有效。
  //   没有 bash 的环境不注册该工具 (模型看不到, 自然退回 run_command), 不假装支持。
  try {
    const sh = registerShellSessionTools(tools, { rootDir: root, config: config?.agent?.shell_session });
    if (sh.available) ctx.provide("shellSession", sh.session);
  } catch (e) { warn(`[tools] 常驻 shell 装配失败 (退回 run_command): ${e?.message || e}`); }
  // 架构优化 ⑦(2026-11-13): 语言服务器工具 —— 代码事实 (定义/引用/悬停/诊断) 交给 LSP,
  //   不再靠"grep 完一个个读文件"。服务器是可选外部程序, 没装就如实报错。
  try {
    const lsp = registerLspTools(tools, { rootDir: root, config: { lsp: config?.agent?.lsp } });
    ctx.provide("lspPool", lsp?.pool || null);
  } catch (e) { warn(`[tools] lsp 工具装配失败 (不影响其他工具): ${e?.message || e}`); }
  // 2026-09-18: onFire 兜底 —— 重启恢复的持久化任务无 action 闭包, 触发时按 job.name 还原行为
  const scheduler = new Scheduler(dataDir, { onFire: (job) => facts.add(`定时任务触发: ${job?.name || "?"}`, { source: "schedule" }) });
  ctx.provide("scheduler", scheduler);
  registerAdvancedTools(tools, { dataDir, scheduler, onMemoryNote: (note) => facts.add(note, { source: "schedule" }) });
  registerMethodTools(tools);
  // 2026-10-31 (队列⑥): selfmod 与 agent 同一 roots 口径 (项目 > 用户 > 内置) —— 此前这里
  //   只传内置单根, list_capabilities / load_skill / search_skills 看不见用户级与项目级技能;
  //   create_skill 落盘改为可写根 (项目 .ppx/skills 优先, 用户级兜底), 用户产物不再写进代码树
  //   (内置根在 npm 装机时位于 node_modules, 升级替换包目录即冲掉)。
  const skillRoots = skillRootsFromConfig(config, root);
  registerSelfmodTools(tools, {
    roots: skillRoots,
    writeDir: (skillRoots.find((r) => r.writable) || skillRoots[0])?.dir,
  });
  // 用户自定义工具 (不改源码扩展能力)
  const customDir = path.join(root, (config.tools && config.tools.custom_dir) || "custom-tools");
  registerCustomTools(tools, customDir);
  // 文档加载器 (RAG: read_document / ingest_document)
  registerDocumentTools(tools, { rootDir: root });
  // 桌面控制 (2026-11-03): 截图/鼠标/键盘/打开程序。工具常驻注册, 但 execute 在
  //   security.computer_control !== true 时直接拒绝 —— 默认关闭, 不把宿主控制面当默认能力。
  registerDesktopTools(tools, { rootDir: root, config });
  // 向量化: 配了 config.embedding 则注入云端/本地 embedder (dense+BM25 RRF)。
  // 2026-10-24: 未配置时默认注入内置零依赖哈希 embedder (特征哈希 256 维) —— 语义检索
  //   从"默认整个关闭"变为"开箱有兜底" (抓子词/词形/CJK 字面近义, 抓不住深层语义)。
  //   需要强语义配 config.embedding; 显式 config.embedding.fallback="off" 恢复纯 BM25。
  const embedder = embedderFromConfig(config);
  if (embedder) {
    const embCfg = config?.embedding || {};
    facts.setEmbedder(embedder, { identity: `${embCfg.backend || "endpoint"}:${embCfg.model || "default"}` });
  } else if (config?.embedding?.fallback !== "off") {
    facts.setEmbedder(hashEmbed, { identity: HASH_EMBEDDER_ID });
  }
  // 军团共享记忆板 (2026-10-02): 所有 agent (主 + worker) 实时共享知识
  const board = ctx.consume("legionBoard");
  // 多 agent 自主协作: spawn_agent 工具 (agent 自主派生子 agent 分工)
  // 传入军团记忆板: share_board 自动发布子任务结论 + 仲裁前自动读板
  registerDelegateTools(tools, { board });
  // 语音 TTS (2026-10-03 开箱即用): Windows SAPI / macOS say / Linux espeak
  registerVoiceTools(tools);
  if (board) {
    const fromName = () => ctx.consume("agent")?.config?.agent?.name || "main";
    tools.register({
      name: "board_publish",
      capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
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
      capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
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
  // Shell 能力 seam: 命令执行解耦为可替换 provider (local 默认 / docker 容器沙箱)
  // 2026-10-31: DockerShellProvider 落地 —— security.shell_provider="docker" 时命令在容器内
  //   执行 (workspace bind-mount 到 /workspace, 默认断网 + cap-drop ALL + 资源上限),
  //   Docker 不可用按 security.docker.missing 回退本地或报错; 判定遗漏由内核边界兜底。
  const shellProviderName = String(config?.security?.shell_provider || "local").toLowerCase();
  if (shellProviderName === "docker") {
    const d = (config.security && config.security.docker) || {};
    ctx.provide("shell", new DockerShellProvider({
      root,
      image: d.image,
      network: d.network,
      memory: d.memory,
      cpus: d.cpus,
      pidsLimit: d.pids_limit,
      user: d.user,
      envPass: d.env_pass,
      missing: d.missing,
      dockerBin: d.bin,
    }));
  } else {
    ctx.provide("shell", new LocalShellProvider());
  }
  // 审计哈希链接入工具执行收口 (未启用时为 null, catalog 内部零开销跳过)
  tools.setAudit(ctx.consume("audit"));
  // 记忆治理 + 审计校验 + 运维工具 (承接自 ppx-v2, 共 10 个)
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
  // 自主迭代进化 (2026-10-25): self_improve 工具 (测试驱动的自改进闭环)
  registerSelfIterateTools(tools, { agent: ctx.consume("agent") });
  // 进化状态报告 (2026-10-25 第二层): 只读, journal 曲线 + 能力快照
  registerEvolutionStatusTool(tools, { agent: ctx.consume("agent") });
  // 自改代码 (2026-10-27): self_edit / self_verify / self_rewind / self_ledger
  // 与 self_improve 的分工: self_improve 让 LLM 自己想补丁; selfcode 由调用方给补丁, 引擎只管验证/回滚/记账
  registerSelfCodeTools(tools, { getAgent: () => ctx.consume("agent") });
  // git 集成 (2026-10-01): status/diff/log/commit, 仅 add+commit, 禁 push/reset
  registerGitTools(tools, { rootDir: root });
  // ---- 2026-10-09 补齐装配: 团队房间 / 编排观测 / 技能中枢 / 专家中枢 / 沙箱 / VAD ----
  // 全部用惰性 getAgent —— ctx.consume("agent") 在装配期可能尚未 provide (返回 undefined 不抛),
  // 用闭包延迟到工具真正被调用时再取, 规避插件装配顺序依赖。
  const getAgentLazy = () => ctx.consume("agent");
  registerTeamRoomTools(tools, { getAgent: getAgentLazy });
  registerOrchestrationTools(tools, { getAgent: getAgentLazy });
  registerSkillHubTools(tools, { getAgent: getAgentLazy, skillsRoot: path.join(root, "skills") });
  registerExpertHubTools(tools, { getAgent: getAgentLazy });
  registerSandboxTools(tools);
  registerVadTools(tools, { rootDir: root });
  // 回合内计划工件 (v5.0 P2.3): update_plan 工具 + system 动态区注入 + EQ plan_updated 事件。
  // agent 侧经 ctx.consume("planLive") 拿同一实例 (与 spill 同款单例口径)。
  const planLive = new PlanLive(dataDir);
  ctx.provide("planLive", planLive);
  registerPlanLiveTools(tools, { planLive });
  // browse (v5.0 P2.3): 网页阅读工具 (桌面渲染优先, 直抓兜底; 截图落 uploads/ 回显)
  registerBrowseTools(tools, { uploadsDir: path.join(root, "uploads") });
  // 链式召回 (2026-11-01 v4.1 平台化): 超长工具结果全文归档存储 + context_read 续读工具。
  // agent.context_recall === false 整体旁路 (不建存储不注册工具, 裁剪回落纯裁剪旧行为)。
  // agent 侧经 ctx.consume("spill") 拿同一实例注入 runToolLoop (单例保证读写一致)。
  if (config?.agent?.context_recall !== false) {
    const spill = new SpillStore(path.join(dataDir, "spill"));
    spill.sweepOnce();
    ctx.provide("spill", spill);
    registerContextTools(tools, { spill });
  }
  // 架构优化 ①(2026-11-13): 意图门面 —— 同族低频工具收进一个 action 分派入口。
  //   原工具名保持可调用 (测试/脚本/既有 skills 一律不受影响), 只是不再单独对模型下发;
  //   门面内部仍走 catalog.call → 策略链/审批/审计/参数校验一处不少。
  try {
    const facade = registerFacadeTools(tools);
    tools.hide(facade.covered);
    if (facade.facades.length) {
      info(`[tools] 意图门面 ${facade.facades.length} 个入口, 收编 ${facade.covered.length} 个长尾工具 (仍可直接调用)`);
    }
  } catch (e) {
    // 门面装配失败 = 退回全量工具面, 不阻断启动
    warn(`[tools] 意图门面装配失败, 退回全量工具面: ${e?.message || e}`);
  }
  ctx.provide("tools", tools);
  ctx.provide("toolsEnabled", config.tools?.enabled !== false);
};

const modePlugin = (ctx) => {
  const registry = new ModeRegistry();
  registerDefaultModes(registry);
  registry.register("legion", legionExecutor);
  ctx.provide("modes", registry);
};

// P2⑧: 内置插件权限位 (函数外赋值, compose 调用前即可读)
//   tools/shell 属敏感服务 (SENSITIVE_SERVICES), 需 full-access
toolsPlugin.access = "full-access";

export const evolvePlugin = (ctx) => {
  // P1④⑤⑥: 进化系插件 —— Playbook 引擎 / 记忆健康监控 / 故障记忆
  // P2⑥⑦: 会话 fork 基线
  //
  // ⚠ 接线状态 (2026-11-08 精简核对): memoryHealth / canvas / assets 三个"预留"服务
  //   自注册以来始终零消费方 (grep consume 无命中), 已随模块一并移除 (supervisor/triage 同批)。
  //   playbook / failures / fork 保留: 单测覆盖 + 进化链路的现成骨架。
  //   提醒: 读到本插件的服务不等于功能已生效; 接入消费方 (写入 + 注入) 后才算真正启用。
  const dataDir = ctx.consume("dataDir");
  ctx.provide("playbook", new PlaybookStore(dataDir));          // 预留: 语境 bullets 引擎
  ctx.provide("failures", new FailureEpisodeStore(dataDir));     // 预留: 故障病历
  ctx.provide("fork", forkTools);                                // 预留: 会话 fork 基线 (函数集, 供 spawn 流程调用)
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
