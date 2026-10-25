// src/selfheal/evolve.js - 自进化引擎
// 职责: 闭合「记录轨迹 → 提炼教训 → 注入上下文」的自进化闭环。
// 背景: refine()(失败→经验) 和 refineSkill()(成功→技能) 方法早已在 agent 上定义,
//   但全仓库没有任何触发点 → 皮皮虾天天记录工具轨迹却从不"停下来学"。
//   本引擎就是那个自动触发点: 每 N 次工具调用后, 异步提炼失败教训 + 沉淀重复成功技能。
// 约束: 异步 fire-and-forget, 绝不阻塞当前对话; 无 LLM 时安全跳过;
//   节流 (minIntervalMs) 防止高频提炼爆 LLM 成本; 可配置关闭 (agent.evolve.enabled=false)。
import { info, warn } from "../utils/logger.js";

export class EvolutionEngine {
  constructor(agent, config = {}) {
    this.agent = agent;
    this.enabled = config.enabled !== false;
    this.everyCalls = Number(config.every_calls) || 20;       // 每 N 次工具调用触发一次提炼
    this.minIntervalMs = Number(config.min_interval_ms) || 30000; // 两次提炼最小间隔
    this.upgradeUses = Number(config.upgrade_uses) || 3;      // 技能用满 N 次自动升级 (用中自进化)
    this._calls = 0;
    this._lastAt = 0;
  }

  // 每轮对话收尾调用 (幂等, 轻量, 同步返回)
  tick() {
    if (!this.enabled) return;
    const a = this.agent;
    if (!a || !a.llm) return;                 // 无 LLM: 无法提炼
    if (typeof a.refine !== "function") return;
    this._calls++;
    if (this._calls < this.everyCalls) return;
    if (Date.now() - this._lastAt < this.minIntervalMs) return;
    this._calls = 0;
    this._lastAt = Date.now();
    this._run();                              // fire-and-forget, 不 await
  }

  async _run() {
    const a = this.agent;
    try {
      const traces = (typeof a.traces?.read === "function") ? a.traces.read(undefined, 50) : [];
      const failed = traces.filter((t) => !t.ok);
      const okCalls = traces.filter((t) => t.ok);
      // 失败 → 提炼经验 (至少 2 条失败轨迹才有得教)
      if (failed.length >= 2) {
        const r = await a.refine({ limit: 20 });
        if (r && r.distilled > 0) info(`[evolve] 失败→经验: ${String(r.lesson || "").slice(0, 120)}`);
      }
      // 重复成功 → 沉淀技能 (至少 3 条成功轨迹才有得沉淀)
      if (okCalls.length >= 3) {
        const r = await a.refineSkill({ limit: 50, minFreq: 2 });
        if (r && r.created > 0) info(`[evolve] 成功→技能: ${r.name}`);
      }
      // 用中自进化: 扫描高频技能 (uses >= upgradeUses) 触发升级
      if (typeof a.upgradeSkill === "function" && a.skills && typeof a.skills.usageAll === "function") {
        try {
          const usage = a.skills.usageAll() || {};
          const ripe = Object.entries(usage).filter(([, u]) => (u && (u.uses || 0)) >= this.upgradeUses);
          for (const [sid] of ripe) {
            const r = await a.upgradeSkill(sid, { minUses: this.upgradeUses });
            if (r && r.upgraded > 0) info(`[evolve] 用中升级技能: ${r.name}`);
          }
        } catch (e) {
          warn(`[evolve] 技能升级失败: ${String(e?.message || e).slice(0, 120)}`);
        }
      }
    } catch (e) {
      warn(`[evolve] 提炼失败 (不影响当前对话): ${String(e?.message || e).slice(0, 160)}`);
    }
  }
}