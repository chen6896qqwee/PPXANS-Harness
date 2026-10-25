// src/evolve/selfiterate.js - 自主迭代进化引擎 (2026-10-25)
//
// 定位: 在既有「自愈内核」(损坏修复/崩溃恢复) 与「行为进化」(经验提炼/技能沉淀) 之上,
//       补上**对自己代码库的可验证自改进闭环** —— 这是"自主迭代/自主优化自己架构和代码"
//       的最小可审计实现:
//
//   发现 → 诊断 → 补丁 → 验证 → 沉淀/回滚
//   ─────  ─────  ─────  ─────  ──────────
//   ① 跑目标测试 (node --test, TAP 解析失败项)
//   ② 失败测试 + 关联源码喂 LLM, 要求输出 SEARCH/REPLACE 补丁 (项目既有 editblock 格式)
//   ③ 快照目标文件 → 应用补丁 (多块全成或全不落盘)
//   ④ 重跑同一测试: 绿 = 保留 + 审计链 + EQ 事件 + playbook 沉淀
//                   红 = Snapshot 整体回滚 + 故障病历, 绝不带着未验证的修改离场
//
// 安全边界 (每一道都有测试钉住):
//   · 双模式: mode="propose" (默认, 只出补丁不动盘) / "apply" (显式配置才落盘)
//   · 只改 root 内的 .js 源码文件 (路径规范化后必须落在 root 之内, 防 ../ 逃逸)
//   · 默认不碰测试文件 (allow_test_edit 才放开 —— 修代码不修考卷)
//   · 每轮 LLM 调用上限 max_llm_calls / 每文件重试上限 max_attempts
//   · 每文件测试超时 test_timeout_ms, 子进程强杀不悬挂
//   · 全程审计链 append (含补丁摘要), 进化不再是黑箱
//   · 无 LLM 时安全跳过 (离线零依赖语义不变)
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseEditBlocks, applyEditBlock } from "../edit/editblock.js";
import { Snapshot } from "../edit/snapshot.js";
import { info, warn } from "../utils/logger.js";

// ---- TAP 输出解析: node --test --test-reporter=tap ----
// 返回 { ok, total, failed: [测试名], raw }
export function parseTap(tapText) {
  const text = String(tapText || "");
  const failed = [];
  for (const m of text.matchAll(/^not ok\s+\d+\s+-\s+(.+)$/gm)) {
    failed.push(m[1].trim());
  }
  const totalM = /^# (?:tests|test)\s+(\d+)/m.exec(text);
  const passM = /^# pass\s+(\d+)/m.exec(text);
  const failM = /^# fail\s+(\d+)/m.exec(text);
  const failCount = failM ? Number(failM[1]) : failed.length;
  const passCount = passM ? Number(passM[1]) : 0;
  return {
    ok: failCount === 0,
    total: totalM ? Number(totalM[1]) : passCount + failCount,
    pass: passCount,
    fail: failCount,
    failed,
  };
}

// ---- 子进程跑测试 (单文件, 带超时强杀) ----
// 环境清洗: 本引擎常在 node --test 内被调用 (selfiterate 的回归测试就是), 外层 runner
//   会给子进程注入 NODE_TEST_CONTEXT/NODE_OPTIONS, 嵌套 node --test 被污染后输出错乱
//   (实测表现为失败测试被判 already-green)。这里显式剥离, 保证嵌套运行语义独立。
export function runTestFile(testFile, { cwd = process.cwd(), timeoutMs = 60000, extraArgs = [] } = {}) {
  return new Promise((resolve) => {
    const args = ["--test", "--test-reporter=tap", ...extraArgs, testFile];
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true });
    let out = "";
    let timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      out += "\n# timeout-killed";
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e), tap: null }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, tap: parseTap(out) });
    });
  });
}

// ---- 测试文件 → 关联源码文件 (静态 import 分析) ----
// 解析 test 里的 ../src/**/*.js 引用, 返回 root 内存在的绝对路径。
export function relatedSources(testFile, root) {
  const src = fs.readFileSync(testFile, "utf8");
  const out = new Set();
  for (const m of src.matchAll(/from\s+["'](\.[^"']+\.js)["']/g)) {
    const rel = m[1];
    const abs = path.resolve(path.dirname(testFile), rel);
    if (abs.startsWith(path.resolve(root)) && fs.existsSync(abs)) out.add(abs);
  }
  return [...out];
}

