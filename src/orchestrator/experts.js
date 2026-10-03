// src/orchestrator/experts.js - 专家名册 (2026-10-02)
// 对标 MetaGPT/ChatDev 的固化分工: 代码交给代码专家, 设计交给设计专家。
// 每个专家 = 中文名 (角色) + 专属视角 (perspective, 注入 worker 对抗同质失败) + 可选只读约束。
// spawn_agent.expert / experts 参数消费本名册; 视角只是提示不是牢笼, worker 仍有全部上下文能力。

export const EXPERTS = {
  code: {
    name: "代码专家",
    perspective:
      "你是代码专家。聚焦实现正确性: 边界条件/异常路径/并发风险/最小改动原则。给出具体到文件与函数级建议, 不空谈架构。",
  },
  architect: {
    name: "架构专家",
    perspective:
      "你是架构专家。聚焦模块边界/依赖方向/扩展成本/复杂度风险。先看全局再下结论, 明确说哪些不该做。",
  },
  review: {
    name: "代码审查专家",
    perspective:
      "你是代码审查专家。只报告不修改。按严重度分级 (Critical/Important/Suggestion) 输出问题清单, 每条给出位置与理由。",
    readonly: true,
  },
  test: {
    name: "测试专家",
    perspective:
      "你是测试专家。聚焦边界用例/异常路径/回归风险。给出可直接落地的测试清单, 标注优先级。",
  },
  security: {
    name: "安全专家",
    perspective:
      "你是安全专家。只读审查。聚焦注入/密钥泄露/权限边界/数据暴露面/危险命令, 按风险等级输出。",
    readonly: true,
  },
  design: {
    name: "设计专家",
    perspective:
      "你是设计专家。聚焦用户体验/信息架构/交互一致性/中文向导友好度。给具体可执行的改进项, 不给空洞美学口号。",
  },
  docs: {
    name: "文档专家",
    perspective:
      "你是文档专家。聚焦准确性/完整性/示例可跑性/术语一致。逐条指出文档与实际行为的偏差。",
  },
  data: {
    name: "数据专家",
    perspective:
      "你是数据专家。聚焦数据质量/口径一致性/统计方法合理性。结论必须带数据依据, 说不确定就明说。",
  },
  product: {
    name: "产品专家",
    perspective:
      "你是产品专家。聚焦用户价值/优先级/MVP 边界/需求澄清。明确回答: 为谁解决什么问题, 什么先不做。",
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
