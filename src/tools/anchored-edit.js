// src/tools/anchored-edit.js - 按内容锚点改文件 (架构优化 ⑩, 2026-11-13)
//
// 与 apply_patch 的分工:
//   apply_patch (SEARCH/REPLACE) = 要把旧内容原样复述; 适合"整块重写 + 需要人读 diff"。
//   edit_lines (锚点)           = 只说"改 a3f2 这行"; 适合"改一行长代码 / 批量小改",
//                                 省掉把旧内容再吐一遍的 token, 且锚点对不上立刻拒绝。
//
// 安全边界与 write_file 一致 (safePath / 二进制容器 / 敏感写入提示 / 撤销快照 / 会话写盘记账),
// 唯一区别是写前先做全量校验: 任一条编辑不合法 → 一个字都不写 (原子性)。
import fs from "node:fs";
import path from "node:path";
import {
  safePath, sensitiveWriteHint, rememberSessionWrite, binaryContainerHint,
} from "./builtin-paths.js";
import { applyAnchorEdits } from "../edit/anchors.js";
import { noteCatch } from "../utils/catch-log.js";

export function registerAnchoredEditTools(catalog, { rootDir, rememberUndo }) {
  catalog.register({
    name: "edit_lines",
    category: "code",
    power: "medium",
    capability: { readOnly: false, riskLevel: "medium", destructive: false, sideEffect: "workspace" },
    description:
      "按内容锚点精确改文件: 先用 read_file(anchors:true) 取每行的 `行号#锚点`, 再用本工具"
      + " 指明 anchor (改一行) 或 from/to (改一段) 加新内容。不用复述旧内容; "
      + "锚点对不上说明文件已变, 会直接拒绝而不是改错地方。多条编辑要么全成要么全不写。"
      + "适用: 整段重写 / 同文件批量改 (基准显示大段重写省 30-40% 输出); "
      + "改一两行短内容请用 apply_patch (锚点的读侧前缀反而更贵)。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径 (相对工作目录)" },
        edits: {
          type: "array",
          description: "编辑列表。每项: {anchor, content} 改一行 (content 省略/空 = 删除该行); {from, to, content} 改一段 (含两端)",
          items: {
            type: "object",
            properties: {
              anchor: { type: "string", description: "单行编辑的行锚点 (如 a3f2)" },
              from: { type: "string", description: "区间起始行锚点" },
              to: { type: "string", description: "区间结束行锚点" },
              content: { type: "string", description: "新内容 (可多行); 省略 = 删除" },
            },
          },
        },
      },
      required: ["path", "edits"],
    },
    execute: async (args, ctx) => {
      const rel = String(args.path || "");
      if (!rel) return JSON.stringify({ error: "path 不能为空" });
      const p = safePath(rootDir, rel, ctx);
      if (!fs.existsSync(p)) return JSON.stringify({ error: `文件不存在: ${rel}` });
      if (fs.statSync(p).isDirectory()) return JSON.stringify({ error: `目标是目录: ${rel}` });
      const blocked = binaryContainerHint(path.extname(p).toLowerCase());
      if (blocked) return JSON.stringify({ error: blocked });
      const sensitive = sensitiveWriteHint(p);
      if (sensitive) return JSON.stringify({ error: sensitive });

      const before = fs.readFileSync(p, "utf8");
      const result = applyAnchorEdits(before, args.edits);
      if (!result.ok) {
        return JSON.stringify({ error: "编辑未应用 (文件未改动)", errors: result.errors });
      }
      if (result.text === before) {
        return JSON.stringify({ ok: true, changed: false, note: "新内容与原文一致, 未写盘" });
      }
      try {
        rememberUndo?.(p); // 与 write_file / delete_file 共用同一个撤销栈
        fs.writeFileSync(p, result.text, "utf8");
        rememberSessionWrite(p);
      } catch (e) {
        noteCatch(e); // 写盘失败要留痕: 返回给模型的同时也进 catch 日志
        return JSON.stringify({ error: `写入失败: ${e.message}` });
      }
      return JSON.stringify({
        ok: true,
        changed: true,
        bytes: Buffer.byteLength(result.text),
        applied: result.applied,
        hint: "行号已变化; 下次编辑前重新 read_file(anchors:true)",
      });
    },
  });
}
