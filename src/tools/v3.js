// src/tools/v3.js - v3.0 新工具注册 (codex 对齐)
// repo_map(aider) / apply_patch(aider SR 编辑块+快照) / review_code(OCR 分级) / goal_board(OMH)
// 零运行时依赖; 全部走 ToolCatalog 标准注册 (权限引擎/钩子链自动织入)。
import fs from "node:fs";
import path from "node:path";
import { renderRepoMap } from "../repomap/index.js";
import { parseEditBlocks, applyAll, formatRetryFeedback } from "../edit/editblock.js";
import { Snapshot } from "../edit/snapshot.js";
import { runReview } from "../review/index.js";
import { safePath } from "./builtin.js";

export function registerV3Tools(catalog, { rootDir, agent = null }) {
  // 1. repo_map — 仓库地图 (PageRank 标识符排序, token 预算内渲染)
  catalog.register({
    name: "repo_map",
    description: "生成仓库地图: 按重要性(PageRank)列出代码标识符与结构骨架, 用于快速理解代码库。省 token, 优先于全量读目录。",
    parameters: {
      type: "object",
      properties: {
        root: { type: "string", description: "仓库根目录 (相对工作目录, 默认 .)" },
        token_budget: { type: "number", description: "渲染 token 预算 (默认 1024)" },
      },
      required: [],
    },
    execute: async (args) => {
      // 2026-09-18 修复 (P2): repo_map 原先对 args.root 无路径防护,
      //   绝对路径/.. 穿越可枚举工作区外任意目录的结构与标识符 (信息泄露面)。
      //   现与 write_file/apply_patch 同一安全不变量: safePath 前缀 + realpath 双校验。
      try {
        safePath(rootDir, args.root || ".");
      } catch (e) {
        return JSON.stringify({ error: `路径被拒绝: ${e.message}` });
      }
      const root = path.resolve(rootDir, args.root || ".");
      if (!fs.existsSync(root)) return JSON.stringify({ error: `目录不存在: ${args.root}` });
      try {
        const map = renderRepoMap(root, { tokenBudget: Number(args.token_budget) || 1024 });
        return JSON.stringify({ stats: map.stats, text: map.text });
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    },
  });

  // 2. apply_patch — SR 编辑块应用 (aider 语义: SEARCH/REPLACE + 快照回滚)
  catalog.register({
    name: "apply_patch",
    description: "按 SEARCH/REPLACE 编辑块修改文件。输入含 <<<<<<< SEARCH / ======= / >>>>>>> REPLACE 的编辑文本, 支持多文件多块。比整体重写更省 token、更精准。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "含一个或多个 SEARCH/REPLACE 块的编辑文本" },
      },
      required: ["content"],
    },
    execute: async (args) => {
      const blocks = parseEditBlocks(String(args.content || ""));
      if (!blocks.length) return JSON.stringify({ error: "未找到任何 SEARCH/REPLACE 块" });
      // 路径防护 (2026-09-18 修复 P1): 原实现直接 path.resolve(rootDir, b.path) 后写盘,
      //   SEARCH/REPLACE 块携带绝对路径 (D:\...) 或 ..\..\ 穿越路径时可写工作区外任意文件,
      //   且目标路径藏在 content 字符串里, permissions 的 findEscape 也看不见。
      //   现统一走 safePath (前缀 + realpath 双重校验), 与 write_file 同一安全不变量。
      try {
        for (const b of blocks) safePath(rootDir, b.path);
      } catch (e) {
        return JSON.stringify({ error: `路径被拒绝: ${e.message}` });
      }
      // 快照所有目标文件 (回滚保险)
      const snapPaths = [...new Set(blocks.map((b) => path.resolve(rootDir, b.path)))];
      const snap = Snapshot.begin(snapPaths);
      const byFile = new Map();
      for (const b of blocks) {
        const key = path.resolve(rootDir, b.path);
        if (!byFile.has(key)) byFile.set(key, { file: b.path, blocks: [] });
        byFile.get(key).blocks.push(b);
      }
      const results = [];
      for (const { file, blocks: fblocks } of byFile.values()) {
        const abs = path.resolve(rootDir, file);
        if (!fs.existsSync(abs)) {
          // 只支持新建: 全部块 search 为空
          const allNew = fblocks.every((b) => !b.search.trim());
          if (!allNew) { results.push({ file, ok: false, error: "not-found: 文件不存在且存在非新建块" }); continue; }
          const content = fblocks.map((b) => b.replace).join("\n");
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content, "utf8");
          results.push({ file, ok: true, created: true });
          continue;
        }
        let content = fs.readFileSync(abs, "utf8");
        const r = applyAll(content, fblocks, { fuzzy: true });
        if (!r.ok) {
          results.push({ file, ok: false, error: r.error, feedback: formatRetryFeedback(r.results) });
          continue;
        }
        fs.writeFileSync(abs, r.content, "utf8");
        results.push({ file, ok: true, blocks: fblocks.length });
      }
      const failed = results.filter((r) => !r.ok);
      // 任一失败 → 整体回滚 (aider: 原子性优先), 回灌反馈交给 LLM 修复
      if (failed.length) {
        try { Snapshot.rollback(snap); } catch {}
        return JSON.stringify({ ok: false, rolled_back: true, results, retry_hint: "请根据 feedback 修正 SEARCH 块后重试" });
      }
      return JSON.stringify({ ok: true, files: results.length, blocks: blocks.length, results });
    },
  });

  // 3. review_code — 分级代码审查 (OCR 五阶段: plan→group→review→relocate→filter)
  catalog.register({
    name: "review_code",
    description: "对指定文件(或最近变更)执行分级审查, 输出 P0/P1/P2 问题清单 (密钥泄漏/调试残留/空 catch 等)。结果同步到 Web UI 审查面板。",
    parameters: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, description: "待审查文件路径列表 (相对工作目录)" },
        diff: { type: "string", description: "可选: 直接传 diff 文本" },
      },
      required: [],
    },
    execute: async (args) => {
      let { files = [], diff = null } = args || {};
      if (!files.length && !diff) {
        // 兜底: 用 traces 里最近的写操作文件
        const recent = (agent?.traces?.read?.("write_file", 10) || []);
        files = recent.map((t) => t.args?.path).filter(Boolean);
      }
      const out = runReview({ files, diff });
      // 报告存到 agent, Web UI /api/review/latest 直接读
      if (agent) agent._lastReview = { issues: out.issues, report: out.report, ts: Date.now() };
      return JSON.stringify({ ok: true, total: out.issues.length, issues: out.issues, report: out.report });
    },
  });

  // 4. goal_board — 目标看板 (OMH goal board: 增删改查 + 只读渲染)
  catalog.register({
    name: "goal_board",
    description: "目标看板: 记录/更新长期目标的优先级与状态 (pending/in_progress/blocked/done)。用户在 Web UI 看板实时可见。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "update", "list"], description: "add=新增 update=更新状态 list=列出" },
        id: { type: "string", description: "目标 id (update 时必填)" },
        title: { type: "string", description: "目标标题 (add 时必填)" },
        priority: { type: "string", enum: ["p0", "p1", "p2"], description: "优先级 (add 可选)" },
        status: { type: "string", enum: ["pending", "in_progress", "blocked", "done"], description: "新状态 (update 时必填)" },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const board = agent?.goalBoard;
      if (!board) return JSON.stringify({ error: "目标看板未装配" });
      const a = args.action;
      if (a === "add") {
        if (!args.title) return JSON.stringify({ error: "add 需要 title" });
        const g = board.addGoal({ title: args.title, priority: args.priority || "p2" });
        return JSON.stringify({ ok: true, goal: g });
      }
      if (a === "update") {
        if (!args.id || !args.status) return JSON.stringify({ error: "update 需要 id + status" });
        const ok = board.updateStatus(args.id, args.status);
        return JSON.stringify({ ok });
      }
      return JSON.stringify({ ok: true, goals: board.list(), text: board.render() });
    },
  });
}
