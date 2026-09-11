// src/agent/index.js - Agent 引擎 (皮皮虾核心) v0.2 含工具调用
import { ensureUTF8Console } from "../utils/winutf8.js";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { TOOL_ERROR_PREFIX } from "../tools/index.js";
import { imageFileToDataUrl } from "../tools/builtin.js";
import { logicalDay } from "../utils/store.js";
import { estimateTokens } from "../utils/text.js";
import { loadConfig } from "../config/index.js";
import { info, warn, error } from "../utils/logger.js";
import { Context, compose, loadPlugins } from "../plugin/index.js";
import { builtinPlugins, resolveLLM, resolveAllLLMs } from "../plugin/builtin.js";
import { registerMcpTools } from "../mcp/index.js";
import { buildCompactionMessages, transcriptToText } from "../memory/compaction.js";
import { buildDsmlPrompt } from "../llm/dsml.js";
import { Auditor, verifyLesson, heldOutSplit } from "../audit/verifier.js";
// ANS 独立模块 (可更换): 价值对齐 / 自主任务生成 / 生命周期
import { Lifecycle } from "../ans/lifecycle.js";
import { valuesPrompt } from "../ans/values.js";
import { suggestProactive, markTaskDone } from "../ans/proactive.js";
import { record as rewardRecord, context as rewardContext, status as rewardStatus } from "../ans/reward.js";
import { scan as evictionScan, status as evictionStatus } from "../ans/eviction.js";
import { installGuard, guardStatus } from "../ans/guard.js";
import { SkillLoader } from "../skills/loader.js";
import { EvolutionEngine } from "../selfheal/evolve.js";
import { verifySkill, verifyUpgradeSkill } from "../skills/verify.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 阈值默认值 (可通过 config.agent.max_tool_rounds / tool_result_budget / max_tool_error_retry 覆盖)
const DEFAULT_MAX_TOOL_ROUNDS = 8;
const DEFAULT_TOOL_RESULT_BUDGET = 4000; // L4 toolResultBudget: 工具结果超过此长度裁剪, 防撑爆上下文
const DEFAULT_MAX_TOOL_ERROR_RETRY = 2;
// 辅助 LLM 调用短超时 (压缩/提炼/查询扩展/经验技能提炼等非主对话调用):
// 模型不可用/网络不通时快速失败降级, 避免阻塞主对话 (主对话仍走 provider 默认长超时)
const AUX_LLM_TIMEOUT_MS = 10000;
// 会话历史条数/token 预算已迁到 config.memory (max_history_items / history_token_budget)

// 上下文窗口感知 (第九轮 review P1): 当 provider 上下文太小、或本地模型真溢出时,
// 压缩依赖 LLM 摘要帮不上忙。这里用 provider 的 context_window 反推一个
// 「历史 token 预算硬上限」, 且提供不依赖 LLM 的硬裁剪兜底 + 溢出检测降档重试。
const DEFAULT_CONTEXT_WINDOW = 8192; // 未知窗口时的保守默认 (绝不放大历史)
const DEFAULT_CONTEXT_RATIO = 0.6;   // 历史+工具结果占用窗口的安全比例上限
const DEFAULT_OVERFLOW_SHRINK_MAX = 2;

// P0③ harness 融断: 探索连击 / 重复命令 阈值 (config.agent.explore_break_limit / repeat_flag_limit 可调)
const DEFAULT_EXPLORE_BREAK = 3;   // 连续 3 轮只有只读/查询无产出 -> 融断
const DEFAULT_REPEAT_FLAG = 2;     // 同一工具+args 命中 2 次 -> 警告重复
// 探索类工具集 (read-only/发现; 不算“产出或修改”)
const EXPLORE_TOOLS = new Set([
  "read_file", "list_dir", "web_search", "fetch_page", "memory_search", "read_document",
  "get_time", "read_image", "ocr_image", "list_schedules", "list_capabilities", "replay_session",
]); // 溢出时最多再降档裁剪重试几次

// 判断是否为「上下文溢出」错误 (常见信号: 消息含 context/length/token/window, 或 HTTP 400/413)
// 注意: AbortError(用户取消/内部超时中止) 一律不算溢出, 沿用 retry.js 不重试约定。
export function _isOverflowError(e) {
  if (!e) return false;
  if (e.name === "AbortError" || e.code === "ABORT_ERR") return false;
  const status = (typeof e.status === "number" ? e.status : e.statusCode) ?? null;
  if (status === 413) return true; // 请求体过大 (content too large)
  if (status !== null && status !== 400 && (status >= 500 || status < 400)) return false; // 服务端/非 4xx 非溢出
  const msg = String(e?.message || e || "");
  // 仅在消息出现上下文/长度/token 相关措辞时判为溢出, 普适 HTTP 400 不误判
  if (status === 400) {
    return /context|token|length|window/i.test(msg);
  }
  return /context\s*(size)?\s*exceeded|maximum\s*context\s*length|too\s*many\s*tokens|context\s*window|token\s*(limit|budget)|exceeds?\s*(the\s*)?(model|context|token)|insufficient\s*context/i.test(msg);
}

// LLM 调用失败的兜底提示: 附排查指引, 避免裸抛错误对用户不友好
export function LLM_FAILED_HINT(message) {
  return `[皮皮虾] LLM 调用失败: ${message}
排查指引: 1) 检查 config/ppx.json 的 providers 是否配置了可用的 API key (export XXX_API_KEY=...); 2) 本地模型 (lmstudio) 是否在运行; 3) 启动 ppx-serve 看日志确认模型加载。`;
}

// L4 toolResultBudget: 裁剪超长工具结果, 保留头尾关键信息 (默认 4000, config.agent.tool_result_budget 可调)
export function trimToolResult(r, budget = DEFAULT_TOOL_RESULT_BUDGET) {
  const s = String(r || "");
  if (s.length <= budget) return s;
  const head = s.slice(0, budget * 0.7);
  const tail = s.slice(-budget * 0.3);
  return head + `\n...[结果已裁剪: 共 ${s.length} 字符, 保留头尾 ${budget}]...\n` + tail;
}

// 多模态: 提取 user 消息中的图片路径并同步读图, 注入为 OpenAI 视觉格式的 content 数组。
// 仅当当前 LLM 是 http 后端且 provider 标记 vision=true 时生效 (openclaw/dsh 走文本围栏不传图)。
// 返回 string (无图/不支持) 或 [{type:text}, {type:image_url}...]
function _visionUserContent(llm, root, userMsg) {
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

// 工具结果 → OpenAI 消息 content: 图片 data URL 转 image_url 块 (多模态), 否则文本裁剪
export function toToolContent(result, budget = DEFAULT_TOOL_RESULT_BUDGET) {
  const s = String(result || "");
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(s)) {
    return [{ type: "image_url", image_url: { url: s } }];
  }
  return trimToolResult(s, budget);
}

