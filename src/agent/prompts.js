// src/agent/prompts.js - Agent 提示词/上下文构建 (从 index.js 拆分, mixin 挂回 prototype)
// 重构 (2026-09-15): 提示词组装 (技能清单/核心价值/DSML/画像/多模态) 从 PPXAgent 类中抽出,
// 方法以 mixin 方式挂回 prototype, 实例行为与调用方完全不变。

import { buildDsmlPrompt } from "../llm/dsml.js";
import path from "node:path";
import { valuesPrompt } from "../ans/values.js";
import { context as rewardContext } from "../ans/reward.js";
import { imageFileToDataUrl } from "../tools/builtin.js";
import { summarize as pwfSummarize } from "../session/pwf.js";
import { renderBullets } from "../evolve/playbook.js";
import { loadProjectInstructions } from "../memory/project-md.js";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_SYSTEM_RATIO, CHARS_PER_TOKEN } from "./context.js";
import { estimateTokens } from "../utils/text.js";
import { boundaryPrompt, detectHighRisk, riskDirective } from "../ans/boundary.js";
import { routerRolePrompt } from "./role.js";

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

// ── system 预算分池拟合 (2026-11-09) ──────────────────────────────────────────
// 旧实现单池按总长裁剪, 静态内容涨到 6492/6553 字符后 (本仓库 67 技能 + 活计划) 暴露两个
// 实测破绽: ① goals 排裁剪序首位 → 预算一紧目标看板被整体丢弃 (goal-board ④ 挂);
// ② 静态段(skills 等)的裁剪量取决于【总】长 → 加一条目标 / 命中一次高风险护栏都会改写
// 静态前缀字节 (goal-board ④"静态前缀逐字节不变"、orchestration 边界护栏挂)。
// 修复: 以 risk 插槽为界分两池 —— 静态池按 (budget − 尾区预留) 独立拟合 (同数据恒同字节,
// 前缀缓存契约成立), 动态池用剩余预算拟合; 池内仍按裁剪代价从小到大。
// 尾区成员与 _context 组装序一致: risk 固定插槽在检索段之前, 其后是工作栈/回合计划/目标。
const TAIL_KEYS = new Set(["risk", "retrieval", "workstack", "planlive", "goals"]);
// 裁剪序: 先让"建议性"内容 (奖励/视角/持久计划), 最后才动技能/工具目录。
// 2026-11-12 修复: plan 曾排在 skills/tools 之后, 一份 3.4KB 的 .ppx/plan 就能把
//   技能清单(1384)与按需工具(1137)整段挤空 —— 模型既不知道有哪些技能, 也不知道
//   存在哪些按需工具 (delegate.test 的 _skillsPrompt 契约实测挂)。目录是"可调用能力
//   的唯一入口", 必须比计划摘要更晚被牺牲。
const HEAD_TRIM_ORDER = ["reward", "perspective", "plan", "citation", "extra", "projectmd", "dsml", "skills", "tools"];
// retrieval 不进裁剪序 (与旧单池设计一致: 记忆检索段永不裁, 自身另有预算约束);
// goals 排 risk 之前 —— 护栏最高优先, 目标只在工作栈/回合计划都让完后才牺牲。
const TAIL_TRIM_ORDER = ["planlive", "workstack", "goals", "risk"];
// 尾区预留: 保底 512 字符、至多 10% 预算 (0.25 时 delegate 实测 skills 被整体丢弃, 过挤)
const TAIL_RESERVE_MIN = 512;
const TAIL_RESERVE_RATIO = 0.1;

