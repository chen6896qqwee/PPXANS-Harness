// src/agent/prompts.js - Agent 提示词/上下文构建 (从 index.js 拆分, mixin 挂回 prototype)
// 重构 (2026-09-15): 提示词组装 (技能清单/核心价值/DSML/画像/多模态) 从 PPXAgent 类中抽出,
// 方法以 mixin 方式挂回 prototype, 实例行为与调用方完全不变。

import { buildDsmlPrompt } from "../llm/dsml.js";
import { valuesPrompt } from "../ans/values.js";
import { context as rewardContext } from "../ans/reward.js";
import { renderBullets } from "../evolve/playbook.js";
import { imageFileToDataUrl } from "../tools/builtin.js";

// 多模态: 提取 user 消息中的图片路径并同步读图, 注入 OpenAI 视觉格式的 content 数组。
// 仅当当前 LLM 是 http 后端且 provider 标记 vision=true 时生效 (自研底座唯一后端)。
// 返回 string (无图/不支持) 或 [{type:text}, {type:image_url}...]
export function visionUserContent(llm, root, userMsg) {
  const text = String(userMsg);
  if (!llm || llm.backend !== "http" || !llm.vision) return text;
  const paths = [];
  for (const m of text.matchAll(/[^\s"'`，。；;：:,，()（）]+\.(?:png|jpe?g|gif|webp|bmp)/gi)) {
    paths.push(m[0]);
  }
  if (!paths.length) return text;
  const content = [{ type: "text", text }];
  for (const p of [...new Set(paths)].slice(0, 4)) {
    try {
      const dataUrl = imageFileToDataUrl(root, p);
      content.push({ type: "image_url", image_url: { url: dataUrl } });
    } catch { /* 读图失败静默跳过, 保留纯文本 */ }
  }
  return content.length > 1 ? content : text;
}

export const promptMethods = {
  // 组装记忆上下文
  // 差异化视角 (_perspective): 多 agent 场景下由委派方注入子 agent 的专属视角,
  // 对抗同质失败 (Anthropic: 同模型+同上下文 → 一个错全错), 生命周期由调用方控制
  // 方法技能清单注入: 让 LLM 知道有哪些方法论技能可用, 面对任务时主动 load_skill
  // (Superpowers 吸收: 技能不自动生效, 需要触发才读取全文, 省 token)
  _skillsPrompt() {
    try {
      if (!this.skills) return "";
      const list = this.skills.list().filter((s) => s && s.description);
      if (!list.length) return "";
      // 蓝皮书 2026 优化 (2026-10-01): description 是触发路由的唯一依据, 但目录常驻上下文,
      // 全量全文描述会随技能数线性膨胀。改为: 常用优先 (usage 降序) + 单条描述截断 + top-K 上限,
      // 其余技能由 skill_search 按需发现 — 三层渐进加载的第 1 层保持轻量。
      const usage = typeof this.skills.usageAll === "function" ? this.skills.usageAll() : {};
      const sorted = [...list].sort((a, b) => ((usage[b.id] || {}).uses || 0) - ((usage[a.id] || {}).uses || 0) || a.id.localeCompare(b.id));
      const DESC_CAP = 120, MAX_SHOWN = 16;
      const lines = sorted.slice(0, MAX_SHOWN).map((s) => {
        let d = String(s.description).split("\n")[0];
        if (d.length > DESC_CAP) d = d.slice(0, DESC_CAP) + "…";
        return `- ${s.id}: ${d}`;
      });
      const more = sorted.length - Math.min(sorted.length, MAX_SHOWN);
      return "【可用技能】面对对应任务时用 load_skill 读取全文再执行:\n"
        + lines.join("\n")
        + (more > 0 ? `\n(另有 ${more} 个技能未列出, 可用 skill_search 按关键词检索)` : "");
    } catch { return ""; }
  },

  // 按需工具清单 (2026-10-03, 上下文工程): 未披露给 LLM 的工具**只列名字、不列参数 schema**。
  // 目的: 让 agent 知道"还有什么能力可取", 同时不为 41 个工具的 JSON schema 付 token。
  // 实测 59 工具全量 schema ≈ 6725 tok/请求, 而这张清单 ≈ 300 tok —— 省掉 95% 的开销。
  // 与 _skillsPrompt 同一思路: 渐进披露的中间层 (列名 → 按需拉全文)。
  _toolsPrompt() {
    try {
      if (!this.tools || typeof this.tools.hiddenFromLLM !== "function") return "";
      const hidden = this.tools.hiddenFromLLM();
      if (!hidden.length) return "";
      const MAX_SHOWN = 40;
      const shown = hidden.slice(0, MAX_SHOWN);
      const more = hidden.length - shown.length;
      return "【按需工具】以下能力已注册, 但完整参数说明未加载。需要时先 enable_capability 启用, 下一轮即可调用:\n"
        + shown.join(", ")
        + (more > 0 ? ` …(另有 ${more} 个)` : "")
        + "\n(不确定用哪个时, 先 list_capabilities 查看全部能力及其用途)";
    } catch { return ""; }
  },

  _context(userMsg) {
    const base = this.persona.systemPrompt(this.userName) + "\n\n" + this.memory.context(userMsg) + "\n\n" + this.experience.context() + this._l3Context();
    // 核心价值 (ANS 价值对齐): 注入最前, 独立于 prompt, 不可被后续指令违背
    const values = this._valuesPrompt();
    // 引用规则 + 额外 system 内容均可配置 (agent.citation_rule / agent.system_extra)
    const citation = this.config.agent?.citation_rule || "";
    const extra = this.config.agent?.system_extra || "";
    const perspective = this._perspective ? `【任务视角】${this._perspective}` : "";
    const active = this.scenes.activeContext(userMsg || "");
    const baseCtx = active ? base + "\n\n" + active : base;
    const skills = this._skillsPrompt();
    const toolsHint = this._toolsPrompt();
    // DSML 原生文本模型 opt-in (provider.dsml=true): 注入工具协议, 让模型能稳定输出 DSML 结构做工具调用
    const dsml = this._dsmlPrompt();
    const rewardCtx = rewardContext(this); // ⑦ 低可靠性工具提醒 (Reward 闭环注入)
    const playbookCtx = this._playbookPrompt(); // 2026-10-03 接线: 语境 Playbook bullets 注入
    return [values, baseCtx, skills, toolsHint, citation, perspective, extra, dsml, rewardCtx, playbookCtx].filter(Boolean).join("\n\n");
  },

  // 语境 Playbook 注入 (2026-10-03 接线): 修复 playbook 引擎"就绪、无消费方"的缺口。
  // bullets 为空时 renderBullets 返回空串 → 零 token 成本, 不影响现有会话。
  _playbookPrompt() {
    try {
      if (!this.playbook) return "";
      return renderBullets(this.playbook.playbook, { maxBullets: 12 });
    } catch { return ""; }
  },

  // DSML 工具调用协议注入 (v1.1.1 接线): 修复 buildDsmlPrompt 过去从未注入的缺口。
  // 仅当激活的 http provider 显式 dsml=true 且工具启用时注入; 默认所有 provider 不注入(零回归)。
  _dsmlPrompt() {
    try {
      if (!(this.llm && this.llm.dsml === true)) return "";
      if (!this.toolsEnabled || !this.tools) return "";
      const tools = this.tools.toOpenAI();
      return buildDsmlPrompt(tools);
    } catch { return ""; }
  },

  // 核心价值文本 (委托 ans/values 模块): 数组 → 固定格式注入 (无值时不注入, 向后兼容)
  _valuesPrompt() {
    return valuesPrompt(this.config.agent?.values);
  },

  // L3 画像注入: 已生成的用户画像 + agent 自我画像 (未生成返回 "")
  _l3Context() {
    try {
      const parts = [];
      const u = this.personaStore.userPersona();
      const a = this.personaStore.agentPersona();
      if (u) parts.push(u);
      if (a) parts.push(a);
      return parts.length ? "\n\n" + parts.join("\n\n") : "";
    } catch { return ""; }
  },

  // L3 画像刷新: 跨天触发 (实现已迁 memory-service, 此处分发; 日期标记在 service 内部)
  _maybeRefreshPersona() {
    return this.memorySvc.refreshPersona();
  },

  // 找视觉 provider: 当前 LLM 若是 vision 直接用, 否则从 allProviders 找第一个 vision
  _visionLLM() {
    if (this.llm && this.llm.vision) return this.llm;
    return (this.allProviders || []).find((p) => p.vision) || null;
  },

  // 多模态 user 消息内容: 有图且存在 vision provider 时返回 content 数组, 否则纯文本
  _userContent(userMsg) {
    return visionUserContent(this._visionLLM(), this.root, userMsg);
  }
};
