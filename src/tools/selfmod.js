// src/tools/selfmod.js - Self-modification 工具
// 参考 deepseek-harness 的 self-modification: agent 能检查/挂载/卸载自己的运行时能力
// 这里落地为"能力级自修改": 枚举能力(工具+技能) / 启用 / 禁用 / 加载技能, 不破坏零依赖内核
import { SkillLoader } from "../skills/loader.js";
import fs from "node:fs";
import path from "node:path";

function capErr(name, msg) {
  return `[工具错误] ${name}: ${msg}`;
}

export function registerSelfmodTools(catalog, { skillsDir }) {
  const loader = new SkillLoader(skillsDir);

  // 1. 枚举全部能力: 工具 + 技能
  catalog.register({
    name: "list_capabilities",
    description: "枚举当前所有可用的工具能力(category/power/enabled) 和已安装技能。用于 agent 了解自己能干啥。",
    parameters: { type: "object", properties: { kind: { type: "string", enum: ["tool", "skill", "all"], description: "all=工具+技能(默认)" } }, required: [] },
    category: "selfmod",
    power: "agent",
    idempotent: true,
    execute: async (args) => {
      const kind = args && args.kind ? args.kind : "all";
      const lines = [];
      if (kind === "all" || kind === "tool") {
        lines.push("— 工具 —");
        for (const t of catalog.listDetailed()) {
          lines.push(`[${t.enabled ? "ON" : "OFF"}] ${t.name} (${t.category}/${t.power})${t.timeoutMs ? ` 超时${t.timeoutMs}ms` : ""}`);
        }
      }
      if (kind === "all" || kind === "skill") {
        lines.push("— 技能 —");
        for (const s of loader.list()) {
          lines.push(`${s.id}: ${s.name} — ${s.description}`);
        }
      }
      return lines.join("\n");
    },
  });

  // 2. 启用能力
  catalog.register({
    name: "enable_capability",
    description: "启用一个已注册但被禁用的工具能力。name 为工具名。",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    category: "selfmod",
    power: "agent",
    execute: async (args) => {
      if (!catalog.enable(args.name)) return capErr("enable_capability", `未知工具: ${args.name}`);
      return `已启用: ${args.name}`;
    },
  });

  // 3. 禁用能力
  catalog.register({
    name: "disable_capability",
    description: "禁用工具能力(不卸载, 可随时启用)。name 为工具名。禁用后该工具不再出现在 LLM schema 且调用被拒。",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    category: "selfmod",
    power: "agent",
    execute: async (args) => {
      if (!catalog.disable(args.name)) return capErr("disable_capability", `未知工具: ${args.name}`);
      return `已禁用: ${args.name}`;
    },
  });

  // 4. 加载技能
  catalog.register({
    name: "load_skill",
    description: "读取一个已安装技能的 SKILL.md 全文, 供 agent 按需加载使用。id 为技能名。",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    category: "selfmod",
    power: "user",
    idempotent: true,
    execute: async (args) => {
      const content = loader.read(args.id);
      if (content === null) return capErr("load_skill", `未知技能: ${args.id}`);
      
      if (loader && typeof loader.trackUse === "function") { try { loader.trackUse(args.id); } catch {} }
      return `# ${args.id}\n\n${content}`;
    },
  });

  // 5. 创建新技能 (L5 auto-skill: 复杂任务后沉淀为可复用 Skill)
  catalog.register({
    name: "create_skill",
    description: "把一次成功的方法/流程沉淀为可复用的 Agent Skill。name=技能名(字母数字横线), description=一句话说明, content=SKILL.md 正文。正文推荐含三个段落(参考 addyosmani/agent-skills): ①「## 流程」逐步工作流+检查点 ②「## 反合理化」常见偷懒借口+反驳 ③「## 验证」完成后必须提供的证据。写进 skills/ 目录后自动被 loader 发现。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名, 仅字母/数字/横线" },
        description: { type: "string", description: "技能一句话说明" },
        content: { type: "string", description: "SKILL.md 正文 (建议含: 流程/反合理化/验证 三段)" },
      },
      required: ["name", "description", "content"],
    },
    category: "selfmod",
    power: "agent",
    execute: async (args) => {
      const name = String(args.name || "").trim();
      if (!/^[a-zA-Z0-9-]+$/.test(name)) return "[工具错误] create_skill: 技能名仅允许字母/数字/横线: " + name;
      const desc = String(args.description || "").trim();
      const content = String(args.content || "").trim();
      if (!desc || !content) return "[工具错误] create_skill: 需 description + content";
      // v1.0.8: 长度上限, 防写超大文件/垃圾内容
      if (desc.length > 300) return "[工具错误] create_skill: description 超长 (最大 300 字符)";
      if (content.length > 50000) return "[工具错误] create_skill: content 超长 (最大 50000 字符)";
      const dir = path.join(skillsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      const frontmatter = "---" + "\n" + "name: " + name + "\n" + "description: " + desc + "\n" + "---" + "\n" + "\n";
      fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter + content, "utf8");
      return "已创建技能: " + name + " (skills/" + name + "/SKILL.md)";
    },
  });

  // 6b. 自我进化: 从失败轨迹自动提炼经验 (refine 的上半场, 补齐「失败→经验」闭环)
  catalog.register({
    name: "refine",
    description: "从最近的失败工具调用轨迹自动提炼一条可复用经验教训 (自我进化闭环)。失败轨迹足够(≥2条)时, 用 LLM 提炼成一句话经验存进经验库, 后续任务自动注入上下文。",
    parameters: { type: "object", properties: { limit: { type: "number", description: "回看轨迹条数, 默认 20" } }, required: [] },
    category: "selfmod",
    power: "agent",
    execute: async (args, ctx) => {
      const agent = ctx && ctx.agent;
      if (!agent || typeof agent.refine !== "function") return capErr("refine", "无 agent 上下文");
      const r = await agent.refine({ limit: Number(args && args.limit) || 20 });
      return JSON.stringify(r);
    },
  });

  // 7. 自我进化: 从成功轨迹自动提炼可复用 Skill (refine 的下半场)
  catalog.register({
    name: "refine_skill",
    description: "从最近成功的工具调用轨迹自动提炼一个可复用 Skill (自我进化闭环)。成功轨迹足够且高频工具重复出现时, 用 LLM 提炼成 skills/<name>/SKILL.md。",
    parameters: { type: "object", properties: { limit: { type: "number", description: "回看轨迹条数, 默认 50" } }, required: [] },
    category: "selfmod",
    power: "agent",
    execute: async (args, ctx) => {
      const agent = ctx && ctx.agent;
      if (!agent || typeof agent.refineSkill !== "function") return capErr("refine_skill", "无 agent 上下文");
      const r = await agent.refineSkill({ limit: Number(args && args.limit) || 50 });
      return JSON.stringify(r);
    },
  });

  // 6. Session Replay: 从原始日志恢复会话历史 (跨天/崩溃续跑)
  catalog.register({
    name: "replay_session",
    description: "从原始对话日志恢复某会话的历史(跨天/崩溃后续跑)。sessionKey=会话名(默认default), days=回溯天数(默认7), limit=返回条数(默认40)。",
    parameters: {
      type: "object",
      properties: {
        sessionKey: { type: "string", description: "会话名, 默认 default" },
        days: { type: "number", description: "回溯天数, 默认 7" },
        limit: { type: "number", description: "返回条数, 默认 40" },
      },
      required: [],
    },
    category: "selfmod",
    power: "user",
    idempotent: true,
    execute: async (args, ctx) => {
      const agent = ctx && ctx.agent;
      if (!agent || !agent.l0) return capErr("replay_session", "无 l0 记录器");
      const msgs = agent.replaySession((args && args.sessionKey) || "default", {
        days: Number(args && args.days) || 7,
        limit: Number(args && args.limit) || 40,
      });
      if (!msgs.length) return "(该会话无历史记录)";
      return msgs.map(m => `${m.role}: ${m.content}`).join("\n");
    },
  });

  return catalog;
}