export class PPXAgent {
  constructor({ root = ROOT, configFile = null, plugins = [], dataDir = null, globalDataDir = null } = {}) {
    this.root = root;
    // dataDir 可覆盖: 显式参数 > PPX_DATA_DIR 环境变量 > 默认目录
    // 默认目录: 包装在 node_modules 里时外置到 ~/.ppx (防卸载丢数据), 否则 root/data
    this.dataDir = dataDir || process.env.PPX_DATA_DIR || this._defaultDataDir(root);
    // 全局共享数据目录 (跨 agent 共享经验等): 显式参数 > PPX_AGENT_GLOBAL_DATA_DIR > 本地 dataDir
    this.globalDataDir = globalDataDir || process.env.PPX_AGENT_GLOBAL_DATA_DIR || this.dataDir;
    this.config = this._loadConfig(configFile);
    this.userName = this.config.user?.name || "兄弟";

    // 插件装配: ctx 预置基础服务, 按顺序装配内置 + 用户插件 (一切皆插件)
    this.ctx = new Context();
    this.ctx.provide("root", root);
    this.ctx.provide("dataDir", this.dataDir);
    this.ctx.provide("globalDataDir", this.globalDataDir);
    this.ctx.provide("config", this.config);
    this.ctx.provide("userName", this.userName);
    this.ctx.provide("agent", this);
    // 装配顺序: 内置插件 → 用户插件目录(声明式) → 构造函数传入插件(编程式)
    const pluginsDir = path.join(root, this.config.plugins?.dir || "plugins");
    compose(this.ctx, [...builtinPlugins, ...loadPlugins(pluginsDir), ...plugins]);

    // 从 ctx 取服务, 设置公开属性 (向后兼容, 外部代码不变)
    this.healer = this.ctx.consume("healer");
    this.health = this.ctx.consume("health");
    this.persona = this.ctx.consume("persona");
    this.facts = this.ctx.consume("facts");
    this.experience = this.ctx.consume("experience");
    this.sessionStore = this.ctx.consume("sessions");
    this.memory = this.ctx.consume("memory");
    this.llm = this.ctx.consume("llm");
    this.allProviders = this.ctx.consume("allProviders");
    this.l0 = this.ctx.consume("l0");
    this.scenes = this.ctx.consume("scenes");
    this.personaStore = this.ctx.consume("personaStore");
    this.traces = this.ctx.consume("traces");
    this.bus = this.ctx.consume("bus");
    // ⑧ 免疫系: 全局闸门挂到总线命令通道 (拦截+审计)
    this.__guard = installGuard(this, { allowList: this.config.agent?.guardAllowList || [] });
    // ⑦ Reward 闭环: 订阅总线工具成败, 自动更新行为倾向 (EWMA)
    this.bus?.on("tool/result", (ev) => {
      const { name, ok } = ev.payload || {};
      if (name) { try { rewardRecord(this, { tool: name, ok: !!ok }); } catch {} }
    });
    this.tools = this.ctx.consume("tools");
    this.scheduler = this.ctx.consume("scheduler");
    // ⑤排泄自治: 每日扫描长期记忆做冗余识别/冷热分层 (幂等注册, 不重复)
    try {
      const hasE = (this.scheduler?.list?.() || []).some((j) => j.name === "eviction-daily");
      if (!hasE) this.scheduler?.add({ name: "eviction-daily", cron: "02:00", type: "daily", action: () => { try { evictionScan(this); } catch {} } });
    } catch {}
    // 首次启动跑一次排遗扫描 (预热治理状态)
    try { evictionScan(this); } catch {}
    this.toolsEnabled = this.ctx.consume("toolsEnabled");
    this._warnMissingCloudApi(); // 发布首启引导: 未配云端 key 时明确提示

    // 注入 LLM 摘要器/提炼器 (依赖 agent 方法, 装配后注入)
    this.memory.summarizer = (raw) => this._summarizeMemory(raw);
    this.memory.setExtractor((u, a, related) => this._extractMemory(u, a, related));

    // 主动通知 + 中断状态
    this._notifyCb = null;
    this._onToolEvent = null; // 工具事件回调
    this._interrupted = false;
    this._lastTurnUsedTools = false;
    this._mcp = null; // MCP 连接句柄 (connectMcp 后赋值)
    this._personaBuilt = null; // L3 画像上次生成日期 (跨天刷新)
    this._proactiveTimer = null; // 主动任务生成定时器
    // 生命周期 (ANS 独立模块): born → growing → mature → evolving / reproducing
    // v1.0.7 持久化: 状态落盘 data/memory/lifecycle.json, 跨进程/重启不归零 (P1)
    this.lifecycle = new Lifecycle({ file: path.join(this.dataDir, "memory", "lifecycle.json") });
    this.evolve = new EvolutionEngine(this, this.config.agent?.evolve || {});
    // Auditor (P0①): 唯一“已验证写回”通道 + 已验证账本 (data/audit/verified.json)
    this.auditor = new Auditor({ ledgerPath: path.join(this.dataDir, "audit", "verified.json") });
    // 方法技能目录 (Superpowers 吸收): 供 _context 注入技能清单, LLM 按需 load_skill
    try { this.skills = new SkillLoader(path.join(root, "skills")); } catch { this.skills = null; }

    // 应用 tools.disabled: 从 config/ppx.json 读取需禁用的工具, 启动时禁用 (设置 UI 写盘生效)
    this._applyDisabledTools();

    // 可选: 启动时自动连接 MCP 服务器 (config.mcp.auto_connect = true 时非阻塞连接)
    if (this.config.mcp?.auto_connect && this.config.mcp.servers?.length) {
      this.connectMcp()
        .then((n) => { if (n) info(`[mcp] 自动连接 ${n} 个 MCP 工具`); })
        .catch((e) => warn(`[mcp] 自动连接失败: ${e.message}`));
    }

    // 首次启动生成 L3 画像 (零依赖高频词统计, 同步快, 不调 LLM)
    this._maybeRefreshPersona();
  }


  
  // 默认数据目录: 包装在 node_modules 里(全局/本地安装)时外置到 ~/.ppx, 否则 root/data
  _defaultDataDir(root) {
    if (String(root).includes("node_modules")) return path.join(os.homedir(), ".ppx");
    return path.join(root, "data");
  }

  // 主动通知 + 中断 API
  setNotify(cb) { this._notifyCb = typeof cb === "function" ? cb : null; }
  // 工具调用过程可视化 - 回调 (tool名, 参数, 耗时, 状态) 供 Web UI 推送
  setToolEvent(cb) { this._onToolEvent = typeof cb === "function" ? cb : null; }
  // turn/step 分层: 推理轮次事件 (每轮工具循环发一次 step), 供军团 worker 上报进度
  setStepEvent(cb) { this._onStepEvent = typeof cb === "function" ? cb : null; }
  notify(message) { if (this._notifyCb) { try { this._notifyCb(String(message)); } catch (e) {} } }
  interrupt() { this._interrupted = true; }
  clearInterrupt() { this._interrupted = false; }

  // 只读模式 (SDD 审查者, 吸收 Superpowers): 禁用一切修改/执行类工具, 只能读/查
  // 供 spawn_agent review 循环的审查者角色 (worker 经 PPX_AGENT_READONLY=1 触发)
  enableReadonlyMode() {
    const disabled = [
      "run_command", "write_file", "code_act", "create_skill",
      "memory_add", "add_schedule",
      "scene_create", "scene_describe", "spawn_agent", "refine_skill",
      "refine", // v1.0.8: refine 会写经验库, 只读审查者也不应触发
    ];
    for (const t of disabled) { try { this.tools.disable(t); } catch {} }
    this.readonly = true;
    return this;
  }

  _loadConfig(configFile) {
    return loadConfig(this.root, configFile);
  }