export const promptMethods = {
  // 【回复风格】段 (2026-11-18, 个性化面板): config.agent.reply_style 非空时注入。
  // 静态段 (只在用户改设置时变), 不在裁剪表 → 永不裁; 语义上与 persona 同属身份区。
  _replyStylePrompt() {
    const style = String(this.config?.agent?.reply_style || "").trim();
    if (!style) return "";
    return `【回复风格】(用户在个性化面板设定, 必须遵循)\n${style}`;
  },

  // 组装记忆上下文
  // 差异化视角 (_perspective): 多 agent 场景下由委派方注入子 agent 的专属视角,
  // 对抗同质失败 (Anthropic: 同模型+同上下文 → 一个错全错), 生命周期由调用方控制
  // 方法技能清单注入: 让 LLM 知道有哪些方法论技能可用, 面对任务时主动 load_skill
  // (设计溯源 docs/PROVENANCE.md#superpowers: 技能不自动生效, 需要触发才读取全文, 省 token)
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

  // 【按需工具】段 (2026-10-30 接线): 只在 tool_exposure 收窄时非空 —— 全量曝光时返回 "" (零 token)。
  // 内容契约 (前缀缓存): 名字恒升序 (catalog.hiddenFromLLM 已排序), 段内无时间戳/无计数漂移以外的
  //   可变内容; 工具集合在一次装配内恒定 ⇒ 同进程逐字节稳定, 不会作废 provider 前缀缓存。
  // 为什么给名字而不是直接不给: 模型必须知道"存在这么一个工具"才可能去取 schema; 只留名字
  //   (每名字约 5~8 tok) 换掉整段 schema (每工具 100+ tok), 这是这笔交易的全部意义。
  _toolsPrompt() {
    try {
      if (!this.tools || typeof this.tools.hiddenFromLLM !== "function") return "";
      const hidden = this.tools.hiddenFromLLM();
      if (!hidden.length) return "";
      const acfg = this.config?.agent || {};
      const CHAR_BUDGET = Number(acfg.tool_catalog_budget) || 1500;
      let body = `【按需工具】另有 ${hidden.length} 个工具本轮未下发完整参数 (省上下文)。`
        + "需要时先调 tool_schema(name) 取参数定义, 取过之后下一轮会直接下发该工具, 不要重复取:";
      body += "\n" + hidden.join(", ");
      if (body.length > CHAR_BUDGET) {
        body = body.slice(0, Math.max(200, CHAR_BUDGET - 40)).trimEnd()
          + "\n…[按需工具名单超出预算已裁剪, 其余用 list_capabilities 枚举]";
      }
      return body;
    } catch { return ""; }
  },

  // 【角色】段 (2026-11-04): 仅 Router 进程非空。静态文本 (名单固定), 前缀缓存不破。
  _rolePrompt() {
    if (this.role !== "router" || !this._routerAllow) return "";
    return routerRolePrompt({ allow: [...this._routerAllow] });
  },

  // 【手头的事】段 (2026-10-30, P1): 跨轮任务栈。空栈返回 "" (零 token)。
  // 位置契约: 内容随任务变化 ⇒ **只能放动态区**(检索段之后), 绝不能进静态前缀,
  //   否则每加/改一件事就作废整段 provider 缓存。段内不含时间戳 (逐字节稳定)。
  _workStackPrompt() {
    try {
      if (!this.workStack || typeof this.workStack.render !== "function") return "";
      return this.workStack.render();
    } catch { return ""; }
  },

  // 【当前计划】段 (v5.0 P2.3): update_plan 工具维护的分步计划, 空计划返回 "" (零 token)。
  // 位置契约: 随任务变化 ⇒ 动态区 (workstack 之后), 不进静态前缀; 段内不含时间戳。
  _planLivePrompt() {
    try {
      if (!this.planLive || typeof this.planLive.render !== "function") return "";
      return this.planLive.render(this._activeSessionKey || "default");
    } catch { return ""; }
  },

  // 【工作目录】段 (2026-10-05, 补接线): 工具 schema 一路写"路径相对工作目录", 但组装出的
  //   system prompt 从没给出该目录的绝对路径, 也没说明"任务点名的文件就在里面"。
  //   真跑基准里 fix-syntax 因此 clarify 反问人类要 broken.js 的位置, analyze-and-report
  //   一次 read_file 都没发就凭猜写了报告。本段补上绝对路径 + 三条硬纪律。
  //   root 每进程恒定 ⇒ 段落逐字稳定, 属静态前缀区 (root 在磁盘布局不变, 前缀缓存不退化)。
  _workspacePrompt() {
    const neutral = String(process.env.PPX_PROMPT_WORKSPACE_MODE || "").toLowerCase() === "neutral"
      || String(this.config?.agent?.workspace_prompt_mode || "").toLowerCase() === "neutral";
    let root;
    try { root = path.resolve(String(this.root || ".")); } catch { root = String(this.root || "."); }
    if (neutral) {
      return [
        "【工作目录】",
        "所有相对路径都相对当前工作目录 (具体路径用 pwd / list_dir 自行确认, 不要向用户反问)。",
        "任务点名的文件就在这个目录里 —— 先用 read_file / search_files / list_dir 自己找, 不要向用户反问路径。",
        "改文件前先 read_file 读原文; 改完用 write_file 或 apply_patch 落盘后再作答, 只在回复里贴代码不算完成, 并确认落盘结果 (读回或看 diff)。",
        "修缺陷遵循「先复现再修」: 先写一条能复现该 bug 的回归测试并跑出失败 (红), 再动手修, 最后重跑测试确认转绿 (绿)。不凭猜测直接改, 也不在没复现前就宣称修好。",
        "clarify 不是第一步: 信息不足时先自己动手查证, 确实无法推进再向用户提问。",
      ].join("\n");
    }
    return [
      "【工作目录】",
      `所有相对路径都相对工作目录: ${root}`,
      "任务点名的文件就在这个目录里 —— 先用 read_file / search_files / list_dir 自己找, 不要向用户反问路径。",
      "改文件前先 read_file 读原文; 改完用 write_file 或 apply_patch 落盘后再作答, 只在回复里贴代码不算完成, 并确认落盘结果 (读回或看 diff)。",
      "修缺陷遵循「先复现再修」: 先写一条能复现该 bug 的回归测试并跑出失败 (红), 再动手修, 最后重跑测试确认转绿 (绿)。不凭猜测直接改, 也不在没复现前就宣称修好。",
      "clarify 不是第一步: 信息不足时先自己动手查证, 确实无法推进再向用户提问。",
    ].join("\n");
  },

  // 【执行循环】段 (2026-11-02): 把"怎么可靠地把一件事做完"压缩成 6 条硬纪律。
  // 为什么单独成段: 工具调用能力不只取决于工具数量, 更取决于模型是否按"取证→小步→纠错→
  // 验证→给证据"的固定节奏走。此前这些约束散落在各工具描述里, 模型看不到全局节奏,
  // 常见失败是"猜路径 / 原样重试 / 改完不验证 / 无证据下结论"。
  // 静态段 (无动态内容), 位置紧跟能力边界, 与 values 同属行为底线, 不参与预算裁剪。
  _executionPrompt() {
    return [
      "【执行循环】",
      "1. 先取证再动手: 路径/文件内容/运行结果都用工具确认, 不要凭记忆或猜测。",
      "2. 一次推进一个可验证的小步; 相互独立的读取可以并行, 有依赖的必须串行。",
      "3. 工具报错先读错误再改: 参数错就修参数 (不确定结构先 tool_schema), 路径错就先列目录, 不要原样重试。",
      "4. 同一手段连续失败 2 次就换路 (换工具/换思路/向用户说明), 不要陷入重试循环。",
      "5. 写入必须验证: 改完读回或看 diff; 声称修好之前跑测试, 遵循先红后绿。",
      "6. 收尾给结论 + 证据 (文件:行 / 命令输出 / 测试结果); 没验证的部分如实标注不确定。",
      // 评测-II P2-1: 生产实测 (2026-11-09 等 3 个会话) npm test 30s 必超时, 反复撞超时烧掉
      //   全部轮次。run_background/job 常驻曝光却零调用 —— 根因是提示词从未引导。
      "7. 预计超过 30 秒的命令 (全量测试/构建/冒烟) 用 run_background 启动, 用 job 轮询结果; run_command 只跑快命令, 不要反复撞超时。",
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
    // PWF 持久规划注入 (设计溯源 docs/PROVENANCE.md#planning-with-files): 有落盘计划时自动带出现场,
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
      { key: "loop", text: this._executionPrompt() },           // 执行循环: 取证→小步→纠错→验证→证据
      { key: "persona", text: identity },                       // 人格卡片 (静态身份区)
      { key: "replyStyle", text: this._replyStylePrompt() },    // 回复风格: 紧跟能格卡片, 用户个性化设定
      { key: "profile", text: profile },                        // L3 画像 (静态身份区)
      { key: "skills", text: skills },
      // 按需工具名单: 紧跟技能目录 (同属"我有什么能力"的静态索引区); 全量曝光时为空串不占位
      { key: "tools", text: this._toolsPrompt() },
      { key: "role", text: this._rolePrompt() },                // 角色: 仅 Router 非空 (静态)
      { key: "experience", text: experience },                  // 经验块: 静态区末位 (技能清单之后、检索段之前)
      { key: "plan", text: planCtx },
      { key: "citation", text: citation },
      { key: "perspective", text: perspective },
      { key: "extra", text: extra },
      // 项目指令 (AGENTS.md / PPX.md): 放静态区末段 (extra 之后) —— 文件变更才作废前缀,
      //   位置越靠后失效半径越小; 语义上仍是"约定"而非动态检索内容。
      { key: "projectmd", text: this._projectMdPrompt() },
      { key: "dsml", text: dsml },
      { key: "reward", text: rewardCtx },
      { key: "playbook", text: playbookCtx },
      // 动态护栏: 仅命中高风险域时非空。位置【固定插在静态区之后、动态检索段之前】——
      //   放到检索段之后会重新引入"检索段在中间"的前缀作废问题。
      { key: "risk", text: riskDirective(detectHighRisk(userMsg || "", this.config), this.config) },
      { key: "retrieval", text: retrieval },                    // 动态检索段: 随 userMsg 变 (含 "# 今日对话")
      // 手头的事: 动态段 (随任务变), 紧跟检索段之后 —— 必须在静态区之外
      { key: "workstack", text: this._workStackPrompt() },
      // 回合内计划 (v5.0): update_plan 工具的分步计划, 同属动态区 (随任务变)
      { key: "planlive", text: this._planLivePrompt() },
      // 目标看板: 恒在检索段**之后** (契约: 加/改目标不得动静态区一个字节)。
      { key: "goals", text: goalsCtx },
    ].filter((p) => p.text);
    const system = this._fitSystemSections(parts, this._systemCharBudget());
    // 2026-11-16 (架构优化 ④ 消费侧): 记录本轮 system 的实测体积, 供紧随其后的
    //   _loadHistory → _trimHistory 计算"固定开销之外还剩多少历史预算"。
    try {
      this._lastContextStats = {
        systemChars: system.length,
        systemTokens: estimateTokens(system),
        toolTokens: this._toolSchemaTokens(),
      };
    } catch { this._lastContextStats = null; }
    return system;
  },

  // system 段字符预算 (窗口 × system_ratio × 字符/token 粗估), 下限 2000 字符保证可用
  _systemCharBudget() {
    const win = Number(this.llm?.context_window) || Number(this.config?.memory?.context_window) || DEFAULT_CONTEXT_WINDOW;
    const ratio = Number(this.config?.memory?.system_ratio) || DEFAULT_SYSTEM_RATIO;
    return Math.max(2000, Math.floor(win * ratio * CHARS_PER_TOKEN));
  },

  // 超预算时按「裁剪代价从小到大」逐段缩; 2026-11-09 起分池 (见文件头 TAIL_KEYS 注释):
  //   静态池独立拟合保证前缀只随静态数据变, 动态池 (risk/检索/工作栈/planlive/goals)
  //   用剩余预算, 两池互不牵连。values / boundary / loop / persona(base) 不在裁剪表 → 永不裁。
  _fitSections(parts, order, budget) {
    let total = parts.reduce((s, p) => s + p.text.length, 0);
    if (total <= budget) return parts;
    for (const key of order) {
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
    return parts;
  },

  _fitSystemSections(parts, budget) {
    const head = parts.filter((p) => !TAIL_KEYS.has(p.key));
    const tail = parts.filter((p) => TAIL_KEYS.has(p.key));
    const reserve = Math.max(TAIL_RESERVE_MIN, Math.floor(budget * TAIL_RESERVE_RATIO));
    const headFit = this._fitSections(head, HEAD_TRIM_ORDER, budget - reserve);
    const used = headFit.reduce((s, p) => s + p.text.length, 0);
    const tailFit = this._fitSections(tail, TAIL_TRIM_ORDER, Math.max(reserve, budget - used));
    return [...headFit, ...tailFit].filter((p) => p.text).map((p) => p.text).join("\n\n");
  },

  // 【项目指令】段 (2026-10-31): AGENTS.md / PPX.md 项目约定注入 —— 修复 /init 自创建起
  //   就声称"每次启动自动读取"但注入实现从未存在的文档-实现缺口 (ARCHITECTURE-V3 规划的
  //   project-md 四级记忆, 本段先落地项目根一级)。AGENTS.md 为 codex/cursor 生态标准文件。
  //   无文件返回 "" 零 token; 文件未变时 project-md 缓存逐字节稳定 (前缀缓存契约)。
  _projectMdPrompt() {
    try { return loadProjectInstructions(this.root); } catch { return ""; }
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
  // v4.2: 若本轮 L2 漏斗有分流提示块 (_turnIntentHints, 按 sessionKey 隔离), 追加到 user 消息尾部。
  //   关键约束: 【幂等】—— 同一轮内多次调用返回一致 (轮末由消费方从 Map 删除);
  //   且该内容会经 _persistTurn 的 historyText 一并落库 —— wire 与历史逐字节一致 (append-only 契约),
  //   下一轮模型看到的历史 = 上一轮真实所见; 记忆抽取仍用原文 (见 _persistTurn)。
  //   sessionKey 须传入 (buildMessages/_userWireText/chatStream 均持有); 缺省按 "default" 取。
  _userContent(userMsg, sessionKey) {
    let content = visionUserContent(this._visionLLM(), this.root, userMsg);
    const sk = String(sessionKey || "default");
    // 2026-11-03: @ 引用文件 (HTTP 层已读成有界资料块) —— 只进本轮 wire, 记忆抽取仍用原文。
    const refs = this._turnFileRefs?.get(sk) || "";
    if (refs) {
      if (Array.isArray(content)) content = [...content, { type: "text", text: "\n\n" + refs }];
      else content = String(content ?? "") + "\n\n" + refs;
    }
    const hint = this._turnIntentHints?.get(sk) || null;
    if (hint) {
      if (Array.isArray(content)) content = [...content, { type: "text", text: "\n\n" + hint }];
      else content = String(content ?? "") + "\n\n" + hint;
    }
    // Step 7: 断点续执行提示 —— 只在本轮由 resumeUnstartedTickets 挂上时出现。
    const rctx = this._turnResumeHints?.get(sk) || null;
    const rhint = rctx && typeof this._resumeHintText === "function" ? this._resumeHintText(rctx) : "";
    if (rhint) {
      if (Array.isArray(content)) content = [...content, { type: "text", text: "\n\n" + rhint }];
      else content = String(content ?? "") + "\n\n" + rhint;
    }
    return content;
  }
};
