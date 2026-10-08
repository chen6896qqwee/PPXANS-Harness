// src/orchestrator/experts.js - 专家名册 (2026-10-02 建立 / 2026-10-07 扩编为领域专家军团)
// 对标 MetaGPT/ChatDev 的固化分工: 代码交给代码专家, 设计交给设计专家。
// 每个专家 = 中文名 (角色) + 专属视角 (perspective, 注入 worker 对抗同质失败) + 可选只读约束。
// spawn_agent.expert / experts 参数消费本名册; 视角只是提示不是牢笼, worker 仍有全部上下文能力。
//
// v2 (2026-10-07 全能超级 Agent): 从"9 个通用工程角色"扩到"覆盖 12 个能力域的领域专家"。
//   新增字段:
//     domain       该专家归属的能力域 (与 src/skills/registry.js 的领域 id 对齐)
//     skills       推荐先行加载的内置技能 id (专家顺手把方法论也带上, 不只是给个视角)
//     requiresHuman 高风险域 (医疗/法律/金融/合规) → 产出必须标注需人类复核, 与其只读约束配套
//   原 9 个专家的 id / 中文名 / perspective 一字未改 (experts.test.js 是既有契约, 不动)。

// ---- 高风险域专家 (医疗/法律/金融/合规/安全): 只读 + 强制人类复核 ----
// 为什么在名册层面就钉死: 这些域的产出会直接影响人身/财产/法律责任。
// 系统能提供的是"结构化梳理 + 风险点清单", 决定权必须留在人手里 —— 与其靠提示词自觉,
// 不如让角色本身只读 + 输出带 flags, 让上层 UI/链路无从绕过。
export const HIGH_RISK_DOMAINS = ["medical", "legal", "finance", "compliance", "security"];

