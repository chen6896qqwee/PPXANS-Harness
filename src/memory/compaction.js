// src/memory/compaction.js - 会话压缩层 (设计溯源 docs/PROVENANCE.md#openclaw compaction 精华)
// 设计要点:
//  - 超阈值时用 LLM 把旧对话压缩成「结构化摘要」(固定格式), 替换旧历史, 防上下文失控
//  - 摘要可迭代: 摘要作为 system 消息进入下一轮, 下次压缩时摘要+新对话一起再压
//  - 固定格式: 目标/进展/关键决策/待办/关键上下文, 保证可预测、可续写
import { estimateTokens } from "../utils/text.js";

const COMPACTION_SYSTEM_PROMPT = `你是对话压缩器。把下面的对话历史压缩成一段结构化摘要，严格按以下格式输出（无内容的小节填「无」）：
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

// 压缩触发判定单源 (2026-11-03 重复消除): agent/context.js 与 agent/evidence.js 此前各持一份
// 相同的「超 1.5×预算则取前半为待压段」判定, 且已出现写法漂移 (事件类型一边用字面量一边用常量)。
// 阈值/取半/最少条数这三处语义必须同源 —— 哪边单独改, 另一边就在压不压之间走样。
// 入参 tail = 压缩点之后的消息事件 (e.data.content / e.seq); 不需压缩返回 null,
// 需要则返回 { old: 待压前半段, lastSeq: 待压段最后一事件的 seq }。
export function compactionSplit(tail, cfgBudget = 4000) {
  if (!tail.length) return null;
  const tokenBudget = Number(cfgBudget) || 4000;
  const total = tail.reduce((a, e) => a + estimateTokens(e.data?.content), 0);
  if (total <= tokenBudget * 1.5) return null; // 未超阈值不压缩
  const split = Math.floor(tail.length / 2);
  const old = tail.slice(0, split);
  if (old.length < 2) return null; // 太少不值得压
  return { old, lastSeq: old[old.length - 1].seq };
}
