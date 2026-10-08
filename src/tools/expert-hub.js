// src/tools/expert-hub.js - 专家库 / 人格 / 市场 工具 (2026-10-07 吸收自 TencentCloud/Octop)
//
//   expert_pack_list     专家库名册 (按域/分类/来源过滤) + 市场分类计数
//   expert_pack_show     看一个专家包的完整信息 (元数据 + 渲染后的 persona + 快速提示词)
//   expert_pack_install  从本地目录安装专家包到用户库 (外部不可信内容 → 全套安全校验)
//   persona_list         16 型人格名册
//   persona_preview      预览某人格渲染出来的 system 块
//
// 与 `expert_list`(已有) 的分工: expert_list 列的是**代码里内置的 EXPERTS 名册**,
// 本组工具列的是**磁盘上的专家包**。两者互补 —— 前者稳定、后者可增长可分发。

import { ExpertPackCatalog, PACK_CATEGORIES, PACK_LIMITS, installPack, userExpertsDir, KNOWN_DOMAINS } from "../orchestrator/expert-pack.js";
import { listProfiles, renderPersona, getProfile, dimensionsOf, BEHAVIOR_KEYS, PERSONA_CODES } from "../orchestrator/personas.js";

export function registerExpertHubTools(catalog, { getAgent = () => null, getPackCatalog = () => null } = {}) {
  const agentOf = (ctx) => (ctx && ctx.agent) || getAgent();
  const packsOf = (ctx) => {
    const viaGetter = getPackCatalog();
    if (viaGetter) return viaGetter;
    const a = agentOf(ctx);
    return a?.expertPacks || new ExpertPackCatalog({ roots: [] });
  };

  // ---- 1. 专家库名册 + 市场 ----
  catalog.register({
    name: "expert_pack_list",
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    category: "orchestration",
    power: "user",
    idempotent: true,
    description: "列出磁盘上的专家包 (专家库/市场): id / 名称 / 能力域 / 市场分类 / 是否只读 / 是否需人工复核。与 expert_list (代码内置名册) 互补。可按 domain / category / 关键词过滤。",
    parameters: {
      type: "object",
      properties: {
        domain: { type: "string", description: "按能力域过滤" },
        category: { type: "string", description: `按市场分类过滤 (${PACK_CATEGORIES.map((c) => c.id).join(" / ")})` },
        source: { type: "string", description: "按来源过滤: builtin / user / project / extra" },
        q: { type: "string", description: "关键词 (匹配 id/名称/描述/域)" },
        market: { type: "boolean", description: "true 时只输出市场分类计数总览" },
      },
      required: [],
    },
    execute: async (args, ctx) => {
      const cat = packsOf(ctx);
      if (args.market === true) {
        const m = cat.market();
        const lines = [`专家库: ${m.total} 个包`];
        for (const c of m.categories) lines.push(`  ${c.count ? "●" : "○"} ${c.name} (${c.id}): ${c.count}${c.count ? " — " + c.experts.join(", ") : ""}`);
        lines.push(`来源: ${m.sources.map((s) => `${s.id}${s.exists ? "" : "(不存在)"} ${s.dir}`).join(" | ")}`);
        if (m.problems.length) lines.push(`⚠ ${m.problems.length} 个目录未通过校验: ${m.problems.map((p) => `${p.id}(${p.reason})`).join("; ")}`);
        return lines.join("\n");
      }
      const list = cat.list({ domain: args.domain || null, category: args.category || null, source: args.source || null, q: args.q || null });
      if (!list.length) {
        const m = cat.market();
        return `(无匹配专家包。当前库内 ${m.total} 个; 可用域: ${[...KNOWN_DOMAINS].join(", ")})`;
      }
      const lines = [`专家包 ${list.length} 个:`];
      for (const p of list) {
        const flags = [p.readonly ? "只读" : null, p.requiresHuman ? "需人工复核" : null, p.personaMbti || null].filter(Boolean).join(", ");
        lines.push(`- ${p.id} — ${p.label} [${p.domain}/${p.category}${flags ? ", " + flags : ""}]`);
        lines.push(`    ${p.description.slice(0, 110)}`);
        if (p.skills.length) lines.push(`    绑定技能: ${p.skills.join(", ")}`);
      }
      return lines.join("\n");
    },
  });

  // ---- 2. 看一个包 ----
  catalog.register({
    name: "expert_pack_show",
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    category: "orchestration",
    power: "user",
    idempotent: true,
    description: "看一个专家包的完整信息: 元数据、绑定技能、快速提示词、以及渲染后的角色人格块 (SOUL + 可选的 MBTI 骨架)。可用来预览\"把这个专家拉起来会是什么样\"。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "专家包 id (也接受中文名模糊匹配)" },
        persona_only: { type: "boolean", description: "只输出渲染后的角色人格块" },
        with_agents: { type: "boolean", description: "是否附上 AGENTS.md 作业准则 (默认 true)" },
      },
      required: ["id"],
    },
    execute: async (args, ctx) => {
      const cat = packsOf(ctx);
      const p = cat.resolve(args.id);
      if (!p) return `[工具错误] expert_pack_show: 未找到专家包 ${args.id}`;
      const a = agentOf(ctx);
      const persona = cat.personaOf(p.id, {
        agentName: a?.config?.agent?.name || "皮皮虾",
        userDisplay: a?.userName || "兄弟",
        withAgents: args.with_agents !== false,
      });
      if (args.persona_only === true) return persona || "(无内容)";
      const lines = [
        `# ${p.label} (${p.id}) v${p.version}`,
        `能力域: ${p.domain} · 市场分类: ${p.category} · 来源: ${p.source}`,
        `约束: ${p.readonly ? "只读" : "可写"}${p.requiresHuman ? " · 需人类复核" : ""}${p.personaMbti ? ` · 推荐人格 ${p.personaMbti}(${getProfile(p.personaMbti).name_zh})` : ""}`,
        p.welcome ? `开场白: ${p.welcome}` : "",
        p.skills.length ? `绑定技能: ${p.skills.join(", ")}` : "",
        p.quickPrompts.length ? `快速提示词:\n${p.quickPrompts.map((q) => `  - ${q.title}: ${q.prompt.slice(0, 90)}`).join("\n")}` : "",
        p.taskExamples.length ? `示例任务: ${p.taskExamples.join(" / ")}` : "",
        "",
        `## 渲染后的角色人格块`,
        persona || "(无)",
      ];
      return lines.filter((x) => x !== "").join("\n");
    },
  });

  // ---- 3. 安装专家包 ----
  catalog.register({
    name: "expert_pack_install",
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "workspace" },
    category: "orchestration",
    power: "agent",
    description: `把一个本地目录安装为专家包 (需含 manifest.json, 可选 SOUL.md/AGENTS.md)。落点到用户专家库, 不改内置库。安全限制: 只收文本类文件 (md/json/txt/yaml/csv/jsonl), 单文件 ${Math.round(PACK_LIMITS.maxFileBytes / 1024)}KB / 单包 ${Math.round(PACK_LIMITS.maxPackBytes / 1024 / 1024)}MB / 最多 ${PACK_LIMITS.maxFiles} 个文件上限; id 与路径双白名单校验。`,
    parameters: {
      type: "object",
      properties: {
        src_dir: { type: "string", description: "源目录绝对路径 (含 manifest.json)" },
        force: { type: "boolean", description: "目标已存在时覆盖 (默认 false 拒绝)" },
      },
      required: ["src_dir"],
    },
    execute: async (args, ctx) => {
      const a = agentOf(ctx);
      const dest = a?.config?.experts?.user_dir || userExpertsDir();
      const r = installPack(String(args.src_dir || ""), { destRoot: dest, force: args.force === true });
      if (!r.ok) return `[工具错误] expert_pack_install: ${r.reason}`;
      const cat = packsOf(ctx);
      if (cat && typeof cat.invalidate === "function") cat.invalidate();
      return `已安装专家包: ${r.id} (${r.label || r.id})\n落点: ${r.dir}\n文件 ${r.files.length} 个, ${Math.round(r.bytes / 1024)}KB\n${r.files.join(", ")}`;
    },
  });

  // ---- 4. 人格名册 ----
  catalog.register({
    name: "persona_list",
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    category: "orchestration",
    power: "user",
    idempotent: true,
    description: "列出 16 型人格模板 (含默认人格)。人格与专家正交: 专家决定干什么, 人格决定怎么说话。",
    parameters: {
      type: "object",
      properties: { code: { type: "string", description: "给定时输出该型的完整档案 (四轴 + 六项行为)" } },
      required: [],
    },
    execute: async (args) => {
      if (args.code) {
        const p = getProfile(args.code);
        if (!p) return `[工具错误] persona_list: 未知人格码 ${args.code}`;
        const dims = dimensionsOf(p.code).map((d) => `${d.label}=${d.poleLabel}(${d.pole} ${d.strength}%)`).join(" ");
        return [
          `${p.code} ${p.name_zh} (${p.name_en})${p.nickname_zh ? ` · ${p.nickname_zh}` : ""}`,
          p.summary_zh,
          `四轴: ${dims || "(默认人格无四轴)"}`,
          `关键词: ${(p.descriptors_zh || []).join(" / ")}`,
          "六项行为:",
          ...BEHAVIOR_KEYS.filter((k) => p.behavior?.[k]).map((k) => `  - ${k}: ${p.behavior[k]}`),
        ].join("\n");
      }
      const lines = [`可用人格 ${PERSONA_CODES.length} 种 (16 型 + default):`];
      for (const p of listProfiles({ includeDefault: true })) {
        lines.push(`- ${p.code} ${p.name_zh}: ${p.summary_zh}`);
      }
      return lines.join("\n");
    },
  });

  // ---- 5. 人格预览 ----
  catalog.register({
    name: "persona_preview",
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    category: "orchestration",
    power: "user",
    idempotent: true,
    description: "预览某个人格渲染出来的 system 块 (含四轴、行为约定、用户补充)。custom 参数即\"修剪\": 它追加在骨架之后, 不覆盖骨架。",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "人格码 (如 INTJ); 未知码回落默认人格" },
        custom: { type: "string", description: "用户自定义补充 (追加在骨架后)" },
      },
      required: ["code"],
    },
    execute: async (args, ctx) => {
      const a = agentOf(ctx);
      return renderPersona(args.code, {
        agentName: a?.config?.agent?.name || "皮皮虾",
        userDisplay: a?.userName || "兄弟",
        custom: args.custom || "",
      });
    },
  });

  return catalog;
}

export default { registerExpertHubTools };
