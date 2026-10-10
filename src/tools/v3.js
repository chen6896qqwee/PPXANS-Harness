// src/tools/v3.js - v3.0 新工具注册 (codex 对齐)
// repo_map(aider) / apply_patch(aider SR 编辑块+快照) / review_code(OCR 分级) / goal_board(OMH)
// 零运行时依赖; 全部走 ToolCatalog 标准注册 (权限引擎/钩子链自动织入)。
import fs from "node:fs";
import path from "node:path";
import { renderRepoMap } from "../repomap/index.js";
import { parseEditBlocks, applyAll, formatRetryFeedback, parseCodexPatch, PATCH_FORMAT_HELP, MISSING_TARGET_HELP, patchTargetPreview, looksLikePath, resolvePatchTargets } from "../edit/editblock.js";
import { Snapshot } from "../edit/snapshot.js";
import { runReview } from "../review/index.js";
import { jsExportSelfCheck } from "../core/postcondition.js";
import { safePath } from "./builtin.js";
import { GOAL_STATUSES } from "../evidence/index.js";
import { generateWiki, checkStaleness } from "../wiki/index.js";
import * as pwf from "../planning/pwf.js";

export function registerV3Tools(catalog, { rootDir, agent = null }) {
  // 0. repo_wiki — 代码库 Wiki (2026-10-02 吸收 ZCode repo-wiki): 架构文档 + file:line 绑定 + 敏感排除
  catalog.register({
    name: "repo_wiki",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    // 陈旧时自动刷新写入 docs/WIKI.md → 有工作区副作用, 不能声明 readOnly (诚实声明, ZCode 教训)
    description: "生成代码库 Wiki 架构文档: 按目录列出核心定义 (签名+file:line) + 模块依赖 mermaid 图; 敏感文件 (token/secret/credential/password 等) 自动排除。可选写入 docs/WIKI.md。",
    parameters: {
      type: "object",
      properties: {
        save: { type: "boolean", description: "是否写入 docs/WIKI.md (默认 false 只返回文本)" },
      },
    },
    execute: async (args) => {
      const out = path.join(rootDir, "docs", "WIKI.md");
      // ZCode 语义: 源码变化后 wiki 陈旧, 自动重生成而非返回过期内容
      const staleness = checkStaleness(out, rootDir);
      const w = generateWiki(rootDir, {});
      const summary = `文件 ${w.stats.files} · 定义 ${w.stats.defs} · 依赖边 ${w.stats.edges} · 敏感排除 ${w.sensitiveSkipped}`;
      if (args.save || staleness.stale) {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, w.text + "\n", "utf8");
        return `Wiki 已刷新写入 docs/WIKI.md (此前状态: ${staleness.reason}; ${summary})\n\n${w.text}`;
      }
      return `Wiki 概况 (${summary}; 上次生成于 docs/WIKI.md, ${staleness.reason}):\n\n${w.text}`;
    },
  });
  // 0b. usage_stats — 会话级使用统计 (2026-10-02 吸收 ZCode 使用统计: 模型消耗/调用次数)
  catalog.register({
    name: "usage_stats",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "查看本会话 LLM 使用统计: 调用次数 / token 消耗 / 按模型分解。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const s = agent?.usageStats;
      if (!s) return JSON.stringify({ calls: 0, tokens: 0, byModel: {} });
      return JSON.stringify({ calls: s.calls, tokens: s.tokens, byModel: s.byModel });
    },
  });
  // 0c. self_diagnose — 自诊断 (2026-10-03, "按症状下药"表自动化: 症状→根因→增强动作)
  catalog.register({
    name: "self_diagnose",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "Agent 自诊断: 从审计链/失败案例库/使用统计/任务基线聚合信号, 按症状输出根因与增强动作 (零 LLM, 确定性)。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const { diagnoseAgent } = await import("../services/diagnose.js");
      const d = diagnoseAgent({ dataDir: agent?.dataDir || path.join(rootDir, "data"), rootDir, usageStats: agent?.usageStats });
      return d.report;
    },
  });
  // 1. repo_map — 仓库地图 (PageRank 标识符排序, token 预算内渲染)
  catalog.register({
    name: "repo_map",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
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
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    description: "按 SEARCH/REPLACE 编辑块修改文件。输入含 <<<<<<< SEARCH / ======= / >>>>>>> REPLACE 的编辑文本, 支持多文件多块; 也接受 codex 风格 *** Begin Patch 统一 diff。比整体重写更省 token、更精准。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "含一个或多个 SEARCH/REPLACE 块的编辑文本 (或 *** Begin Patch 风格的统一 diff)" },
      },
      required: ["content"],
    },
    execute: async (args) => {
      const rawContent = String(args.content || "");
      // 2026-10-09: SR 解不出块时再看 codex 风格 —— 模型实测会吐 *** Begin Patch 统一 diff,
      //   旧实现在那种情况下只会回一句"未找到任何 SEARCH/REPLACE 块", 模型无从改写;
      //   权限层也因取不到落点而升级审批, headless 直接拒。这里把它还原成等价 SR 块走同一条应用路径。
      let blocks = parseEditBlocks(rawContent);
      if (!blocks.length) {
        const cx = parseCodexPatch(rawContent);
        if (cx.detected) {
          const kinds = [...new Set(cx.unsupported.map((u) => u.kind))];
          if (kinds.length) {
            // Delete / Move 刻意不猜: 猜错会动错文件, 而"删除"本就该由 delete_file 承担
            const extra = [];
            if (kinds.includes("Delete File")) extra.push("删除请改用 delete_file 工具");
            if (kinds.includes("Move")) extra.push("移动请分两步: 先 Add File 目标文件, 再 delete_file 源文件");
            return JSON.stringify({
              ok: false,
              error: `codex 补丁含暂不支持的段: ${kinds.join("、")}${extra.length ? " —— " + extra.join("; ") : ""}`,
              help: PATCH_FORMAT_HELP,
            });
          }
          if (cx.blocks.length) blocks = cx.blocks;
        }
      }
      if (!blocks.length) {
        return JSON.stringify({
          ok: false,
          error: "未找到任何 SEARCH/REPLACE 块 (也不像 codex 风格的 *** Begin Patch)",
          help: PATCH_FORMAT_HELP,
        });
      }
      // 缺目标: 三种合法写法 (path 参数 / SEARCH 上一行 / codex 表头) 都写进错误里, 让模型能自纠。
      // 注意不能用 parseEditBlocks 的 b.path 直接判空 —— 它会把 SEARCH 后紧跟的【代码行】当成路径,
      // 于是"缺目标"看起来像"有目标", 校验形同虚设。统一走 looksLikePath / resolvePatchTargets。
      const argPath = looksLikePath(args.path) ? String(args.path).trim() : null;
      const targets = resolvePatchTargets(rawContent, blocks);
      const resolved = blocks.map((b, i) => argPath || targets[i] || null);
      if (resolved.some((t) => !t)) {
        return JSON.stringify({
          ok: false,
          error: `补丁块缺少目标文件。实际收到: ${patchTargetPreview(rawContent)}\n${MISSING_TARGET_HELP}`,
          help: PATCH_FORMAT_HELP,
        });
      }
      blocks = blocks.map((b, i) => ({ ...b, path: resolved[i] }));
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
      // 写后自查 (2026-10-05): 每个文件的回执带一行 selfcheck (仅 .js/.mjs/.cjs 且无任何导出时)。
      //   与 write_file 同源实现 —— 新建/改写都算写过, 都该自查。
      const withSelfCheck = (res, file, content) => {
        const sc = jsExportSelfCheck(file, content);
        if (sc) res.selfcheck = sc;
        return res;
      };
      for (const { file, blocks: fblocks } of byFile.values()) {
        const abs = path.resolve(rootDir, file);
        if (!fs.existsSync(abs)) {
          // 只支持新建: 全部块 search 为空
          const allNew = fblocks.every((b) => !b.search.trim());
          if (!allNew) { results.push({ file, ok: false, error: "not-found: 文件不存在且存在非新建块" }); continue; }
          const content = fblocks.map((b) => b.replace).join("\n");
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content, "utf8");
          results.push(withSelfCheck({ file, ok: true, created: true }, file, content));
          continue;
        }
        let content = fs.readFileSync(abs, "utf8");
        const r = applyAll(content, fblocks, { fuzzy: true });
        if (!r.ok) {
          // 2026-10-10 修复: 此前漏传第 2 参 (当前文件内容), 于是 hint 的 ±5 行原文摘录
          //   永远渲染不出来 (formatRetryFeedback 里 fl 为空) —— 回灌提示只剩干巴巴一句
          //   "not-found", LLM 拿不到原文无从修正。补上真实文件内容。
          results.push({ file, ok: false, error: r.error, feedback: formatRetryFeedback(r.results, content) });
          continue;
        }
        fs.writeFileSync(abs, r.content, "utf8");
        results.push(withSelfCheck({ file, ok: true, blocks: fblocks.length }, file, r.content));
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
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
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
  // 2026-10-05: schema 不再用 enum 卡死大小写 —— store 的 normalizePriority/normalizeStatus 才是判定处。
  // 未知优先级/状态由 board 抛错 → 这里转成**可行动错误**回给模型, 而不是静默降档或整体抛异常。
  catalog.register({
    name: "goal_board",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    description: "目标看板: 记录/更新长期目标的优先级与状态 (pending/in_progress/blocked/done)。用户在 Web UI 看板实时可见。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "update", "list"], description: "add=新增 update=更新状态 list=列出" },
        id: { type: "string", description: "目标 id (update 时必填)" },
        title: { type: "string", description: "目标标题 (add 时必填)" },
        priority: { type: "string", description: "优先级 p0/p1/p2, 大小写均可 (未知值会被拒绝, 不静默降档)" },
        status: { type: "string", enum: [...GOAL_STATUSES], description: "新状态 (update 时必填)" },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const board = agent?.goalBoard;
      if (!board) return JSON.stringify({ ok: false, error: "目标看板未装配" });
      const a = args.action;
      if (a === "add") {
        if (!args.title) return JSON.stringify({ ok: false, error: "add 需要 title" });
        try {
          const before = board.count();
          const g = board.addGoal({ title: args.title, priority: args.priority });
          // 同标题会被认成既有目标 (不新增) —— 明说给模型, 免得它以为计划已扩展
          const already = board.count() === before;
          return JSON.stringify(already ? { ok: true, goal: g, already_present: true } : { ok: true, goal: g });
        } catch (e) {
          return JSON.stringify({ ok: false, error: e.message });
        }
      }
      if (a === "update") {
        if (!args.id || !args.status) return JSON.stringify({ ok: false, error: "update 需要 id + status" });
        try {
          const g = board.updateGoal(args.id, { status: args.status });
          if (!g) return JSON.stringify({ ok: false, error: `未知目标 id: ${args.id}` });
          return JSON.stringify({ ok: true, goal: g });
        } catch (e) {
          return JSON.stringify({ ok: false, error: e.message });
        }
      }
      const goals = board.list();
      const issues = board.loadIssues ? board.loadIssues() : [];
      const out = { ok: true, count: goals.length, goals, text: board.render() };
      // 盘上非规范行被修好但**明说** (不静默吞掉数据问题)
      if (issues.length) out.load_issues = issues;
      return JSON.stringify(out);
    },
  });

  // 5. plan_files — 三文件持久规划 (2026-10-06 吸收 planning-with-files 27k★)
  //    task_plan/findings/progress 落盘 .ppx/plan/, 计划在磁盘不在上下文,
  //    扛住压缩//clear/崩溃; SessionStart 与压缩摘要自动注入现场 (prompts._planContext)
  catalog.register({
    name: "plan_files",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    description: "三文件持久规划: 把任务计划/发现/进度写入 .ppx/plan/ (磁盘存续, 不随上下文压缩丢失)。长任务必须先 init, 每完成一步 update_step, 关键结论写 finding。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["init", "update_step", "finding", "progress", "read", "summary", "archive"], description: "init=新建三文件 update_step=更新步骤状态 finding=记发现 progress=记进度 read=读全文 summary=压缩摘要 archive=归档当前计划" },
        goal: { type: "string", description: "init 时: 任务目标" },
        steps: { type: "array", items: { type: "string" }, description: "init 时: 步骤列表 (每步精确可验证)" },
        step: { type: "number", description: "update_step 时: 步骤序号 (1-based)" },
        status: { type: "string", enum: ["pending", "done", "blocked"], description: "update_step 时: 新状态" },
        note: { type: "string", description: "update_step 备注 / finding 内容 / progress 内容" },
        text: { type: "string", description: "finding 或 progress 的正文" },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const root = rootDir;
      const a = args.action;
      if (a === "init") {
        const steps = Array.isArray(args.steps) ? args.steps.map(String).filter(Boolean) : [];
        if (!args.goal && !steps.length) return JSON.stringify({ error: "init 需要 goal 或 steps" });
        return JSON.stringify(pwf.initPlan(root, { goal: args.goal || "", steps }));
      }
      if (a === "update_step") {
        if (!args.step) return JSON.stringify({ error: "update_step 需要 step (1-based 序号)" });
        return JSON.stringify(pwf.updateStep(root, Number(args.step), args.status || "done", args.note || ""));
      }
      if (a === "finding") {
        if (!args.text && !args.note) return JSON.stringify({ error: "finding 需要 text" });
        return JSON.stringify(pwf.appendFinding(root, args.text || args.note));
      }
      if (a === "progress") {
        if (!args.text && !args.note) return JSON.stringify({ error: "progress 需要 text" });
        return JSON.stringify(pwf.appendProgress(root, args.text || args.note));
      }
      if (a === "read") return JSON.stringify(pwf.readAll(root));
      if (a === "summary") return pwf.summarize(root) || "当前无持久计划 (用 action=init 创建)";
      if (a === "archive") return JSON.stringify(pwf.archive(root));
      return JSON.stringify({ error: `未知 action: ${a}` });
    },
  });
}
