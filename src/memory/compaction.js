// src/memory/compaction.js - 会话压缩层 (吸收 OpenClaw compaction 精华)
// 设计要点:
//  - 超阈值时用 LLM 把旧对话压缩成「结构化摘要」(固定格式), 替换旧历史, 防上下文失控
//  - 摘要可迭代: 摘要作为 system 消息进入下一轮, 下次压缩时摘要+新对话一起再压
//  - 固定格式: 目标/进展/关键决策/待办/关键上下文, 保证可预测、可续写

export const COMPACTION_SYSTEM_PROMPT = `你是对话压缩器。把下面的对话历史压缩成一段结构化摘要，严格按以下格式输出（无内容的小节填「无」）：
- 目标：用户想达成什么
- 进展：已完成的关键步骤
- 关键决策：已确定的重要决定/约定
- 待办：尚未完成的事项
- 关键上下文：后续对话必须知道的细节（数字/路径/偏好/约束）
要求：简洁，≤300字，保留所有关键事实，不要客套，直接输出摘要。`;

// 组装压缩请求消息 (system + 待压缩对话)
export function buildCompactionMessages(transcript) {
  return [
    { role: "system", content: COMPACTION_SYSTEM_PROMPT },
    { role: "user", content: String(transcript).slice(0, 8000) },
  ];
}

// 把投影消息列表转成压缩用文本 (role → 中文标签)
export function transcriptToText(messages) {
  return messages
    .map((m) => (m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : m.role) + ": " + String(m.content ?? ""))
    .join("\n");
}
