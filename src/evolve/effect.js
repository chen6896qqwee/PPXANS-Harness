// src/evolve/effect.js - 蒸馏效果闭环 (cohort 登记 + 前后对照) (2026-11-15)
//
// 回答一个问题: 自动蒸馏出的技能/教训, 在后续同类工具域上是否真的带来可测量的
// 成功率变化? 此前这个问题无法回答 —— held-out 回归 (audit/verifier.js) 是"合并前
// 防过拟合", 不是"合并后证明有用"; journal 的能力快照只记条数曲线, 不记效果。
//
// 机制 (撤提示评测的仓库内版本; 本模块**只记账**, 反哺动作在 evolve/loop.js Phase 3.6):
//   · 登记: refineSkill/refine 成功落库时登记一个 cohort —— 记录产出时点该工具域的
//     基线成功率 (来自同一 traces 口径) 与 hotTools;
//   · 对照: measure() 用 cohort 时点之后同工具域的新轨迹算对照成功率, delta = post - base;
//   · 入账: evolve/loop.js Phase 3.5 把 measure 结果追加进 journal.jsonl, 曲线可画。
// 统计口径纪律: 基线/对照都用 (域内轨迹 ok 数 / 域内轨迹总数); 对照窗口轨迹数不足
//   minPostTraces 时标 immature, 不给 delta 结论 (防小样本误导)。
//
// 确定性、零 LLM。持久化 data/evolve/effect-cohorts.json (锁内读-改-写)。
import path from "node:path";
import fs from "node:fs";
import { ensureDir, readJson, writeJson, withFileLock } from "../utils/store.js";
import { noteCatch } from "../utils/catch-log.js";

const DEFAULT_MIN_POST_TRACES = 10;   // 对照窗口最少轨迹数, 不足标 immature
const DEFAULT_WINDOW_DAYS = 30;       // cohort 对照窗口 (30 天后不再累计, 防老 cohort 一直拖尾)
const MAX_COHORTS = 400;              // 登记上限 (超出丢弃最老的, 防文件无限膨胀)

// 域内轨迹成功率: {ok, total, rate} —— traces 元素须有 {tool, ok, ts}
function domainRate(traces, hotTools, { since = 0, until = Infinity } = {}) {
  const hot = new Set((hotTools || []).map((t) => String(t)));
  let ok = 0, total = 0;
  for (const t of traces || []) {
    if (!hot.has(String(t.tool || ""))) continue;
    const ts = new Date(t.ts || 0).getTime() || 0;
    if (ts < since || ts > until) continue;
    total += 1;
    if (t.ok) ok += 1;
  }
  return { ok, total, rate: total > 0 ? Math.round((ok / total) * 1000) / 1000 : null };
}

export { domainRate };

export class EffectTracker {
  // @param {object} opts
  // @param {string} opts.dataDir          数据目录 (cohort 文件落在 <dataDir>/evolve/)
  // @param {number} [opts.minPostTraces]  对照窗口最少轨迹数 (默认 10)
  // @param {number} [opts.windowDays]     对照窗口天数 (默认 30)
  constructor({ dataDir, minPostTraces = DEFAULT_MIN_POST_TRACES, windowDays = DEFAULT_WINDOW_DAYS } = {}) {
    this.file = path.join(dataDir, "evolve", "effect-cohorts.json");
    // 目录必须先建: withFileLock 的锁文件落在同目录, 目录缺席会让 acquire 永远 ENOENT 直到超时
    ensureDir(path.dirname(this.file));
    this.minPostTraces = Math.max(1, Number(minPostTraces) || DEFAULT_MIN_POST_TRACES);
    this.windowDays = Math.max(1, Number(windowDays) || DEFAULT_WINDOW_DAYS);
    this.cohorts = readJson(this.file, []);
    if (!Array.isArray(this.cohorts)) this.cohorts = [];
  }

