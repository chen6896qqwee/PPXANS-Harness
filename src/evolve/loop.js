// src/evolve/loop.js - 持续进化循环 (2026-10-25, 自主进化第二层)
//
// 定位: 把已有的三个孤立能力编排成**一条自主变强的闭环**:
//   · EvolutionEngine (selfheal/evolve.js): 按 N 次调用做行为学习 (经验/技能) —— 零散触发
//   · SelfIterationEngine (evolve/selfiterate.js): 按需的代码自改进 —— 人工触发
//   · FailureEpisodeStore / PlaybookStore: 已记录但少被主动消费
// 本循环每个周期跑三段 (每段独立失败隔离, 任何一段崩不拖垮整轮):
//
//   Phase 1 自我学习 (行为层, 无 LLM 安全跳过):
//     - 弱点驱动: 故障病历按工具聚类, 头部弱点 (同类 ≥3 条) 定向 refine —— 不再只看"最近 50 条轨迹"
//     - 常规: refine 失败→经验 + refineSkill 重复模式→技能 (沉淀后自动进 playbook, 既有链路)
//   Phase 2 自我迭代 (代码层, 需 LLM + 显式配置, 默认 propose 只出补丁):
//     - 对目标测试文件跑 SelfIterationEngine (发现→诊断→补丁→验证→绿保留/红回滚)
//   Phase 3 进化度量 (无条件):
//     - journal.jsonl 追加本轮各段结果 + 能力快照 (经验数/技能数/病历数/playbook 条数)
//     - "变强"从此有账可查: 每轮一条, 曲线可画
//
// 护栏: 单飞锁 (上一轮没跑完不叠加) / 每周期最小间隔 / LLM 预算透传 / 全程 try 隔离。
// 接入: config agent.evolution_loop { enabled, cron, mode } → Scheduler 每日定时;
//       CLI `npm run evolve:loop` 手动一轮; evolution_status 工具随时看进化报告。
import fs from "node:fs";
import path from "node:path";
import { info, warn } from "../utils/logger.js";
import { SelfIterationEngine } from "./selfiterate.js";

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

  // ---- 主循环: 一轮完整进化 ----
  async cycle({ targetFiles = null, onEvent = null } = {}) {
    const ev = (t, p) => { if (onEvent) { try { onEvent(t, p); } catch {} } };
    if (this.running) return { ran: false, reason: "上一轮进化仍在进行 (单飞锁)" };
    if (Date.now() - this.lastRunAt < this.minIntervalMs && this.lastRunAt > 0) {
      return { ran: false, reason: "距上一轮过近 (最小间隔保护)" };
    }
    this.running = true;
    const t0 = Date.now();
    const record = { ts: new Date().toISOString(), durationMs: 0, learn: null, iterate: null, capability: null };
    try {
      record.learn = await this.learn();       ev("evolution/learned", record.learn);
      record.iterate = await this.iterate(targetFiles); ev("evolution/iterated", { ran: record.iterate.ran });
      record.capability = this.capabilitySnapshot();
      record.durationMs = Date.now() - t0;
      this._journalAppend(record);
      info(`[evolution-loop] ✅ 进化周期完成 (${record.durationMs}ms): 经验+${record.learn.refined} 技能+${record.learn.skillsCreated}`
        + `${record.iterate.ran ? ` 代码修复 fixed=${record.iterate.fixed ?? 0} rolledBack=${record.iterate.rolledBack ?? 0}` : ""}`);
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
    } catch { /* 日志失败不阻断 */ }
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
