// src/orchestrator/experts.js - 专家名册
// 对标 MetaGPT/ChatDev 的固化分工: 代码交给代码专家, 设计交给设计专家。
// 每个专家 = 中文名 (角色) + 能力域 (domain) + 专属视角 (perspective, 注入 worker 对抗同质失败)
//           + 可选只读约束 (readonly) + 可选人类复核标记 (requiresHuman)。
// spawn_agent.expert / experts 参数消费本名册; 视角只是提示不是牢笼, worker 仍有全部上下文能力。
//
// 2026-10-09 补齐 (缺陷: 半成品接线):
//   src/orchestrator/teams.js 的班组名册引用了 11 个【名册里根本不存在】的角色
//   (researcher / synthesizer / scholar / planner / consultant / creative / vision /
//    office_assistant / compliance / legal / life_assistant), 且 src/tools/{team-room,orchestration}.js
//   与 expert-pack.js 依赖本模块的 HIGH_RISK_DOMAINS / expertCatalog —— 这些从未实现,
//   导致 teams/team-room/orchestration 一 import 就走不下去, 相关工具全部装配不上。
//   本次按使用方 (teams.js 班组定义 + teams.test.js 不变量) 的真实形状补齐。
// 向后兼容: 原 9 员的 id 与中文名保持不变。

// 需人类监督的高风险能力域 (超出技能域词表 SKILL_DOMAINS 的范围)。
// expert-pack 的 KNOWN_DOMAINS = DOMAIN_IDS ∪ HIGH_RISK_DOMAINS, 故此处须登记使用方用到的域。
import path from "node:path";
import { ensureDir, readJson, writeJson } from "../utils/store.js";

export const HIGH_RISK_DOMAINS = ["compliance", "medical", "legal", "finance"];

export const EXPERTS = {
  // ---------- 原 9 员 (id 与中文名为既有契约, 不得改动) ----------
  code: {
    name: "代码专家",
    domain: "code",
    perspective:
      "你是代码专家。聚焦实现正确性: 边界条件/异常路径/并发风险/最小改动原则。给出具体到文件与函数级建议, 不空谈架构。",
  },
  architect: {
    name: "架构专家",
    domain: "code",
    perspective:
      "你是架构专家。聚焦模块边界/依赖方向/扩展成本/复杂度风险。先看全局再下结论, 明确说哪些不该做。",
  },
  review: {
    name: "代码审查专家",
    domain: "code",
    perspective:
      "你是代码审查专家。只报告不修改。按严重度分级 (Critical/Important/Suggestion) 输出问题清单, 每条给出位置与理由。",
    readonly: true,
  },
  test: {
    name: "测试专家",
    domain: "code",
    perspective:
      "你是测试专家。聚焦边界用例/异常路径/回归风险。给出可直接落地的测试清单, 标注优先级。",
  },
  security: {
    name: "安全专家",
    domain: "compliance",
    perspective:
      "你是安全专家。只读审查。聚焦注入/密钥泄露/权限边界/数据暴露面/危险命令, 按风险等级输出。",
    readonly: true,
    requiresHuman: true,
  },
  design: {
    name: "设计专家",
    domain: "content",
    perspective:
      "你是设计专家。聚焦用户体验/信息架构/交互一致性/中文向导友好度。给具体可执行的改进项, 不给空洞美学口号。",
  },
  docs: {
    name: "文档专家",
    domain: "office",
    perspective:
      "你是文档专家。聚焦准确性/完整性/示例可跑性/术语一致。逐条指出文档与实际行为的偏差。",
  },
  data: {
    name: "数据专家",
    domain: "data",
    perspective:
      "你是数据专家。聚焦数据质量/口径一致性/统计方法合理性。结论必须带数据依据, 说不确定就明说。",
  },
  product: {
    name: "产品专家",
    domain: "business",
    perspective:
      "你是产品专家。聚焦用户价值/优先级/MVP 边界/需求澄清。明确回答: 为谁解决什么问题, 什么先不做。",
  },

  // ---------- 2026-10-09 补齐: 班组名册实际引用到的角色 ----------
  researcher: {
    name: "调研专家",
    domain: "research",
    perspective:
      "你是调研专家。聚焦多源检索与一手信息获取: 每个结论都要能指回来源, 区分事实与推测, 明确标注信息时效与不确定性。",
  },
  synthesizer: {
    name: "综合蒸馏专家",
    domain: "knowledge",
    perspective:
      "你是综合蒸馏专家。聚焦跨来源交叉验证与信息压缩: 找一致点与矛盾点, 输出结构化的结论清单, 不复述原文。",
  },
  scholar: {
    name: "学术把关专家",
    domain: "research",
    perspective:
      "你是学术把关专家。聚焦方法论严谨性: 样本与口径是否成立、因果是否被误当相关、引用是否被曲解。逐条给出质疑。",
  },
  planner: {
    name: "规划专家",
    domain: "planning",
    perspective:
      "你是规划专家。聚焦任务拆解与依赖排序: 输出带里程碑与验收标准的计划, 指出关键路径与最可能卡住的一步。",
  },
  consultant: {
    name: "商业顾问",
    domain: "business",
    perspective:
      "你是商业顾问。聚焦商业可行性与取舍: 明确成本/收益假设、竞争与替代方案, 给出可决策的建议而不是罗列选项。",
  },
  creative: {
    name: "创意策划专家",
    domain: "content",
    perspective:
      "你是创意策划专家。聚焦选题钩子与叙事结构: 先给差异化角度, 再给可落地的脚本骨架, 拒绝模板化的空话标题。",
  },
  vision: {
    name: "视觉专家",
    domain: "multimodal",
    perspective:
      "你是视觉专家。聚焦画面构成与视觉一致性: 景别/光线/色调/风格锚点要说清楚, 给出可直接进图像模型的提示词。",
  },
  office_assistant: {
    name: "办公助理专家",
    domain: "office",
    perspective:
      "你是办公助理专家。聚焦文档/表格/演示的产出质量: 结构清晰、数据可追溯、结论前置, 兼顾中文汇报习惯。",
  },
  life_assistant: {
    name: "生活助理专家",
    domain: "life",
    perspective:
      "你是生活助理专家。聚焦行程与办事流程的可执行性: 时间/地点/价格/开放信息逐项核验, 标出需要用户确认的前提。",
  },

  // ---------- 高风险域 (一律只读 + 需人类复核) ----------
  compliance: {
    name: "合规风控专家",
    domain: "compliance",
    perspective:
      "你是合规风控专家。只读评审。聚焦监管要求、内部政策与数据合规边界, 逐条给出依据与整改建议, 不确定处明确标注需法务确认。",
    readonly: true,
    requiresHuman: true,
  },
  legal: {
    name: "法务专家",
    domain: "legal",
    perspective:
      "你是法务专家。只读评审。聚焦合同条款、责任边界与争议风险, 指出哪些表述会被对方利用, 结论必须标注需执业律师复核。",
    readonly: true,
    requiresHuman: true,
  },
  finance: {
    name: "财务专家",
    domain: "finance",
    perspective:
      "你是财务专家。只读评审。聚焦口径一致性、成本归集与现金流影响, 所有金额都要标出来源与假设, 不做无依据预测。",
    readonly: true,
    requiresHuman: true,
  },
  medical: {
    name: "医疗信息顾问",
    domain: "medical",
    perspective:
      "你是医疗健康专家。只读评审。只做通用健康信息整理与就医建议方向, 明确声明不构成诊断, 紧急情况一律建议立即就医。",
    readonly: true,
    requiresHuman: true,
  },
};

