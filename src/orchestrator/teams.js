// src/orchestrator/teams.js - 专家班组 (Expert Teams) 与协作拓扑 (2026-10-07)
//
// 为什么在"专家个体"之上再加一层班组:
//   单个专家回答的是"这件事从我的视角怎么看"; 而端到端把事情做完, 需要的是
//   **一组角色 + 一个收敛机制**。"帮我上这个功能"不是一个角色的活 —— 要有人拆解、
//   有人实现、有人审查、有人验收。班组把这套编排固化成可点名的一等对象,
//   上层 (spawn_agent / legion 模式 / Web UI) 只要说"用研发班组", 不用自己拼专家列表。
//
// 拓扑 (topology) —— 班组内部怎么协作, 而不是谁参与:
//   parallel    各自独立产出一份结果, 主 agent 拼接 (适合广撒网探索)
//   supervisor  监督者循环: 多专家并行 → 分歧检测 → 评审打回 → 定稿 (适合需收敛的决策)
//   debate      正反方对抗: 分组互评, 暴露对立论据 (适合有争议的判断)
//   pipeline    流水线: 按序传递, 前一环产出即后一环输入 (适合"拆解→实现→审查"这种强依赖)
//   review      实施 + 只读审查循环 (SDD; 复用 delegate 既有能力)
//
// 关键取舍: 拓扑只描述**依赖形状**。是否只读、是否需要人类签字, 由专家自身的
// readonly / requiresHuman 决定 —— 不让班组去覆盖个体的安全属性。

import { EXPERTS, HIGH_RISK_DOMAINS } from "./experts.js";

export const TOPOLOGIES = ["parallel", "supervisor", "debate", "pipeline", "review"];

export const TEAMS = {
  dev: {
    name: "研发班组",
    desc: "需求澄清 → 方案设计 → 实现 → 代码审查 → 测试验收。适合功能开发、重构、缺陷修复。",
    members: ["product", "architect", "code", "review", "test"],
    topology: "pipeline",
    domain: "code",
  },
  hotfix: {
    name: "紧急修复班组",
    desc: "小范围快速定位 + 只读复核。适合线上故障定位与热修验证, 规模小、轮次少。",
    members: ["code", "review"],
    topology: "review",
    domain: "code",
  },
  research: {
    name: "研究班组",
    desc: "多源检索 → 来源核验 → 交叉蒸馏 → 学术把关。适合调研报告、技术选型、文献综述。",
    members: ["researcher", "synthesizer", "scholar"],
    topology: "supervisor",
    domain: "knowledge",
  },
  data: {
    name: "数据班组",
    desc: "口径定义 → 数据剖析 → 指标分析 → 决策矩阵。适合数据分析、汇报取数、方案对比。",
    members: ["data", "planner", "consultant"],
    topology: "supervisor",
    domain: "data",
  },
  content: {
    name: "内容班组",
    desc: "选题创意 → 文案脚本 → 视觉方案 → 设计把关。适合公众号/短剧/宣传物料。",
    members: ["creative", "design", "vision"],
    topology: "parallel",
    domain: "content",
  },
  office: {
    name: "办公班组",
    desc: "文档/表格/演示产出 + 文档一致性复核。适合周报、方案书、会议纪要、汇报材料。",
    members: ["office_assistant", "docs", "design"],
    topology: "pipeline",
    domain: "office",
  },
  business: {
    name: "商业班组",
    desc: "商业分析 → 数据支撑 → 合规风控 → 人类决策输入。适合可行性、定价、对外沟通材料。",
    members: ["consultant", "data", "compliance"],
    topology: "supervisor",
    domain: "business",
  },
  governance: {
    name: "评审班组",
    desc: "安全 / 合规 / 法务 三方只读评审, 输出风险清单与签署需求。全程只读, 不产出可执行动作。",
    members: ["security", "compliance", "legal"],
    topology: "parallel",
    domain: "compliance",
  },
  life: {
    name: "生活班组",
    desc: "行程规划 + 信息核验 (价格/时间/开放信息)。适合出行、办事流程、生活决策。",
    members: ["life_assistant", "researcher"],
    topology: "parallel",
    domain: "life",
  },
  debate: {
    name: "对抗论证班组",
    desc: "正反两方 + 仲裁。适合有争议的技术/商业判断 —— 强制把反方论据摆到台面上。",
    members: ["architect", "security", "product"],
    topology: "debate",
    domain: "collab",
  },
};

