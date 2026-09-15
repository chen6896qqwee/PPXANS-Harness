// src/services/learning-service.js - 自我学习服务 (重构第二刀, 2026-09-14)
// 目的: 把 PPXAgent 上的自我进化闭环 (失败→经验 refine / 成功→技能 refineSkill /
//       使用中进化 upgradeSkill) 抽为独立服务, agent 只保留薄委托。
// 设计:
//   - 依赖全部注入: llm (getLlm 闭包, 实时取当前 provider) / traces (工具轨迹) /
//     skills (技能加载器) / experience (经验库) / lifecycle (进化计数) /
//     auditor (验证账本) / tracer (事件流) / toolNames (工具名清单, 接地防幻觉) /
//     runTool (create_skill 工具调用, 由 agent 提供 agent 上下文)。
//   - 验证闸门 (verifyLesson / verifySkill / verifyUpgradeSkill) 保持不动:
//     经验/技能必须过确定性闸门才写回, 不信任模型自评。
import { TOOL_ERROR_PREFIX } from "../tools/index.js";
import { info, warn } from "../utils/logger.js";
import { Auditor, verifyLesson, heldOutSplit } from "../audit/verifier.js";
import { verifySkill, verifyUpgradeSkill } from "../skills/verify.js";

// 辅助 LLM 调用短超时 (经验/技能提炼): 模型不可用/网络不通时快速失败降级
const AUX_LLM_TIMEOUT_MS = 10000;

export class LearningService {
  // deps: { getLlm, traces, skills, experience, lifecycle, auditor, tracer, toolNames, runTool }
  constructor(deps) {
    this.getLlm = deps.getLlm;           // () => llm
    this.traces = deps.traces;           // 工具调用轨迹 (Traces)
    this.skills = deps.skills;           // SkillLoader
    this.experience = deps.experience;   // 经验库
    this.lifecycle = deps.lifecycle;     // ANS 生命周期
    this.auditor = deps.auditor;         // Auditor (验证账本)
    this.tracer = deps.tracer;           // 结构化事件流
    this.toolNames = deps.toolNames;     // () => string[], 工具名清单 (verifyLesson 接地)
    this.runTool = deps.runTool;         // (name, args) => Promise<string>, create_skill 调用
    if (!(this.auditor instanceof Auditor)) {
      // 兼容: 外部可能传普通对象 (测试/轻量装配), 不强求 Auditor 实例
    }
  }

  _llm() { return this.getLlm ? this.getLlm() : null; }

  // 失败→经验: 回放近期失败轨迹, LLM 提炼经验教训进经验库 (原 agent.refine)
  async refine({ limit = 20 } = {}) {
    const llm = this._llm();
    if (!llm) return { distilled: 0, reason: "无 LLM" };
    const failed = this.traces.read(undefined, limit).filter((t) => !t.ok);
    if (failed.length < 2) return { distilled: 0, reason: "失败轨迹不足" };
    const summary = failed
      .map((t) => `工具 ${t.tool}: ${String(t.error || t.result || "").slice(0, 160)}`)
      .join("\n");
    let lesson;
    try {
      const r = await llm.chat([
        { role: "system", content: "你是经验提炼器。从失败的工具调用轨迹中提炼一条可复用的经验教训, 一句话说清: 什么场景、为什么失败、下次怎么做。只输出这一句话, 不要解释。" },
        { role: "user", content: summary.slice(0, 2000) },
      ], { timeoutMs: AUX_LLM_TIMEOUT_MS, retryMax: 0 });
      lesson = String(r.content || "").trim();
    } catch { lesson = ""; }
    if (!lesson) return { distilled: 0, reason: "LLM 未产出经验" };
    // Auditor: 经验必须过确定性验证闸门才写回经验库 (不信任模型自评)
    // 接地防幻觉(点名工具须有失败轨迹背书) + 可操作动词 + 单句精炼
    const knownTools = this.toolNames ? this.toolNames() : [];
    const g = await this.auditor.gate(
      "lesson",
      { lesson, failedTraces: failed, knownTools },
      verifyLesson,
      (p) => {
        this.experience.learn({ task: "自动提炼", lesson: p.lesson, tags: ["auto-refine"] });
        if (this.lifecycle) this.lifecycle.evolve(); // 生命周期: 进化计数 (落盘)
      }
    );
    if (!g.committed) {
      warn(`[refine] 经验被验证闸门拒绝 (${g.reason}): ${lesson.slice(0, 80)}`);
      return { distilled: 0, rejected: true, reason: g.reason, lesson };
    }
    info(`[refine] 学到经验: ${lesson}`);
    this.tracer?.event("learning/refine", { lesson: lesson.slice(0, 120) });
    return { distilled: 1, lesson };
  }

