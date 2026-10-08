// src/tools/skill-hub.js - 技能库自省与扩展工具 (2026-10-07 内置技能层 v2)
//
//   skill_coverage  领域覆盖率自述 (哪个能力域有几个技能 / 缺口在哪)
//   skill_domains   十二个能力域的域目录
//   skill_import    从 GitHub 导入通用 Agent Skill 包 (零依赖, 落成 <domain>/<skill> 布局)
//
// skill_import 的安全定位: 导入的是**外部不可信文本**, 因此
//   - 只接 github.com / raw.githubusercontent.com (防 SSRF)
//   - 单文件/单技能/文件数三重上限, 只抓文本类附随文件
//   - 只写文件, 绝不执行导入内容
// 风险等级 medium (写工作区 + 出网), 非只读。

import { importSkills, parseRepoRef, fetchSkillPaths, inferDomain, upstreamSources, resolveUpstream, IMPORT_LIMITS } from "../skills/importer.js";
import { SKILL_DOMAINS } from "../skills/registry.js";

export function registerSkillHubTools(catalog, { getAgent = () => null, skillsRoot = null } = {}) {
  const agentOf = (ctx) => (ctx && ctx.agent) || getAgent();
  const registryOf = (ctx) => {
    const a = agentOf(ctx);
    return a?.skillRegistry || null;
  };

  // ---- 1. 领域覆盖率 ----
  catalog.register({
    name: "skill_coverage",
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    category: "selfmod",
    power: "agent",
    idempotent: true,
    description: "技能库能力域覆盖率自述: 十二个能力域各有几个技能、缺口在哪、技能来自哪个源 (内置/用户/附加)。用于判断自己哪块能力薄。",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async (args, ctx) => {
      const reg = registryOf(ctx);
      if (!reg) return "[工具错误] skill_coverage: 技能注册表未装配";
      const cov = reg.coverage();
      const lines = [`技能总数 ${cov.total} · 域覆盖 ${cov.coveredDomains}/${cov.domainCount} (${(cov.coverage * 100).toFixed(0)}%)`];
      for (const d of cov.domains) {
        lines.push(`${d.covered ? "✓" : "✗"} ${d.name} (${d.id}): ${d.count} 个${d.uses ? `, 累计使用 ${d.uses} 次` : ""}${d.covered ? "" : "  ← 缺口"}`);
        if (d.count) lines.push(`    ${d.skills.join(", ")}`);
      }
      if (cov.uncovered.length) lines.push(`未覆盖域: ${cov.uncovered.join(", ")}`);
      if (cov.unregistered?.length) {
        lines.push(`未登记域名的技能 (建议补 domain): ${cov.unregistered.map((u) => `${u.id}(${u.count})`).join(", ")}`);
      }
      lines.push(`技能源: ${cov.sources.map((s) => `${s.id}${s.exists ? "" : "(不存在)"} ${s.dir}`).join(" | ")}`);
      return lines.join("\n");
    },
  });

  // ---- 2. 域目录 ----
  catalog.register({
    name: "skill_domains",
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    category: "selfmod",
    power: "user",
    idempotent: true,
    description: "列出十二个能力域目录 (id / 名称 / 用途)。技能目录结构与领域分类以此为准。",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => SKILL_DOMAINS.map((d) => `${d.id} — ${d.name}: ${d.desc}`).join("\n"),
  });

  // ---- 3. GitHub 技能导入 ----
  catalog.register({
    name: "skill_import",
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "workspace+network" },
    category: "selfmod",
    power: "agent",
    description: "从 GitHub 导入通用 Agent Skill 包 (SKILL.md 目录式) 到本地技能库, 自动补充 domain 归类到 <域>/<技能>/。三种用法: ① repo=owner/repo (含 #branch 与完整 GitHub 地址) ② from=可信源 id 或已知技能名 (如 anthropics / pdf), 来源见内置白名单 ③ 两个都不给 = 列出可装的上游源。导入只写文件、不执行内容; 单文件 512KB/单技能 4MB/最多 40 个附随文件上限。dry_run=true 可先预览会导入哪些。",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "仓库引用, 如 anthropics/skills 或 https://github.com/obra/superpowers" },
        from: { type: "string", description: "可信上游源 id 或技能名 (如 anthropics / pdf); 与 repo 二选一" },
        skills: { type: "array", items: { type: "string" }, description: "只导入这些技能名 (默认全部)" },
        domain: { type: "string", description: "强制领域 (默认按技能名/描述自动推断)" },
        with_assets: { type: "boolean", description: "是否连同 references/scripts 等文本类附随文件一起导入 (默认 true)" },
        dry_run: { type: "boolean", description: "只列出将要导入的技能, 不写盘" },
        token: { type: "string", description: "GitHub token (可选, 提升速率上限)" },
      },
      required: [],
    },
    execute: async (args, ctx) => {
      const reg = registryOf(ctx);
      const dest = reg?.loader?.writeDir || skillsRoot;
      if (!dest) return "[工具错误] skill_import: 技能库写入目录不可用";

      // ③ 什么都没给 → 列出可装来源 (这就是"市场"的离线版: 不做在线搜索, 只列验证过的源)
      if (!args.repo && !args.from) {
        const { sources, known_skills } = upstreamSources();
        if (!sources.length) return "内置上游源清单不可用 (skills/upstream-sources.json 缺失或损坏)。仍可直接给 repo=owner/repo 导入。";
        const rows = sources.map((s) => `  ${s.id.padEnd(12)} ${s.repo.padEnd(28)} ${String(s.license).padEnd(12)} 已内置${s.imported || 0} 个${s.verified ? "" : "  [未验证]"} — ${s.note || ""}`);
        const names = Object.keys(known_skills);
        return [
          `可导入的上游技能源 (${sources.length} 个, 离线白名单 — 不做在线搜索, 只列手工验证过的):`,
          ...rows,
          "",
          `已知可直接点名的技能 (${names.length} 个): ${names.join(", ")}`,
          "",
          "用法: skill_import { from: \"anthropics\", dry_run: true } 先看清单, 再去掉 dry_run 真正导入。",
        ].join("\n");
      }

      // ② from → 白名单解析成 repo (解析不到就明确报错, 绝不拿用户输入去猜仓库)
      let repoRef = args.repo;
      let skillFilter = Array.isArray(args.skills) ? args.skills : null;
      if (!repoRef && args.from) {
        const hit = resolveUpstream(args.from);
        if (!hit) {
          const { sources } = upstreamSources();
          return `[工具错误] skill_import: 上游源/技能名 "${args.from}" 不在内置白名单里。可用源: ${sources.map((s) => s.id).join(", ") || "(无)"}。若确需导入其它仓库, 请显式给 repo=owner/repo。`;
        }
        repoRef = hit.repo;
        if (hit.skills && !skillFilter) skillFilter = hit.skills;
      }
      let ref;
      try { ref = parseRepoRef(repoRef); } catch (e) { return `[工具错误] skill_import: ${e.message}`; }
      try {
        // dry_run 先走轻量探测, 让用户看清会动哪些东西
        if (args.dry_run === true) {
          const { branch, paths } = await fetchSkillPaths({ ...ref, token: args.token || null });
          const rows = paths.map((p) => {
            const dir = p.split("/").slice(0, -1).join("/");
            const leaf = dir.split("/").pop();
            return `  ${inferDomain(dir, leaf)}/${leaf}  ← ${p}`;
          });
          return `[干跑] ${ref.owner}/${ref.repo}@${branch}: 发现 ${paths.length} 个技能\n${rows.join("\n")}\n\n落点: ${dest}\n(去掉 dry_run 即真正导入)`;
        }
        const rep = await importSkills({
          ref: args.repo,
          dest,
          skills: skillFilter,
          domain: args.domain || null,
          withAssets: args.with_assets !== false,
          token: args.token || null,
        });
        const head = `已从 ${rep.repo}@${rep.branch} 导入 ${rep.imported.length} 个技能${rep.truncated ? " (仓库树被 GitHub 截断, 仅处理了返回部分)" : ""}`;
        const rows = rep.imported.map((i) => `  ✓ ${i.id} (${i.files.length} 个文件, ${Math.round(i.bytes / 1024)}KB)`);
        const fails = rep.failed.map((f) => `  ✗ ${f.path}: ${f.error}`);
        return [head, ...rows, ...(fails.length ? ["失败:", ...fails] : [])].join("\n");
      } catch (e) {
        return `[工具错误] skill_import: ${e.message}`;
      }
    },
  });

  return catalog;
}

export { IMPORT_LIMITS };
export default { registerSkillHubTools };