// ---- 路径安全: 补丁目标必须落在 root 内且是 .js ----
function safeTarget(p, root, { allowTestEdit = false, testFile = null } = {}) {
  const abs = path.resolve(root, p);
  if (!abs.startsWith(path.resolve(root) + path.sep) && abs !== path.resolve(root)) return null;
  if (!abs.endsWith(".js")) return null;
  if (!allowTestEdit && testFile && abs === path.resolve(testFile)) return null;
  return abs;
}

const SYSTEM_PROMPT = [
  "你是资深 Node.js 工程师, 负责修复失败测试对应的源码缺陷。",
  "规则:",
  "1) 只修源码, 不修改测试文件 (测试是考卷)。",
  "2) 用 SEARCH/REPLACE 块输出补丁, 每块格式:",
  "<<<<<<< SEARCH",
  "相对路径/文件名",
  "要替换的旧代码 (必须与文件内容逐字一致, 含缩进)",
  "=======",
  "新代码",
  ">>>>>>> REPLACE",
  "3) 可输出多个块 (同文件多处或不同文件, 每块自带文件名行)。",
  "4) 最小改动: 不重构无关代码, 不改导出签名。",
  "5) 先输出一段不超过 3 行的诊断, 然后直接给补丁块, 不要多余解释。",
].join("\n");

export class SelfIterationEngine {
  constructor(agent, config = {}) {
    this.agent = agent;
    this.root = config.root || agent?.root || process.cwd();
    this.mode = config.mode === "apply" ? "apply" : "propose";
    this.maxFiles = Number(config.max_files) || 3;          // 每轮最多处理几个失败测试文件
    this.maxAttempts = Number(config.max_attempts) || 2;    // 每文件最多补丁尝试轮数
    this.testTimeoutMs = Number(config.test_timeout_ms) || 60000;
    this.llmCallBudget = Number(config.max_llm_calls) || 6; // 每轮 LLM 调用上限
    this.allowTestEdit = !!config.allow_test_edit;
    this.logFile = config.log_file || path.join(agent?.dataDir || this.root, "evolve", "selfiterate.jsonl");
    this._llmCalls = 0;
  }

  // 主入口: targetFiles = 要跑的测试文件列表 (绝对/相对 root)
  async run({ targetFiles = [], onEvent = null } = {}) {
    const ev = (type, payload) => { if (onEvent) { try { onEvent(type, payload); } catch {} } };
    const files = (targetFiles.length ? targetFiles : []).map((f) => path.resolve(this.root, f));
    if (!files.length) return { ran: false, reason: "no target files" };
    const llm = this.agent?.llm;
    if (!llm || typeof llm.chat !== "function") {
      return { ran: false, reason: "无 LLM, 自主迭代跳过 (离线安全语义)" };
    }
    const summary = { ran: true, mode: this.mode, files: [], fixed: 0, rolledBack: 0, proposed: 0, skipped: 0 };
    for (const tf of files.slice(0, this.maxFiles)) {
      const first = await runTestFile(tf, { cwd: this.root, timeoutMs: this.testTimeoutMs });
      if (first.tap?.ok) { summary.files.push({ file: tf, result: "already-green" }); continue; }
      const fileReport = await this._fixOne(tf, first, ev);
      summary.files.push(fileReport);
      if (fileReport.result === "fixed") summary.fixed++;
      else if (fileReport.result === "rolled-back") summary.rolledBack++;
      else if (fileReport.result === "proposed") summary.proposed++;
      else summary.skipped++;
      if (this._llmCalls >= this.llmCallBudget) {
        warn("[selfiterate] LLM 调用预算用尽, 停止本轮");
        break;
      }
    }
    this._record(summary);
    ev("selfiterate/done", summary);
    return summary;
  }

