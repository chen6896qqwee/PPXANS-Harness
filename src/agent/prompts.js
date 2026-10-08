// src/agent/prompts.js - Agent 提示词/上下文构建 (从 index.js 拆分, mixin 挂回 prototype)
// 重构 (2026-09-15): 提示词组装 (技能清单/核心价值/DSML/画像/多模态) 从 PPXAgent 类中抽出,
// 方法以 mixin 方式挂回 prototype, 实例行为与调用方完全不变。

import { buildDsmlPrompt } from "../llm/dsml.js";
import { valuesPrompt } from "../ans/values.js";
import { boundaryPrompt, riskDirective, detectHighRisk } from "../ans/boundary.js";
import { context as rewardContext } from "../ans/reward.js";
import { renderBullets } from "../evolve/playbook.js";
import { imageFileToDataUrl } from "../tools/builtin.js";
import path from "node:path";

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
      const list = this.skills.list().filter((s) => s && s.id);
      if (!list.length) return "";
      // 三层渐进加载 (2026-10-07 重做第 1 层):
      //   旧版: 按热度取 top-K, 每行 "id: description"。技能从 12 涨到 56 后这条路线失效 ——
      //        要么截断到 16 个 (2/3 的技能连名字都看不到, 而 skill_search 需要模型先"想到要搜"),
      //        要么全列描述 (实测 1257 tok/请求, 每次闲聊都付)。
      //   新版: ① **按能力域分组的全量名册** (只有名字, 中文域标 + 英文 id, 56 个约 400 tok) ——
      //          "有什么"这件事必须无损; ② **常用技能带描述** (top-K by usage, 保留路由信号)。
      //         描述不再常驻全员, 由 skill_search / load_skill 按需取 (蓝皮书的渐进披露)。
      const DESC_CAP = Number(this.config?.skills?.prompt_desc_cap) || 120;
      const HOT = Number(this.config?.skills?.prompt_hot_shown) || 8;
      const usage = typeof this.skills.usageAll === "function" ? this.skills.usageAll() : {};

      // ① 按域分组的名册 (域内按 id 排序: 字节稳定, 不破坏前缀缓存)
      const byDomain = new Map();
      for (const s of list) {
        const d = s.domain || "misc";
        if (!byDomain.has(d)) byDomain.set(d, []);
        byDomain.get(d).push(s);
      }
      const groupLines = [...byDomain.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([d, arr]) => {
          const names = arr.map((s) => (s.id.startsWith(`${d}/`) ? s.id.slice(d.length + 1) : s.id)).sort();
          return `${d}(${names.length}): ${names.join(", ")}`;
        });

      // ② 常用技能附描述 (只有被真正用过才有条目 → 新装环境零额外开销)
      const hot = [...list]
        .filter((s) => (usage[s.id]?.uses || 0) > 0)
        .sort((a, b) => (usage[b.id].uses - usage[a.id].uses) || a.id.localeCompare(b.id))
        .slice(0, HOT)
        .map((s) => {
          let d = String(s.description || "").split("\n")[0];
          if (d.length > DESC_CAP) d = d.slice(0, DESC_CAP) + "…";
          return `  - ${s.id}: ${d}`;
        });

      return "【可用技能】共 " + list.length + " 个, 按能力域分组 (用 skill_search 按关键词找, load_skill 读全文):\n"
        + groupLines.join("\n")
        + (hot.length ? "\n常用:\n" + hot.join("\n") : "");
    } catch { return ""; }
  },

  // 能力边界注入 (2026-10-07, 静态区): 与 ANS 价值并列的第二条硬约束。
  // 价值 = "我该怎么做人"; 边界 = "我做不到什么、什么不该由我拍板"。二者都不可被后续指令违背。
  // 确定性文本 + 零日期 → 不破坏前缀缓存 (契约见 test/prefix-cache-static-region.test.js)。
  _boundaryPrompt() {
    try { return boundaryPrompt(this.config); } catch { return ""; }
  },

  // 高风险域护栏 (2026-10-07, **动态区**): 只有 userMsg 命中医疗/法律/金融/安全/合规时才注入。
  // 刻意不做进静态区: 常驻会让每次闲聊都为医疗条款付 token, 而静态区一旦随消息变化就作废前缀。
  _riskDirective(userMsg) {
    try { return riskDirective(detectHighRisk(userMsg, this.config), this.config); } catch { return ""; }
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

  // 工作区定位 + 先读后改纪律 (2026-10-05, 基准真跑的两个病根):
  //   工具 schema 一路写"路径相对工作目录", 但组装出来的 system prompt 从没说过这个目录
  //   到底是哪个绝对路径, 也从没说过"用户点名的文件就在里面"。于是 fix-syntax 直接
  //   clarify 反问人类"请提供 broken.js 的具体位置", analyze-and-report 一次 read_file
  //   都没发就凭猜写了"共 1 行"。root 每进程恒定 → 放静态区, 前缀缓存不受影响。
  _workspacePrompt() {
    try {
      const root = path.resolve(this.root || process.cwd());
      return "【工作目录】" + root
        + "\n(工具参数里的相对路径都以它为基准)"
        + "\n- 任务点名的文件就在这个目录里: 先 read_file / search_files / list_dir 去找;"
        + " 找遍了再回答\"找不到\"。不要向用户反问路径。"
        + "\n- 改文件前先 read_file 读它; 写完按工具返回确认落盘。没读过就不要声称\"已修改/已统计\"。"
        // 2026-10-05 真跑复盘 (fix-logic/write-function): 模型只在回复里贴代码不落盘、
        // 且把 clarify 当"复述任务"的第一步烧掉整个回合。一句纪律, 仍留在静态前缀。
        + "\n- 要求改/写/修/重命名文件时: 必须用 write_file 或 apply_patch 落盘后再作答, 只在回复贴代码不算完成; clarify 不是第一步, 别用它复述任务。";
    } catch { return ""; }
  },

  // 上下文组装 (2026-10-04 重排): **静态块在前, 依赖 userMsg 的检索结果在后**。
  // 原因: provider 侧的 prompt caching 只匹配最长公共前缀。旧顺序把 memory.context(userMsg)
  // 放在第 2 位, 于是每次换问题前缀从 ~600 tok 处就分叉, 固定开销 (~3.4k) 全部重新计费;
  // 重排后与 userMsg 无关的 ~2.6k 常驻不变, 只有末尾检索段变化 —— 缓存能命中前缀。
  // 顺带把检索段挪到紧邻用户消息, 符合"文档贴近问题"的检索注入惯例。
  //
  // 2026-10-05 续 (cache-audit volatile_isolation 回归修复): "静态在前"此前被 habits =
  // experience.context() + _l3Context() 自己拆台 —— 学习派生文本坐在静态区, 每次学习事件/
  // 每次同天重启都会让其后全部字节重新计费。现在:
  //   ① L3 画像正文无日期 + 刷新跨进程按天 (memory/l3.js meta.json + memory-service.refreshPersona),
  //      所以画像只在"内容真的变了"的日子变一次字节, 而那一夜的 TTL (≤1h) 缓存本就失效, 免费;
  //      它保留在身份区 (价值/人格/工作目录/视角之后, 原 habits 槽位) —— 仍是 system 指令区的
  //      "他是谁", 不是可丢弃的检索噪声。
  //   ② 学到的经验 (lessons) 挪到静态区**末位** (紧贴动态检索段之前): 日内学到新经验时,
  //      只有它自己及其后的检索尾部重新计费, 前头的 价值/人格/技能/工具 schema 段照旧命中。
  // 顺序即语义契约: ANS 价值永远第一且不可被后续违背; 学习文本留在 system 消息内, 只后移不降级。
  _context(userMsg) {
    // ── 静态前缀 ──
    // 核心价值 (ANS 价值对齐): 注入最前, 独立于 prompt, 不可被后续指令违背
    const values = this._valuesPrompt();
    // 能力边界 (2026-10-07): 与价值并列的第二条硬约束, 紧跟其后 (都在指令区最前)
    const boundary = this._boundaryPrompt();
    const persona = this.persona.systemPrompt(this.userName);
    // 工作目录绝对路径 + 先读后改 (静态: root 每进程恒定, 排在 persona 之后不破坏前缀缓存)
    const workspace = this._workspacePrompt();
    // 差异化视角 (_perspective): 多 agent 场景下由委派方注入子 agent 的专属视角,
    // 对抗同质失败 (Anthropic: 同模型+同上下文 → 一个错全错), 生命周期由调用方控制
    const perspective = this._perspective ? `【任务视角】${this._perspective}` : "";
    // L3 画像 (学习派生; 日内字节稳定, 见上) 落在原 habits 槽位 (persona/workspace/perspective
    // 之后): 画像是对"用户是谁/我学成什么样"的常驻陈述, 与身份区同属指令上下文, 不并入尾部检索段
    const profile = this._l3Context();
    const skills = this._skillsPrompt();
    const toolsHint = this._toolsPrompt();
    // 引用规则 + 额外 system 内容均可配置 (agent.citation_rule / agent.system_extra)
    const citation = this.config.agent?.citation_rule || "";
    const extra = this.config.agent?.system_extra || "";
    // DSML 原生文本模型 opt-in (provider.dsml=true): 注入工具协议, 让模型能稳定输出 DSML 结构做工具调用
    const dsml = this._dsmlPrompt();
    const rewardCtx = rewardContext(this); // ⑦ 低可靠性工具提醒 (Reward 闭环注入)
    const playbookCtx = this._playbookPrompt(); // 2026-10-03 接线: 语境 Playbook bullets 注入
    // 学到的经验: 静态区末位 (②), 日内学习事件的分叉代价最小
    const lessons = this.experience.context();
    // ── 动态后缀 (随 userMsg 变化) ──
    // 高风险域护栏 (2026-10-07): 只有命中医疗/法律/金融/安全/合规时才非空 —— 空串被 filter 丢掉, 零成本
    const riskCtx = this._riskDirective(userMsg);
    const memoryCtx = this.memory.context(userMsg);
    const sceneCtx = this.scenes.activeContext(userMsg || "");
    // 目标看板 (2026-10-05 接线): 台账过去**只写不读** —— 模型从来看不到自己写下的计划,
    // 于是长任务每轮重新决策。放在动态检索段**之后** (整串末位) 而不是静态区, 理由是成本:
    //   ① memory.context(userMsg)/sceneCtx 本身随每句话变, 任何坐在它们**前面**的块都会被
    //      它们带着重新计费 —— 哪怕看板自身字节没变。挪到末位后: 看板不变时静态前缀
    //      (价值/人格/工作目录/视角/画像/技能/工具/引用/DSML/Reward/Playbook/经验) 全命中,
    //      只有尾部这一截分叉, 而尾部本来就要重付。
    //   ② 空看板返回 "" → 被下面的 .filter(Boolean) 整条丢掉 → 固定开销恰好 0 token
    //      (scripts/ctx-profile.js --check 的 4500 tok 闸门: 空板 4285 → 与接线前逐字节相同)。
    //   ③ 块内零时间戳 + 条数/单条长度双闸 (src/evidence promptBlock): 同一份看板每回合
    //      渲染出同一串字节, 不会重蹈 logicalDay()/学习文本烘进静态区的每日作废。
    const goalsCtx = this._goalBoardPrompt();
    return [values, boundary, persona, workspace, perspective, profile, skills, toolsHint,
            citation, extra, dsml, rewardCtx, playbookCtx, lessons, riskCtx, memoryCtx, sceneCtx, goalsCtx]
      .filter(Boolean).join("\n\n");
  },

  // 目标看板注入 (与 _playbookPrompt/_toolsPrompt 同一类"惰性重建、可缓存"块):
  // 每回合现算, 但内容只由看板数据决定 —— 数据没变就字节没变 (对表由 store 的
  // mtimeNs+size 闸门做, 一次 stat 而已, 不是每回合全量读盘)。
  // 未装配看板 / 无目标 / 老内存态看板 (没有 promptBlock) 一律返回 "" (0 token)。
  _goalBoardPrompt() {
    try {
      const board = this.goalBoard;
      if (!board || typeof board.promptBlock !== "function") return "";
      return board.promptBlock();
    } catch { return ""; }
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

  // L3 画像注入: 已生成的用户画像 + agent 自我画像 (未生成返回 "")。
  // 2026-10-05: 作为独立块直接进 join (旧版 habits 拼接用的小前置 "\n\n" 已不需要)。
  _l3Context() {
    try {
      const parts = [];
      const u = this.personaStore.userPersona();
      const a = this.personaStore.agentPersona();
      if (u) parts.push(u);
      if (a) parts.push(a);
      return parts.join("\n\n");
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
