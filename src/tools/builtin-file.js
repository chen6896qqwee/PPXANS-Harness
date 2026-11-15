// src/tools/builtin-file.js - 内置文件域工具 (2026-11-14 自 builtin.js 按域拆分, 自审唯一 large-module)
//
// 关注点: "一个文件怎么被安全地读/写/删/移/撤销/找" —— 读(含锚点视图)/写(含写后自查)/追加/
//   删除/移动(跨盘回退)/撤销(内存快照栈)/列目录/搜索文件/读图片, 以及与写域共用撤销栈的
//   锚点编辑 (registerAnchoredEditTools)。执行域 (run_command/code_act/run_background/job)
//   见 ./builtin-exec.js; 记忆域见 ./builtin-memory.js; 路径安全原语见 ./builtin-paths.js。
//
// 域内闭包状态: fileUndoStack (写/删/追加前快照, 上限 20, 仅内存 —— 刻意不落盘, 内容可能含敏感数据)。
// 跨域共享: rememberSessionWrite (builtin-paths.js 模块级账本) —— 执行域的 findSessionWrittenScript
//   靠它拦 "write_file + node" 连招, 两域经由同一模块读写, 不经闭包。
import fs from "node:fs";
import path from "node:path";
import { scrubPII } from "../utils/pii.js";
import { jsSyntaxOutcome, jsExportSelfCheck, DEFAULT_SYNTAX_TIMEOUT_MS, JS_SELF_CHECK_EXT } from "../verify/postcondition.js";
// 2026-10-24 (R2): 文件级快照/回滚 —— 写/删/追加前入撤销栈, undo_file 可回退
import { Snapshot } from "../edit/snapshot.js";
import { renderAnchored } from "../edit/anchors.js";
import { registerAnchoredEditTools } from "./anchored-edit.js";
import { noteCatch } from "../utils/catch-log.js";
import {
  binaryContainerHint, isProtectedRead, rememberSessionWrite,
  imageFileToDataUrl, safePath, sensitiveWriteHint,
} from "./builtin-paths.js";
import { globToRegex } from "./code-act.js";

