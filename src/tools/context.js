// src/tools/context.js - 链式召回工具 (2026-11-01 v4.1 平台化)
//
// context_read: 按 spill_id 分页续读被裁剪归档的超长工具结果全文。
// 配套 src/tools/spill.js (归档) 与 agent/loop/policy.js 的裁剪告示牌 —— 裁剪不再是死路,
// 模型看到"...全文已归档 spill_id=sp-xxx..."即可自己续读 (dsh spill-notice 同语义)。
import { TOOL_ERROR_PREFIX } from "./seam.js";

export function registerContextTools(catalog, { spill } = {}) {
  catalog.register({
    name: "context_read",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "按 spill_id 分页续读被裁剪的超长工具结果全文 (见结果末尾裁剪告示)。",
    parameters: {
      type: "object",
      properties: {
        spill_id: { type: "string", description: "归档 id (见告示 spill_id=...)" },
        offset: { type: "number", description: "起始偏移, 首次 0" },
      },
      required: ["spill_id"],
    },
    execute: async (args) => {
      if (!spill || typeof spill.read !== "function") {
        return `${TOOL_ERROR_PREFIX} context_read: 归档存储未启用 (agent.context_recall 配置关闭或未初始化)`;
      }
      const r = spill.read(args.spill_id, { offset: args.offset, maxChars: args.max_chars });
      if (!r) {
        return `${TOOL_ERROR_PREFIX} context_read: 归档 ${args.spill_id} 不存在或已被清理 (TTL/容量淘汰), 如仍需原文请重跑原工具`;
      }
      const head = `[归档 ${r.id}${r.tool ? ` tool=${r.tool}` : ""}] 全文共 ${r.total} 字符, 本次第 ${r.offset}–${r.offset + r.text.length} 字符`;
      const foot = r.done
        ? "(已到末尾)"
        : `(还有 ${r.total - r.offset - r.text.length} 字符, 用 offset=${r.nextOffset} 继续读)`;
      return `${head}\n${r.text}\n${foot}`;
    },
  });
}
