// src/memory/session-events.js - 会话事件类型常量 (独立成模块, 供 session.js 与各 mixin 共用)
// 单独存放的理由: session.js 拆出的 mixin 需要判事件类型, 若直接 import session.js 会与宿主成环。
// 对齐设计溯源 docs/PROVENANCE.md#dsh 事件域: user/assistant/tool/system
export const EVENTS = {
  USER: "user/message",
  ASSISTANT: "assistant/message",
  SYSTEM: "system",
  TOOL_CALL: "tool/call",
  TOOL_RESULT: "tool/result",
  COMPACTION: "compaction/summary",
};