export function registerFileTools(catalog, { rootDir }) {
  // 2026-10-24 (R2): 文件撤销栈 —— 写/删/追加前对目标做内存快照 (最近 20 条),
  //   undo_file 按栈回退。覆盖 apply_patch 之外的文件破坏面 (此前只有 apply_patch 有快照)。
  //   仅内存: 进程退出即失 (快照不落盘是刻意的 —— 内容可能含敏感数据, 不复制到第二处)。
  const fileUndoStack = [];
  const UNDO_MAX = 20;
  const rememberUndo = (absPath) => {
    try {
      fileUndoStack.push({ path: absPath, snap: Snapshot.begin([absPath]), ts: Date.now() });
      if (fileUndoStack.length > UNDO_MAX) fileUndoStack.shift();
    } catch { /* 快照失败不阻断原操作 (回退能力降级, 不添堵) */ }
  };

  // 1. 读文件
  catalog.register({
    name: "read_file",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "读取文件内容。anchors=true 时每行带内容锚点 (形如 `12#a3f2| 原文`), 供 edit_lines 按行改。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径 (相对工作目录)" },
        anchors: { type: "boolean", description: "true = 返回带锚点的视图 (改代码前先取一次)" },
        start: { type: "number", description: "起始行 (1 基), 仅 anchors 模式" },
        end: { type: "number", description: "结束行, 仅 anchors 模式" },
      },
      required: ["path"],
    },
    execute: async (args, ctx) => {
      const p = safePath(rootDir, args.path, ctx);
      if (isProtectedRead(p)) {
        return JSON.stringify({ error: "受保护路径, 禁止读取 (审计锚点/凭证/含密钥配置)" });
      }
      if (!fs.existsSync(p)) return JSON.stringify({ error: `文件不存在: ${args.path}` });
      const content = fs.readFileSync(p, "utf8");
      // v1.0.9: 输出 PII 脱敏 (与 run_command/code_act 一致, 文件可能含密钥/手机号)
      const safe = scrubPII(content).cleaned.slice(0, 20000);
      // 架构优化 ⑩: 锚点视图 —— 模型改文件时只需引用 `行号#锚点`, 不必重打旧内容
      if (args.anchors === true) {
        return renderAnchored(safe, { start: args.start, end: args.end, maxLines: 2000 });
      }
      return safe;
    },
  });

  // 2. 写文件
  catalog.register({
    name: "write_file",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    description: "写入文件 (覆盖)。可用于创建/修改文件。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        content: { type: "string", description: "要写入的内容" },
      },
      required: ["path", "content"],
    },
    execute: async (args, ctx) => {
      // v1.0.9: 写入内容上限 512KB (防撑爆磁盘); 路径是目录时给友好错误
      const content = String(args.content ?? "");
      if (content.length > 512 * 1024) return JSON.stringify({ error: `写入内容过大 (>512KB, 当前 ${content.length} 字符)` });
      const p = safePath(rootDir, args.path, ctx);
      const blocked = binaryContainerHint(path.extname(p).toLowerCase());
      if (blocked) return JSON.stringify({ error: blocked });
      const sensitive = sensitiveWriteHint(p);
      if (sensitive) return JSON.stringify({ error: sensitive });
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        return JSON.stringify({ error: `目标是目录: ${args.path}` });
      }
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        rememberUndo(p); // 2026-10-24 (R2): 覆盖前留撤销点
        fs.writeFileSync(p, content, "utf8");
        rememberSessionWrite(p); // 2026-10-31: 会话内写过的脚本执行前需人工审批 (防 write+node 连招)
        const out = { ok: true, bytes: Buffer.byteLength(content) };
        // 写后自查 (2026-10-05, 与回合级后置校验**同源实现**): .js/.mjs/.cjs 且**无任何导出**时,
        //   回执带一行 selfcheck 提示 —— 否则模型写个没有 export 的 utils.js 也会宣称"已导出",
        //   下游 import 拿到 null。空内容/非 JS/有导出/有 module.exports 一律不出现。
        const selfcheck = jsExportSelfCheck(args.path, content);
        if (selfcheck) out.selfcheck = selfcheck;
        // 语法回执同理: 只报告, 失败不门控、不回滚、不改盘。
        if (JS_SELF_CHECK_EXT.has(path.extname(p).toLowerCase())) {
          try {
            const r = await jsSyntaxOutcome(p, { timeoutMs: DEFAULT_SYNTAX_TIMEOUT_MS });
            // 回执契约: syntax 是**单行文本** (闸门据此判定, 与 write 写后自查同口径)
            out.syntax = r && typeof r === "object" ? String(r.text || "") : String(r || "");
            if (r && typeof r === "object" && "ok" in r) out.syntax_ok = !!r.ok;
          } catch (e) { noteCatch(e); /* 自查故障不污染写入结果, 由校验层自行兜底 */ }
        }
        return JSON.stringify(out);
      } catch (e) {
        return JSON.stringify({ error: `写入失败: ${e.message}` });
      }
    },
  });

  // 2b. 追加文件 (2026-10-02 基线暴露缺口: 无追加能力时 agent 只能整体重写, 易丢原内容)
  catalog.register({
    name: "append_file",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    description: "向文件末尾追加内容 (不覆盖原文件)。文件不存在时等同创建。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        content: { type: "string", description: "要追加的内容 (追加在文件末尾)" },
      },
      required: ["path", "content"],
    },
    execute: async (args, ctx) => {
      const content = String(args.content ?? "");
      if (content.length > 512 * 1024) return JSON.stringify({ error: `追加内容过大 (>512KB, 当前 ${content.length} 字符)` });
      const p = safePath(rootDir, args.path, ctx);
      const blocked = binaryContainerHint(path.extname(p).toLowerCase());
      if (blocked) return JSON.stringify({ error: blocked });
      const sensitive = sensitiveWriteHint(p);
      if (sensitive) return JSON.stringify({ error: sensitive });
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        return JSON.stringify({ error: `目标是目录: ${args.path}` });
      }
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        // 已有内容且不以换行结尾时补一个换行, 避免追加粘到原末行
        let prefix = "";
        if (fs.existsSync(p)) {
          const old = fs.readFileSync(p, "utf8");
          if (old.length && !old.endsWith("\n")) prefix = "\n";
        }
        rememberUndo(p); // 2026-10-24 (R2): 追加前留撤销点
        fs.appendFileSync(p, prefix + content, "utf8");
        rememberSessionWrite(p); // 2026-10-31: 会话内写过的脚本执行前需人工审批
        return JSON.stringify({ ok: true, appended: Buffer.byteLength(content) });
      } catch (e) {
        return JSON.stringify({ error: `追加失败: ${e.message}` }); /* swallowed-ok(2026-11-03): 错误随工具返回值上报 */
      }
    },
  });

  // 架构优化 ⑩: 按内容锚点编辑 (与 write_file 共用撤销栈 / 会话写盘记账)
  registerAnchoredEditTools(catalog, { rootDir, rememberUndo });

  // 2c. 删除文件 (2026-10-02 基线暴露缺口: 无删除工具, agent 只能放弃或绕道)
  catalog.register({
    name: "delete_file",
    capability: { readOnly: false, riskLevel: "high", sideEffect: "workspace", destructive: true },
    description: "删除指定文件 (仅限工作区内, 不能删目录)。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "要删除的文件路径" } },
      required: ["path"],
    },
    execute: async (args, ctx) => {
      const p = safePath(rootDir, args.path, ctx);
      const sensitive = sensitiveWriteHint(p);
      if (sensitive) return JSON.stringify({ error: sensitive });
      if (!fs.existsSync(p)) return JSON.stringify({ error: `文件不存在: ${args.path}` });
      if (fs.statSync(p).isDirectory()) return JSON.stringify({ error: `目标是目录, 拒绝删除 (只支持文件): ${args.path}` });
      try {
        rememberUndo(p); // 2026-10-24 (R2): 删除前留撤销点 (undo_file 可恢复)
        fs.unlinkSync(p);
        return JSON.stringify({ ok: true, deleted: args.path, undo_hint: "可用 undo_file 恢复此文件" });
      } catch (e) {
        return JSON.stringify({ error: `删除失败: ${e.message}` });
      }
    },
  });

  // 2e. 移动/重命名文件 (2026-10-24 R3): 权限引擎 WRITE_EXEC_TOOLS 一直引用 move_file,
  //   但工具从未存在 —— 宣称面与实现面缺口。带撤销: 源/目标双双入撤销栈。
  catalog.register({
    name: "move_file",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    description: "移动或重命名文件 (源文件被移走, 目标获得内容)。目标已存在时覆盖。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "源文件路径 (相对工作目录)" },
        destination: { type: "string", description: "目标路径 (相对工作目录)" },
      },
      required: ["path", "destination"],
    },
    execute: async (args, ctx) => {
      const src = safePath(rootDir, args.path, ctx);
      const dst = safePath(rootDir, args.destination, ctx);
      const srcSensitive = sensitiveWriteHint(src);
      if (srcSensitive) return JSON.stringify({ error: srcSensitive });
      const dstSensitive = sensitiveWriteHint(dst);
      if (dstSensitive) return JSON.stringify({ error: dstSensitive });
      if (!fs.existsSync(src)) return JSON.stringify({ error: `源文件不存在: ${args.path}` });
      if (fs.statSync(src).isDirectory()) return JSON.stringify({ error: `源是目录, 只支持文件: ${args.path}` });
      if (src === dst) return JSON.stringify({ error: "源与目标相同" });
      try {
        rememberUndo(src);
        rememberUndo(dst);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
        rememberSessionWrite(dst); // 2026-10-31: 移入/改名后的脚本同属"会话内写过"
        return JSON.stringify({ ok: true, moved: args.path, to: args.destination, undo_hint: "可用 undo_file 撤销 (分别指定源/目标路径)" });
      } catch (e) {
        // rename 跨盘符会失败 (EXDEV): 退回复制+删除
        if (e && e.code === "EXDEV") {
          try {
            fs.copyFileSync(src, dst);
            fs.unlinkSync(src);
            rememberSessionWrite(dst); // 2026-10-31: 跨盘复制同属写入
            return JSON.stringify({ ok: true, moved: args.path, to: args.destination, via: "copy+delete (跨盘)" });
          } catch (e2) {
            return JSON.stringify({ error: `移动失败: ${e2.message}` });
          }
        }
        return JSON.stringify({ error: `移动失败: ${e.message}` });
      }
    },
  });

  // 2d. 撤销文件操作 (2026-10-24 R2): 按撤销栈回退最近一次写/删/追加
  //   write_file → 恢复覆盖前内容 (新建文件则删除); delete_file → 恢复原文件;
  //   append_file → 恢复追加前内容。栈上限 20, 仅内存 (进程退出即失)。
  catalog.register({
    name: "undo_file",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    description: "撤销最近一次文件写/删/追加操作 (恢复到操作前状态)。可指定 path 撤销该文件的最近一次操作, 省略则撤销全局最近一次。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "可选: 只撤销该文件的操作 (相对工作目录)" } },
    },
    execute: async (args, ctx) => {
      let entry = null;
      if (args && args.path) {
        const target = safePath(rootDir, args.path, ctx);
        for (let i = fileUndoStack.length - 1; i >= 0; i--) {
          if (fileUndoStack[i].path === target) { entry = fileUndoStack[i]; break; }
        }
        if (!entry) return JSON.stringify({ error: `该文件没有可撤销的操作记录: ${args.path} (撤销栈仅保留本次进程内最近 ${20} 条)` });
      } else {
        entry = fileUndoStack[fileUndoStack.length - 1];
        if (!entry) return JSON.stringify({ error: "撤销栈为空: 本次进程内没有可撤销的文件操作" });
      }
      const rb = Snapshot.rollback(entry.snap);
      // 无论成败都出栈 (半恢复状态重放同一快照无意义)
      const idx = fileUndoStack.indexOf(entry);
      if (idx >= 0) fileUndoStack.splice(idx, 1);
      if (!rb.ok) {
        return JSON.stringify({ ok: false, error: `回滚部分失败: ${rb.restored} 成功 / ${rb.failures.length} 失败`, failures: rb.failures });
      }
      return JSON.stringify({ ok: true, restored: entry.path, note: "文件已恢复到该次操作前状态" });
    },
  });

  // 3. 列目录
  catalog.register({
    name: "list_dir",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "列出目录内容 (文件名列表)。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "目录路径, 默认工作目录" } },
    },
    execute: async (args, ctx) => {
      // 2026-10-10 修复 (P0): 归一 args —— 无必填参数的工具被以 undefined/null 调用时,
      //   原先 `args.path` 直接 TypeError → [工具错误], 轨迹归因误记为"执行报错 × list_dir"。
      const a = (args && typeof args === "object") ? args : {};
      const p = safePath(rootDir, a.path || ".", ctx);
      if (!fs.existsSync(p)) {
        return JSON.stringify({ error: `目录不存在: ${a.path || "."}` });
      }
      if (!fs.statSync(p).isDirectory()) {
        // 目标是文件: 给可判读的业务错误 + 可行动的下一步 (而非崩溃/含糊失败)
        return JSON.stringify({ error: `目标是文件不是目录: ${a.path || "."}, 请改用 read_file 读取内容` });
      }
      const items = fs.readdirSync(p).map((f) => {
        const fp = path.join(p, f);
        const st = fs.statSync(fp);
        return `${st.isDirectory() ? "[D]" : "[F]"} ${f}`;
      });
      // 空目录返回可读标记: 空串会让"空结果"与"失败"无从区分
      return items.length ? items.join("\n") : "(空目录)";
    },
  });

  // 3b. 搜索文件 (glob/正则, 只读) — 2026-10-03 T2 能力提升
  // 上限: 4000 文件 / 深度 14, 防 glob 全库遍历拖垮事件循环
  catalog.register({
    name: "search_files",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "按文件名 glob (如 '*.js'、'src/**/*.ts') 或正则 (/pattern/flags) 在工作区搜索文件, 返回匹配的相对路径列表。只读, 不读文件内容。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "glob 模式 (如 *.js) 或 /正则/ 形式" },
        path: { type: "string", description: "搜索起始目录, 默认工作目录" },
        list_only: { type: "boolean", description: "true 只搜当前目录不递归, 默认 false" },
      },
      required: ["query"],
    },
    execute: async (args, ctx) => {
      const q = String(args.query || "").trim();
      if (!q) return JSON.stringify({ error: "query 不能为空" });
      const base = safePath(rootDir, args.path || ".", ctx);
      if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
        return JSON.stringify({ error: `目录不存在: ${args.path || "."}` });
      }
      // 正则形式: /pattern/flags; 否则按 glob
      let re = null;
      let glob = null;
      const reM = q.match(/^\/(.+)\/([a-z]*)$/);
      if (reM) {
        try { re = new RegExp(reM[1], reM[2] || ""); } catch { return JSON.stringify({ error: `非法正则: ${q}` }); }
      } else {
        glob = globToRegex(q);
      }
      const MAX_FILES = 4000;
      const MAX_DEPTH = 14;
      const out = [];
      const walk = (dir, depth) => {
        if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (out.length >= MAX_FILES) return;
          const fp = path.join(dir, e.name);
          const rel = path.relative(rootDir, fp).replace(/\\/g, "/");
          if (e.isDirectory()) {
            if (!args.list_only) walk(fp, depth + 1);
          } else if (e.isFile()) {
            if (re ? re.test(rel) : glob.test(rel)) out.push(rel);
          }
        }
      };
      walk(base, 0);
      if (!out.length) return "(无匹配文件)";
      return out.join("\n");
    },
  });

  // 8. 读图片 (多模态): 返回 base64 data URL, 供多模态模型视觉理解
  catalog.register({
    name: "read_image",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "读取图片文件, 返回 base64 data URL 供多模态模型理解图片内容 (需配置支持视觉的模型, 如 gpt-4o/qwen-vl/glm-4v)。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "图片文件路径 (相对工作目录)" } },
      required: ["path"],
    },
    execute: async (args) => {
      try {
        return imageFileToDataUrl(rootDir, args.path);
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    },
  });
}
