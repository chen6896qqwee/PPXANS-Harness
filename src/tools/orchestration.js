// src/tools/orchestration.js - 编排与自省工具 (2026-10-07 全能超级 Agent)
//
// 这一组工具回答的是"我现在是个什么样的 Agent、还能扩到多宽":
//   legion_status            军团 + 并发治理器实时视图 (谁在跑、排了多少、峰值多少)
//   legion_set_concurrency   运行期调整最大子智能体并发 (用户明确要的"并发数可调")
//   team_list / expert_list  班组与专家名册 (含只读/需人工标记)
//   capability_matrix        九维能力面 + 十二能力域的自述 (诚实报告缺口)
//   boundary_check           高风险域自检 (医疗/法律/金融/安全/合规 → 人类监督)
//
// 全部工具都显式声明 capability —— 见 test/capability-guard.test.js 的不变量。

import { getGovernor, governorOptsFromConfig } from "../orchestrator/governor.js";
import { listTeams, teamCatalog, teamRiskProfile, TEAMS } from "../orchestrator/teams.js";
import { listExperts, expertCatalog, EXPERTS, HIGH_RISK_DOMAINS } from "../orchestrator/experts.js";
import { assessBoundary, CAPABILITY_BOUNDARIES } from "../ans/boundary.js";

// 九维核心能力 → 本仓库的实际承载体 (用于 capability_matrix 的诚实自述)
export const CAPABILITY_AXES = [
  { id: "perceive", name: "感知", impl: "visionUserContent 多模态读图 / read_document / ocr_image / voice_transcribe (ASR)" },
  { id: "memory", name: "记忆", impl: "五层记忆 (L0 会话 / L1 原子 / L2 场景 / L3 画像 / L4 程序性) + WAL + 高斯衰减 + 遗忘回滚" },
  { id: "plan", name: "规划", impl: "plan / plan-exec 模式 + goal_board 目标台账 + DAG 拓扑编排 (orchestrator/dag.js)" },
  { id: "reason", name: "推理", impl: "DSML 原生文本工具协议 + 工具循环策略 (探索熔断/重复告警) + 可配置推理轮次" },
  { id: "tools", name: "工具调用", impl: "ToolCatalog 能力缝 (渐进披露 + deny-wins 策略链 + 熔断) + MCP 客户端/服务端" },
  { id: "act", name: "执行", impl: "run_command + 内置 JS 沙箱 (CodeAct) + apply_patch + 文档/表格/办公产出 + seam shell provider" },
  { id: "reflect", name: "反思", impl: "verify 交付前核验 + postcondition 后置检查 + review 循环 + refine/refine_skill 自进化" },
  { id: "collab", name: "协作", impl: "Legion 多进程军团 + 专家名册 + 班组拓扑 + supervisor 收敛 + 共享记忆板" },
  { id: "govern", name: "权限管理", impl: "SandboxPolicy 三档 + AskForApproval 四档 + 能力闸门 + 审批缓存 + 审计哈希链 + 能力边界护栏" },
];

