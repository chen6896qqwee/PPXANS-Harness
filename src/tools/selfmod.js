// src/tools/selfmod.js - Self-modification 工具
// 设计溯源 docs/PROVENANCE.md#dsh; 自研 self-modification: agent 能检查/挂载/卸载自己的运行时能力
// 这里落地为"能力级自修改": 枚举能力(工具+技能) / 启用 / 禁用 / 加载技能, 不破坏零依赖内核
import { SkillLoader } from "../skills/loader.js";
import { scoreSkills } from "../skills/search.js";
import fs from "node:fs";
import path from "node:path";

function capErr(name, msg) {
  return `[工具错误] ${name}: ${msg}`;
}

// 2026-10-31 (队列⑥): 多根装配 —— 传 roots (项目>用户>内置) 走全量技能面; writeDir 为可写根
//   (create_skill 落盘处)。兼容旧 skillsDir 单根入参 (内部唯一调用方已切 roots, 参数保留防外部误用)。
export function registerSelfmodTools(catalog, { roots, writeDir, skillsDir }) {
  const loader = roots?.length ? new SkillLoader({ roots }) : new SkillLoader(skillsDir);
  const destDir = writeDir || skillsDir;

  // 1. 枚举全部能力: 工具 + 技能
  catalog.register({
    name: "list_capabilities",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "枚举当前所有可用的工具能力(category/power/enabled) 和已安装技能。用于 agent 了解自己能干啥。",
    parameters: { type: "object", properties: { kind: { type: "string", enum: ["tool", "skill", "all"], description: "all=工具+技能(默认)" } }, required: [] },
    category: "selfmod",
    power: "agent",
    idempotent: true,
    execute: async (args, ctx) => {
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
        // 有 agent 时读它的 loader (含用户停用清单); 无 ctx 的直调回落到本模块实例
        const ldr = ctx?.agent?.skills || loader;
        for (const s of ldr.list()) {
          lines.push(`${s.id}: ${s.name} — ${s.description}`);
        }
      }
      return lines.join("\n");
    },
  });

  // 2. 取单个工具的完整参数定义 (2026-10-30, 按需工具模式的配套件)
  // 背景: 收窄 agent.tool_exposure 后, 长尾工具的 schema 不再随请求下发, 只在 system prompt
  //   留名字。模型需要它时得有一条**明确的路**把 schema 取回来 —— 否则按需模式等于"名字可见、
  //   参数全靠猜", 比全量下发更糟。本工具就是那条路: 名字 → JSON Schema。
  // 全量曝光模式下它同样可用 (行为不变, 只是没人需要叫它)。
  catalog.register({
    name: "tool_schema",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "取工具完整参数定义 (JSON Schema)。【按需工具】名单里的工具先取参数再调, 不要凭猜; name 可逗号分隔多个。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "工具名, 可逗号分隔多个 (如 read_file,apply_patch)" },
      },
      required: ["name"],
    },
    category: "selfmod",
    power: "agent",
    idempotent: true,
    execute: async (args) => {
      const names = String(args?.name || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 10);
      if (!names.length) return capErr("tool_schema", "需要 name (工具名, 可用 list_capabilities 枚举)");
      const out = [];
      for (const n of names) {
        const m = catalog.metaOf(n);
        if (!m) {
          out.push(`# ${n}\n[未知工具] 用 list_capabilities 枚举可用工具名。`);
          continue;
        }
        out.push([
          `# ${m.name} (${m.category}/${m.power}${m.enabled === false ? ", 当前已禁用" : ""})`,
          m.description || "(无描述)",
          "参数定义:",
          JSON.stringify(m.parameters || { type: "object", properties: {} }, null, 2),
        ].join("\n"));
      }
      // 按需模式: 取过 schema 的工具从下一轮起回到函数数组 (2026-11-02)。
      // 否则模型每轮都得"先取 schema 再凭记忆拼参数", 同一工具反复取 = 白付 token 还更容易错。
      try {
        const added = typeof catalog.expose === "function" ? catalog.expose(names) : [];
        if (added.length) out.push(`[已加入后续轮次工具列表] ${added.join(", ")} —— 下一轮可直接调用, 无需重复取 schema。`);
      } catch { /* 曝光失败不影响本次返回 schema */ }
      return out.join("\n\n");
    },
  });

  // 3. 启用能力
  catalog.register({
    name: "enable_capability",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "system" },
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
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "system" },
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
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "system" },
    description: "读取一个已安装技能的 SKILL.md 全文, 供 agent 按需加载使用。id 为技能名。",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    category: "selfmod",
    power: "user",
    idempotent: true,
    execute: async (args, ctx) => {
      const ldr = ctx?.agent?.skills || loader;
      // 2026-11-13 (评测 P2-1): 接受 id 或唯一 slug/叶子名 (如 webapp-testing)
      const resolved = (ldr && typeof ldr.resolveId === "function" && ldr.resolveId(args.id)) || args.id;
      // 已停用技能与"不存在"要分开报: 前者用户在管理页关掉了, 后者才是真没有。
      //   loader.read 对停用技能返回 null (与未知同形), 这里先按 agent 的权威清单判一次。
      if (typeof ldr.isDisabled === "function" && (ldr.isDisabled(resolved) || ldr.isDisabled(args.id))) {
        return capErr("load_skill", `技能已停用: ${args.id} (可在 Web 管理页重新启用)`);
      }
      const content = ldr.read(resolved);
      if (content === null) {
        // 2026-11-14 (评测 P2-1): 只报"未知技能"会让模型拿同一 id 盲目重试 (实测 5 连败:
        //   Word×2 / webapp-testing×3)。报错里附上可用清单, 让模型一步自纠, 不再撞墙。
        let hint = "";
        try {
          const ids = (typeof ldr.list === "function" ? ldr.list() : [])
            .map((s) => String(s && s.id ? s.id : s)).filter(Boolean).slice(0, 20);
          if (ids.length) hint = `。可用技能: ${ids.join(", ")}${ids.length >= 20 ? " …" : ""}`;
        } catch { /* 清单取不到就保持原报错 */ }
        return capErr("load_skill", `未知技能: ${args.id}${hint}`);
      }

      if (ldr && typeof ldr.trackUse === "function") { try { ldr.trackUse(resolved); } catch {} }
      // 技能正文里的相对路径 (scripts/xxx.py) 是相对 SKILL.md 所在目录, 而 run_command 的
      //   工作目录是项目根 —— 只回正文, 模型会照抄 `python scripts/xxx.py`, 拿到
      //   "can't open file" 后转头用 write_file 硬写 .docx/.xlsx, 产出打不开的坏文件。
      //   这里把绝对目录一并给出, 让"加载技能 → 调脚本"这条链一次走通。
      let dirHint = "";
      try {
        const meta = typeof ldr.get === "function" ? ldr.get(resolved) : null;
        if (meta && meta.file) {
          dirHint = `> 技能目录: ${path.dirname(meta.file)}\n`
            + `> 正文中的相对路径 (如 scripts/xxx.py) 相对此目录; run_command 的工作目录是项目根, `
            + `请拼绝对路径调用。\n\n`;
        }
      } catch { /* 取不到路径不影响正文返回 */ }
      return `# ${resolved}\n\n${dirHint}${content}`;
    },
  });

  // 4.5 技能检索 (蓝皮书 2026: 发现机制是技能生态的瓶颈 — 给 agent 一个检索入口)
  catalog.register({
    name: "skill_search",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "按关键词检索已安装技能, 对 name/description 打分排序返回。面对任务不确定用哪个技能时先用它发现, 再用 load_skill 读取全文。",
    parameters: { type: "object", properties: { query: { type: "string", description: "关键词 (中英文均可)" } }, required: ["query"] },
    category: "selfmod",
    power: "user",
    idempotent: true,
    execute: async (args, ctx) => {
      const q = String(args.query || "").trim();
      if (!q) return capErr("skill_search", "需要 query 关键词");
      if (!loader) return capErr("skill_search", "技能目录未装配");
      const results = scoreSkills(ctx?.agent?.skills || loader, q).slice(0, 8);
      return JSON.stringify({ query: q, count: results.length, results });
    },
  });

  // 5. 创建新技能 (L5 auto-skill: 复杂任务后沉淀为可复用 Skill)
  catalog.register({
    name: "create_skill",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    description: "把一次成功的方法/流程沉淀为可复用的 Agent Skill。name=技能名(字母数字横线), description=一句话说明, content=SKILL.md 正文 (建议含 流程/反合理化/验证 三段)。写进 skills/ 目录后自动被 loader 发现。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名, 仅字母/数字/横线" },
        description: { type: "string", description: "技能一句话说明" },
        content: { type: "string", description: "SKILL.md 正文" },
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
      // 2026-10-31 (队列⑥): 落盘到可写根 (项目 .ppx/skills 优先, 用户级 ~/.ppx/skills 兜底) ——
      //   此前写死 <root>/skills (内置根): npm 装机时位于 node_modules, 升级替换包目录即冲掉用户产物;
      //   且项目里放同 id 技能本是有意覆盖, 写进被压死的内置根等于白写。
      if (!destDir) return capErr("create_skill", "无可写技能根 (全部技能源只读)");
      fs.mkdirSync(destDir, { recursive: true });
      const dir = path.join(destDir, name);
      fs.mkdirSync(dir, { recursive: true });
      const frontmatter = "---" + "\n" + "name: " + name + "\n" + "description: " + desc + "\n" + "---" + "\n" + "\n";
      fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter + content, "utf8");
      return "已创建技能: " + name + " (" + path.basename(destDir) + "/" + name + "/SKILL.md)";
    },
  });

  // 6b. 自我进化: 从失败轨迹自动提炼经验 (refine 的上半场, 补齐「失败→经验」闭环)
  catalog.register({
    name: "refine",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
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
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
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
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
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