  // P1#9: LLM 结构化记忆提炼 - 从高信号对话提取关键事实/偏好/待办 (替代简单启发式)
  // 感知式提炼: 传入已有相关记忆 (existing), 让 LLM 从源头跳过与已有记忆同义/被覆盖的提炼结果,
  // 防同一主题反复以不同措辞入库 (字面变体逃过精确去重, 语义变体逃过 0.6 Jaccard 阈值)
  // 返回 string[] (纯内容数组); existing 为空时行为与旧版完全一致 (向后兼容)
  async _extractMemory(user, assistant, existing = []) {
    if (!this.llm) return [];
    if (!(await this._auxLlmReady())) return []; // 模型不可用时跳过提炼 (退回启发式)
    // v1.0.7 噪声治理: 显式跳过寒暄/无信息量/关于系统本身的元讨论 (如"任务描述要详细"这类对助手的建议, 非用户长期事实)
    const sys = "你是记忆提炼器。从对话中提取值得长期记忆的关键事实、用户偏好、待办事项。只输出 JSON 数组, 每项是{content: 一句完整中文记忆}。没有值得记的返回 []。不要解释, 只输出 JSON。\n跳过以下内容: 1) 寒暄/问候/客套话; 2) 无信息量的闲聊; 3) 对助手/系统本身的元讨论与建议 (如任务描述方式、提示词建议等); 4) 已被现有记忆覆盖的内容。";
    let userMsg = "用户: " + String(user).slice(0, 800) + "\n助手: " + String(assistant).slice(0, 800);
    // 感知已有记忆: 若提炼结果与已有记忆含义相同/已被覆盖, 不要输出该条
    if (existing.length) {
      userMsg += "\n\n【已有记忆】以下记忆已存在, 若你提炼的内容与其中任意一条含义相同或被其覆盖, 则不要输出该条 (避免重复):\n"
        + existing.map((f, i) => `${i + 1}. ${f.content}`).join("\n");
    }
    const r = await this.llm.chat([
      { role: "system", content: sys },
      { role: "user", content: userMsg },
    ], { timeoutMs: AUX_LLM_TIMEOUT_MS, retryMax: 0 });
    const text = String(r.content || "").trim();
    // 容忍模型把 JSON 包在 markdown 代码块里
    const cleaned = text.replace(/```(?:json|JSON)?\s*/g, "").replace(/```/g, "").trim();
    // 提取第一个最外层 JSON 数组 (贪婪匹配到最后一个 ], 容忍内容里的嵌套方括号)
    const m = cleaned.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try {
      const arr = JSON.parse(m[0]);
      return Array.isArray(arr) ? arr.map((x) => String(x.content || x).trim()).filter(Boolean) : [];
    } catch { return []; }
  }

  // 辅助 LLM 调用前置健康探测 (v1.0.7): 模型不可用 (本地服务未运行/远端不可达) 时快速跳过,
  // 不发起 10s 超时等待 — 本地未运行的 health() 是 ECONNREFUSED 毫秒级失败, 开销可忽略
  async _auxLlmReady() {
    if (!this.llm) return false;
    if (typeof this.llm.health !== "function") return true;
    try { return await this.llm.health(); } catch { return false; }
  }

  // 用 LLM 把旧对话浓缩成语义摘要 (Harness 上下文工程)
  async _summarizeMemory(raw) {
    if (!this.llm) throw new Error("无 LLM");
    if (!(await this._auxLlmReady())) throw new Error("LLM 不可用, 跳过辅助摘要");
    const r = await this.llm.chat([
      { role: "system", content: "你是记忆压缩器。把下面这段对话记录压缩成一段简洁的中文摘要(≤200字), 保留关键事实、用户偏好、进展和待办。不要客套, 直接输出摘要。" },
      { role: "user", content: String(raw).slice(0, 4000) },
    ], { timeoutMs: AUX_LLM_TIMEOUT_MS, retryMax: 0 });
    return r.content;
  }