// 解析专家: 支持英文 id (code) / 中文名 (代码专家, 模糊包含匹配), 不区分大小写; 未命中返回 null
export function resolveExpert(key) {
  if (!key) return null;
  const k = String(key).trim();
  if (!k) return null;
  const lower = k.toLowerCase();
  // 1. 精确 id
  if (EXPERTS[lower]) return EXPERTS[lower];
  // 2. 中文名/别名模糊匹配 (专家名或 id 被查询串包含)
  for (const [id, e] of Object.entries(EXPERTS)) {
    if (lower.includes(id) || k.includes(e.name) || e.name.includes(k)) return e;
  }
  return null;
}

// 名册摘要 (工具描述/错误提示用)
export function listExperts() {
  return Object.entries(EXPERTS)
    .map(([id, e]) => `${id}(${e.name}${e.readonly ? "/只读" : ""})`)
    .join("、");
}

// 结构化名册 (供 expert_list / team_room_open / boundary_check 等工具消费)。
// 形状契约由使用方定义: { id, name, domain, readonly, requiresHuman, perspective, skills }。
// skills 保持空数组 —— 不臆造"推荐技能"映射, 宁可不显示也不给错指引。
export function expertCatalog() {
  return Object.entries(EXPERTS).map(([id, e]) => ({
    id,
    name: e.name,
    domain: e.domain || "meta",
    readonly: !!e.readonly,
    requiresHuman: !!e.requiresHuman,
    perspective: e.perspective || "",
    skills: Array.isArray(e.skills) ? e.skills : [],
  }));
}

// 按能力域筛选 (expert_list 的 domain 参数直接消费)
export function expertsByDomain(domain) {
  if (!domain) return expertCatalog();
  return expertCatalog().filter((e) => e.domain === domain);
}