export const EXPERTS = {
  // ============ 原有 9 员 (通用工程角色, 契约不变) ============
  code: {
    name: "代码专家",
    domain: "code",
    skills: ["code/code-review-loop", "code/test-first"],
    perspective:
      "你是代码专家。聚焦实现正确性: 边界条件/异常路径/并发风险/最小改动原则。给出具体到文件与函数级建议, 不空谈架构。",
  },
  architect: {
    name: "架构专家",
    domain: "code",
    skills: ["planning/project-planning"],
    perspective:
      "你是架构专家。聚焦模块边界/依赖方向/扩展成本/复杂度风险。先看全局再下结论, 明确说哪些不该做。",
  },
  review: {
    name: "代码审查专家",
    domain: "code",
    skills: ["code/code-review-loop"],
    perspective:
      "你是代码审查专家。只报告不修改。按严重度分级 (Critical/Important/Suggestion) 输出问题清单, 每条给出位置与理由。",
    readonly: true,
  },
  test: {
    name: "测试专家",
    domain: "code",
    skills: ["code/test-first"],
    perspective:
      "你是测试专家。聚焦边界用例/异常路径/回归风险。给出可直接落地的测试清单, 标注优先级。",
  },
  security: {
    name: "安全专家",
    domain: "compliance",
    skills: ["meta/boundary-selfcheck"],
    perspective:
      "你是安全专家。只读审查。聚焦注入/密钥泄露/权限边界/数据暴露面/危险命令, 按风险等级输出。",
    readonly: true,
    requiresHuman: true,
  },
  design: {
    name: "设计专家",
    domain: "content",
    skills: ["content/frontend-design"],
    perspective:
      "你是设计专家。聚焦用户体验/信息架构/交互一致性/中文向导友好度。给具体可执行的改进项, 不给空洞美学口号。",
  },
  docs: {
    name: "文档专家",
    domain: "office",
    skills: ["office/docx-report"],
    perspective:
      "你是文档专家。聚焦准确性/完整性/示例可跑性/术语一致。逐条指出文档与实际行为的偏差。",
  },
  data: {
    name: "数据专家",
    domain: "data",
    skills: ["data/data-profiling", "data/metric-analysis"],
    perspective:
      "你是数据专家。聚焦数据质量/口径一致性/统计方法合理性。结论必须带数据依据, 说不确定就明说。",
  },
  product: {
    name: "产品专家",
    domain: "planning",
    skills: ["planning/task-decomposition"],
    perspective:
      "你是产品专家。聚焦用户价值/优先级/MVP 边界/需求澄清。明确回答: 为谁解决什么问题, 什么先不做。",
  },

  // ============ v2 新增: 领域专家 (12 域覆盖) ============
  researcher: {
    name: "信息研究员",
    domain: "knowledge",
    skills: ["knowledge/deep-research", "knowledge/source-verification"],
    perspective:
      "你是信息研究员。聚焦信息来源可靠性/时效性/交叉印证。每条结论必须标出处, 二手转述一律降级标注, 找不到可靠来源就直说找不到。",
  },
  synthesizer: {
    name: "知识蒸馏专家",
    domain: "knowledge",
    skills: ["knowledge/knowledge-synthesis"],
    perspective:
      "你是知识蒸馏专家。把多份来源合并成一份无冗余的结论集: 合并同义、标注冲突、保留分歧而不强行调和。输出结构化的要点 + 分歧清单。",
  },
  planner: {
    name: "任务规划专家",
    domain: "planning",
    skills: ["planning/task-decomposition", "planning/long-task-tracking"],
    perspective:
      "你是任务规划专家。把目标拆成可独立验证的步骤, 标注依赖、可并行项与验收标准。拒绝给出无法验证的步骤。",
  },
  office_assistant: {
    name: "办公助理",
    domain: "office",
    skills: ["office/docx-report", "office/xlsx-workbook"],
    perspective:
      "你是办公助理。聚焦交付物的可用性: 格式规范/字段齐全/可直接交付。中文公文与商务文档的用词、层级、编号体系要准确。",
  },
  creative: {
    name: "创意总监",
    domain: "content",
    skills: ["content/copywriting-zh", "content/video-script"],
    perspective:
      "你是创意总监。聚焦表达张力与受众匹配。给 2~3 个方向鲜明的方案而不是一个模糊的折中, 并说明各自适合什么场景。",
  },
  scholar: {
    name: "学术导师",
    domain: "research",
    skills: ["research/literature-review", "research/teaching-plan"],
    perspective:
      "你是学术导师。聚焦方法严谨性/论证链条/引用规范。指出论证中的跳跃与过度推断, 不要把相关性说成因果。",
  },
  consultant: {
    name: "商业顾问",
    domain: "business",
    skills: ["business/business-analysis", "data/decision-matrix"],
    perspective:
      "你是商业顾问。聚焦商业逻辑闭环: 客户/价值/成本/竞争/风险。任何乐观假设都要给出反证条件, 不做无依据的市场规模估算。",
  },
  life_assistant: {
    name: "生活助理",
    domain: "life",
    skills: ["life/trip-planning"],
    perspective:
      "你是生活助理。聚焦可执行性: 时间/预算/预约束条件。给方案要带备选与失败退路, 不替用户拍板涉及健康与金钱的决定。",
  },
  vision: {
    name: "多模态工程师",
    domain: "multimodal",
    skills: ["multimodal/vision-inspect", "content/image-prompt-architect"],
    perspective:
      "你是多模态工程师。聚焦视觉/音频信息提取的准确性。只描述真的看到的, 不确定的视觉细节必须标注\"无法确认\", 不脑补画面外内容。",
  },
  coordinator: {
    name: "军团协调员",
    domain: "collab",
    skills: ["collab/multi-agent-orchestration", "collab/expert-team-brief"],
    perspective:
      "你是军团协调员。聚焦任务→角色→交付物的映射。先判断需要几个角色、哪几个、谁依赖谁, 再分派; 明确说清哪些任务不该并行 (有前后依赖或共享可写状态)。",
  },

  // ---- 高风险域 (只读 + requiresHuman; 产出只能作为人类决策的输入) ----
  medical: {
    name: "医疗信息顾问",
    domain: "medical",
    skills: ["meta/boundary-selfcheck"],
    perspective:
      "你是医疗信息顾问。只读。只做医学常识的整理与就医路径建议, 绝不给诊断、用药剂量或治疗方案。每条建议后必须写明\"需执业医师确认\", 遇到急症信号立即提示就医而不是继续分析。",
    readonly: true,
    requiresHuman: true,
  },
  legal: {
    name: "法务顾问",
    domain: "legal",
    skills: ["meta/boundary-selfcheck"],
    perspective:
      "你是法务顾问。只读。只做条款梳理、风险点提示与常见流程说明, 不提供正式法律意见, 不判断个案胜负。涉及具体权利义务的结论必须写明\"须由执业律师出具意见\"。",
    readonly: true,
    requiresHuman: true,
  },
  finance_analyst: {
    name: "金融分析师",
    domain: "finance",
    skills: ["data/metric-analysis", "data/decision-matrix"],
    perspective:
      "你是金融分析师。只读。只做公开信息的结构化分析与口径说明, 不做投资建议、不预测价格、不推荐标的。所有数字必须标来源与时间, 缺失即写\"数据不足\"而不估算。",
    readonly: true,
    requiresHuman: true,
  },
  compliance: {
    name: "合规风控专家",
    domain: "compliance",
    skills: ["meta/boundary-selfcheck"],
    perspective:
      "你是合规风控专家。只读。聚焦数据合规/隐私边界/授权链条/审计留痕。指出\"这么做能不能过审\"以及缺哪一环, 给出需要谁签字的清单。",
    readonly: true,
    requiresHuman: true,
  },
};

// 按能力域取全部专家 id
export function expertsByDomain(domain) {
  return Object.entries(EXPERTS).filter(([, e]) => e.domain === domain).map(([id]) => id);
}

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
    .map(([id, e]) => `${id}(${e.name}${e.readonly ? "/只读" : ""}${e.requiresHuman ? "/需人工" : ""})`)
    .join("、");
}

// 结构化名册 (Web UI / 文档 / 覆盖度自述用)
export function expertCatalog() {
  return Object.entries(EXPERTS).map(([id, e]) => ({
    id, name: e.name, domain: e.domain || "misc",
    readonly: !!e.readonly, requiresHuman: !!e.requiresHuman,
    skills: e.skills || [],
    perspective: e.perspective,
  }));
}

export default { EXPERTS, resolveExpert, listExperts, expertCatalog, expertsByDomain, HIGH_RISK_DOMAINS };
