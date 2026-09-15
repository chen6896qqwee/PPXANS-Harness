// src/agent/prompts.js - Agent 提示词/上下文构建 (从 index.js 拆分, mixin 挂回 prototype)
// 重构 (2026-09-15): 提示词组装 (技能清单/核心价值/DSML/画像/多模态) 从 PPXAgent 类中抽出,
// 方法以 mixin 方式挂回 prototype, 实例行为与调用方完全不变。

import { buildDsmlPrompt } from "../llm/dsml.js";
import { valuesPrompt } from "../ans/values.js";
import { context as rewardContext } from "../ans/reward.js";
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
      return "【可用技能】面对对应任务时用 load_skill 读取全文再执行:\n"
        + list.map((s) => `- ${s.id}: ${s.description}`).join("\n");
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
    // DSML 原生文本模型 opt-in (provider.dsml=true): 注入工具协议, 让模型能稳定输出 DSML 结构做工具调用
    const dsml = this._dsmlPrompt();
    const rewardCtx = rewardContext(this); // ⑦ 低可靠性工具提醒 (Reward 闭环注入)
    return [values, baseCtx, skills, citation, perspective, extra, dsml, rewardCtx].filter(Boolean).join("\n\n");
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
