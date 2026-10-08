// src/tools/selfmod.js - Self-modification 工具
// 参考 deepseek-harness 的 self-modification: agent 能检查/挂载/卸载自己的运行时能力
// 这里落地为"能力级自修改": 枚举能力(工具+技能) / 启用 / 禁用 / 加载技能, 不破坏零依赖内核
import { SkillLoader } from "../skills/loader.js";
import { scoreSkills } from "../skills/search.js";
import fs from "node:fs";
import path from "node:path";
import { debug } from "../utils/logger.js";

function capErr(name, msg) {
  return `[工具错误] ${name}: ${msg}`;
}

// skillsRoot: 新技能落盘根 (create_skill / refine_skill 写这里)
// loader:     可选的**读取**加载器 (多源技能库 v2: 内置 + 用户 + 附加目录)。
//             不传则退化为只读 skillsRoot 的单根加载器 (老测试与老调用方零差异)。
// 读与写刻意分开: 内置技能是只读资产 (升级包会覆盖), 用户新建的技能必须落到可写根,
//   否则下次升级内置库时用户的沉淀会被一起冲掉。
export function registerSelfmodTools(catalog, { skillsDir, loader = null }) {
  const readLoader = loader || new SkillLoader(skillsDir);

  // 1. 枚举全部能力: 工具 + 技能
  catalog.register({
    name: "list_capabilities",
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
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
          const dep = t.deprecated ? ` 【已弃用${t.deprecated.replacedBy ? `→${t.deprecated.replacedBy}` : ""}】` : "";
          lines.push(`[${t.enabled ? "ON" : "OFF"}] ${t.name} (${t.category}/${t.power})${t.timeoutMs ? ` 超时${t.timeoutMs}ms` : ""}${dep}`);
        }
        // 弃用清单单独成段: 混在 85 行工具列表里没人看得见, 而它恰恰是"该迁移了"的唯一信号
        const dep = catalog.deprecatedTools ? catalog.deprecatedTools() : [];
        if (dep.length) {
          lines.push("— 已弃用工具 (请迁移) —");
          for (const d of dep) lines.push(`${d.name}${d.replacedBy ? ` → ${d.replacedBy}` : ""}${d.since ? ` (自 ${d.since})` : ""}${d.note ? ` — ${d.note}` : ""}`);
        }
      }
      if (kind === "all" || kind === "skill") {
        lines.push("— 技能 —");
        for (const s of readLoader.list()) {
          lines.push(`${s.id}: ${s.name} — ${s.description}`);
        }
      }
      return lines.join("\n");
    },
  });

  // 2. 启用能力 (+ 按需披露: 让该工具的 schema 进入下一轮 LLM 请求)
  catalog.register({
    name: "enable_capability",
    // F1: 改的是自己的运行时 (enabled + 披露集) —— 权限/能力变更类, 绝不能算只读。
    // 定 medium 而非 high 的取舍: 动态披露是【按需工具】机制的承重墙 (agent 先看到功能摘要,
    // 启用后才有 schema), 定 high 会让默认模式下每次"想用某工具"都要人点头, 等于关掉该特性。
    // 收紧面落在 plan / 只读巡检: 两者都拒绝或升级审批; 真正确需放权的高危工具本身另有 high 档。
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "selfmod" },
    description: "启用并加载一个工具能力 (name 为工具名)。用于加载未默认携带的工具 —— 它们的功能已在【按需工具】清单里列出, 但完整参数说明需要先启用才能调用。",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    category: "selfmod",
    power: "agent",
    execute: async (args) => {
      if (!catalog.enable(args.name)) return capErr("enable_capability", `未知工具: ${args.name}`);
      catalog.expose(args.name); // 披露给 LLM: 下一轮请求即可见其参数 schema
      return `已启用: ${args.name}`;
    },
  });

  // 3. 禁用能力
  catalog.register({
    name: "disable_capability",
    // 同 enable_capability: 运行时能力状态变更 (方向是收紧, 但 plan 模式仍不该改装配状态)
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "selfmod" },
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
    // 读 SKILL.md 全文, 但 loader.trackUse() 会落使用计数 (写盘) → 严格说非只读;
    // 风险量级仍是"读", 故 low + 非只读 (plan 模式不接受加载新能力, 默认模式静默放行)
    capability: { riskLevel: "low", readOnly: false, destructive: false, sideEffect: "workspace" },
    description: "读取一个已安装技能的 SKILL.md 全文, 供 agent 按需加载使用。id 为技能名 (支持领域前缀, 如 office/docx-report)。",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    category: "selfmod",
    power: "user",
    idempotent: true,
    execute: async (args) => {
      const content = readLoader.read(args.id);
      if (content === null) return capErr("load_skill", `未知技能: ${args.id}`);
      
      if (readLoader && typeof readLoader.trackUse === "function") { try { readLoader.trackUse(args.id); } catch (e) { debug(`[tools/selfmod] 已忽略异常: ${e && e.message ? e.message : e}`); } }
      return `# ${args.id}\n\n${content}`;
    },
  });

  // 4.5 技能检索 (蓝皮书 2026: 发现机制是技能生态的瓶颈 — 给 agent 一个检索入口)
  catalog.register({
    name: "skill_search",
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    description: "按关键词检索已安装技能, 对 name/description 打分排序返回。面对任务不确定用哪个技能时先用它发现, 再用 load_skill 读取全文。",
    parameters: { type: "object", properties: { query: { type: "string", description: "关键词 (中英文均可)" } }, required: ["query"] },
    category: "selfmod",
    power: "user",
    idempotent: true,
    execute: async (args) => {
      const q = String(args.query || "").trim();
      if (!q) return capErr("skill_search", "需要 query 关键词");
      if (!readLoader) return capErr("skill_search", "技能目录未装配");
      const results = scoreSkills(readLoader, q).slice(0, 8);
      return JSON.stringify({ query: q, count: results.length, results });
    },
  });

  // 5. 创建新技能 (L5 auto-skill: 复杂任务后沉淀为可复用 Skill)
  catalog.register({
    name: "create_skill",
    // 往 skills/ 写 SKILL.md = 给自己加装新能力 (持久自修改), 不是只读 (旧兜底曾放行)。
    // medium 而非 high: L5 沉淀闭环 (refine_skill 同源产物) 是既有产品行为, 收紧点放在
    // plan / 只读巡检; 文件落点由 name 正则 + 长度上限约束, 不可撤销性低于删除类工具。
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "selfmod" },
    description: "把一次成功的方法/流程沉淀为可复用的 Agent Skill。name=技能名(字母数字横线), description=一句话说明, content=SKILL.md 正文。正文推荐含三个段落(参考 addyosmani/agent-skills): ①「## 流程」逐步工作流+检查点 ②「## 反合理化」常见偷懒借口+反驳 ③「## 验证」完成后必须提供的证据。写进 skills/ 目录后自动被 loader 发现。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名, 支持 领域/名称 形式 (如 data/my-method); 仅字母/数字/横线与单个斜线" },
        description: { type: "string", description: "技能一句话说明" },
        content: { type: "string", description: "SKILL.md 正文 (建议含: 流程/反合理化/验证 三段)" },
      },
      required: ["name", "description", "content"],
    },
    category: "selfmod",
    power: "agent",
    execute: async (args) => {
      const name = String(args.name || "").trim();
      // 2026-10-07: 允许一个领域前缀 (data/my-method) —— 技能库 v2 是领域二级目录结构;
      // 但不允许多级/空段/穿越: 目录深度与范围都必须可控。
      if (!/^[a-zA-Z0-9-]+(\/[a-zA-Z0-9-]+)?$/.test(name)) return "[工具错误] create_skill: 技能名仅允许字母/数字/横线, 可带一个领域前缀 (如 data/my-method): " + name;
      const desc = String(args.description || "").trim();
      const content = String(args.content || "").trim();
      if (!desc || !content) return "[工具错误] create_skill: 需 description + content";
      // v1.0.8: 长度上限, 防写超大文件/垃圾内容
      if (desc.length > 300) return "[工具错误] create_skill: description 超长 (最大 300 字符)";
      if (content.length > 50000) return "[工具错误] create_skill: content 超长 (最大 50000 字符)";
      const dir = path.join(skillsDir, name);
      // 落点必须留在可写技能根内 (name 正则已挡 ../, 这里再核一次路径 —— 双保险)
      const rootAbs = path.resolve(skillsDir).toLowerCase();
      if (!path.resolve(dir).toLowerCase().startsWith(rootAbs)) {
        return "[工具错误] create_skill: 落点越出技能库目录";
      }
      fs.mkdirSync(dir, { recursive: true });
      const leaf = name.includes("/") ? name.split("/").pop() : name;
      const domain = name.includes("/") ? name.split("/")[0] : "";
      const frontmatter = "---" + "\n" + "name: " + leaf + "\n" + "description: " + desc + "\n"
        + (domain ? "domain: " + domain + "\n" : "") + "---" + "\n" + "\n";
      fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter + content, "utf8");
      return "已创建技能: " + name + " (" + path.relative(process.cwd(), dir).replace(/\\/g, "/") + "/SKILL.md)";
    },
  });

  // 6b. 自我进化: 从失败轨迹自动提炼经验 (refine 的上半场, 补齐「失败→经验」闭环)
  catalog.register({
    name: "refine",
    // 从失败轨迹提炼经验并写经验库 (持久状态变更 + LLM 调用) → 非只读
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "memory" },
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
    // 自动生成并写入 skills/<name>/SKILL.md (与 create_skill 同族的持久自修改) → 非只读
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "selfmod" },
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
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
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