  // 成功→技能: 从成功轨迹自动提炼可复用 Skill (原 agent.refineSkill)
  // 轨迹 → 高频成功工具模式 → LLM 提炼 → create_skill 落盘 skills/<name>/SKILL.md
  // 与 refine() (失败→经验) 互补, 形成「失败学教训 + 成功沉淀技能」完整闭环
  async refineSkill({ limit = 50, minFreq = 2 } = {}) {
    const llm = this._llm();
    if (!llm) return { created: 0, reason: "无 LLM" };
    const ok = this.traces.read(undefined, limit).filter((t) => t.ok);
    if (ok.length < minFreq) return { created: 0, reason: "成功轨迹不足" };
    // 找高频成功工具 (出现 >= minFreq 次)
    const freq = {};
    for (const t of ok) freq[t.tool] = (freq[t.tool] || 0) + 1;
    const hot = Object.entries(freq).filter(([, n]) => n >= minFreq).map(([t]) => t);
    if (!hot.length) return { created: 0, reason: "无重复成功工具模式" };
    // 用 LLM 提炼 skill (name/description/content)
    const summary = ok.slice(-20).map((t) => `工具 ${t.tool}: ${String(t.result || "").slice(0, 80)}`).join("\n");
    let skill;
    try {
      const r = await llm.chat([
        { role: "system", content: "你是技能提炼器。根据成功的工具调用轨迹, 提炼一个可复用技能。只输出 JSON: {\"name\":\"技能名(仅字母数字横线)\",\"description\":\"一句话说明\",\"content\":\"SKILL正文, 含 ## 流程(逐步工作流) 和 ## 验证(完成后必须提供的证据)\"}。不要解释, 只输出 JSON。" },
        { role: "user", content: `高频工具: ${hot.join(", ")}\n成功轨迹:\n${summary.slice(0, 2000)}` },
      ], { timeoutMs: AUX_LLM_TIMEOUT_MS, retryMax: 0 });
      const text = String(r.content || "").trim().replace(/```(?:json|JSON)?\s*/g, "").replace(/```/g, "").trim();
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return { created: 0, reason: "LLM 未产出有效 JSON" };
      skill = JSON.parse(m[0]);
    } catch { return { created: 0, reason: "LLM 提炼失败" }; }
    if (!skill || !skill.content) return { created: 0, reason: "Skill 字段缺失" };
    // name 归一化: 仅字母/数字/横线, 非法字符剔除, 空则兜底
    const name = String(skill.name || "").replace(/[^a-zA-Z0-9-]/g, "").toLowerCase() || ("auto-" + Date.now().toString(36));

    // self-evolution "reliable verification": gate before persist (no LLM)
    // -> structure (## Process + ## Verify) + grounded (content references hot tool, trace-backed)
    // held-out 回归: 样本够多时切出未见过的 held-out 子集, 要求接地工具在那也有背书, 防过拟合
    const { heldOut } = heldOutSplit(ok, { ratio: 0.4, minTotal: 6 });
    const v = verifySkill({
      name,
      content: String(skill.content || ""),
      hotTools: hot,
      okTraces: ok,
      minFreq,
      heldOutTraces: heldOut.length ? heldOut : undefined,
    });
    if (!v.ok) {
      warn("[refineSkill] skill rejected by verify gate: " + name + " - " + v.reason);
      return { created: 0, reason: v.reason, rejected: true, name };
    }
    const res = await this.runTool("create_skill", {
      name,
      description: String(skill.description || "自动提炼的技能"),
      content: String(skill.content),
    });
    if (res.startsWith(TOOL_ERROR_PREFIX)) return { created: 0, reason: res };
    if (this.auditor) this.auditor.record("skill_created", { lesson: `创建技能 ${name}` }); // 已过 verifySkill 闸门, 只记账
    info(`[refineSkill] 生成技能: ${name}`);
    this.tracer?.event("learning/refine_skill", { name });
    return { created: 1, name };
  }