export function registerOrchestrationTools(catalog, { getAgent = () => null } = {}) {
  const agentOf = (ctx) => (ctx && ctx.agent) || getAgent();

  // ---- 1. 军团与并发实时视图 ----
  catalog.register({
    name: "legion_status",
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    category: "orchestration",
    power: "agent",
    idempotent: true,
    description: "查看子智能体军团的实时状态: 当前存活进程、全局并发上限、正在跑几个、有多少在排队、历史峰值、排队超时次数。派发子 agent 前先看它, 避免派出超过并发上限的批量任务 (多余的只会排队)。",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async (args, ctx) => {
      const agent = agentOf(ctx);
      const L = agent?._legion;
      const gov = (L && L.governor) || getGovernor();
      const st = gov.stats();
      const lines = [
        `并发治理器: 上限 ${st.limit} / 在跑 ${st.running} / 空闲 ${st.idle} / 排队 ${st.waiting}(占 ${st.waitingSlots} 槽)`,
        `单次派发上限 ${st.perCallMax} · 历史峰值 ${st.peak} · 累计发放 ${st.acquired} · 归还 ${st.completed}`,
        `排队事件 ${st.queued} 次, 其中超时 ${st.timeouts} 次; 未纳管 spawn ${st.ungoverned} 次`,
        `排队超时阈值 ${st.queueTimeoutMs}ms`,
      ];
      if (L && typeof L.list === "function") {
        const agents = L.list();
        lines.push(`军团成员 ${agents.length} 个:`);
        for (const a of agents) lines.push(`  - ${a.name} (pid=${a.pid}${a.governed ? "" : ", 未纳管"}${a.sinceMs != null ? `, 存活 ${Math.round(a.sinceMs / 1000)}s` : ""})`);
        if (!agents.length) lines.push("  (空 — 尚无子 agent 存活, 委派后会出现)");
      } else {
        lines.push("军团成员: 本进程尚未创建军团 (尚未委派过子 agent)");
      }
      return lines.join("\n");
    },
  });

  // ---- 2. 运行期调整并发上限 ----
  catalog.register({
    name: "legion_set_concurrency",
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "config" },
    category: "orchestration",
    power: "agent",
    description: "运行期调整最大子智能体并发数 (不改配置文件, 立即生效并写回内存配置)。limit=全局同时存活的子 agent 进程数上限; per_call=单次派发宽度上限。收紧不会杀掉已在跑的进程, 只影响后续派发; 放宽会立刻放行排队中的请求。",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "全局并发上限 (1-256)" },
        per_call: { type: "number", description: "单次派发宽度上限 (1-256, 不大于 limit)" },
        queue_timeout_ms: { type: "number", description: "排队等槽位超时 (毫秒)" },
        persist: { type: "boolean", description: "是否同时写回 config/ppx.json (默认 false 仅改内存)" },
      },
      required: [],
    },
    execute: async (args, ctx) => {
      const agent = agentOf(ctx);
      const gov = (agent?._legion?.governor) || getGovernor();
      const before = gov.stats();
      if (args.limit === undefined && args.per_call === undefined && args.queue_timeout_ms === undefined) {
        return `[工具错误] legion_set_concurrency: 至少给一个参数 (limit / per_call / queue_timeout_ms)。当前: limit=${before.limit} per_call=${before.perCallMax}`;
      }
      gov.configure({ limit: args.limit, perCallMax: args.per_call, queueTimeoutMs: args.queue_timeout_ms });
      // 同步到内存配置, 让后续所有 Legion 实例 (含嵌套委派懒建的) 都用新值
      if (agent && agent.config) {
        agent.config.agent = agent.config.agent || {};
        agent.config.agent.legion = { ...(agent.config.agent.legion || {}) };
        if (args.limit !== undefined) agent.config.agent.legion.max_concurrent_agents = gov.limit;
        if (args.per_call !== undefined) agent.config.agent.legion.max_concurrent_per_call = gov.perCallMax;
        if (args.queue_timeout_ms !== undefined) agent.config.agent.legion.queue_timeout_ms = gov.queueTimeoutMs;
      }
      let persisted = "";
      if (args.persist === true && agent) {
        try {
          // 刻意不走 config/settings.js updateSettings: 那个入口按 SETTINGS_FIELDS 白名单过滤,
          // agent.legion 不在 Web 设置面板的可改字段里, 走它会被静默丢弃 (用户以为存了其实没存)。
          const { configFilePath, readPpxConfig, writeConfigAtomic } = await import("../utils/config-file.js");
          const { withFileLock } = await import("../utils/store.js");
          const p = configFilePath(agent.root);
          await withFileLock(p, () => {
            const cfg = readPpxConfig(agent.root, {});
            cfg.agent = cfg.agent || {};
            cfg.agent.legion = { ...(cfg.agent.legion || {}), ...(agent.config.agent.legion || {}) };
            writeConfigAtomic(agent.root, cfg);
          });
          persisted = " (已写回 config/ppx.json)";
        } catch (e) {
          persisted = ` (写盘失败, 仅内存生效: ${e.message})`;
        }
      }
      const after = gov.stats();
      return `并发已调整${persisted}: limit ${before.limit}→${after.limit}, per_call ${before.perCallMax}→${after.perCallMax}, 排队超时 ${before.queueTimeoutMs}→${after.queueTimeoutMs}ms (当前在跑 ${after.running}, 排队 ${after.waiting})`;
    },
  });

  // ---- 3. 班组名册 ----
  catalog.register({
    name: "team_list",
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    category: "orchestration",
    power: "user",
    idempotent: true,
    description: "列出预置专家班组 (每个班组 = 一组角色 + 一个协作拓扑 + 风险画像)。spawn_agent 的 team 参数可点名其中任一个。",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => {
      const rows = teamCatalog().map((t) => {
        const risk = teamRiskProfile(t.id);
        const flags = [
          risk.allReadonly ? "全员只读" : null,
          risk.requiresHuman ? `含高风险域(${risk.highRiskMembers.join("/")})` : null,
        ].filter(Boolean).join(", ");
        return `${t.id} — ${t.name} [拓扑 ${t.topology}, ${t.members.length} 人${flags ? ", " + flags : ""}]\n    ${t.desc}\n    成员: ${t.members.map((m) => m.name + (m.readonly ? "(只读)" : "") + (m.requiresHuman ? "(需人工)" : "")).join(" / ")}`;
      });
      return rows.join("\n");
    },
  });

  // ---- 4. 专家名册 ----
  catalog.register({
    name: "expert_list",
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    category: "orchestration",
    power: "user",
    idempotent: true,
    description: "列出全部专家角色 (含能力域、推荐技能、只读与需人工复核标记)。spawn_agent 的 expert / experts 参数可点名。",
    parameters: {
      type: "object",
      properties: { domain: { type: "string", description: "按能力域过滤 (如 code / office / medical)" } },
      required: [],
    },
    execute: async (args) => {
      const all = expertCatalog();
      const list = args.domain ? all.filter((e) => e.domain === args.domain) : all;
      if (!list.length) return `(无匹配专家; 可用域: ${[...new Set(all.map((e) => e.domain))].join(", ")})`;
      return list.map((e) => `${e.id} — ${e.name} [域 ${e.domain}${e.readonly ? ", 只读" : ""}${e.requiresHuman ? ", 需人工复核" : ""}]\n    ${e.perspective.slice(0, 120)}${e.skills.length ? `\n    推荐技能: ${e.skills.join(", ")}` : ""}`).join("\n");
    },
  });

  // ---- 5. 能力矩阵自述 ----
  catalog.register({
    name: "capability_matrix",
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    category: "orchestration",
    power: "agent",
    idempotent: true,
    description: "输出本 Agent 的能力矩阵自述: 九维核心能力 (感知/记忆/规划/推理/工具/执行/反思/协作/权限) 的实现位置 + 十二个能力域的技能覆盖情况 + 并发上限 + 能力边界。用于做能力盘点或向用户说明「我能干什么、哪里还有缺口」。",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async (args, ctx) => {
      const agent = agentOf(ctx);
      const gov = (agent?._legion?.governor) || getGovernor();
      const st = gov.stats();
      const lines = ["— 九维核心能力 —"];
      for (const a of CAPABILITY_AXES) lines.push(`${a.name}: ${a.impl}`);
      lines.push("", "— 能力域技能覆盖 —");
      const reg = agent?.skillRegistry;
      if (reg) {
        const cov = reg.coverage();
        lines.push(`技能总数 ${cov.total} · 域覆盖 ${cov.coveredDomains}/${cov.domainCount} (${(cov.coverage * 100).toFixed(0)}%)`);
        for (const d of cov.domains) lines.push(`  ${d.covered ? "✓" : "✗"} ${d.name}: ${d.count} 个${d.covered ? "" : "  ← 缺口"}`);
        if (cov.uncovered.length) lines.push(`  未覆盖域: ${cov.uncovered.join(", ")}`);
      } else {
        lines.push("(技能注册表未装配, 无法统计覆盖率)");
      }
      lines.push("", "— 协作与并发 —");
      lines.push(`专家 ${Object.keys(EXPERTS).length} 名 (含高风险域 ${Object.keys(EXPERTS).filter((k) => EXPERTS[k].requiresHuman).length} 名, 只读 ${Object.keys(EXPERTS).filter((k) => EXPERTS[k].readonly).length} 名)`);
      lines.push(`班组 ${Object.keys(TEAMS).length} 个`);
      lines.push(`子智能体并发: 上限 ${st.limit} / 单次派发 ${st.perCallMax} / 在跑 ${st.running} / 排队 ${st.waiting}`);
      lines.push("", "— 能力边界 —");
      const b = assessBoundary({ task: "", config: agent?.config });
      lines.push(`边界条款 ${CAPABILITY_BOUNDARIES.length} 条: ${CAPABILITY_BOUNDARIES.map((x) => x.title).join(" / ")}`);
      lines.push(`高风险域需人类监督: ${(agent?.config?.agent?.boundary?.high_risk_domains || HIGH_RISK_DOMAINS).join(", ")}`);
      return lines.join("\n");
    },
  });

  // ---- 6. 边界自检 ----
  catalog.register({
    name: "boundary_check",
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    category: "governance",
    power: "user",
    idempotent: true,
    description: "对一段任务描述做能力边界自检: 是否命中高风险领域 (医疗/法律/金融/安全/合规), 是否需要人类监督, 以及必须遵守的边界条款。涉及高风险领域的任务动手前先跑它。",
    parameters: {
      type: "object",
      properties: { task: { type: "string", description: "要检查的任务描述或即将给出的产出" } },
      required: ["task"],
    },
    execute: async (args, ctx) => {
      const agent = agentOf(ctx);
      const r = assessBoundary({ task: args.task, config: agent?.config });
      if (!r.enabled) return "边界护栏已关闭 (config.agent.boundary.enabled=false)";
      const lines = [r.verdict];
      if (r.detected.length) {
        for (const d of r.detected) lines.push(`  - ${d.name}: 命中关键词 ${d.hits.join(", ")}`);
        lines.push("要求: 只输出分析与选项, 不做最终决定; 写明需要哪位专业人士复核; 结论末尾加 \"⚠ 需人类复核后执行\"。");
      }
      lines.push(`边界条款: ${CAPABILITY_BOUNDARIES.map((b) => b.title).join(" / ")}`);
      return lines.join("\n");
    },
  });

  return catalog;
}

export default { registerOrchestrationTools, CAPABILITY_AXES };
