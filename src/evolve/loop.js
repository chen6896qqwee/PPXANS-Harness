// src/evolve/loop.js - 持续进化循环 (2026-10-25, 自主进化第二层)
//
// 定位: 把已有的三个孤立能力编排成**一条自主变强的闭环**:
//   · EvolutionEngine (evolve/trigger.js): 按 N 次调用做行为学习 (经验/技能) —— 零散触发
//   · SelfIterationEngine (selfcode/selfiterate.js): 按需的代码自改进 (2026-11-08 归位 selfcode/) —— 人工触发
//   · FailureEpisodeStore / PlaybookStore: 已记录但少被主动消费
// 本循环每个周期跑三段 (每段独立失败隔离, 任何一段崩不拖垮整轮):
//
//   Phase 0 结构体检 (新增 2026-11-02): 跑一次确定性 self_audit (零 LLM),
//     把评分/严重度分布写进 journal —— 代码健康度从此也有曲线, 不再只看"修了几个测试"
//   Phase 1 自我学习 (行为层, 无 LLM 安全跳过):
//     - 弱点驱动: 故障病历按工具聚类, 头部弱点 (同类 ≥3 条) 定向 refine —— 不再只看"最近 50 条轨迹"
//     - 常规: refine 失败→经验 + refineSkill 重复模式→技能 (沉淀后自动进 playbook, 既有链路)
//   Phase 2 自我迭代 (代码层, 需 LLM + 显式配置, 默认 propose 只出补丁):
//     - 对目标测试文件跑 SelfIterationEngine (发现→诊断→补丁→验证→绿保留/红回滚)
//   Phase 3 进化度量 (无条件):
//     - journal.jsonl 追加本轮各段结果 + 能力快照 (经验数/技能数/病历数/playbook 条数)
//     - "变强"从此有账可查: 每轮一条, 曲线可画
//   Phase 3.5 效果对照 (2026-11-15, 无条件, 只读): 蒸馏 cohort 的前后成功率对照
//     (src/evolve/effect.js) —— 能力快照记"存了多少", 效果对照答"有没有用"。
//     窗口轨迹不足的 cohort 标 immature, 不给结论 (防小样本误导)。
//   Phase 3.6 效果反哺 (2026-11-16, opt-in, **唯一会写行为的段**): 把"测出来没用"变成
//     实际动作 —— 否则 3.5 永远只是仪表盘, 系统照旧按同一套策略跑 (AhaBench 那条缺口
//     的准确位置: 不是没测量, 是测出来不反馈)。动作只有一种语义: **给策略记有害票**,
//     淘汰交给既有 growAndRefine 阈值 —— 不在这里直接 REMOVE/retire, 留着可回滚的余地。
//     门槛三重 (mature + delta ≤ -阈值 + 未反哺过), 幂等靠 cohort.fedBackAt。
//
// 护栏: 单飞锁 (上一轮没跑完不叠加) / 每周期最小间隔 / LLM 预算透传 / 全程 try 隔离。
// 接入: config agent.evolution_loop { enabled, cron, mode } → Scheduler 每日定时;
//       CLI `npm run evolve:loop` 手动一轮; evolution_status 工具随时看进化报告。
import { noteCatch } from "../utils/catch-log.js";
import fs from "node:fs";
import path from "node:path";
import { info, warn } from "../utils/logger.js";
import { SelfIterationEngine } from "../selfcode/selfiterate.js";
import { runAudit } from "../selfcode/audit.js";
import { growAndRefine, lexicalSimilarity } from "./playbook.js";

const JOURNAL_FILE = "evolve/journal.jsonl";

export class EvolutionLoop {
  constructor(agent, config = {}) {
    this.agent = agent;
    this.root = config.root || agent?.root || process.cwd();
    this.dataDir = agent?.dataDir || this.root;
    this.journalFile = config.journal_file || path.join(this.dataDir, JOURNAL_FILE);
    // self_iteration 配置沿用 (mode/max_files/max_attempts/max_llm_calls 等), evolution_loop 只管编排
    this.iterateCfg = { ...(agent?.config?.agent?.self_iteration || {}), ...(config.self_iteration || {}) };
    this._rot = 0;               // 适应度轮换游标: 集 > max_files 时跨夜轮转, 不永远只跑前 N 个
    this.running = false;        // 单飞锁
    this.lastRunAt = 0;
    this.minIntervalMs = Number(config.min_interval_ms) || 60 * 1000;
    this.weaknessThreshold = Number(config.weakness_threshold) || 3; // 同类病历 ≥N 触发定向学习
  }

