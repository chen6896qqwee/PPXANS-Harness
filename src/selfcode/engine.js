// src/selfcode/engine.js — 自改代码闭环引擎 (2026-10-27)
//
// 一句话: 让皮皮虾能**安全地改自己的源码** —— 改得进去、验得出来、坏得回滚、改过的有账。
//
//   解析补丁 → 边界校验 → 原子落盘 → 三关验证 → 绿保留 / 红回滚 → 记账 → 待生效标记
//   ────────   ────────   ────────   ────────   ─────────────────   ──────   ────────────
//
// 与既有能力的分工 (不重复造轮子):
//   · apply_patch (tools/v3.js)     —— 单次补丁应用, 不验证、不记账
//   · self_improve (evolve/)        —— 测试驱动、需要 LLM 出补丁
//   · selfcode (本模块)             —— 补丁由调用方给, 引擎负责**验证 + 回滚 + 账本**,
//                                      零 LLM, 每次落盘都留可恢复的快照
//
// 安全不变量 (每条都有测试钉住):
//   1) 目标必须落在 root 内 (guardPath, 双重规范化)
//   2) 默认不准改测试文件 —— 修代码不修考卷
//   3) 多块原子: 任一块匹配失败 → 整批不落盘 (不留半成品)
//   4) mode=propose 默认只出 diff, 不动盘; apply 需调用方 + config 双开
//   5) 验证红 → 从备份恢复, 绝不带着未验证的改动离场
//   6) 每次落盘前备份、落盘后记账, 账本 append-only
//   7) 改了 ESM 源码就标记 pending-reload —— 不谎称"已生效"
import fs from "node:fs";
import path from "node:path";
import { parseEditBlocks, applyAll, formatRetryFeedback, PATCH_FORMAT_HELP, parseCodexPatch, looksLikePath, resolvePatchTargets, patchTargetPreview, MISSING_TARGET_HELP } from "../edit/editblock.js";
import { SelfCodeLedger } from "./ledger.js";
import { guardPath, verifyChange } from "./verify.js";
import { info, warn } from "../utils/logger.js";

// ---- 紧凑 diff: 行数统计 + 变化预览 (不做完整 LCS, 够看就行) ----
export function compactDiff(before, after, maxPreview = 6) {
  const a = String(before ?? "").split("\n");
  const b = String(after ?? "").split("\n");
  const setA = new Map();
  for (const l of a) setA.set(l, (setA.get(l) || 0) + 1);
  let added = 0, removed = 0;
  const preview = [];
  for (const l of b) {
    const n = setA.get(l) || 0;
    if (n > 0) setA.set(l, n - 1);
    else { added++; if (preview.length < maxPreview) preview.push("+ " + l.slice(0, 160)); }
  }
  for (const [l, n] of setA) {
    if (n > 0) { removed += n; if (preview.length < maxPreview) preview.push("- " + l.slice(0, 160)); }
  }
  return { added, removed, linesBefore: a.length, linesAfter: b.length, preview };
}

function atomicWrite(abs, content) {
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = abs + ".ppx-selfcode-" + Math.random().toString(36).slice(2, 10);
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, abs);
}

export class SelfCodeEngine {
  /**
   * @param {object} opts
   * @param {string} opts.root        仓库根 (自改边界)
   * @param {string} opts.dataDir     账本与备份落点
   * @param {string} [opts.mode]      "propose"(默认, 不落盘) | "apply"
   * @param {boolean} [opts.allowTestEdit] 是否允许改测试文件
   * @param {number} [opts.syntaxTimeoutMs]
   * @param {number} [opts.testTimeoutMs]
   */
  constructor({ root, dataDir, mode = "propose", allowTestEdit = false, syntaxTimeoutMs = 5000, testTimeoutMs = 120000 } = {}) {
    this.root = path.resolve(root || process.cwd());
    this.mode = mode === "apply" ? "apply" : "propose";
    this.allowTestEdit = !!allowTestEdit;
    this.syntaxTimeoutMs = syntaxTimeoutMs;
    this.testTimeoutMs = testTimeoutMs;
    this.ledger = new SelfCodeLedger({ dataDir: dataDir || path.join(this.root, "data") });
  }

