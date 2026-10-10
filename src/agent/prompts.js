// src/agent/prompts.js - Agent 提示词/上下文构建 (从 index.js 拆分, mixin 挂回 prototype)
// 重构 (2026-09-15): 提示词组装 (技能清单/核心价值/DSML/画像/多模态) 从 PPXAgent 类中抽出,
// 方法以 mixin 方式挂回 prototype, 实例行为与调用方完全不变。

import { buildDsmlPrompt } from "../llm/dsml.js";
import path from "node:path";
import { valuesPrompt } from "../ans/values.js";
import { context as rewardContext } from "../ans/reward.js";
import { imageFileToDataUrl } from "../tools/builtin.js";
import { summarize as pwfSummarize } from "../planning/pwf.js";
import { renderBullets } from "../evolve/playbook.js";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_SYSTEM_RATIO, CHARS_PER_TOKEN } from "./context.js";
import { boundaryPrompt, detectHighRisk, riskDirective } from "../ans/boundary.js";

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
      // 三层渐进加载的第 1 层: 只放"名字", 不放描述 —— 路由靠 skill_search, 全文靠 load_skill。
      // 2026-10-09 重估: 技能库已扩到 56+ 个, 原 top-K(24) + 单条描述截断的做法会【静默丢名字】,
      //   模型根本不知道存在哪些技能。改为【全量按域分组只列名】: 一个不丢, 且比带描述更省 token
      //   (域内逗号分隔, 无前缀 "- id: ")。整段仍有硬字符预算兜底, 超出才裁剪并提示可检索。
      const acfg = this.config?.agent || {};
      const CHAR_BUDGET = Number(acfg.skill_catalog_budget) || 4000;
      const groups = new Map();
      for (const s of list) {
        const key = String(s.domain || "misc");
        const raw = String(s.id || "");
        const leaf = raw.includes("/") ? raw.split("/").pop() : raw;
        if (!leaf) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(leaf);
      }
      let body = `【可用技能】共 ${list.length} 个, 按域分组 (用 load_skill 读取全文再执行, 不确定用哪个就 skill_search 检索):`;
      for (const [domain, ids] of groups) {
        body += `\n[${domain}] ${ids.join(", ")}`;
      }
      if (body.length > CHAR_BUDGET) {
        body = body.slice(0, Math.max(200, CHAR_BUDGET - 48)).trimEnd()
          + "\n…[技能目录超出预算已裁剪, 其余请用 skill_search 按关键词检索]";
      }
      return body;
    } catch { return ""; }
  },

  // 【工作目录】段 (2026-10-05, 补接线): 工具 schema 一路写"路径相对工作目录", 但组装出的
  //   system prompt 从没给出该目录的绝对路径, 也没说明"任务点名的文件就在里面"。
  //   真跑基准里 fix-syntax 因此 clarify 反问人类要 broken.js 的位置, analyze-and-report
  //   一次 read_file 都没发就凭猜写了报告。本段补上绝对路径 + 三条硬纪律。
  //   root 每进程恒定 ⇒ 段落逐字稳定, 属静态前缀区 (root 在磁盘布局不变, 前缀缓存不退化)。
  _workspacePrompt() {
    let root;
    try { root = path.resolve(String(this.root || ".")); } catch { root = String(this.root || "."); }
    return [
      "【工作目录】",
      `所有相对路径都相对工作目录: ${root}`,
      "任务点名的文件就在这个目录里 —— 先用 read_file / search_files / list_dir 自己找, 不要向用户反问路径。",
      "改文件前先 read_file 读原文; 改完用 write_file 或 apply_patch 落盘后再作答, 只在回复里贴代码不算完成, 并确认落盘结果 (读回或看 diff)。",
      "clarify 不是第一步: 信息不足时先自己动手查证, 确实无法推进再向用户提问。",
    ].join("\n");
  },

  _context(userMsg) {
    // 组装次序契约 (2026-10-05 前缀缓存 / 2026-10-10 收敛为单条静态区):
    //   静态区在前, **动态检索段在末尾**。检索段 (memory.context 的关键事实排序 /
    //   scenes.activeContext) 随 userMsg 变, 若排在中间, 则每换一个问题, 从检索段起的
    //   整个 system 前缀都会作废 (provider 只命中最长公共前缀)。
    //   见 test/prefix-cache-static-region.test.js 契约 C/D。
    const identity = this.persona.systemPrompt(this.userName);
    const profile = this._l3Context();               // L3 画像: 身份区 (紧邻 persona, 未降级为尾注)
    const experience = this.experience.context();     // 经验库: 静态区末位 (学习→新增经验分叉代价最小)
    // 核心价值 (ANS 价值对齐): 注入最前, 独立于 prompt, 不可被后续指令违背
    const values = this._valuesPrompt();
    // 引用规则 + 额外 system 内容均可配置 (agent.citation_rule / agent.system_extra)
    const citation = this.config.agent?.citation_rule || "";
    const extra = this.config.agent?.system_extra || "";
    const perspective = this._perspective ? `【任务视角】${this._perspective}` : "";
    const skills = this._skillsPrompt();
    // PWF 持久规划注入 (2026-10-06 吸收 planning-with-files): 有落盘计划时自动带出现场,
    // 压缩/清空后 agent 仍知道"刚才干到哪、下一步干嘛" — 计划在磁盘, 不在上下文
    const planCtx = this._planContext();
    // 目标看板注入 (2026-10-05): 多 agent 协作时统一目标可见性 (块内零时间戳, 逐字节稳定)。
    const goalsCtx = this._goalContext();
    // DSML 原生文本模型 opt-in (provider.dsml=true): 注入工具协议, 让模型能稳定输出 DSML 结构做工具调用
    const dsml = this._dsmlPrompt();
    const rewardCtx = rewardContext(this); // ⑦ 低可靠性工具提醒 (Reward 闭环注入)
    // 2026-10-10: playbook bullets 注入 (语境 Playbook 接线) —— 空库返回空串, 零 token 成本
    const playbookCtx = this.playbook ? renderBullets(this.playbook.playbook) : "";
    // 动态检索段 (唯一允许随 userMsg 分叉的区段) —— 必须落在最末尾。
    const active = this.scenes.activeContext(userMsg || "");
    const memCtx = this.memory.context(userMsg);
    const retrieval = active ? memCtx + "\n\n" + active : memCtx;
    // 2026-10-09: system 段此前【完全没有预算】, 只有历史消息受 _trimHistory 约束。
    // 技能库/经验库/画像持续增长会把 system 推高到挤占历史预算 (默认 8k 窗口 → 历史仅 4915 token),
    // 长跑会话更容易触发溢出降档。这里给 system 一个上界, 超预算按优先级逐段裁剪。
    const parts = [
      { key: "values", text: values },
      { key: "workspace", text: this._workspacePrompt() },      // 工作目录: 静态前缀区最前 (root 恒定)
      { key: "boundary", text: boundaryPrompt(this.config) },  // 能力边界: 静态常驻, 与 values 同属行为底线
      { key: "persona", text: identity },                       // 人格卡片 (静态身份区)
      { key: "profile", text: profile },                        // L3 画像 (静态身份区)
      { key: "skills", text: skills },
      { key: "experience", text: experience },                  // 经验块: 静态区末位 (技能清单之后、检索段之前)
      { key: "plan", text: planCtx },
      { key: "citation", text: citation },
      { key: "perspective", text: perspective },
      { key: "extra", text: extra },
      { key: "dsml", text: dsml },
      { key: "reward", text: rewardCtx },
      { key: "playbook", text: playbookCtx },
      // 动态护栏: 仅命中高风险域时非空。位置【固定插在静态区之后、动态检索段之前】——
      //   放到检索段之后会重新引入"检索段在中间"的前缀作废问题。
      { key: "risk", text: riskDirective(detectHighRisk(userMsg || "", this.config), this.config) },
      { key: "retrieval", text: retrieval },                    // 动态检索段: 随 userMsg 变 (含 "# 今日对话")
      // 目标看板: 恒在检索段**之后** (契约: 加/改目标不得动静态区一个字节)。
      { key: "goals", text: goalsCtx },
    ].filter((p) => p.text);
    return this._fitSystemSections(parts, this._systemCharBudget());
  },

  // system 段字符预算 (窗口 × system_ratio × 字符/token 粗估), 下限 2000 字符保证可用
  _systemCharBudget() {
    const win = Number(this.llm?.context_window) || Number(this.config?.memory?.context_window) || DEFAULT_CONTEXT_WINDOW;
    const ratio = Number(this.config?.memory?.system_ratio) || DEFAULT_SYSTEM_RATIO;
    return Math.max(2000, Math.floor(win * ratio * CHARS_PER_TOKEN));
  },

  // 超预算时按「裁剪代价从小到大」的顺序逐段缩, values/persona(base) 永不裁 —— 它们是行为底线。
  _fitSystemSections(parts, budget) {
    let total = parts.reduce((s, p) => s + p.text.length, 0);
    if (total <= budget) return parts.map((p) => p.text).join("\n\n");
    // 裁剪顺序 = 裁剪代价从小到大; values / boundary / base 不在表内 → 永不裁 (行为底线)。
    // risk 放最后: 它是已命中高风险域后的强制护栏, 优先级最高, 最后才考虑牺牲。
    const TRIM_ORDER = ["goals", "reward", "perspective", "skills", "plan", "citation", "extra", "dsml", "risk"];
    for (const key of TRIM_ORDER) {
      if (total <= budget) break;
      const p = parts.find((x) => x.key === key);
      if (!p || !p.text) continue;
      const need = total - budget;
      if (p.text.length <= need + 64) {
        total -= p.text.length;
        p.text = "";
        continue;
      }
      const keepLen = p.text.length - need - 64;
      const next = p.text.slice(0, keepLen).trimEnd() + `\n…[${key} 段因 system 预算不足被裁剪]`;
      total -= (p.text.length - next.length);
      p.text = next;
    }
    return parts.filter((p) => p.text).map((p) => p.text).join("\n\n");
  },

  // PWF 持久规划摘要 (2026-10-06): 无计划返回 "", 零侵入向后兼容; 异常静默不阻断主链路
  _planContext() {
    try {
      if (!this.root) return "";
      return pwfSummarize(this.root);
    } catch { return ""; }
  },

  // 目标看板注入 (2026-10-05): 空看板返回 "" (固定开销恰 0 token)。
  // 看板本身保证块内零时间戳 → 同一份数据每回合同一串字节, 不会作废前缀缓存。
  _goalContext() {
    try {
      const b = this.goalBoard;
      if (!b || typeof b.promptBlock !== "function") return "";
      return b.promptBlock();
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