  // ---- 弱点聚类: 故障病历按 (tool, category) 分组, 返回按规模排序的头部 ----
  weaknessClusters() {
    const episodes = (() => {
      try { return this.agent.failures?.list?.(200) || []; } catch { return []; }
    })();
    const map = new Map();
    for (const ep of episodes) {
      const key = `${ep.tool || "?"}::${ep.category || "?"}`;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return [...map.entries()]
      .map(([key, count]) => { const [tool, category] = key.split("::"); return { tool, category, count }; })
      .sort((a, b) => b.count - a.count);
  }

  // ---- Phase 0: 结构体检 (只读, 零 LLM) ----
  // 只取结论不取全文: journal 是长期追加文件, 每轮塞 20 条 findings 会迅速失控。
  auditSnapshot() {
    try {
      const r = runAudit({ root: this.root });
      return {
        score: r.score,
        grade: r.grade,
        bySeverity: r.bySeverity,
        topFindings: r.findings.slice(0, 3).map((f) => f.title),
      };
    } catch (e) {
      return { error: String(e?.message || e).slice(0, 200) }; /* swallowed-ok(2026-11-03): 错误随返回值上报 */
    }
  }

  // ---- Phase 1: 自我学习 (行为层) ----
  async learn() {
    const a = this.agent;
    const out = { refined: 0, lessons: [], skillsCreated: 0, weaknessTargeted: null };
    if (typeof a.refine !== "function") return out;

    // 弱点驱动: 头部同类病历超阈值 → 先针对它提炼 (失败上下文最相关的教训优先沉淀)
    const head = this.weaknessClusters()[0];
    if (head && head.count >= this.weaknessThreshold) {
      out.weaknessTargeted = head;
      try {
        const r = await a.refine({ limit: 30 });
        if (r?.distilled > 0) { out.refined += r.distilled; out.lessons.push(String(r.lesson || "").slice(0, 200)); }
      } catch (e) { warn(`[evolution-loop] 弱点定向学习失败: ${e.message}`); }
    }
    // 常规: 失败→经验 (无失败时 refine 内部自行空转)
    try {
      const r = await a.refine({ limit: 20 });
      if (r?.distilled > 0) { out.refined += r.distilled; out.lessons.push(String(r.lesson || "").slice(0, 200)); }
    } catch { /* refine 失败不拖垮整轮 */ }
    // 重复成功模式 → 技能
    if (typeof a.refineSkill === "function") {
      try {
        const r = await a.refineSkill({ limit: 50, minFreq: 2 });
        if (r?.created > 0) out.skillsCreated = r.created;
      } catch { /* 同上 */ }
    }
    return out;
  }

  // ---- Phase 2: 自我迭代 (代码层) ----
  async iterate(targetFiles = null) {
    const a = this.agent;
    if (!a.llm || typeof a.llm.chat !== "function") {
      return { ran: false, reason: "无 LLM, 代码迭代跳过" };
    }
    const files = targetFiles || this.iterateCfg.target_files || [];
    if (!Array.isArray(files) || !files.length) {
      return { ran: false, reason: "未配置目标测试文件 (agent.self_iteration.target_files)" };
    }
    // 轮换: 集 > max_files 时按游标旋转, 每夜覆盖不同区段 (几夜扫完全集), 修掉
    // "slice(0, N) 恒取前 N 个、后面的文件永远轮不到"的盲区
    const maxFiles = Math.max(1, Number(this.iterateCfg.max_files) || 3);
    let ordered = files;
    let rotated = false;
    if (files.length > maxFiles) {
      const at = this._rot % files.length;
      ordered = files.slice(at).concat(files.slice(0, at));
      this._rot = (at + maxFiles) % files.length;
      rotated = true;
    }
    const engine = new SelfIterationEngine(a, { ...this.iterateCfg, root: this.root });
    try {
      const r = await engine.run({ targetFiles: ordered.map((f) => path.resolve(this.root, f)) });
      if (rotated) r.rotated = true;
      return r;
    } catch (e) {
      warn(`[evolution-loop] 代码迭代异常: ${e.message}`);
      return { ran: false, reason: e.message };
    }
  }

  // ---- Phase 3: 能力快照 ----
  capabilitySnapshot() {
    const a = this.agent;
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    return {
      experiences: num(a.experience?.count?.()),
      skills: num(a.skills?.list?.()?.length),
      failureEpisodes: num(a.failures?.stats?.()?.total ?? a.failures?.list?.(500)?.length),
      playbookBullets: num(a.playbook?.playbook?.bullets?.length),
    };
  }

  // ---- Phase 3.5: 蒸馏效果对照 (2026-11-15, 只读) ----
  // effect 未装配 (轻量装配/旧测试桩) 或 traces 缺席时返回 null —— journal 字段缺省即无此段。
  // assignments 联表 (2026-11-15): workgraph 的确定性 taskType 标签经时间窗 join 到 traces,
  //   cross-task 对照的口径由此保证 (不用模型分类, 见 workgraph/service.js deriveTaskType)。
  effectSnapshot() {
    const a = this.agent;
    if (!a.effect || typeof a.effect.measure !== "function") return null;
    const traces = typeof a.traces?.read === "function" ? a.traces.read(undefined, 400) : [];
    const assignments = typeof a.work?.listRecentAssignments === "function" ? a.work.listRecentAssignments(100) : [];
    try {
      return a.effect.measure({ traces, assignments });
    } catch (e) {
      return { error: String(e?.message || e).slice(0, 200) };
    }
  }

  // ---- Phase 3.6: 效果反哺 (2026-11-16, opt-in, 唯一会写行为的段) ----
  // 与 3.5 的分工: 3.5 只出结论, 3.6 才动手。动作设计刻意保守 —— 只"记有害票",
  //   不"删策略": 达到 pruneAt 的淘汰由既有 growAndRefine 完成 (同一份阈值逻辑, 不另造
  //   一套), 未达阈值的策略仍在役, 下一轮若 delta 转正, helpful 票会把它拉回来。
  //
  // 关联纪律 (宁可不动, 不误伤): cohort 名字与策略条目的关联必须**可验证** ——
  //   · playbook bullet: 词法相似度 ≥ relate_threshold (默认 0.25), 否则跳过并留原因;
  //   · lesson: 只在 tags/task **确定性包含** 技能名时退休 (不做模糊匹配)。
  //   两条都不命中 → 记 skipped, 零写入。这比"猜一个最像的"诚实。
  //
  // 为什么 prune 不走回归门禁: 门禁 (createGate) 守的是"新增策略有没有害", 而这里是
  //   "已证有害的策略退场", 方向相反; 而且误判可逆 (bullet 会重新被 refine 产出来)。
  //   真正防止误杀的是三重门槛 + 单轮动作上限, 不是门禁。
  async feedbackFromEffect(effect = null) {
    const cfg = this.agent?.config?.agent?.evolution_loop?.effect_feedback || {};
    if (cfg.enabled !== true) return { ran: false, reason: "effect_feedback.enabled 未开启 (默认关闭)" };
    if (!effect || !Array.isArray(effect.measured)) return { ran: false, reason: "本轮无测量结果" };
    const threshold = Number(cfg.degrade_threshold) > 0 ? Number(cfg.degrade_threshold) : 0.15;
    const relate = Number(cfg.relate_threshold) > 0 ? Number(cfg.relate_threshold) : 0.25;
    const maxActions = Math.max(1, Number(cfg.max_actions) || 3);
    const pruneAt = Math.max(1, Number(cfg.prune_at) || 3);

    const cands = (effect.measured || []).filter((r) => {
      if (!r || r.mature !== true || r.delta == null || r.delta > -threshold) return false;
      if (r.fedBackAt) return false;
      // 第二道幂等闸: 调用方可能拿上一轮的测量快照来调, 以磁盘 cohort 为准
      try { if (this.agent?.effect?.isFedBack?.(r.cohortKey)) return false; } catch { /* 查不到就当未反哺 */ }
      return true;
    });
    if (!cands.length) return { ran: true, acted: 0, skipped: 0, reason: "无退化 cohort (mature 且 delta ≤ -阈值, 或均已反哺过)" };

    const pb = this.agent?.playbook;
    const exp = this.agent?.experience;
    const out = { ran: true, threshold, maxActions, acted: 0, skipped: 0, actions: [] };
    const pick = cands.slice(0, maxActions); // 单轮上限: 一次最多动 N 条, 防一轮清空半个库

    for (const r of pick) {
      const name = String(r.name || "");
      let done = null;

      // 路径 A: playbook 记有害票 (技能名 ↔ bullet 内容的词法关联)
      if (pb && typeof pb.apply === "function") {
        const bullets = pb.playbook?.bullets || [];
        let best = null;
        let bestSim = 0;
        for (const b of bullets) {
          const sim = lexicalSimilarity(b?.content, name);
          if (sim > bestSim) { bestSim = sim; best = b; }
        }
        if (best && bestSim >= relate) {
          try {
            const res = await pb.apply([{ op: "UPDATE", id: best.id, counters: { harmful: 1 } }]);
            done = res?.committed === false
              ? { kind: "rejected_by_gate", target: best.id, similarity: Math.round(bestSim * 1000) / 1000 }
              : { kind: "harmful", target: best.id, similarity: Math.round(bestSim * 1000) / 1000 };
          } catch (e) {
            done = { kind: "error", detail: String(e?.message || e).slice(0, 120) };
          }
        }
      }

      // 路径 B: lesson 退休 (仅确定性包含命中; 路径 A 已成功则不叠加, 避免一次错误双重惩罚)
      if (!done && exp && typeof exp.retire === "function" && typeof exp.list === "function") {
        try {
          const hit = (exp.list({ includeRetired: false }) || []).find((l) => {
            if (!name) return false;
            const inTags = Array.isArray(l.tags) && l.tags.some((t) => String(t).includes(name));
            return inTags || String(l.task || "").includes(name);
          });
          if (hit) {
            exp.retire(hit.id, `effect_delta_negative: ${name} delta=${r.delta} (对照 ${r.post?.total ?? 0} 轨迹)`);
            done = { kind: "retire", target: hit.id, detail: `delta=${r.delta}` };
          }
        } catch (e) {
          done = { kind: "error", detail: String(e?.message || e).slice(0, 120) };
        }
      }

      if (!done) {
        out.skipped += 1;
        out.actions.push({
          cohort: r.cohortKey, delta: r.delta, kind: "skipped",
          reason: `无关联条目 (playbook 最高相似 < ${relate}; lesson 无包含命中) —— 不猜、不动`,
        });
        continue;
      }
      out.acted += 1;
      out.actions.push({ cohort: r.cohortKey, delta: r.delta, ...done });
      // 幂等回写: 只有真产生动作才标记 —— skipped 的下一轮仍可重试 (那时可能已有对应策略)
      try { this.agent.effect?.markFedBack?.(r.cohortKey, done); } catch (e) { noteCatch("src/evolve/loop.js#markFedBack", e); }
    }

    // 记有害票后立刻跑一次淘汰 —— 否则 harmful 只是又一个没人看的计数器
    if (out.acted > 0 && pb && typeof pb.save === "function") {
      try {
        const refined = growAndRefine(pb.playbook, { pruneAt });
        if (refined.removed > 0) {
          pb.save(refined.playbook);
          out.pruned = refined.pruned;
          info(`[evolution-loop] 效果反哺淘汰 ${refined.removed} 条策略 (pruneAt=${pruneAt}): ${refined.pruned.map((p) => p.id).join(",")}`);
        }
      } catch (e) { noteCatch("src/evolve/loop.js#growAndRefine", e); }
    }
    return out;
  }

  // ---- 主循环: 一轮完整进化 ----
  async cycle({ targetFiles = null, onEvent = null } = {}) {
    const ev = (t, p) => { if (onEvent) { try { onEvent(t, p); } catch {} } };
    if (this.running) return { ran: false, reason: "上一轮进化仍在进行 (单飞锁)" };
    if (Date.now() - this.lastRunAt < this.minIntervalMs && this.lastRunAt > 0) {
      return { ran: false, reason: "距上一轮过近 (最小间隔保护)" };
    }
    this.running = true;
    const t0 = Date.now();
    const record = { ts: new Date().toISOString(), durationMs: 0, audit: null, learn: null, iterate: null, capability: null, effect: null, effectFeedback: null };
    try {
      record.audit = this.auditSnapshot();       ev("evolution/audited", { score: record.audit.score, grade: record.audit.grade });
      record.learn = await this.learn();       ev("evolution/learned", record.learn);
      record.iterate = await this.iterate(targetFiles); ev("evolution/iterated", { ran: record.iterate.ran });
      record.capability = this.capabilitySnapshot();
      record.effect = this.effectSnapshot();   ev("evolution/measured", { matured: record.effect?.matured ?? null });
      // Phase 3.6 (2026-11-16): 测量 → 反哺。默认关闭时返回 {ran:false} 且零写入,
      //   与 3.5 一样不会让旧部署多出任何行为。
      record.effectFeedback = await this.feedbackFromEffect(record.effect);
      if (record.effectFeedback?.acted) ev("evolution/fed_back", record.effectFeedback);
      record.durationMs = Date.now() - t0;
      this._journalAppend(record);
      info(`[evolution-loop] ✅ 进化周期完成 (${record.durationMs}ms): 经验+${record.learn.refined} 技能+${record.learn.skillsCreated}`
        + `${record.audit && Number.isFinite(record.audit.score) ? ` 结构${record.audit.score}分(${record.audit.grade})` : ""}`
        + `${record.iterate.ran ? ` 代码修复 fixed=${record.iterate.fixed ?? 0} rolledBack=${record.iterate.rolledBack ?? 0}` : ""}`
        + `${record.effectFeedback?.acted ? ` 反哺 acted=${record.effectFeedback.acted} pruned=${record.effectFeedback.pruned?.length ?? 0}` : ""}`);
      return record;
    } catch (e) {
      record.error = e.message;
      record.durationMs = Date.now() - t0;
      this._journalAppend(record);
      warn(`[evolution-loop] 进化周期异常 (已留痕): ${e.message}`);
      return record;
    } finally {
      this.running = false;
      this.lastRunAt = Date.now();
    }
  }

  _journalAppend(record) {
    try {
      fs.mkdirSync(path.dirname(this.journalFile), { recursive: true });
      fs.appendFileSync(this.journalFile, JSON.stringify(record) + "\n", "utf8");
    } catch (e) { noteCatch("src/evolve/loop.js#_journalAppend", e); /* 日志失败不阻断 */ }
  }

  journalTail(n = 20) {
    try {
      const lines = fs.readFileSync(this.journalFile, "utf8").split("\n").filter(Boolean);
      return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }
}

// ---- 装配: agent 启动时按配置挂定时任务 (config.agent.evolution_loop) ----
// 返回 EvolutionLoop 实例 (无论是否定时, agent._evolutionLoop 都可被工具/CLI 复用)。
export function installEvolutionLoop(agent) {
  const cfg = agent?.config?.agent?.evolution_loop || {};
  const loop = new EvolutionLoop(agent, cfg);
  if (agent) agent._evolutionLoop = loop;
  if (!cfg?.enabled) return loop;
  const cron = /^\d{2}:\d{2}$/.test(String(cfg.cron || "")) ? cfg.cron : "03:30";
  try {
    // 幂等注册: 恢复的无 action 任务先移除再挂真闭包 (与 eviction-daily 同一手法)
    const jobs = agent.scheduler?.jobs || [];
    const stale = jobs.find((j) => j.name === "evolution-loop" && typeof j.action !== "function");
    if (stale) agent.scheduler?.remove(stale.id);
    const has = jobs.some((j) => j.name === "evolution-loop" && typeof j.action === "function");
    if (!has) {
      agent.scheduler?.add({
        name: "evolution-loop", cron, type: "daily",
        action: () => { loop.cycle().catch(() => {}); },
      });
      info(`[evolution-loop] 已启用每日 ${cron} 自主进化 (learn→iterate→journal)`);
    }
  } catch (e) {
    warn(`[evolution-loop] 定时装配失败: ${e.message}`);
  }
  return loop;
}