// 中文名 / 别名 → 班组 id
export const TEAM_ALIASES = {
  "研发": "dev", "开发": "dev", "功能开发": "dev", "重构": "dev",
  "修复": "hotfix", "热修": "hotfix", "故障": "hotfix",
  "调研": "research", "研究": "research", "选型": "research",
  "数据分析": "data", "取数": "data", "报表": "data",
  "内容": "content", "文案": "content", "短剧": "content", "创意": "content",
  "办公": "office", "文档": "office", "汇报": "office",
  "商业": "business", "商务": "business", "可行性": "business",
  "评审": "governance", "合规": "governance", "风控": "governance", "安全": "governance",
  "生活": "life", "出行": "life", "行程": "life",
  "对抗": "debate", "辩论": "debate", "正反": "debate",
};

export function resolveTeam(key) {
  if (!key) return null;
  const k = String(key).trim();
  if (!k) return null;
  const lower = k.toLowerCase();
  if (TEAMS[lower]) return { id: lower, ...TEAMS[lower] };
  for (const [id, t] of Object.entries(TEAMS)) {
    if (lower.includes(id) || k.includes(t.name) || t.name.includes(k)) return { id, ...t };
  }
  for (const [alias, id] of Object.entries(TEAM_ALIASES)) {
    if (k.includes(alias)) return { id, ...TEAMS[id] };
  }
  return null;
}

// 班组 → 专家 (带安全属性)。成员里混入未知名册的键时静默丢弃 (班组不该因错别字整体失效)。
export function teamExperts(team) {
  const t = typeof team === "string" ? resolveTeam(team) : team;
  if (!t) return [];
  return (t.members || [])
    .map((m) => {
      const e = EXPERTS[m] || resolveExpertLoose(m);
      return e ? { id: m, ...e } : null;
    })
    .filter(Boolean);
}

// 名册内模糊解析 (仅供班组用; 找不到返回 null, 不抛)
function resolveExpertLoose(key) {
  const k = String(key || "").trim();
  if (!k) return null;
  if (EXPERTS[k.toLowerCase()]) return EXPERTS[k.toLowerCase()];
  for (const [, e] of Object.entries(EXPERTS)) if (k.includes(e.name)) return e;
  return null;
}

export function listTeams() {
  return Object.entries(TEAMS)
    .map(([id, t]) => `${id}(${t.name}, ${t.members.length}人, ${t.topology})`)
    .join("、");
}

export function teamCatalog() {
  return Object.entries(TEAMS).map(([id, t]) => ({
    id, name: t.name, desc: t.desc, topology: t.topology, domain: t.domain,
    members: (t.members || []).map((m) => ({
      id: m,
      name: EXPERTS[m]?.name || m,
      readonly: !!EXPERTS[m]?.readonly,
      requiresHuman: !!EXPERTS[m]?.requiresHuman,
    })),
  }));
}

// 班组风险画像: 全员只读 / 含高风险域 → 上层据此决定是否强制人类把关
export function teamRiskProfile(team) {
  const experts = teamExperts(team);
  const highRisk = experts.filter((e) => e.requiresHuman || HIGH_RISK_DOMAINS.includes(e.domain));
  return {
    memberCount: experts.length,
    allReadonly: experts.length > 0 && experts.every((e) => e.readonly),
    highRiskMembers: highRisk.map((e) => e.name),
    requiresHuman: highRisk.length > 0,
  };
}

export default { TEAMS, TOPOLOGIES, resolveTeam, teamExperts, listTeams, teamCatalog, teamRiskProfile };
