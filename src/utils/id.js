// src/utils/id.js - 短 ID 生成 (唯一实现, 2026-09-18 重构收敛)
// 原先 trace/playbook/mcp-tasks/asset-hub/failure-episode 各写一份
// `prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, n)`, 易漂移。
// randEnd 传 Math.random().toString(36).slice(2, randEnd) 的结束下标, 与历史格式逐字节一致
// (各调用方原有 randEnd: 5/6/8, 保持不变 —— ID 只要求唯一, 不保证加密安全)。
export function shortId(prefix = "", randEnd = 6) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, randEnd);
}