  // ---- 补丁 → 文件级新内容 (不落盘) ----
  // 返回 { ok, plans: [{rel, abs, before, after, diff}], blocks, failed, error? }
  plan(patchText) {
    const raw = String(patchText || "");
    let blocks = parseEditBlocks(raw);
    if (!blocks.length) {
      const cx = parseCodexPatch(raw);
      if (cx.detected) {
        const kinds = [...new Set((cx.unsupported || []).map((u) => u.kind))];
        if (kinds.length) {
          return { ok: false, error: `补丁含暂不支持的段: ${kinds.join("、")} (删除请用 delete_file; 移动请分两步)` };
        }
        blocks = cx.blocks || [];
      }
    }
    if (!blocks.length) {
      return { ok: false, error: "未找到任何 SEARCH/REPLACE 块 (也不像 codex 的 *** Begin Patch)", help: PATCH_FORMAT_HELP };
    }
    // 落点解析: 补丁里的路径 / 块上一行的文件名
    const targets = resolvePatchTargets(raw, blocks);
    const resolved = blocks.map((b, i) => (looksLikePath(b.path) ? b.path : targets[i] || null));
    if (resolved.some((t) => !t)) {
      return { ok: false, error: `补丁块缺少目标文件。实际收到: ${patchTargetPreview(raw)}\n${MISSING_TARGET_HELP}`, help: PATCH_FORMAT_HELP };
    }
    // 按目标分组 (同文件多块保序)
    const groups = new Map();
    blocks.forEach((b, i) => {
      const rel = String(resolved[i]).trim().replace(/^["']|["']$/g, "");
      if (!groups.has(rel)) groups.set(rel, []);
      groups.get(rel).push(b);
    });

    const plans = [];
    const failed = [];
    for (const [rel, bs] of groups) {
      const g = guardPath(this.root, rel, { allowTestEdit: this.allowTestEdit });
      if (!g.ok) { failed.push({ path: rel, error: g.error }); continue; }
      let before = "";
      try { before = fs.readFileSync(g.abs, "utf8"); } catch {
        failed.push({ path: rel, error: `文件不存在 (自改只改既有文件; 新建请用 write_file): ${rel}` });
        continue;
      }
      const applied = applyAll(before, bs.map((b) => ({ ...b, path: g.rel })));
      if (!applied.ok) {
        failed.push({
          path: rel,
          error: "补丁块匹配失败 (SEARCH 必须与文件内容逐字一致)",
          feedback: formatRetryFeedback(applied.results, before),
          blocks: applied.results.filter((r) => !r.ok).map((r) => ({ kind: r.kind, error: r.error })),
        });
        continue;
      }
      if (applied.content === before) {
        failed.push({ path: rel, error: "补丁应用后内容无变化 (SEARCH 与 REPLACE 相同?)" });
        continue;
      }
      plans.push({ rel: g.rel, abs: g.abs, before, after: applied.content, diff: compactDiff(before, applied.content) });
    }
    if (failed.length) {
      // 多块原子: 有任何一个文件失败, 整批不落盘 (不写半成品)
      return { ok: false, plans: [], failed, error: "补丁未能完整应用, 整批未落盘" };
    }
    return { ok: true, plans, blockCount: blocks.length, fileCount: plans.length };
  }

  /**
   * 主流程。
   * @param {object} req
   * @param {string} req.patch    SEARCH/REPLACE 或 codex 补丁文本
   * @param {string[]} [req.tests] 相对 root 的测试文件 (行为关)
   * @param {string} [req.mode]   覆盖实例 mode
   * @param {string} [req.reason] 自改理由 (记账用)
   */
  async run({ patch, tests = [], mode, reason = "" } = {}) {
    const started = Date.now();
    const effMode = mode === "apply" ? "apply" : mode === "propose" ? "propose" : this.mode;
    const testList = (Array.isArray(tests) ? tests : []).map(String).slice(0, 12);

    const planned = this.plan(patch);
    if (!planned.ok) {
      return { ok: false, stage: "plan", mode: effMode, error: planned.error, failed: planned.failed || null, help: planned.help || PATCH_FORMAT_HELP };
    }

    // propose: 只回 diff, 不动盘
    if (effMode !== "apply") {
      return {
        ok: true,
        stage: "propose",
        mode: "propose",
        applied: false,
        fileCount: planned.fileCount,
        files: planned.plans.map((p) => ({ path: p.rel, ...p.diff })),
        hint: "propose 模式只出 diff。要真正落盘+验证, 传 mode=\"apply\" (需 config agent.self_code.mode=\"apply\")",
      };
    }

    const id = this.ledger.nextId();
    const bk = this.ledger.backup(id, planned.plans.map((p) => ({ path: p.abs, content: p.before })));
    const fileBackups = bk.files; // 内联进账本, 回滚不再依赖目录重建
    if (!bk.ok) {
      return { ok: false, stage: "backup", mode: effMode, error: `备份失败, 拒绝落盘: ${JSON.stringify(bk.skipped)}` };
    }

    // 落盘 (原子写)
    const written = [];
    try {
      for (const p of planned.plans) { atomicWrite(p.abs, p.after); written.push(p.abs); }
    } catch (e) {
      // 落盘中途失败 → 立刻按备份恢复
      for (const entry of bk.files) {
        const orig = this.ledger.readBackup(id, entry);
        try {
          if (entry.existed && orig !== null) atomicWrite(entry.path, orig);
          else if (!entry.existed && fs.existsSync(entry.path)) fs.unlinkSync(entry.path);
        } catch {}
      }
      const rec = this.ledger.append({ id, ts: new Date().toISOString(), status: "write_failed", mode: effMode, reason, fileBackups, files: planned.plans.map((p) => p.rel), error: String(e?.message || e), durationMs: Date.now() - started });
      return { ok: false, stage: "write", mode: effMode, ledgerId: rec.id, error: `落盘失败已回滚: ${e?.message || e}` };
    }

    // 验证
    const verification = await verifyChange({
      root: this.root,
      changed: written,
      tests: testList,
      syntaxTimeoutMs: this.syntaxTimeoutMs,
      testTimeoutMs: this.testTimeoutMs,
    });

    if (!verification.ok) {
      // 红 → 整体回滚
      let restored = 0;
      const failures = [];
      for (const entry of bk.files) {
        const orig = this.ledger.readBackup(id, entry);
        try {
          if (entry.existed && orig !== null) { atomicWrite(entry.path, orig); restored++; }
          else if (!entry.existed) { if (fs.existsSync(entry.path)) fs.unlinkSync(entry.path); restored++; }
        } catch (e) { failures.push({ path: entry.path, error: String(e?.message || e) }); }
      }
      const rec = this.ledger.append({
        id, ts: new Date().toISOString(), status: "rolled_back", mode: effMode, reason, fileBackups,
        files: planned.plans.map((p) => ({ path: p.rel, added: p.diff.added, removed: p.diff.removed })),
        verify: { stage: verification.stage, summary: verification.summary, failedTests: verification.tests?.failed || [], syntaxFailed: verification.syntax?.failed || [] },
        rollback: { restored, failures },
        durationMs: Date.now() - started,
      });
      warn(`[selfcode] 自改验证失败, 已回滚 (${id}): ${verification.summary}`);
      return {
        ok: false,
        stage: "verify",
        mode: effMode,
        applied: false,
        rolledBack: true,
        ledgerId: rec.id,
        summary: verification.summary,
        syntax: verification.syntax,
        tests: verification.tests,
        rollback: { restored, failures },
        hint: "改动已全部回滚, 磁盘回到改动前状态。按失败信息修正补丁后重试。",
      };
    }

    // 绿 → 保留 + 记账 + 待生效标记
    const pending = this.ledger.markPending(written.map((p) => path.relative(this.root, p)), id);
    const rec = this.ledger.append({
      id, ts: new Date().toISOString(), status: "kept", mode: effMode, reason, fileBackups,
      files: planned.plans.map((p) => ({ path: p.rel, added: p.diff.added, removed: p.diff.removed, linesAfter: p.diff.linesAfter })),
      verify: { summary: verification.summary, stage: verification.stage, tests: verification.tests ? { pass: verification.tests.pass, total: verification.tests.total } : null },
      durationMs: Date.now() - started,
    });
    info(`[selfcode] 自改已落盘并验证通过 (${id}): ${planned.fileCount} 个文件`);
    return {
      ok: true,
      stage: "kept",
      mode: effMode,
      applied: true,
      ledgerId: rec.id,
      summary: verification.summary,
      files: planned.plans.map((p) => ({ path: p.rel, ...p.diff })),
      tests: verification.tests,
      reloadRequired: pending.files,
      hint: "代码已改并验证通过, 但当前进程跑的仍是旧模块 —— 重启后生效 (ESM 无热替换, 这是诚实的边界)。",
    };
  }

  // ---- 回滚某次自改 (按账本 id, 默认最近一次 kept) ----
  rewind({ id = null } = {}) {
    const rec = id ? this.ledger.get(id) : [...this.ledger.tail(50)].reverse().find((r) => r.status === "kept");
    if (!rec) return { ok: false, error: id ? `账本无此记录: ${id}` : "账本里没有可回滚的成功自改记录" };
    if (rec.status !== "kept") return { ok: false, error: `记录 ${rec.id} 状态为 ${rec.status}, 不是 kept, 无需回滚` };
    const entries = (rec.fileBackups || []).length ? rec.fileBackups : this._manifestFor(rec.id);
    if (!entries.length) return { ok: false, error: `找不到 ${rec.id} 的备份清单` };
    let restored = 0;
    const failures = [];
    for (const e of entries) {
      const orig = this.ledger.readBackup(rec.id, e);
      try {
        if (e.existed && orig !== null) { atomicWrite(e.path, orig); restored++; }
        else if (!e.existed) { if (fs.existsSync(e.path)) fs.unlinkSync(e.path); restored++; }
      } catch (err) { failures.push({ path: e.path, error: String(err?.message || err) }); }
    }
    const rec2 = this.ledger.append({
      id: this.ledger.nextId(), ts: new Date().toISOString(), status: "rewound", rewoundFrom: rec.id,
      files: entries.map((e) => path.relative(this.root, e.path)), rollback: { restored, failures },
    });
    return { ok: failures.length === 0, rewoundFrom: rec.id, ledgerId: rec2.id, restored, failures };
  }

  // 从备份目录重建清单 —— 仅当账本记录缺少 fileBackups 时兜底 (老账本兼容)。
  // 注意: 备份文件按落盘顺序编号, 与记录里的 files[] 同序, 因此按下标配对。
  // 记录里跳过备份的文件 (超上限) 没有 .bak, 这种情况下会错位 —— 宁可明确报错也不猜。
  _manifestFor(id) {
    const dir = path.join(this.ledger.backupRoot, id);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".bak")).sort(); } catch { return []; }
    const rec = this.ledger.get(id);
    const rels = (rec?.files || []).map((f) => (typeof f === "string" ? f : f.path));
    if (rels.length !== names.length) return [];
    return rels.map((rel, i) => ({ path: path.resolve(this.root, rel), existed: true, bak: names[i] }));
  }

  // ---- 报告 ----
  status({ limit = 10 } = {}) {
    const rows = this.ledger.tail(limit);
    const pending = this.ledger.readPending();
    return {
      pendingReload: pending.files || [],
      pendingUpdatedAt: pending.updatedAt || null,
      total: this.ledger.all().length,
      kept: this.ledger.all().filter((r) => r.status === "kept").length,
      rolledBack: this.ledger.all().filter((r) => r.status === "rolled_back").length,
      recent: rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        status: r.status,
        files: (r.files || []).map((f) => (typeof f === "string" ? f : f.path)),
        verify: r.verify?.summary || null,
        reason: r.reason || "",
      })),
    };
  }
}