  // 使用中进化: 技能用满 minUses 次后, 读当前内容 + 相关成功轨迹,
  // LLM 改进 SKILL.md, 过 verifyUpgradeSkill 闸门(防退化) 后写回, 重置计数防连跑 (原 agent.upgradeSkill)
  async upgradeSkill(id, { minUses = 3, limit = 40 } = {}) {
    try {
      const llm = this._llm();
      if (!llm) return { upgraded: 0, reason: "无 LLM" };
      if (!this.skills || typeof this.skills.read !== "function") return { upgraded: 0, reason: "无 skills加载器" };
      const need = this.skills.get(id);
      if (!need) return { upgraded: 0, reason: "未知技能: " + id };
      const used = this.skills.useOf ? this.skills.useOf(id) : { uses: 0 };
      if ((used.uses || 0) < minUses) return { upgraded: 0, reason: "使用不足", uses: used.uses, need: minUses, name: id };
      const prev = this.skills.read(id);
      if (prev === null) return { upgraded: 0, reason: "读取失败", name: id };
      const ok = this.traces && typeof this.traces.read === "function" ? this.traces.read(undefined, limit).filter((t) => t.ok) : [];
      const sample = ok.slice(-15).map((t) => "工具 " + t.tool + ": " + String(t.result || "").slice(0, 120)).join("\n");
      let upgraded;
      try {
        const r = await llm.chat([
          { role: "system", content: "你是技能升级器。下面是一个已存在的技能全文 + 最近的成功工具轨迹。你的任务: 基于这些实际经验改进这个技能, 补充它的“## 流程”工作步骤/检查点和“## 反合理化”建议, 切勿删除“## 验证”段。只输出改进后的 SKILL.md 正文 (frontmatter 不用重复), 不要解释。" },
          { role: "user", content: "当前技能 (保留效果, 改进不足):\n\n" + String(prev).slice(0, 3000) + "\n\n最近成功轨迹:\n" + String(sample).slice(0, 2000) },
        ], { timeoutMs: AUX_LLM_TIMEOUT_MS, retryMax: 0 });
        upgraded = String(r.content || "").trim().replace(/```(?:md|markdown)?\s*/g, "").replace(/```/g, "").trim();
      } catch {
        return { upgraded: 0, reason: "LLM 升级失败", name: id };
      }
      if (!upgraded) return { upgraded: 0, reason: "空升级结果", name: id };
      const v = verifyUpgradeSkill({ content: upgraded, prevContent: prev });
      if (!v.ok) {
        warn("[upgradeSkill] 被升级闸门拦截: " + id + " - " + v.reason);
        return { upgraded: 0, reason: v.reason, rejected: true, name: id };
      }
      const w = await this.runTool("create_skill", { name: id, description: (need.description || ""), content: upgraded });
      if (typeof w === "string" && w.startsWith(TOOL_ERROR_PREFIX)) return { upgraded: 0, reason: w, name: id };
      if (this.skills.resetUse) this.skills.resetUse(id);
      info("[upgradeSkill] 升级技能: " + id + " (uses=" + used.uses + ")");
      this.tracer?.event("learning/upgrade_skill", { id, uses: used.uses });
      return { upgraded: 1, name: id, changed: v.changed, uses: used.uses };
    } catch (e) {
      warn("[upgradeSkill] 失败: " + String(e?.message || e).slice(0, 120));
      return { upgraded: 0, reason: String(e?.message || e).slice(0, 120), name: id };
    }
  }
}