  async _fixOne(testFile, firstRun, ev) {
    const report = { file: testFile, result: "skipped", attempts: [] };
    const llm = this.agent.llm;
    const sources = relatedSources(testFile, this.root);
    if (!sources.length) {
      report.reason = "测试文件未引用可定位的源码";
      return report;
    }
    for (let attempt = 1; attempt <= this.maxAttempts && this._llmCalls < this.llmCallBudget; attempt++) {
      // ① 组装上下文: 失败测试名 + 源码全文 (截断)
      const ctx = [
        `失败测试文件: ${path.relative(this.root, testFile)}`,
        `失败用例 (${firstRun.tap.failed.length}):`,
        ...firstRun.tap.failed.slice(0, 10).map((n) => `- ${n}`),
        "",
        "相关源码:",
        ...sources.map((s) => `--- ${path.relative(this.root, s)} ---\n${fs.readFileSync(s, "utf8").slice(0, 12000)}`),
      ].join("\n");

      // ② 诊断 + 补丁
      let reply = "";
      try {
        this._llmCalls++;
        const r = await llm.chat([
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: ctx },
        ], { timeoutMs: 120000, retryMax: 1 });
        reply = String(r?.content || r || "");
      } catch (e) {
        report.attempts.push({ attempt, error: `LLM 调用失败: ${e.message}` });
        break;
      }
      const blocks = parseEditBlocks(reply);
      if (!blocks.length) {
        report.attempts.push({ attempt, error: "LLM 未输出可解析的 SEARCH/REPLACE 块" });
        continue;
      }

      // ③ propose 模式: 只出补丁不动盘
      if (this.mode === "propose") {
        report.result = "proposed";
        report.attempts.push({ attempt, blocks: blocks.length, patch: reply.slice(0, 4000) });
        break;
      }

      // ④ apply 模式: 快照 → 应用 → 验证 → 保留或回滚
      const targets = new Map(); // abs -> newContent
      let applyErr = null;
      for (const b of blocks) {
        const abs = safeTarget(b.path || sources[0], this.root, { allowTestEdit: this.allowTestEdit, testFile });
        if (!abs) { applyErr = `补丁目标不合法或不允许: ${b.path}`; break; }
        const cur = targets.get(abs) ?? fs.readFileSync(abs, "utf8");
        const applied = applyEditBlock(cur, b);
        if (!applied.ok) { applyErr = `SEARCH 未命中 (${path.relative(this.root, abs)}): ${applied.error || applied.kind}`; break; }
        targets.set(abs, applied.content);
      }
      if (applyErr || !targets.size) {
        report.attempts.push({ attempt, error: applyErr || "无有效落点" });
        continue;
      }
      const snap = Snapshot.begin([...targets.keys()]);
      for (const [abs, content] of targets) fs.writeFileSync(abs, content, "utf8");
      ev("selfiterate/patch-applied", { file: testFile, files: [...targets.keys()].map((p) => path.relative(this.root, p)) });
      const rerun = await runTestFile(testFile, { cwd: this.root, timeoutMs: this.testTimeoutMs });
      if (rerun.tap?.ok) {
        report.result = "fixed";
        report.attempts.push({ attempt, fixed: true, files: [...targets.keys()] });
        this._audit(true, { testFile: path.relative(this.root, testFile), files: [...targets.keys()].map((p) => path.relative(this.root, p)) });
        info(`[selfiterate] ✅ 自主修复: ${path.relative(this.root, testFile)} (第 ${attempt} 轮)`);
        return report;
      }
      // 红: 回滚 + 记病历, 绝不带伤离场 (回滚失败必须显式报警 —— 静默带伤比失败更危险)
      const rb = Snapshot.rollback(snap);
      if (!rb?.ok) {
        warn(`[selfiterate] ⚠ 回滚不完整 (${rb?.restored ?? 0}/${snap.entries.size}): ${JSON.stringify(rb?.failures || [])}`);
        report.attempts.push({ attempt, rollbackFailures: rb?.failures || [] });
      }
      this._audit(false, { testFile: path.relative(this.root, testFile), reason: "重跑仍红, 已回滚" });
      report.attempts.push({ attempt, fixed: false, rerunFail: rerun.tap?.fail ?? "?", rolledBack: true });
      firstRun = rerun; // 下一轮用最新失败信息
      ev("selfiterate/rolled-back", { file: testFile, attempt });
    }
    return report;
  }

  _audit(ok, args) {
    try {
      this.agent?.audit?.append?.({ tool: "self_improve", args, ok, ms: 0 });
    } catch { /* 审计失败不阻断 */ }
    try {
      this.agent?.tracer?.event?.(ok ? "selfiterate/fixed" : "selfiterate/rollback", args);
    } catch {}
  }

  _record(summary) {
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, JSON.stringify({ ts: new Date().toISOString(), ...summary }) + "\n", "utf8");
    } catch { /* 记录失败不阻断 */ }
  }
}

// 便捷入口: 独立脚本/工具共用
export async function runSelfIteration(agent, opts = {}) {
  const cfg = { ...(agent?.config?.agent?.self_iteration || {}), ...opts };
  const engine = new SelfIterationEngine(agent, cfg);
  return engine.run({ targetFiles: cfg.target_files || [] });
}