  _persistLocked() {
    // 容量纪律: 最老的先出清 (cohort 只在窗口期内有对照价值)
    if (this.cohorts.length > MAX_COHORTS) this.cohorts = this.cohorts.slice(-MAX_COHORTS);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeJson(this.file, this.cohorts);
    } catch (e) { noteCatch("src/evolve/effect.js#persist", e); /* 记账失败不阻断 */ }
  }

  // 登记 skill cohort: name + hotTools + 产出时点基线成功率 (learning-service 从 traces 算好传入)
  // taskType (2026-11-15, 可选): 产出该技能的任务类型标记 —— cross-task 对照的前提信号。
  //   缺省 null = 只参与任务内 (in-task) 对照; 轨迹/账本侧尚无 taskType 打标时, 跨任务层如实报不可测。
  registerSkill({ name, hotTools = [], baseline = null, taskType = null } = {}) {
    if (!name) return null;
    return withFileLock(this.file, () => {
      this.cohorts = readJson(this.file, []);
      if (!Array.isArray(this.cohorts)) this.cohorts = [];
      const entry = {
        kind: "skill",
        name: String(name),
        hotTools: (hotTools || []).map(String).slice(0, 16),
        taskType: taskType ? String(taskType).slice(0, 60) : null,
        ts: new Date().toISOString(),
        baseline: baseline && Number.isFinite(baseline.rate)
          ? { ok: baseline.ok, total: baseline.total, rate: baseline.rate }
          : null,
      };
      this.cohorts.push(entry);
      this._persistLocked();
      return entry;
    });
  }

  // 登记 lesson cohort: 只记产出时点与关联工具 (教训的"效果"经由 skill 域与 uses 曲线观测,
  //   这里保证 cohort 总量对账 —— lesson 登记不改行为, 只让 journal 有据可查)
  registerLesson({ lesson, tool = null } = {}) {
    if (!lesson) return null;
    return withFileLock(this.file, () => {
      this.cohorts = readJson(this.file, []);
      if (!Array.isArray(this.cohorts)) this.cohorts = [];
      const entry = {
        kind: "lesson",
        tool: tool ? String(tool) : null,
        lesson: String(lesson).slice(0, 120),
        ts: new Date().toISOString(),
      };
      this.cohorts.push(entry);
      this._persistLocked();
      return entry;
    });
  }

  // 对照测量 (2026-11-15 两层拆分): cohort 的粒度决定测的是什么 ——
  //   in-task (同工具域前后对照) = "这个技能在这个任务族上有没有用" (任务内提升);
  //   cross-task (域内轨迹按 taskType 分桶) = "技能在不同任务类型上的表现差异" (泛化)。
  //   taskType 来源 (2026-11-15 破循环依赖): **不用模型分类** —— 用当前模型打标再去测
  //   新模型泛化, 分错类会污染分层。改由 assignments 时间窗联表 (workgraph 的确定性派生
  //   标签 origin|route|tools哈希): trace.ts 落在哪个 assignment 的 [startedAt, endedAt]
  //   里, 就继承哪个 assignment 的 taskType。零 LLM, 口径从第一天就是干净的。
  // `measured` 键保留 = inTask 明细 (journal 消费方兼容)。
  measure({ traces = [], assignments = [], now = Date.now() } = {}) {
    const until = now;
    const out = {
      measuredAt: new Date(now).toISOString(),
      skillCohorts: 0, lessonCohorts: 0,
      measured: [], matured: 0, improving: 0, degrading: 0,
      taskTypeCoverage: { labeled: 0, total: 0 },
      crossTask: null,
    };
    const windowMs = this.windowDays * 86400000;
    // 联表: assignment 时间窗 → trace 的确定性 taskType (优先轨迹自带标记, 兼容旧路径)
    const asgs = (Array.isArray(assignments) ? assignments : [])
      .filter((a) => a && a.taskType)
      .map((a) => ({ st: new Date(a.startedAt || 0).getTime() || 0, en: a.endedAt ? new Date(a.endedAt).getTime() : Infinity, taskType: String(a.taskType) }))
      .sort((a, b) => a.st - b.st);
    const labelOf = (t) => {
      if (t.taskType) return String(t.taskType);
      const ts = new Date(t.ts || 0).getTime() || 0;
      for (const a of asgs) {
        if (ts < a.st) continue;
        if (ts <= a.en) return a.taskType;
      }
      return null;
    };
    for (const t of traces || []) {
      if (labelOf(t)) out.taskTypeCoverage.labeled += 1;
      out.taskTypeCoverage.total += 1;
    }

    let anyLabeledRow = false;
    const crossRows = [];
    for (const c of this.cohorts) {
      if (c.kind === "lesson") { out.lessonCohorts += 1; continue; }
      if (c.kind !== "skill") continue;
      const born = new Date(c.ts || 0).getTime() || 0;
      if (until - born > windowMs) continue; // 窗口已过, 不再拖尾
      out.skillCohorts += 1;
      const post = domainRate(traces, c.hotTools, { since: born, until });
      const row = {
        name: c.name, ts: c.ts, hotTools: c.hotTools,
        // cohortKey (2026-11-16): 反哺回写主键 —— 反哺动作必须能精确落回"哪一条 cohort
        //   被测出退化", 否则幂等无从谈起 (同一技能多次蒸馏会产生多条 cohort, 名字会撞)。
        cohortKey: `${c.name}@${c.ts}`,
        fedBackAt: c.fedBackAt || null,
        baseline: c.baseline, post,
        delta: (c.baseline?.rate != null && post.total >= this.minPostTraces)
          ? Math.round((post.rate - c.baseline.rate) * 1000) / 1000 : null,
        mature: post.total >= this.minPostTraces,
      };
      out.measured.push(row);
      if (row.mature) {
        out.matured += 1;
        if (row.delta != null && row.delta > 0) out.improving += 1;
        if (row.delta != null && row.delta < 0) out.degrading += 1;
      }
      // cross-task: 域内轨迹按 taskType 分桶 (联表标签), 主类型 vs 其余 = 迁移信号
      const postTraces = (traces || []).filter((t) => {
        const ts = new Date(t.ts || 0).getTime() || 0;
        return ts >= born && ts <= until;
      });
      const hot = new Set(c.hotTools.map(String));
      const byType = new Map();
      for (const t of postTraces) {
        if (!hot.has(String(t.tool || ""))) continue;
        const tt = labelOf(t);
        if (!tt) continue;
        const cur = byType.get(tt) || { taskType: tt, ok: 0, total: 0 };
        cur.total += 1;
        if (t.ok) cur.ok += 1;
        byType.set(tt, cur);
      }
      if (byType.size) {
        const rows = [...byType.values()]
          .map((r) => ({ ...r, rate: Math.round((r.ok / r.total) * 1000) / 1000 }))
          .sort((a, b) => b.total - a.total);
        const home = rows[0];
        const others = rows.slice(1);
        const oTotal = others.reduce((s, r) => s + r.total, 0);
        const oOk = others.reduce((s, r) => s + r.ok, 0);
        anyLabeledRow = true;
        crossRows.push({
          name: c.name,
          homeType: home.taskType,
          rows: rows.slice(0, 6),
          transferDelta: (home.total >= this.minPostTraces && oTotal >= this.minPostTraces)
            ? Math.round((oOk / oTotal - home.ok / home.total) * 1000) / 1000 : null,
          note: "transferDelta = 其余任务类型合并成功率 − 主类型成功率; null = 分桶样本不足",
        });
      }
    }
    out.measured = out.measured.slice(-30); // journal 单条最多带 30 行明细, 防记录膨胀
    out.crossTask = crossRows.length
      ? { measurable: true, rows: crossRows.slice(-15) }
      : {
          measurable: false,
          reason: anyLabeledRow
            ? "有 taskType 标签但窗口内域内轨迹未跨类型"
            : "无 taskType 标签 (assignments 未传入或 complete 未打标) —— 跨任务迁移不可测, 只统计任务内提升, 不冒充泛化结论",
        };
    return out;
  }

  // 反哺回写 (2026-11-16): 记录"这条 cohort 已被消费过一次" —— 幂等的唯一依据。
  //   本模块仍只记账不改行为: 动作在 evolve/loop.js 的 Phase 3.6 里执行, 这里只保证
  //   "同一条 cohort 终身只被反哺一次"可被验证 (否则一轮一轮重复 retire/harmful 会把
  //   counters 刷爆, 最终把一条本可救的策略直接推到 pruneAt 阈值以上误杀)。
  // @param {string} cohortKey  measure() 回传的 ${name}@${ts}
  // @param {object} action     { kind:"harmful"|"retire", target, detail }
  markFedBack(cohortKey, action = {}) {
    const key = String(cohortKey || "");
    if (!key) return null;
    return withFileLock(this.file, () => {
      this.cohorts = readJson(this.file, []);
      if (!Array.isArray(this.cohorts)) this.cohorts = [];
      const c = this.cohorts.find((x) => x.kind === "skill" && `${x.name}@${x.ts}` === key);
      if (!c) return null;
      c.fedBackAt = new Date().toISOString();
      c.fedBackAction = {
        kind: String(action.kind || "unknown").slice(0, 20),
        target: action.target == null ? null : String(action.target).slice(0, 120),
        detail: action.detail == null ? null : String(action.detail).slice(0, 300),
      };
      this._persistLocked();
      return c;
    });
  }

  // 幂等查询 (2026-11-16): 反哺前的第二道闸 —— 调用方可能拿着上一轮的测量快照来调用,
  //   只信 row.fedBackAt 会重复动手。以磁盘上的 cohort 为准 (markFedBack 已把 this.cohorts
  //   刷成最新, 这里直接读内存视图)。
  isFedBack(cohortKey) {
    const key = String(cohortKey || "");
    if (!key) return false;
    const c = this.cohorts.find((x) => x.kind === "skill" && `${x.name}@${x.ts}` === key);
    return Boolean(c?.fedBackAt);
  }

  // 人类可读快照 (状态页/对话观测用)
  status() {
    const now = Date.now();
    const skillN = this.cohorts.filter((c) => c.kind === "skill").length;
    const lessonN = this.cohorts.filter((c) => c.kind === "lesson").length;
    return { file: this.file, skillCohorts: skillN, lessonCohorts: lessonN, windowDays: this.windowDays, minPostTraces: this.minPostTraces, now: new Date(now).toISOString() };
  }
}
