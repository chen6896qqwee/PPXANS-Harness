// src/tools/delegate-review.js - 多 agent 协作 · SDD review 纯函数组 (2026-11-03 从 delegate.js 拆出)
// 职责: review 循环的纯函数部分 —— 严重级映射 / 审查输出解析 / 提示词组装。零导入、零 IO,
//   可独立单测 (test/delegate.test.js 等经 delegate.js 的重导出入口引用, import 路径不变)。
// 编排侧 (runTeam/runReviewLoop) 在 delegate-team.js, 工具注册面在 delegate.js。

// 严重级标签映射 (v1.0.8): 内部表示 Critical/Important/Minor, 展示用中文, 解析兼容中英
export function severityLabel(s) {
  if (s === "Critical" || s === "严重" || s === "P0") return "严重";
  if (s === "Important" || s === "重要" || s === "P1") return "重要";
  return "次要";
}
function severityOf(token) {
  if (token === "严重" || token === "P0") return "Critical";
  if (token === "重要" || token === "P1") return "Important";
  if (token === "Critical" || token === "Important") return token; // 英文 token 原样映射
  return "Minor";
}

// 解析审查者输出 -> 发现列表 [{ severity, finding }]
// 期望格式: 每行 "[严重|重要|次要] 描述" (兼容英文 Critical/Important/Minor), 无发现为 "(无发现)"
export function parseReviewFindings(text) {
  if (!text) return [];
  const out = [];
  const re = /\[(严重|重要|次要|Critical|Important|Minor)\]\s*([^\n]+)/g;
  let m;
  while ((m = re.exec(String(text)))) {
    const finding = m[2].trim();
    if (finding) out.push({ severity: severityOf(m[1]), finding });
  }
  return out;
}

// 是否需要触发修复: 有 Critical/Important
export function needsFix(findings) {
  return findings.some((f) => f.severity === "Critical" || f.severity === "Important");
}

// 组装审查者提示词 (只读审查契约)
export function buildReviewPrompt(workDesc, judge, perspective) {
  const p = perspective ? `\n【审查视角】${perspective}` : "";
  return `你是只读审查者。审查下面"产出"中实施者的结果, 找出问题。严格遵守: 只读审查, 禁止修改/写入任何文件, 禁止执行命令。

【任务要求】${workDesc}
【审查准则】${judge || "对照任务要求检查: 功能正确性 / 需求满足度 / 边界情况 / 明显风险"}${p}

【产出】
${"<产出内容>"}

输出发现清单, 每行一条, 格式 "[严重级] 描述", 严重级用:
- [严重] 功能错误 / 需求未满足 / 会导致失败
- [重要] 质量缺陷 / 边界情况 / 明显风险
- [次要] 小改进 / 风格
没有任何问题时只输出一行 "(无发现)"。不要输出其他内容。`;
}

// 修复提示词: 把未决发现交给实施者修复
export function buildFixPrompt(task, findings) {
  const open = findings.filter((f) => f.severity === "Critical" || f.severity === "Important");
  const lines = open.map((f) => `[${severityLabel(f.severity)}] ${f.finding}`).join("\n");
  return `上一轮产出存在以下 ${open.length} 项问题, 请逐一修复 (只解决这些问题, 不要引入新问题):\n${lines}\n\n原始任务: ${task}`;
}
