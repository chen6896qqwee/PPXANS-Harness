// src/mcp/admin.js - MCP 管理虚拟工具 (零依赖)
// 把会话管理 / 提供方 CRUD / 设置读写 / 任务面板 暴露为标准 MCP 工具,
// 让 web 前端完全走 MCP 协议, 逐步退役 /api/* REST 端点。
// 这些是"虚拟工具" (注入 McpServer extraTools), 不进 catalog, 不污染 LLM 工具列表。
import {
  listProviders, addProvider, updateProvider, removeProvider, reorderProviders,
} from "../config/providers.js";
import { getSettings, updateSettings } from "../config/settings.js";
import { createTaskBoard } from "./tasks.js";
import { ensureDir } from "../utils/store.js";
import { warn } from "../utils/logger.js";
import path from "node:path";

// 任务面板技能模板库: 按技能预置步骤列表, 新建任务时可选 (供 web 前端渲染下拉)
// 每个模板 = { id, label, steps: string[] }
export const TASK_TEMPLATES = [
  {
    id: "apt",
    label: "Agent 专业训练评估 (agent-professional-training)",
    steps: [
      "读取 README 与流程设计说明，理解技能定位",
      "精读 SKILL.md 与全部 references",
      "检查安装脚本与目录结构规范性",
      "按技能规范逐项评估并给出改进建议",
    ],
  },
  {
    id: "session-naming",
    label: "会话重命名整理 (session-naming)",
    steps: [
      "列出全部对话及其创建时间",
      "按 MMDD|类型|主题 提炼新名称 (类型限定: 功能/设计/修复/优化/发布/探索/文档/研究)",
      "输出两列表格 (原名称|新名称) 等确认",
      "确认后修改, 仅报告结果",
    ],
  },
  {
    id: "prompt-depth",
    label: "回答深度提示词方案 (prompt-depth-kit)",
    steps: [
      "明确目标: 更敢说 / 更有逻辑 / 极简专业",
      "从三套方案中选一 (主动边界探索 / 情境化优先级 / 极简优雅)",
      "落地到 config/ppx.json 的 agent.system_extra 或场景 persona",
      "热重载并验证回答质量提升",
    ],
  },
  {
    id: "code-review",
    label: "代码审查 (code-review)",
    steps: [
      "拉取变更范围 (diff / PR 描述)",
      "逐文件审查: 逻辑/安全/性能/可维护性",
      "输出问题清单 (严重度分级)",
      "给出可落地修改建议",
    ],
  },
  {
    id: "mcp-audit",
    label: "MCP 合规性评估",
    steps: [
      "读取协议实现 (server.js / http.js)",
      "对照 MCP 2026-07-28 规范逐条核对",
      "检查错误码/版本协商/传输语义",
      "输出合规报告与改进项",
    ],
  },
  {
    id: "skill-import",
    label: "技能吸收入库",
    steps: [
      "读透技能 (README → SKILL.md → 配套数据)",
      "复制进 skills/learned/ 并注册索引",
      "验证 SkillLoader 可发现",
      "沉淀吸收报告",
    ],
  },
];

// 写配置前确保 config 目录存在 (空 root / 首次启动时 agent 自愈建目录是异步的,
// 若目录缺失, withFileLock 的 openSync(wx) 抛 ENOENT 会被误判为"锁冲突"并超时)
function ensureConfigDir(root) {
  try { ensureDir(path.join(root, "config")); } catch {}
}

const str = (v, d = "") => (v == null ? d : String(v));

// 工具执行封装: 抛错转 JSON-RPC 工具错误 (isError)
function wrap(fn) {
  return async (args) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await fn(args || {})) }] };
    } catch (e) {
      warn(`[mcp-admin] ${e.message}`);
      return { content: [{ type: "text", text: JSON.stringify({ error: String(e.message) }) }], isError: true };
    }
  };
}

/**
 * 生成 MCP 管理虚拟工具列表。
 * @param {object} agent - PPXAgent 实例
 * @returns {{ tools: object[], taskBoard: object }}
 */