  // P1: LLM 查询扩展 - 把问题改写成多个词面变体, 补语义召回 (零依赖, 复用已有 LLM)
  async _expandQuery(q) {
    if (!(await this._auxLlmReady())) return []; // 模型不可用时跳过扩展 (退回单查询)
    const r = await this.llm.chat([
      { role: "system", content: "你是查询扩展器。把用户的问题改写成 3 个语义相近但词面不同的检索短语(用于语义记忆检索), 每行一个, 不要序号、不要解释。" },
      { role: "user", content: String(q).slice(0, 300) },
    ], { timeoutMs: AUX_LLM_TIMEOUT_MS, retryMax: 0 });
    return String(r.content || "")
      .split(/\n+/)
      .map((s) => s.replace(/^[\d\.\-、)）]\s*/, "").trim())
      .filter((s) => s && s !== String(q).trim())
      .slice(0, 3);
  }

  // P1: 语义记忆检索 - 原始查询 + LLM 扩展变体做 RRF 融合; 无 LLM 时退化为单查询
  async _memoryQuery(q, { limit = 5, scope = null } = {}) {
    // 有 embedder 时走 dense 语义检索 (与 BM25 RRF 融合), 否则 LLM 扩展 + RRF
    if (this.facts.embedder) {
      return this.facts.querySemantic(q, { limit, scope });
    }
    const variants = [q];
    if (this.llm) {
      try { variants.push(...(await this._expandQuery(q))); } catch { /* LLM 失败静默降级 */ }
    }
    if (variants.length === 1) return this.facts.query(q, { limit, scope });
    return this.facts.queryMulti(variants, { limit, scope });
  }

  // ---- 多轮会话历史 (吸收 dsh "会话即事实源") ----
  // 历史从事件日志投影, 再按预算裁剪 (裁剪只发生在投影层, 日志本身不可变)
  // v0.6.6 优化: 信息量感知裁剪 (学自 Claude Code Microcompact 思路)
  //   旧版: 纯按条数硬截 + 尾部 token 预算, 可能裁掉关键决策/工具结果轮次
  //   新版: 优先保留"含关键信息"的轮次(指令/数字/路径/结论/工具结果), 纯寒暄让位
  _historyPriority(m) {
    const s = String(m?.content || "");
    if (!s) return 0;
    let p = 0;
    // 长消息(含工具结果/详细决策)权重高
    if (s.length > 120) p += 2;
    // 含指令/结论/数字/路径/文件等关键信号
    if (/[查|算|计算|写|建|改|创建|删除|修复|总结|分析|设置|配置|执行|运行|启动|停止|提交|部署|安装|生成|编译|测试]/.test(s)) p += 2;
    if (/[0-9]{2,}|[%.¥$元%]|[:：][0-9]/.test(s)) p += 1;
    if (/[A-Za-z]:[\\\/]|\.(js|py|md|json|txt|ts|go|rs|cpp|java|log)\b/.test(s)) p += 2;
    if (/失败|错误|报错|异常|成功|完成|结果|结论|决定|方案|建议/.test(s)) p += 2;
    // 纯寒暄/简短确认权重低
    if (/^(你好|hi|hello|在吗|谢谢|好的|ok|嗯|是的|对|收到|知道|了解|再见|拜拜)/i.test(s.trim())) p -= 3;
    return p;
  }
  // provider 上下文窗口 -> 历史 token 预算硬上限:
  // 用 llm.context_window(未配置回退 config.memory.context_window) * 安全比例, 与显式预算取小。
  // 目的: 本地小上下文模型即使没配 history_token_budget, 也不会把历史塞爆窗口。
  _histTokenCap() {
    const window = Number(this.llm?.context_window) || Number(this.config?.memory?.context_window) || DEFAULT_CONTEXT_WINDOW;
    const ratio = Number(this.config?.memory?.context_window_ratio) || DEFAULT_CONTEXT_RATIO;
    return Math.max(200, Math.floor(window * ratio));
  }

  // 会话历史裁剪 (中心函数): 条数上限 + token 预算, 信息量感知, 必保最近一条。
  // opts.budget / opts.maxItems 可覆盖 (溢出降档重试时传更紧预算)。
  // token 预算 = min(显式 history_token_budget, 窗口硬上限), 两者都收紧, 取小者。
  _trimHistory(hist, opts = {}) {
    let h = [...hist];
    const maxItems = opts.maxItems != null ? opts.maxItems : (Number(this.config.memory?.max_history_items) || 40);
    const cfgBudget = Number(this.config.memory?.history_token_budget) || 4000;
    const tokenBudget = opts.budget != null ? opts.budget : Math.min(cfgBudget, this._histTokenCap());
    // 1) 条数上限: 超限时按信息量淘汰 (低信息量优先, 从旧到新)
    if (h.length > maxItems) {
      const scored = h.map((m, i) => ({ m, i, p: this._historyPriority(m) }));
      scored.sort((a, b) => (a.p - b.p) || (a.i - b.i));
      const drop = scored.length - maxItems;
      const dropped = new Set(scored.slice(0, drop).map((x) => x.i));
      scored.sort((a, b) => a.i - b.i);
      h = scored.filter((x) => !dropped.has(x.i)).map((x) => x.m);
    }
    // 2) token 预算: 信息量感知裁剪 (替代旧版"丢最旧前缀")
    //    必保最近一条, 其余按信息量从高到低补足, 低信息量轮次让位
    let total = h.reduce((a, m) => a + estimateTokens(m.content), 0);
    if (total > tokenBudget) {
      const keep = new Set();
      let used = 0;
      const lastIdx = h.length - 1;
      keep.add(lastIdx); used += estimateTokens(h[lastIdx].content);
      const rest = h.slice(0, lastIdx)
        .map((m, i) => ({ m, i, p: this._historyPriority(m) }))
        .sort((a, b) => (b.p - a.p) || (a.i - b.i));
      for (const { m, i } of rest) {
        const t = estimateTokens(m.content);
        if (used + t > tokenBudget) continue;
        keep.add(i); used += t;
      }
      h = h.filter((_, i) => keep.has(i));
    }
    return h;
  }

  // 绝对硬裁剪兜底 (第九轮 review P1: 不依赖 LLM 也能保证历史放得下):
  // 在 _trimHistory 基础上再加一道绝对底线 — 超条数则保留最近 N 轮,
  // 超 token 则从最新向前贪心保留到预算内 (最近信息优先, 必保最后一条)。
  // 即便 config 异常 (预算极大/极小的模型), 注入的历史也不会超过窗口安全比例。
  _ensureContextFit(hist, { budget = this._histTokenCap(), maxItems } = {}) {
    let h = [...hist];
    const itemCap = maxItems != null ? maxItems : (Number(this.config.memory?.max_history_items) || 40);
    // 环节 1: 条数绝对兜底 — 超上限只留最近 itemCap 条
    if (h.length > itemCap) h = h.slice(-itemCap);
    // 环节 2: token 绝对兜底 — 最近优先贪心直到塞满预算 (必保最后一条)
    let total = h.reduce((a, m) => a + estimateTokens(m.content), 0);
    if (total > budget && h.length) {
      const keep = [];
      let used = 0;
      for (let i = h.length - 1; i >= 0; i--) {
        const t = estimateTokens(h[i].content);
        // 至少保留最后一条 (当前对话), 其余超预算跳过
        if (keep.length === 0 || used + t <= budget) {
          keep.unshift(h[i]); used += t;
        }
      }
      h = keep;
    }
    return h;
  }

  // 溢出降档: 把已组好的消息数组按「更紧历史预算」重建 (消息完整性安全版)。
  //  - 保留全部 system (角色/记忆/经验)
  //  - 自最后一条 user 起的一切消息原样保留 (含 in-flight 的 assistant tool_calls + tool 配对,
  //    绝不剪切成"孤立的 tool 消息"导致 API 400)
  //  - 只对最后一条 user 之前的旧历史做最近优先硬裁剪到 budget 内
  _shrinkMessagesForOverflow(messages, budget) {
    let i = 0;
    while (i < messages.length && messages[i] && messages[i].role === "system") i++;
    const systems = messages.slice(0, i);
    const rest = messages.slice(i);
    if (!rest.length) return messages; // 只有 system, 无裁剪空间, 原样返回
    // 从后向前找最后一条 user 作为「进行中单元」起点 (含其后的 tool 配对)
    let lastUser = rest.length - 1;
    while (lastUser > 0 && rest[lastUser].role !== "user") lastUser--;
    const tail = rest.slice(lastUser);          // 完整保留 (结束于 user 或 in-flight 工具单元)
    const mid = rest.slice(0, lastUser);        // 仅剪这里的历史
    const itemCap = Math.max(2, Number(this.config.memory?.max_history_items) || 40);
    const trimmed = this._ensureContextFit(mid, { budget, maxItems: itemCap });
    return [...systems, ...trimmed, ...tail];
  }

  _getSession(sessionKey) {
    // 先信息量感知裁剪, 再 + 绝对硬兜底: 即便 config 异常/压缩失败, 历史也放得下
    const raw = this.sessionStore.deriveCompacted(sessionKey || "default");
    return this._ensureContextFit(this._trimHistory(raw));
  }

  // 追加一轮对话为不可变事件 (append-only, 永不重写日志)
  // v1.1.1: user+assistant 一次批量落盘 (skipFlush), 一轮对话只写一次磁盘而非两次
  _pushTurn(sessionKey, userMsg, assistant) {
    const k = sessionKey || "default";
    this.sessionStore.append(k, "user/message", { content: String(userMsg) }, Date.now(), { skipFlush: true });
    if (assistant) this.sessionStore.append(k, "assistant/message", { content: String(assistant) }, Date.now(), { skipFlush: true });
    this.sessionStore.flush(k);
  }

  // 加载历史: 先尝试结构化压缩(超阈值), 再按预算裁剪
  async _loadHistory(sessionKey) {
    const k = sessionKey || "default";
    await this._maybeCompact(k);
    return this._getSession(k).map((m) => ({ ...m }));
  }

  // 会话压缩: 未压缩部分超 token 阈值时, 把最旧一半压成结构化摘要并持久化到日志
  // (吸收 OpenClaw compaction: 摘要替换被压缩区间, 日志本身不可变)
  async _maybeCompact(sessionKey) {
    if (!this.llm) return;
    if (!(await this._auxLlmReady())) return; // 模型不可用时跳过压缩 (交给 _trimHistory 硬裁剪)
    const events = this.sessionStore.replay(sessionKey);
    let upToSeq = 0;
    for (const e of events) if (e.type === "compaction/summary") upToSeq = e.data?.upToSeq || 0;
    const tail = events.filter((e) => e.seq > upToSeq && (e.type === "user/message" || e.type === "assistant/message"));
    if (!tail.length) return;
    const tokenBudget = Number(this.config.memory?.history_token_budget) || 4000;
    const total = tail.reduce((a, e) => a + estimateTokens(e.data?.content), 0);
    if (total <= tokenBudget * 1.5) return; // 未超阈值不压缩
    const split = Math.floor(tail.length / 2);
    const old = tail.slice(0, split);
    if (old.length < 2) return; // 太少不值得压
    const lastSeq = old[old.length - 1].seq;
    const transcript = transcriptToText(old.map((e) => ({ role: e.type === "user/message" ? "user" : "assistant", content: e.data?.content })));
    try {
      const r = await this.llm.chat(buildCompactionMessages(transcript), { timeoutMs: AUX_LLM_TIMEOUT_MS, retryMax: 0 });
      const summary = r?.content;
      if (summary) this.sessionStore.append(sessionKey, "compaction/summary", { summary, upToSeq: lastSeq });
    } catch {
      // 压缩失败静默降级, 交给 _trimHistory 硬裁剪
    }
  }

  // 重置某会话历史 (新会话): 删除事件日志
  resetSession(sessionKey) { this.sessionStore.delete(sessionKey || "default"); }

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
  }

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
  }

  // DSML 工具调用协议注入 (v1.1.1 接线): 修复 buildDsmlPrompt 过去从未注入的缺口。
  // 仅当激活的 http provider 显式 dsml=true 且工具启用时注入; 默认所有 provider 不注入(零回归)。
  _dsmlPrompt() {
    try {
      if (!(this.llm && this.llm.dsml === true)) return "";
      if (!this.toolsEnabled || !this.tools) return "";
      const tools = this.tools.toOpenAI();
      return buildDsmlPrompt(tools);
    } catch { return ""; }
  }

  // 核心价值文本 (委托 ans/values 模块): 数组 → 固定格式注入 (无值时不注入, 向后兼容)
  _valuesPrompt() {
    return valuesPrompt(this.config.agent?.values);
  }

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
  }

  // L3 画像刷新: 跨天触发 (内存日期标记, 每天首次对话刷新一次)
  _maybeRefreshPersona() {
    const today = logicalDay();
    if (this._personaBuilt === today) return;
    this._personaBuilt = today;
    try {
      this.personaStore.buildUserPersona(this.facts.list(), { force: true });
      this.personaStore.buildAgentPersona(this.experience.lessons, { force: true });
    } catch (e) {
      warn("L3 画像生成失败:", e.message);
    }
  }

  // 找视觉 provider: 当前 LLM 若是 vision 直接用, 否则从 allProviders 找第一个 vision
  _visionLLM() {
    if (this.llm && this.llm.vision) return this.llm;
    return (this.allProviders || []).find((p) => p.vision) || null;
  }

  // 多模态 user 消息内容: 有图且存在 vision provider 时返回 content 数组, 否则纯文本
  _userContent(userMsg) {
    return _visionUserContent(this._visionLLM(), this.root, userMsg);
  }

  // 对话主入口 (含工具调用循环)
  async chat(userMsg, { persist = true, sessionKey = "default", mode = null } = {}) {
    this.clearInterrupt(); // 新一轮对话开始, 复位上一轮的中断状态
    this.bus?.emit("chat/user", { userMsg, sessionKey }, { source: "agent.chat" });
    let reply;
    // 内核自主决策: 高置信简单指令本地处理, 不调 LLM
    const local = (this.config.agent?.localIntent !== false) ? await this._localIntent(userMsg) : null;
    if (local) {
      reply = local;
    } else {
      // 模式分发: 编排策略可插拔 (react/single, 未来 plan-exec/multi-agent/graph 等)
      const modeName = mode || this.config.agent?.mode || "react";
      try {
        reply = await this.ctx.consume("modes").run(modeName, this, userMsg, { sessionKey });
      } catch (e) {
        error("LLM 调用失败:", e.message);
        reply = LLM_FAILED_HINT(e.message);
      }
    }

    const usedTools = this._lastTurnUsedTools;
    this._lastTurnUsedTools = false;
    if (this._notifyCb && usedTools) this.notify("[done] 任务完成 (工具执行)。");

    if (persist) {
      this._pushTurn(sessionKey, String(userMsg), reply);
      await this.memory.recordTurn(userMsg, reply);
      this.bus?.emit("memory/record", { userMsg, reply }, { source: "agent.chat" });
      // L2 场景归档: 从新记忆里找需要归档的
      this._archiveScenes();
      this._learnFromTurn(userMsg, reply);
      // L3 画像: 跨天刷新 (吸收新记忆/经验)
      this._maybeRefreshPersona();
    }
    // 生命周期推进: 每次对话计数, 阶段转换 born→growing→mature
        this.bus?.emit("chat/reply", { reply }, { source: "agent.chat" });
    this._lifecycleTick();
    this.evolve && this.evolve.tick();
    return reply;
  }

  // 生命周期: 每次对话计数 + 阶段转换 (委托 ans/lifecycle 模块)
  _lifecycleTick() {
    this.lifecycle.tick();
  }

  // 生命周期摘要 (可观测, 委托 ans/lifecycle 模块)
  lifecycleStatus() {
    return this.lifecycle.status();
  }

  // Reward 行为倾向可观测 (⑦内分泌)
  rewardStatus() {
    return rewardStatus(this);
  }

  // 排泄治理可观测 (⑤遗忘-归档)
  evictionStatus() {
    return evictionStatus(this);
  }

  // 立即手动触发一次记忆治理扫描 (冗余识别 + 冷热分层)
  runMemoryEviction() {
    return evictionScan(this);
  }

  // 免疫闸门可观测 (⑧安全治理)
  guardStatus() {
    return guardStatus(this);
  }

  // 单次审批: 放行一个危险命令 verb (一次用完自动失效)
  approveGuard(verb) {
    return this.__guard ? this.__guard.approveOnce(String(verb)) : null;
  }


  // 流式对话: 返回 { text, history } 或回调 onDelta 推送增量
  // 支持工具循环: 若消息触发工具调用, 走 _llmWithTools (触发 onTool 事件推送工具活动),
  // 最终结果作为一次 delta 推送; 否则走 streamChat 逐字流式 [P1#7]
  async chatStream(userMsg, { sessionKey = "default", onDelta, onTool, onStep } = {}) {
    if (!this.llm) return this.chat(userMsg, { sessionKey });
    this.clearInterrupt(); // 新一轮对话开始, 复位中断状态
    // 内核自主决策: 高置信简单指令本地处理
    const local = (this.config.agent?.localIntent !== false) ? await this._localIntent(userMsg) : null;
    if (local) { onDelta && onDelta(local); return local; }
    const system = this._context(userMsg);
    const history = await this._loadHistory(sessionKey);
    const messages = [{ role: "system", content: system }, ...history, { role: "user", content: this._userContent(userMsg) }];

    // 多模态路由: 消息含图片时优先 vision provider (否则图片发到文本后端无意义)
    const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c && c.type === "image_url"));
    const activeLLM = hasImage ? (this._visionLLM() || this.llm) : this.llm;

    // 挂工具事件透传 (供 onTool 推送)
    const prevCb = this._onToolEvent;
    if (onTool) this._onToolEvent = (ev) => { try { onTool(ev); } catch {} };
    // 挂 step 事件透传 (供 onStep 推送推理轮次)
    const prevStepCb = this._onStepEvent;
    if (onStep) this._onStepEvent = (ev) => { try { onStep(ev); } catch {} };

    let reply;
    try {
      // 无工具开启: 直连后端可逐字流式 (恢复打字机效果); 有工具时走工具循环保轨迹完整 [复审 P2]
      if (!this.toolsEnabled && activeLLM.supportsStream) {
        reply = await activeLLM.streamChat(messages, {
          onDelta: (d) => { onDelta && onDelta(d); },
        });
      } else {
        reply = await this._llmWithTools(messages, activeLLM);
        if (onDelta) onDelta(reply);
      }
    } catch (e) {
      warn("chatStream 失败, 降级非流式 chat:", e.message);
      reply = await this.chat(userMsg, { sessionKey });
      if (onDelta) onDelta(reply);
    } finally {
      this._onToolEvent = prevCb;
      this._onStepEvent = prevStepCb;
    }
    this._pushTurn(sessionKey, String(userMsg), reply);
    await this.memory.recordTurn(userMsg, reply);
    return reply;
  }

  // 多 provider 回退: 依次尝试, 失败切下一个
  // 多 provider 并发健康探测 + 回退: 只对可用 provider 调用, 避免串行等待 180s 超时
  async _llmWithFallback(seedMessages) {
    let clients = this.allProviders.length ? this.allProviders : [this.llm];
    // 多模态路由: 消息含图片 (image_url 块) 时, 优先 vision provider, 避免图片发到文本后端浪费
    const hasImage = seedMessages.some((m) => Array.isArray(m.content) && m.content.some((c) => c && c.type === "image_url"));
    if (hasImage) {
      const visionClients = clients.filter((c) => c.vision);
      if (visionClients.length) clients = visionClients;
      else info("消息含图片但无 vision provider, 图片将无法被模型理解 (请配置 vision: true 的 provider)");
    }
    // 工具类任务: 优先原生 tool_calls 后端 (http)。
    // openclaw 是完整 agent 运行时, 会拒绝围栏协议(视为伪协议); 实测 http 原生 tool_calls 全链路通过。
    if (this.toolsEnabled) {
      const native = clients.filter((c) => c.supportsNativeToolCalls);
      const fence = clients.filter((c) => !c.supportsNativeToolCalls);
      if (native.length) clients = [...native, ...fence];
    }
    if (clients.length > 1) {
      try {
        const states = await Promise.all(clients.map((c) => c.health ? c.health() : Promise.resolve(true)));
        const healthy = clients.filter((_, i) => states[i]);
        if (healthy.length) clients = healthy;
        else info("所有 provider 健康探测失败, 按原配置顺序尝试兜底");
      } catch (e) {
        warn("health 探测异常, 按原顺序回退:", e.message);
      }
    }
    let lastErr = null;
    for (const client of clients) {
      try {
        return await this._llmWithTools(seedMessages, client);
      } catch (e) {
        lastErr = e;
        warn("provider 失败, 切换下一个:", client.model, e.message);
      }
    }
    throw lastErr || new Error("所有 provider 均失败");
  }

  // 统一工具执行入口 (供 http 原生 tool_calls + openclaw/dsh 围栏代理共用) [P0#1]
  // v1.0.7: 移除未使用的 llmInstance 死参数, 所有工具执行统一走此入口 (trace/事件只此一份)
  async _runTool(name, args) {
    const t0 = Date.now();
    this._lastTurnUsedTools = true;
    this.bus?.emit("tool/call", { name, args }, { source: "agent._runTool" });
    if (this._onToolEvent) { try { this._onToolEvent({ type: "start", tool: name, args, ts: Date.now() }); } catch {} }
    const result = await this.tools.call(name, args, { agent: this });
    const ok = !result.startsWith(TOOL_ERROR_PREFIX);
    this.bus?.emit("tool/result", {
      name,
      ok,
      args,
      durationMs: Date.now() - t0,
      error: ok ? null : result.slice(0, 300),
    }, { source: "agent._runTool" });
    this.traces.record({
      tool: name,
      args,
      result: result.slice(0, 800),
      ok,
      durationMs: Date.now() - t0,
      error: ok ? null : result,
    });
    if (this._onToolEvent) { try { this._onToolEvent({ type: "done", tool: name, args, ok, durationMs: Date.now() - t0, result: result.slice(0, 300), ts: Date.now() }); } catch {} }
    return result;
  }

  // LLM + 工具调用循环 (带 provider 回退)
  async _llmWithTools(seedMessages, llmInstance = this.llm) {
    let messages = [...seedMessages];
    const tools = this.toolsEnabled ? this.tools.toOpenAI() : [];
    // 阈值从 config 读取 (可调), 默认值兜底
    const maxRounds = Number(this.config.agent?.max_tool_rounds) || DEFAULT_MAX_TOOL_ROUNDS;
    const resultBudget = Number(this.config.agent?.tool_result_budget) || DEFAULT_TOOL_RESULT_BUDGET;
    const maxErrorRetry = Number(this.config.agent?.max_tool_error_retry) || DEFAULT_MAX_TOOL_ERROR_RETRY;
    const exploreBreak = Number(this.config.agent?.explore_break_limit) || DEFAULT_EXPLORE_BREAK;
    const repeatFlag = Number(this.config.agent?.repeat_flag_limit) || DEFAULT_REPEAT_FLAG;
    let errorRetries = 0;
    // P0③ 融断状态 (每轮 agent 内): 探索连击 / 重复命令 计数器
    let exploreStreak = 0;
    const seenSig = new Map();
    // 上下文溢出降档: 溢出时裁剪历史后重发, 最多 DEFAULT_OVERFLOW_SHRINK_MAX 档 (第九轮 review P1)
    let overflowShrinks = 0;

    for (let round = 0; round < maxRounds; round++) {
      if (this._interrupted) return "[皮皮虾] 任务已被中断 (operator cancelled).";
      if (this._onStepEvent) { try { this._onStepEvent({ type: "step", round, maxRounds, ts: Date.now() }); } catch {} }
      let resp;
      try {
        resp = await llmInstance.apiChat(messages, {
          tools,
          toolRunner: async (name, args) => this._runTool(name, args),
        });
      } catch (e) {
        // 上下文溢出: 不影响其它错误路径 — 非溢出照常抛出 (交由 _llmWithFallback 切换 provider / 调用方处理)
        if (overflowShrinks < DEFAULT_OVERFLOW_SHRINK_MAX && _isOverflowError(e)) {
          overflowShrinks++;
          warn(`上下文溢出, 降档裁剪后重试 (${overflowShrinks}/${DEFAULT_OVERFLOW_SHRINK_MAX}): ${String(e?.message || e).slice(0, 120)}`);
          const cap = Math.max(200, Math.floor(this._histTokenCap() / (overflowShrinks + 1))); // 逐档缩紧
          messages = this._shrinkMessagesForOverflow(messages, cap);
          continue;
        }
        throw e;
      }
      const msg = resp.message;
      messages.push(msg);

      const toolCalls = msg.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        return msg.content || "[皮皮虾] (无回复)";
      }

      // 工具错误重试: 若本轮有工具失败, 汇总错误喂回模型修正后重试 (最多 errorRetries 次)
      // v1.0.7: 统一走 _runTool (trace/事件只此一份, 不再内嵌重复执行)
      const errors = [];
      for (const tc of toolCalls) {
        if (tc.type === "function" && tc.function) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
          const result = await this._runTool(tc.function.name, args);
          messages.push({ role: "tool", tool_call_id: tc.id, content: toToolContent(result, resultBudget) });
          if (result.startsWith(TOOL_ERROR_PREFIX)) errors.push(result);
        }
      }
      if (errors.length && errorRetries < maxErrorRetry) {
        errorRetries++;
        messages.push({
          role: "user",
          content: "以下工具调用失败, 请修正参数或改用其他方式后重试:\n" + errors.join("\n"),
        });
        continue;
      }
      // P0③ harness 融断: 探索循环 / 重复命令 (无产出的自转) → 注入方向盘给模型
      const _called = toolCalls.filter((tc) => tc.type === "function" && tc.function);
      if (_called.length) {
        let _allExplore = true;
        for (const tc of _called) {
          if (!EXPLORE_TOOLS.has(tc.function?.name || "")) { _allExplore = false; break; }
        }
        let _repeatHit = false;
        for (const tc of _called) {
          let _a = {};
          try { _a = JSON.parse(tc.function.arguments || "{}"); } catch {}
          const _sig = (tc.function?.name || "") + "::" + JSON.stringify(_a).slice(0, 120);
          seenSig.set(_sig, (seenSig.get(_sig) || 0) + 1);
          if (seenSig.get(_sig) >= repeatFlag) _repeatHit = true;
        }
        if (_allExplore) exploreStreak++; else exploreStreak = 0;
        if (_repeatHit) { exploreStreak = 0; seenSig.clear(); }
        if (_allExplore && exploreStreak >= exploreBreak) {
          exploreStreak = 0; seenSig.clear();
          messages.push({
            role: "user",
            content: "检测到连续探索循环: 连续 " + exploreBreak + " 轮只有只读/查询工具, 未产生任何产出或修改。请停止继续探测, 基于已获得的信息直接给出结论或交付物; 若确实缺少关键信息, 明确说明并结束本轮, 不要空转。",
          });
          continue;
        }
        if (_repeatHit) {
          messages.push({
            role: "user",
            content: "检测到重复执行相同工具与参数。请不要再重复该调用, 换一条不同路径推进, 或直接基于现有信息产出结论。",
          });
          continue;
        }
      }
    }
    return "[皮皮虾] 工具调用轮次过多, 已停止。";
  }

  // 离线工具路由: 无 LLM 时识别简单工具指令
  // ---- 内核自主决策: 本地意图预判层 (P2-7) ----
  // 高置信简单指令(问候/时间/记忆/明确工具)本地处理, 不调 LLM, 省成本更快
  async _localIntent(userMsg) {
    const m = String(userMsg).trim();
    // 纯问候/告别/感谢 (短句, 高置信)
    const greet = /^(你好|您好|嗨|哈喽|hello|hi|在吗|早上好|晚上好|下午好|再见|拜拜|谢谢|感谢|辛苦了|good\s*(mom|afternoon|evening)|thanks?|bye)\s*[!。？?]*$/i;
    if (greet.test(m)) {
      if (/再见|拜拜|bye/i.test(m)) return "再见兄弟, 有事随时喊我。";
      if (/谢谢|感谢|辛苦/i.test(m)) return "客气啥, 应该的。";
      return "在的兄弟, 说。";
    }
    // 时间/日期
    if (/^(现在)?(几点|时间|日期|几号|今天|星期几)[!?。？]*$/i.test(m)) {
      return `[工具] ${await this.tools.call("get_time", {})}`;
    }
    // 记忆查询: 你记得XXX / 上次聊过XXX (P1: LLM 查询扩展 + RRF 融合补语义召回)
    if (/^(你)?(记得|还记得|上次聊过|关于)[:：]?\s*(.+)/i.test(m)) {
      const q = m.replace(/^(你)?(记得|还记得|上次聊过|关于)[:：]?\s*/i, "").trim();
      const res = await this._memoryQuery(q || m, { limit: 3 });
      return res.length ? "我记得:\n" + res.map(r => `- ${r.content}`).join("\n") : `(记忆里没找到关于"${q || m}"的)`;
    }
    // 记住 XX
    const add = m.match(/^记住[:：]\s*(.+)$/i);
    if (add) return `[工具] ${await this.tools.call("memory_add", { content: add[1].trim() })}`;
    // 读文件 / 列目录 (明确工具指令)
    const read = m.match(/^读文件\s+(.+)$/i);
    if (read) return `[工具] ${await this.tools.call("read_file", { path: read[1].trim() })}`;
    const list = m.match(/^列出?\s+(\S+)?$/i);
    if (list) return `[工具] ${await this.tools.call("list_dir", { path: list[1] || "." })}`;
    return null;
  }

  // ---- Session Replay: 从 l0 原始日志恢复某会话历史 (跨天/崩溃续跑) ----
  replaySession(sessionKey = "default", { days = 7, limit = 40 } = {}) {
    const msgs = [];
    const now = new Date();
    for (let d = days - 1; d >= 0; d--) {
      const day = logicalDay(new Date(now.getTime() - d * 86400000));
      const recs = this.l0.read(day, 2000);
      for (const r of recs) {
        if (r.sessionKey !== sessionKey) continue;
        if (r.role === "user" || r.role === "assistant") msgs.push({ role: r.role, content: r.content, ts: r.timestamp });
      }
    }
    msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return msgs.slice(-limit).map(({ role, content }) => ({ role, content }));
  }

  // 离线工具路由已并入 _localIntent (超集), 不再单独保留

  // 工具名清单 (给 verifyLesson 做幻觉接地)
  _toolNames() {
    try {
      if (this.tools && typeof this.tools.listDetailed === "function") return this.tools.listDetailed().map((t) => t.name);
      if (this.tools && typeof this.tools.names === "function") return this.tools.names();
    } catch {}
    return [];
  }

  _learnFromTurn(userMsg, reply) {
    const m = String(userMsg).match(/经验交给皮皮虾[:：]\s*(.+)/i);
    if (m) {
      this.experience.learn({ task: "用户主动分享", lesson: m[1], tags: ["user-shared"] });
      if (this.lifecycle) this.lifecycle.evolve(); // 生命周期: 进化计数 (落盘)
      info(`学到经验: ${m[1]}`);
    }
  }

  // P3: 自我进化闭环 - 回放近期失败轨迹, LLM 提炼经验教训进经验库 (轨迹 → 经验 → 注入上下文)
  // 复用已有 experience.learn, 把「哪一步坏了」沉淀为可复用教训
  async refine({ limit = 20 } = {}) {
    if (!this.llm) return { distilled: 0, reason: "无 LLM" };
    const failed = this.traces.read(undefined, limit).filter((t) => !t.ok);
    if (failed.length < 2) return { distilled: 0, reason: "失败轨迹不足" };
    const summary = failed
      .map((t) => `工具 ${t.tool}: ${String(t.error || t.result || "").slice(0, 160)}`)
      .join("\n");
    let lesson;
    try {
      const r = await this.llm.chat([
        { role: "system", content: "你是经验提炼器。从失败的工具调用轨迹中提炼一条可复用的经验教训, 一句话说清: 什么场景、为什么失败、下次怎么做。只输出这一句话, 不要解释。" },
        { role: "user", content: summary.slice(0, 2000) },
      ], { timeoutMs: AUX_LLM_TIMEOUT_MS, retryMax: 0 });
      lesson = String(r.content || "").trim();
    } catch { lesson = ""; }
    if (!lesson) return { distilled: 0, reason: "LLM 未产出经验" };
    // P0① Auditor: 经验必须过确定性验证闸门才写回经验库 (不信任模型自评)
    //   接地防幻觉(点名工具须有失败轨迹背书) + 可操作动词 + 单句精炼
    const knownTools = this._toolNames();
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
    return { distilled: 1, lesson };
  }

  // P2: 自我进化闭环 (下) - 从成功轨迹自动提炼可复用 Skill
  // 轨迹 → 高频成功工具模式 → LLM 提炼 → 复用 create_skill 落盘 skills/<name>/SKILL.md
  // 与 refine() (失败→经验) 互补, 形成「失败学教训 + 成功沉淀技能」完整闭环
  async refineSkill({ limit = 50, minFreq = 2 } = {}) {
    if (!this.llm) return { created: 0, reason: "无 LLM" };
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
      const r = await this.llm.chat([
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
    //   -> structure (## Process + ## Verify) + grounded (content references hot tool, trace-backed)
    // P0② held-out 回归: 样本够多时切出未见过的 held-out 子集, 要求接地工具在那也有背书, 防过拟合
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
    const res = await this.tools.call("create_skill", {
      name,
      description: String(skill.description || "自动提炼的技能"),
      content: String(skill.content),
    }, { agent: this });
    if (res.startsWith(TOOL_ERROR_PREFIX)) return { created: 0, reason: res };
    if (this.auditor) this.auditor.record("skill_created", { lesson: `创建技能 ${name}` }); // 已过 verifySkill 闸门, 只记账
    info(`[refineSkill] 生成技能: ${name}`);
    return { created: 1, name };
  }

  // 用中自进化 (source: Hermes "skill self-improves during use"):
  // 技能用满 minUses 次后, 读它当前内容 + 相关成功轨迹,
  // 让 LLM 改进 SKILL.md, 过 verifyUpgradeSkill 闸门(防退化) 后写回, 重置计数防连跑。
  async upgradeSkill(id, { minUses = 3, limit = 40 } = {}) {
    try {
      if (!this.llm) return { upgraded: 0, reason: "无 LLM" };
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
        const r = await this.llm.chat([
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
      const w = await this.tools.call("create_skill", { name: id, description: (need.description || ""), content: upgraded }, { agent: this });
      if (typeof w === "string" && w.startsWith(TOOL_ERROR_PREFIX)) return { upgraded: 0, reason: w, name: id };
      if (this.skills.resetUse) this.skills.resetUse(id);
      info("[upgradeSkill] 升级技能: " + id + " (uses=" + used.uses + ")");
      return { upgraded: 1, name: id, changed: v.changed, uses: used.uses };
    } catch (e) {
      warn("[upgradeSkill] 失败: " + String(e?.message || e).slice(0, 120));
      return { upgraded: 0, reason: String(e?.message || e).slice(0, 120), name: id };
    }
  }

  // 拊新记忆归档进 L2 场景
  _archiveScenes() {
    const recent = this.facts.query("", { limit: 5 });
    for (const f of recent) {
      if (!this.scenes.findByFactId(f.id)) this.scenes.assign(f);
    }
  }

  // 可观测: 聚合各层状态 (记忆 L0-L3 / 轨迹 / 工具 / 经验 / 自愈)
  // 顶层展平 traces.stats() 字段 (count/failed/failRate/slowTools), 向后兼容 web 前端
  stats() {
    const sessions = this.sessionStore ? this.sessionStore.list() : [];
    const eventsTotal = sessions.reduce((a, s) => a + (s.count || 0), 0);
    const tools = this.tools ? this.tools.listDetailed() : [];
    return {
      ...(this.traces && typeof this.traces.stats === "function" ? this.traces.stats() : {}),
      agent: {
        name: this.config.agent?.name || "ppx",
        mode: this.config.agent?.mode || "react",
        llm: this.llm ? (this.llm.backend || this.llm.model || "configured") : "none",
      },
      memory: {
        l0: { events_total: eventsTotal, sessions: sessions.length },
        l1: this.facts && this.facts.stats ? this.facts.stats() : {},
        l2: this.scenes && this.scenes.count ? { scenes: this.scenes.count() } : {},
        l3: this.personaStore && this.personaStore.stats ? this.personaStore.stats() : {},
        ...(this.memory && this.memory.stats ? this.memory.stats() : {}),
      },
      tools: {
        total: tools.length,
        enabled: tools.filter((t) => t.enabled).length,
        list: tools.map((t) => ({ name: t.name, enabled: t.enabled, category: t.category })),
      },
      skills: this.skills && typeof this.skills.list === "function"
        ? this.skills.list().map((s) => ({ id: s.id, description: s.description }))
        : [],
      mcp: this._mcp ? { connected: true, count: this._mcp.count || 0 } : { connected: false, count: 0 },
      experience: this.experience ? { lessons: this.experience.lessons.length } : {},
      health: this.health || null,
    };
  }

  // 主动任务生成 (ANS 自主性): 扫描 L1 记忆里的待办/偏好, 生成主动提醒 (委托 ans/proactive 模块)
  // 返回可直接投递的文本 (保持兼容); 结构化数据见 startProactiveTicker 回调的 payload
  async proactiveSuggest() {
    const out = await suggestProactive(this);
    return out ? out.text : null;
  }

  // 标记待办完成 (ANS): 之后不再主动提醒 (窗口去重 + 完成跟踪)
  proactiveMarkDone(id) {
    return markTaskDone(this, id);
  }

  // 启动主动任务生成定时器 (config.agent.proactive.enabled 才启用)
  // 回调契约: cb(payload) → { ts, items: [{content, importance, source, id}], text }
  startProactiveTicker(cb) {
    const cfg = this.config.agent?.proactive;
    if (!cfg || !cfg.enabled) return null;
    const ms = Number(cfg.interval_ms) || 3600000;
    this._proactiveTimer = setInterval(async () => {
      try {
        const payload = await suggestProactive(this);
        if (payload && typeof cb === "function") { try { cb(payload); } catch {} }
      } catch {}
    }, ms);
    info(`[proactive] 主动任务生成已启动 (每 ${Math.round(ms / 60000)} 分钟)`);
    return this._proactiveTimer;
  }

  stopProactiveTicker() {
    if (this._proactiveTimer) { clearInterval(this._proactiveTimer); this._proactiveTimer = null; }
  }

  // 接入 MCP 服务器: 连接 + 注册工具到 catalog (可选能力, 显式调用)
  // servers 缺省用 config.mcp.servers; 返回注册的工具数
  async connectMcp(servers = null) {
    const list = servers || (this.config.mcp && this.config.mcp.servers) || [];
    if (!list.length) return 0;
    const r = await registerMcpTools(this.tools, list);
    this._mcp = r;
    return r.count;
  }

  // 热重载提供方: 从 config/ppx.json 重建 LLM 客户端列表
  // 用法: HTTP API 增删改提供方后调用, 立即生效无需重启
  // provider 可用性解析复用 plugin/builtin.js (只此一份, 不重复实现)
  // 发布首启引导: 若未配置任何云端大模型 API key, 明确提示按 README 配置 (不阻断运行)
  _warnMissingCloudApi() {
    const provs = (this.config && this.config.providers) || [];
    const isLocal = (p) => /127\.0\.0\.1|localhost|lm-studio|ollama/i.test(p.base_url || "");
    const isSpecial = (p) => p.backend === "openclaw" || p.backend === "dsh" || p.id === "dsh";
    const cloud = provs.filter((p) => !isLocal(p) && !isSpecial(p));
    const hasCloudKey = cloud.some((p) => p.api_key || (p.api_key_env && process.env[p.api_key_env]));
    const hasLocal = provs.some(isLocal);
    // 默认本地优先(agent.model_preference=local): 有本地模型即满足运行, 不告警(本地测试正用本地模型)
    if (hasLocal) return;
    // 无本地但配了云端 key → 正常走云端, 不告警
    if (hasCloudKey) return;
    // 任何可用模型都没有 → 必须提示, 否则对话不可用
    warn(
      "未检测到任何可用模型。皮皮虾默认本地优先(agent.model_preference=local), 需至少满足一项:\n" +
      "  1) 启动本地模型服务 (LM Studio 等, 127.0.0.1 即识别)\n" +
      "  2) 配置云端大模型 API key: OPENAI_API_KEY | DEEPSEEK_API_KEY | VOLCENGINE_API_KEY(需填 endpoint) | DASHSCOPE_API_KEY\n" +
      "  3) 或显式设 agent.model_preference=cloud 后走云端 key\n" +
      "详见 README「快速开始」模型接入节。"
    );
  }
  // 热重载提供方: 从 config/ppx.json 重建 LLM 客户端列表
  reloadProviders() {
    this.config = this._loadConfig(null);
    this.llm = resolveLLM(this.config);
    this.allProviders = resolveAllLLMs(this.config);
    info(`[providers] 热重载完成: ${this.allProviders.length} 个客户端`);
    return { llm: this.llm ? (this.llm.backend || this.llm.model) : null, count: this.allProviders.length };
  }

  // 热重载通用设置 (用户名/安全/agent 预设): 重新加载 config + 更新内存字段
  // 不重建 LLM 客户端 (settings 不涉及 provider), 只让 user.name/security/agent 生效
  reloadSettings() {
    this.config = this._loadConfig(null);
    this.userName = this.config.user?.name || "兄弟";
    this.ctx.provide("userName", this.userName);
    // 应用 tools.disabled 变更 (设置 UI 启停工具后立即生效)
    this._applyDisabledTools();
    info(`[settings] 热重载完成: 用户=${this.userName}, 模式=${this.config.agent?.mode || "react"}`);
    return { userName: this.userName, mode: this.config.agent?.mode || "react" };
  }

  // 应用 config.tools.disabled: 禁用列表中的工具 (启停工具 UI 写盘后生效)
  _applyDisabledTools() {
    try {
      const disabled = Array.isArray(this.config.tools?.disabled) ? this.config.tools.disabled : [];
      if (!disabled.length) return;
      let n = 0;
      for (const name of disabled) {
        try { if (this.tools.disable(name)) n += 1; } catch {}
      }
      if (n) info(`[tools] 已禁用 ${n} 个工具: ${disabled.join(", ")}`);
    } catch { /* 工具未就绪时静默跳过 */ }
  }

  shutdown() {
    this.stopProactiveTicker();
    this._mcp?.close?.();
    // v1.0.8: 清理军团子进程 (spawn_agent 派生的 worker), 防后台残留
    if (this._legion && typeof this._legion.shutdownAll === "function") {
      try { this._legion.shutdownAll(); } catch {}
    }
    this.memory._saveState?.();
    this.scheduler?.shutdown?.(); // ⑤/②: 清定时器防进程挂起
    this.healer.markClean();
  }
}

ensureUTF8Console();
if (process.argv[1] && process.argv[1].endsWith("src/agent/index.js")) {
  const agent = new PPXAgent();
  console.log(`皮皮虾 就绪 | 记忆:${agent.facts.count()}条 | 工具:${agent.tools.list().join(",")} | 自愈:${agent.health.fixes.length ? "修复" + agent.health.fixes.length + "项" : "OK"}`);
  process.stdin.on("data", async (d) => {
    const line = d.toString().trim();
    if (["quit", "exit"].includes(line)) { agent.shutdown(); process.exit(0); }
    const r = await agent.chat(line);
    console.log("\n" + r + "\n");
  });
}