/* ========================================================================
 * 可生长专家名册 (用户专家库, 2026-10-09)
 * 锁语义: ①内置契约不可被用户库顶掉 ②高危域强制 requiresHuman ③落盘可复用 ④自动建档 opt-in
 * ====================================================================== */

// 中文域 → 规范域名 (HIGH_RISK_DOMAINS 是英文, 但用户/LLM 常给中文域)
const DOMAIN_ALIAS = {
  医疗: "medical", 医学: "medical", 临床: "medical",
  法律: "legal", 法务: "legal",
  金融: "finance", 投资: "finance", 基金: "finance",
  合规: "compliance", 风控: "compliance", 审计: "compliance",
};

// 进程内用户专家库 (id -> expert)。落盘是为了跨进程/重启复用, 内存是为了零 IO 命中。
const USER_EXPERTS = new Map();

function makeUserExpertId(name) {
  const slug = String(name || "").toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "");
  const h = Buffer.from(String(name || "")).toString("hex").slice(0, 6);
  return `u_${slug.slice(0, 16) || "expert"}_${h}`;
}

/**
 * 归一用户专家档案: 字段裁剪 + 默认补全 + 高危域闸门。
 * name ≤ 24 字 / perspective ≤ 400 字 (防一条自动建档的档案把上下文吃穿)。
 */
export function normalizePersona(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const name = String(src.name || "").trim().slice(0, 24) || "未命名专家";
  const perspective = String(src.perspective || "").trim().slice(0, 400)
    || `从${name}的专业视角分析问题, 给出可执行建议`;
  const rawDomain = String(src.domain || "").trim();
  const domain = DOMAIN_ALIAS[rawDomain] || rawDomain.toLowerCase() || "general";
  return {
    id: String(src.id || "").trim().replace(/[^\w-]/g, "").slice(0, 40) || makeUserExpertId(name),
    name,
    perspective,
    domain,
    skills: Array.isArray(src.skills) ? src.skills.map((s) => String(s).slice(0, 24)).slice(0, 8) : [],
    // 高危域强制人工把关 (医疗/法律/金融/合规) —— 用户自定义也必须过这道闸
    requiresHuman: HIGH_RISK_DOMAINS.includes(domain) || src.requiresHuman === true,
    readonly: src.readonly === true,
    userCreated: true,
  };
}

/** 注册 (或覆盖) 一个用户专家。**不会**顶掉内置 EXPERTS —— 解析层保证内置优先。 */
export function registerUserExpert(input) {
  const e = normalizePersona(input);
  USER_EXPERTS.set(e.id, e);
  return e;
}

/**
 * 解析专家: 内置名册优先 (同名用户专家不可顶掉内置 id), 未命中再查用户库 (id → 名 → 模糊)。
 */
export function resolveExpertWithUser(key) {
  const builtin = resolveExpert(key); // 内置实验契约优先
  if (builtin) return builtin;
  const k = String(key || "").trim();
  if (!k) return null;
  const lower = k.toLowerCase();
  for (const e of USER_EXPERTS.values()) {
    if (e.id.toLowerCase() === lower) return e;
  }
  for (const e of USER_EXPERTS.values()) {
    if (e.name === k) return e;
  }
  // 归一化匹配: 调用方常把 id 写成自然语言 (建档 "rust-ffi" ↔ 后续查询 "rust ffi")
  const squash = (s) => String(s || "").toLowerCase().replace(/[\s_-]+/g, "");
  const sq = squash(k);
  if (sq) {
    for (const e of USER_EXPERTS.values()) {
      if (squash(e.id) === sq || squash(e.name) === sq) return e;
    }
  }
  for (const e of USER_EXPERTS.values()) {
    if (e.name.includes(k) || k.includes(e.name)) return e;
  }
  return null;
}

/** 用户库条目数 */
export function userExpertCount() { return USER_EXPERTS.size; }

/** 落盘用户专家库 (返回是否成功; 失败不抛) */
export function saveUserExperts(dir) {
  try {
    if (!dir) return false;
    const file = path.join(dir, "experts", "user-experts.json");
    ensureDir(path.dirname(file));
    writeJson(file, { version: 1, experts: [...USER_EXPERTS.values()] });
    return true;
  } catch { return false; }
}

/** 载入用户专家库, 返回载入条数 (文件缺失/损坏返回 0, 不抛) */
export function loadUserExperts(dir) {
  try {
    if (!dir) return 0;
    const j = readJson(path.join(dir, "experts", "user-experts.json"), null);
    const list = Array.isArray(j?.experts) ? j.experts : [];
    for (const e of list) {
      const n = normalizePersona(e);
      if (n.id) USER_EXPERTS.set(n.id, n);
    }
    return list.length;
  } catch { return 0; }
}