export function createAdminTools(agent) {
  const root = agent.root;
  const taskBoard = createTaskBoard(root);

  const tools = [
    // ---- 会话管理 ----
    {
      name: "ppx.sessions.list",
      title: "会话列表",
      description: "列出全部会话 (key/count/lastTs/title)。等价于旧 REST /sessions。",
      inputSchema: { type: "object", properties: {} },
      execute: wrap(() => (agent.sessionStore && typeof agent.sessionStore.list === "function" ? agent.sessionStore.list() : [])),
    },
    {
      name: "ppx.sessions.history",
      title: "会话历史",
      description: "读取指定会话的消息历史 (role/content 数组)。等价于旧 REST /sessions/:key/history。",
      inputSchema: { type: "object", properties: { key: { type: "string", description: "会话 key" } }, required: ["key"] },
      execute: wrap((args) => (agent.sessionStore && typeof agent.sessionStore.deriveMessages === "function" ? agent.sessionStore.deriveMessages(String(args.key)) : [])),
    },
    {
      name: "ppx.sessions.rename",
      title: "会话重命名",
      description: "重命名会话 (复制事件到新 key 并删旧 key)。",
      inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
      execute: wrap((args) => (agent.sessionStore && typeof agent.sessionStore.rename === "function" ? agent.sessionStore.rename(String(args.from), String(args.to)) : false)),
    },
    {
      name: "ppx.sessions.delete",
      title: "删除会话",
      description: "删除指定会话及其历史。",
      inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
      execute: wrap((args) => { if (agent.sessionStore && typeof agent.sessionStore.delete === "function") agent.sessionStore.delete(String(args.key)); return { ok: true }; }),
    },
    {
      name: "ppx.session.reset",
      title: "重置会话",
      description: "清空会话历史 (等同新建)。",
      inputSchema: { type: "object", properties: { sessionId: { type: "string", description: "会话 key, 默认 default" } } },
      execute: wrap((args) => { agent.resetSession(String(args.sessionId || "default")); return { ok: true }; }),
    },

    // ---- 提供方 CRUD (模型配置) ----
    {
      name: "ppx.providers.list",
      title: "模型提供方列表",
      description: "列出全部 LLM 提供方 (key 已抹掉, 只留 api_key_set 标志)。等价于旧 REST /api/providers。",
      inputSchema: { type: "object", properties: {} },
      execute: wrap(() => { ensureConfigDir(root); const p = listProviders(root); return { providers: p, default_id: p[0] ? p[0].id : null }; }),
    },
    {
      name: "ppx.providers.add",
      title: "新增提供方",
      description: "新增一个 LLM 提供方 (http 后端, 需 base_url + 模型 + key/env)。热重载立即生效。",
      inputSchema: {
        type: "object",
        properties: { provider: { type: "object", description: "提供方配置: {id, base_url, api_key/api_key_env, model, vision?, timeout_ms?}" } },
        required: ["provider"],
      },
      execute: wrap(async (args) => { ensureConfigDir(root); const created = addProvider(root, args.provider || {}); agent.reloadProviders(); return { ok: true, provider: created }; }),
    },
    {
      name: "ppx.providers.update",
      title: "更新提供方",
      description: "更新指定提供方字段 (patch)。热重载立即生效。",
      inputSchema: { type: "object", properties: { id: { type: "string" }, patch: { type: "object" } }, required: ["id"] },
      execute: wrap(async (args) => { ensureConfigDir(root); const updated = updateProvider(root, String(args.id), args.patch || {}); agent.reloadProviders(); return { ok: true, provider: updated }; }),
    },
    {
      name: "ppx.providers.delete",
      title: "删除提供方",
      description: "删除指定提供方。热重载立即生效。",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      execute: wrap(async (args) => { ensureConfigDir(root); const removed = removeProvider(root, String(args.id)); agent.reloadProviders(); return { ok: true, provider: removed }; }),
    },
    {
      name: "ppx.providers.test",
      title: "探测提供方",
      description: "健康探测指定提供方 (复用 agent 客户端, 无真实网络时返回可读结果)。",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      execute: wrap(async (args) => { ensureConfigDir(root);
        const id = String(args.id);
        let client = (agent.allProviders || []).find((c) => c.providerId === id);
        let fromCache = !!client;
        if (!client && agent.llm && agent.llm.providerId === id) { client = agent.llm; fromCache = true; }
        if (!client) {
          const { readConfig } = await import("../config/providers.js");
          const { providers } = readConfig(root);
          const p = providers.find((x) => x.id === id);
          if (!p) throw new Error("提供方不存在");
          const { LLMClient } = await import("../llm/client.js");
          client = new LLMClient(p);
        }
        const healthy = await client.health();
        return { ok: true, healthy, detail: healthy ? "API 端点可达" : "探测失败, 请检查 key/base_url", source: fromCache ? "agent-cache" : "disk-config" };
      }),
    },
    {
      name: "ppx.providers.reorder",
      title: "重排提供方",
      description: "按给定 id 顺序重排提供方列表 (决定主模型优先级)。",
      inputSchema: { type: "object", properties: { order: { type: "array", items: { type: "string" } } }, required: ["order"] },
      execute: wrap(async (args) => { ensureConfigDir(root); const providers = reorderProviders(root, args.order || []); agent.reloadProviders(); return { ok: true, providers }; }),
    },

    // ---- 设置 ----
    {
      name: "ppx.settings.get",
      title: "读取设置",
      description: "读取可编辑设置 (用户名/HTTP 端口/安全/agent 预设)。敏感字段只回 set 标志。",
      inputSchema: { type: "object", properties: {} },
      execute: wrap(() => { ensureConfigDir(root); return { settings: getSettings(root) }; }),
    },
    {
      name: "ppx.settings.update",
      title: "更新设置",
      description: "更新设置 (patch: {user?, http?, security?, agent?, mcp?, tools?})。热重载立即生效。",
      inputSchema: { type: "object", properties: { patch: { type: "object" } }, required: ["patch"] },
      execute: wrap(async (args) => { ensureConfigDir(root); const settings = updateSettings(root, args.patch || {}); agent.reloadSettings(); return { ok: true, settings }; }),
    },

    // ---- 任务面板 ----
    {
      name: "ppx.task.templates",
      title: "任务模板列表",
      description: "列出任务面板内置技能模板 (按技能预置步骤), 供新建任务时选用。含 agent 训练评估/会话重命名/提示词方案/代码审查/MCP 合规/技能吸收。",
      inputSchema: { type: "object", properties: {} },
      execute: wrap(() => TASK_TEMPLATES),
    },
    {
      name: "ppx.task.create",
      title: "创建任务",
      description: "创建任务面板条目 (title/description/steps/template_id)。steps 为步骤标题数组, 每步初始 pending; 也可传 template_id 使用内置模板的步骤。",
      inputSchema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, steps: { type: "array", items: { type: "string" } }, template_id: { type: "string", description: "内置模板 id (见 ppx.task.templates)" } }, required: ["title"] },
      execute: wrap((args) => {
        const tpl = args.template_id ? TASK_TEMPLATES.find((t) => t.id === args.template_id) : null;
        const steps = tpl ? tpl.steps : (args.steps || []);
        return taskBoard.create({ title: args.title, description: args.description || (tpl ? tpl.label : ""), steps });
      }),
    },
    {
      name: "ppx.task.list",
      title: "任务列表",
      description: "列出全部任务 (含每步状态)。等价于任务面板读操作。",
      inputSchema: { type: "object", properties: {} },
      execute: wrap(() => taskBoard.list()),
    },
    {
      name: "ppx.task.update",
      title: "更新任务",
      description: "更新任务状态或字段: {id, status?} status 为 todo|running|done|failed。",
      inputSchema: { type: "object", properties: { id: { type: "string" }, status: { type: "string" } }, required: ["id"] },
      execute: wrap((args) => taskBoard.update(args)),
    },
    {
      name: "ppx.task.step",
      title: "更新任务步骤",
      description: "更新某任务某步骤: {id, index, status?, detail?} index 从 0 开始, status 为 pending|running|done|failed。",
      inputSchema: { type: "object", properties: { id: { type: "string" }, index: { type: "number" }, status: { type: "string" }, detail: { type: "string" } }, required: ["id", "index"] },
      execute: wrap((args) => taskBoard.step(args)),
    },
    {
      name: "ppx.task.delete",
      title: "删除任务",
      description: "删除任务面板条目。",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      execute: wrap((args) => taskBoard.delete(args)),
    },
    {
      name: "ppx.task.run",
      title: "运行任务",
      description: "把任务交给 agent 执行: 标 running → 调 agent.chat 处理任务描述 → 全部步骤标 done → 结果回填任务 result。返回 agent 回复。",
      inputSchema: { type: "object", properties: { id: { type: "string" }, prompt: { type: "string", description: "给 agent 的执行指令 (默认用任务 title+description)" } }, required: ["id"] },
      execute: wrap(async (args) => {
        const id = String(args.id);
        const t = taskBoard.get(id);
        if (!t) throw new Error("任务不存在");
        taskBoard.update({ id, status: "running" });
        const prompt = str(args.prompt) || `执行任务「${t.title}」: ${t.description || ""}`;
        const reply = await agent.chat(prompt, { sessionKey: "task:" + id });
        // 全部步骤置 done, 任务置 done
        taskBoard.complete(id, reply);
        return { ok: true, id, result: reply };
      }),
    },
  ];

  return { tools, taskBoard };
}
