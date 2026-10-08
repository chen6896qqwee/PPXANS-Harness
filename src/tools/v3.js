// src/tools/v3.js - v3.0 新工具注册 (codex 对齐)
// repo_map(aider) / apply_patch(aider SR 编辑块+快照) / review_code(OCR 分级) / goal_board(OMH)
// 零运行时依赖; 全部走 ToolCatalog 标准注册 (权限引擎/钩子链自动织入)。
import fs from "node:fs";
import path from "node:path";
import { renderRepoMap } from "../repomap/index.js";
import { parseEditBlocks, parseCodexPatch, applyAll, formatRetryFeedback, PATCH_FORMAT_HELP, MISSING_TARGET_HELP, patchTargetPreview } from "../edit/editblock.js";
import { Snapshot } from "../edit/snapshot.js";
import { runReview } from "../review/index.js";
import { safePath, jsExportSelfCheck } from "./builtin.js";
import { generateWiki, checkStaleness } from "../wiki/index.js";
import { debug } from "../utils/logger.js";

export function registerV3Tools(catalog, { rootDir, agent = null }) {
  // 0. repo_wiki — 代码库 Wiki (2026-10-02 吸收 ZCode repo-wiki): 架构文档 + file:line 绑定 + 敏感排除
  catalog.register({
    name: "repo_wiki",
    // 陈旧时自动刷新写入 docs/WIKI.md → 有工作区副作用, 不能声明 readOnly (诚实声明, ZCode 教训)
    capability: { riskLevel: "low", readOnly: false, destructive: false, sideEffect: "workspace" },
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
      const d = diagnoseAgent({
        dataDir: agent?.dataDir || path.join(rootDir, "data"),
        rootDir,
        usageStats: agent?.usageStats,
        // 记忆管线健康度 (2026-10-03 接线): MemoryHealthMonitor 曾装配却零消费, 现作为诊断信号源
        health: agent?.memoryHealth && typeof agent.memoryHealth.status === "function" ? agent.memoryHealth.status() : null,
      });
      return d.report;
    },
  });
  // 1. repo_map — 仓库地图 (PageRank 标识符排序, token 预算内渲染)
  catalog.register({
    name: "repo_map",
    // 只读: 扫目录 + 渲染地图, 不写盘 (2026-09-18 修复后路径也锁在工作区内)
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
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
    // F1 定档说明 (勿改): medium = 默认(workspace-write)模式**不**因此升级审批 ——
    // 免审批仍由 permissions 的 WORKSPACE_AUTO_TOOLS/patchWorkspaceStatus 按"落点能否自证
    // 在工作区内"裁定 (越界/unprovable 照旧 ask)。声明 high 会让工作区内合规补丁也被
    // 能力门拦下, 直接推翻 2026-10-05 那次 headless 编辑可用性修复。
    // 但必须非只读: plan 模式拒绝它, 「只读巡检」档位升级审批 (旧兜底报 readOnly:true 放行)。
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "workspace" },
    description:
      "按 SEARCH/REPLACE 编辑块修改文件, 精确局部编辑, 比整体重写省 token。块格式 (支持多块多文件):\n" +
      "文件名.js        <- 可选: 写在 <<<<<<< SEARCH 上一行; 省略则用 path 参数\n" +
      "<<<<<<< SEARCH\n原文 (须精确匹配文件现有内容)\n=======\n新文\n>>>>>>> REPLACE\n" +
      "新建文件: SEARCH 留空 + 文件不存在。行内路径 (紧跟 SEARCH 的裸文件名行) 仍兼容。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "含一个或多个 SEARCH/REPLACE 块的编辑文本" },
        path: { type: "string", description: "块内未写文件名时的目标文件 (相对工作目录); 每块也可自带文件名" },
      },
      required: ["content"],
    },
    execute: async (args) => {
      const content = String(args.content || "");
      let parsed = parseEditBlocks(content);
      if (!parsed.length) {
        // 模型还会吐第三种格式 (codex 统一 diff)。只有 SR 解析出 0 块时才进这条分支 ——
        // SEARCH/REPLACE 主路径的行为与代码完全不变。
        const codex = parseCodexPatch(content);
        if (codex.unsupported.length) {
          // 认不出的段 (Delete/Move/裸正文): 整份拒绝, 不"猜着应用"半个补丁
          return JSON.stringify({
            ok: false,
            error: `补丁含无法应用的段: ${codex.unsupported.map((u) => `${u.kind}(${u.detail})`).slice(0, 3).join("; ")}`,
            help: PATCH_FORMAT_HELP,
          });
        }
        if (codex.blocks.length) parsed = codex.blocks;
      }
      if (!parsed.length) {
        return JSON.stringify({
          ok: false,
          error: "未解析出任何编辑块: content 既没有 SEARCH/REPLACE 块, 也不是 *** Begin Patch 风格的补丁",
          help: PATCH_FORMAT_HELP,
        });
      }
      // 2026-10-05: 解析器不再强制吞首行当路径; 无路径块兜底到 args.path (与
      // permissions collectPatchPaths 同源口径, 两边看到的落点一致)。
      const argsPath = typeof args.path === "string" ? args.path.trim() : "";
      const blocks = parsed.map((b) => (b.path ? b : { ...b, path: argsPath }));
      if (blocks.some((b) => !b.path)) {
        // 与权限层 unprovable 文案同源 (editblock.MISSING_TARGET_HELP): 三种合法写法点名 +
        // 实际收到的前两行内容, headless 下模型拿到即可改写 (2026-10-05)。
        return JSON.stringify({ error: MISSING_TARGET_HELP + " 收到的内容前两行: " + patchTargetPreview(content) });
      }
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
          // 写后自查 (与 write_file 同源, 只报告不门控): 新建无导出的 .js 时提示一句
          const scNew = jsExportSelfCheck(abs, content);
          results.push(scNew ? { file, ok: true, created: true, selfcheck: scNew } : { file, ok: true, created: true });
          continue;
        }
        let content = fs.readFileSync(abs, "utf8");
        const r = applyAll(content, fblocks, { fuzzy: true });
        if (!r.ok) {
          // 带上当前文件内容: formatRetryFeedback 的最佳匹配窗口摘录 (±5 行原文) 依赖它,
          // 2026-10-02 特性此前因没传而实际退化成了无摘录版
          results.push({ file, ok: false, error: r.error, feedback: formatRetryFeedback(r.results, content) });
          continue;
        }
        fs.writeFileSync(abs, r.content, "utf8");
        const scEd = jsExportSelfCheck(abs, r.content);
        results.push(scEd ? { file, ok: true, blocks: fblocks.length, selfcheck: scEd } : { file, ok: true, blocks: fblocks.length });
      }
      const failed = results.filter((r) => !r.ok);
      // 任一失败 → 整体回滚 (aider: 原子性优先), 回灌反馈交给 LLM 修复
      if (failed.length) {
        try { Snapshot.rollback(snap); } catch (e) { debug(`[tools/v3] 已忽略异常: ${e && e.message ? e.message : e}`); }
        return JSON.stringify({ ok: false, rolled_back: true, results, retry_hint: "请根据 feedback 修正 SEARCH 块后重试" });
      }
      return JSON.stringify({ ok: true, files: results.length, blocks: blocks.length, results });
    },
  });

  // 3. review_code — 分级代码审查 (OCR 五阶段: plan→group→review→relocate→filter)
  catalog.register({
    name: "review_code",
    // 只读: 读文件/算 diff 做静态审查; 结果只挂在 agent 内存字段 (agent._lastReview), 不落盘
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
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

  // 4. goal_board — 目标看板 (OMH goal board: 计划台账, 增/改/查 + 渲染)
  // 2026-10-05: 修 "每次调用都抛错" 的死工具 —— 旧 execute 调 board.addGoal({title, priority})
  //   而不给 id, 旧 store 里 `if (!id) throw new Error("addGoal 需要 id")` → 真实调用 100% 失败,
  //   全仓没有任何地方生成 id。id 现由 src/evidence 生成 (shortId("g_")), 调用方无需再传;
  //   优先级/状态的归一与非法值判定也统一收到 store 那一层 (旧实现在这里塞 "p2" 默认值,
  //   而 store 的 PRIORITY_RANK 键是大写 → "p0" 被静默降成最低档, 计划顺序悄悄错掉)。
  catalog.register({
    name: "goal_board",
    // action=add/update 会改写看板状态 (list 只读), 但 capability 是静态声明 ——
    // 按最坏动作定档: 非只读 (plan 模式拒绝, 只读巡检升级审批)。
    // sideEffect=memory: 写的是 agent 自己的数据目录 (dataDir/evidence/goals.json), 不动工作区。
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "memory" },
    description: "目标看板: 多步任务的计划台账 (持久化, 重启不丢)。add 记录一步, update 改优先级/状态 (pending/in_progress/blocked/done), list 回看全表。开工前用它列步骤, 每完成一步就 update —— 不要凭记忆重排计划。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "update", "list"], description: "add=新增 update=改状态/优先级 list=列出" },
        id: { type: "string", description: "目标 id (update 必填; add 可省略 —— 省略则由看板生成)" },
        title: { type: "string", description: "目标标题 (add 必填; 同标题不会重复成两条)" },
        // 不再列 enum: 大小写都由 store 归一并校验 (enum 会让模型写 "P0" 直接被参数层拒掉,
        // 而真正该拒绝的是"未知值" —— 那一层在 normalizePriority, 报错带可行动的候选值)
        priority: { type: "string", description: "优先级 p0/p1/p2 (大小写均可; 省略=p2)" },
        status: { type: "string", enum: ["pending", "in_progress", "blocked", "done"], description: "状态 (add 可选; update 常用)" },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const board = agent?.goalBoard;
      if (!board) return JSON.stringify({ ok: false, error: "目标看板未装配" });
      const a = args.action;
      // store 层用 throw 表达"值不合法/看板已满" (见 src/evidence normalizePriority):
      // 这里收成 {ok:false, error} 返回给模型 —— 响亮但不崩会话。
      try {
        if (a === "add") {
          if (!args.title) return JSON.stringify({ ok: false, error: "add 需要 title" });
          // 锁外的预检只用于给模型一句实话 (是否命中了既有目标);
          // 真正的去重在看板锁内并集之后做, 所以跨进程同时 add 同标题也只有一条。
          const existed = typeof board.findGoalByTitle === "function" ? board.findGoalByTitle(args.title) : null;
          const g = board.addGoal({ id: args.id, title: args.title, priority: args.priority, status: args.status });
          return JSON.stringify({
            ok: true,
            goal: g,
            already_present: !!existed && existed.id === g?.id,
            hint: existed && existed.id === g?.id
              ? "同标题目标已在看板上, 未重复添加; 要改状态用 action=update + id"
              : "已持久化; 继续用 add 补齐其余步骤",
          });
        }
        if (a === "update") {
          if (!args.id) return JSON.stringify({ ok: false, error: "update 需要 id" });
          const patch = {};
          if (args.status) patch.status = args.status;
          if (args.priority) patch.priority = args.priority;
          if (args.title) patch.title = args.title;
          if (!Object.keys(patch).length) {
            return JSON.stringify({ ok: false, error: "update 需要 status / priority / title 至少一项" });
          }
          const g = board.updateGoal
            ? board.updateGoal(args.id, patch)
            : (patch.status ? board.updateStatus(args.id, patch.status) : null);
          if (!g) return JSON.stringify({ ok: false, error: `未找到目标 id=${String(args.id).slice(0, 40)} (先 action=list 取现有 id)` });
          return JSON.stringify({ ok: true, goal: g });
        }
        const goals = board.list();
        const issues = typeof board.loadIssues === "function" ? board.loadIssues() : [];
        return JSON.stringify({
          ok: true,
          count: goals.length,
          goals,
          text: board.render(),
          // 盘上被就地修好的非规范字段 (手写/旧版数据) —— 显式带回, 不做静默规范化
          ...(issues.length ? { load_issues: issues } : {}),
        });
      } catch (e) {
        return JSON.stringify({ ok: false, error: (e && e.message ? String(e.message) : String(e)).slice(0, 300) });
      }
    },
  });
}
