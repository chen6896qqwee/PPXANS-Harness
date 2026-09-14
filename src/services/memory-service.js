// src/services/memory-service.js - 记忆协调服务 (重构第二刀, 2026-09-14)
// 目的: 把散在 PPXAgent 上的记忆升降级逻辑 (L1提炼/L2归档/L3画像/经验/检索)
//       收敛为独立服务, agent 只保留薄委托 (公共 API 兼容, 外部调用点/测试不变)。
// 设计 (对应方案「记忆升降级协调器」轻量版):
//   - MemoryService 持有四层记忆的协调逻辑, 依赖全部注入 (llm 用 getLlm 闭包,
//     因 reloadProviders 会热替换 agent.llm, 固定引用会过期)。
//   - afterTurn() 是「升降级协调器」: 一轮对话落盘后, 依次触发 L2 场景归档、
//     用户主动经验学习、L3 画像跨天刷新 —— 升降级策略集中在此, 可单独调参/替换。
//   - 事件流 (tracer) 埋点保留, 行为与抽取前逐字节等价。
import { info, warn } from "../utils/logger.js";
import { logicalDay } from "../utils/store.js";

// 辅助 LLM 调用短超时 (提炼/压缩/检索扩展): 模型不可用/网络不通时快速失败降级
const AUX_LLM_TIMEOUT_MS = 10000;

export class MemoryService {
  // deps: { getLlm, facts, scenes, personaStore, experience, lifecycle, tracer }
  constructor(deps) {
    this.getLlm = deps.getLlm;           // () => llm (闭包, 实时取当前 provider)
    this.facts = deps.facts;             // L1 事实库
    this.scenes = deps.scenes;           // L2 场景
    this.personaStore = deps.personaStore; // L3 画像
    this.experience = deps.experience;   // 经验库
    this.lifecycle = deps.lifecycle;     // ANS 生命周期 (进化计数)
    this.tracer = deps.tracer;           // 结构化事件流
    this._personaBuilt = null;           // L3 画像上次生成日期 (跨天刷新标记, 原 agent 字段)
  }

  _llm() { return this.getLlm ? this.getLlm() : null; }

  // 辅助 LLM 调用前置健康探测: 模型不可用 (本地服务未运行/远端不可达) 时快速跳过
  async _auxLlmReady() {
    const llm = this._llm();
    if (!llm) return false;
    if (typeof llm.health !== "function") return true;
    try { return await llm.health(); } catch { return false; }
  }

  // L1 提炼: 从一轮对话提取值得长期记忆的事实 (原 agent._extractMemory)
  async extractMemory(user, assistant, existing = []) {
    const llm = this._llm();
    if (!llm) return [];
    if (!(await this._auxLlmReady())) return []; // 模型不可用时跳过提炼 (退回启发式)
    // 噪声治理: 显式跳过寒暄/无信息量/关于系统本身的元讨论
    const sys = "你是记忆提炼器。从对话中提取值得长期记忆的关键事实、用户偏好、待办事项。只输出 JSON 数组, 每项是{content: 一句完整中文记忆}。没有值得记的返回 []。不要解释, 只输出 JSON。\n跳过以下内容: 1) 寒暄/问候/客套话; 2) 无信息量的闲聊; 3) 对助手/系统本身的元讨论与建议 (如任务描述方式、提示词建议等); 4) 已被现有记忆覆盖的内容。";
    let userMsg = "用户: " + String(user).slice(0, 800) + "\n助手: " + String(assistant).slice(0, 800);
    // 感知已有记忆: 若提炼结果与已有记忆含义相同/已被覆盖, 不要输出该条 (避免重复)
    if (existing.length) {
      userMsg += "\n\n【已有记忆】以下记忆已存在, 若你提炼的内容与其中任意一条含义相同或被其覆盖, 则不要输出该条 (避免重复):\n"
        + existing.map((f, i) => `${i + 1}. ${f.content}`).join("\n");
    }
    const r = await llm.chat([
      { role: "system", content: sys },
      { role: "user", content: userMsg },
    ], { timeoutMs: AUX_LLM_TIMEOUT_MS, retryMax: 0 });
    const text = String(r.content || "").trim();
    // 容忍模型把 JSON 包在 markdown 代码块里
    const cleaned = text.replace(/```(?:json|JSON)?\s*/g, "").replace(/```/g, "").trim();
    // 提取第一个最外层 JSON 数组 (贪婪匹配到最后一个 ], 容忍内容里的嵌套方括号)
    const m = cleaned.match(/\[[\s\S]*\]/);
    if (!m) { this.tracer?.event("memory/extract", { count: 0, reason: "no_json" }); return []; }
    try {
      const arr = JSON.parse(m[0]);
      const out = Array.isArray(arr) ? arr.map((x) => String(x.content || x).trim()).filter(Boolean) : [];
      this.tracer?.event("memory/extract", { count: out.length, existing: existing.length });
      return out;
    } catch { this.tracer?.event("memory/extract", { count: 0, reason: "parse_fail" }); return []; }
  }

  // L0 压缩: 用 LLM 把旧对话浓缩成语义摘要 (原 agent._summarizeMemory)
  async summarizeMemory(raw) {
    const llm = this._llm();
    if (!llm) throw new Error("无 LLM");
    if (!(await this._auxLlmReady())) throw new Error("LLM 不可用, 跳过辅助摘要");
    const r = await llm.chat([
      { role: "system", content: "你是记忆压缩器。把下面这段对话记录压缩成一段简洁的中文摘要(≤200字), 保留关键事实、用户偏好、进展和待办。不要客套, 直接输出摘要。" },
      { role: "user", content: String(raw).slice(0, 4000) },
    ], { timeoutMs: AUX_LLM_TIMEOUT_MS, retryMax: 0 });
    this.tracer?.event("memory/summarize", { chars: String(raw).length, ok: true });
    return r.content;
  }

  // 检索扩展: 把问题改写成多个词面变体, 补语义召回 (原 agent._expandQuery)
  async expandQuery(q) {
    const llm = this._llm();
    if (!llm) return [];
    if (!(await this._auxLlmReady())) return []; // 模型不可用时跳过扩展 (退回单查询)
    const r = await llm.chat([
      { role: "system", content: "你是查询扩展器。把用户的问题改写成 3 个语义相近但词面不同的检索短语(用于语义记忆检索), 每行一个, 不要序号、不要解释。" },
      { role: "user", content: String(q).slice(0, 300) },
    ], { timeoutMs: AUX_LLM_TIMEOUT_MS, retryMax: 0 });
    return String(r.content || "")
      .split(/\n+/)
      .map((s) => s.replace(/^[\d\.\-、)）]\s*/, "").trim())
      .filter((s) => s && s !== String(q).trim())
      .slice(0, 3);
  }

  // L1 检索: 原始查询 + LLM 扩展变体做 RRF 融合; 无 LLM 时退化为单查询 (原 agent._memoryQuery)
  async query(q, { limit = 5, scope = null } = {}) {
    // 有 embedder 时走 dense 语义检索 (与 BM25 RRF 融合), 否则 LLM 扩展 + RRF
    let hits;
    if (this.facts.embedder) {
      hits = this.facts.querySemantic(q, { limit, scope });
    } else {
      const variants = [q];
      const llm = this._llm();
      if (llm) {
        try { variants.push(...(await this.expandQuery(q))); } catch { /* LLM 失败静默降级 */ }
      }
      hits = variants.length === 1 ? this.facts.query(q, { limit, scope }) : this.facts.queryMulti(variants, { limit, scope });
    }
    this.tracer?.event("memory/query", { q: String(q).slice(0, 80), hits: Array.isArray(hits) ? hits.length : 0, scope: scope || null });
    return hits;
  }

  // L3 画像刷新: 跨天触发 (原 agent._maybeRefreshPersona, 状态 _personaBuilt 移入本服务)
  refreshPersona() {
    const today = logicalDay();
    if (this._personaBuilt === today) return;
    this._personaBuilt = today;
    try {
      this.personaStore.buildUserPersona(this.facts.list(), { force: true });
      this.personaStore.buildAgentPersona(this.experience.lessons, { force: true });
      this.tracer?.event("memory/persona", { ok: true });
    } catch (e) {
      warn("L3 画像生成失败:", e.message);
      this.tracer?.event("memory/persona", { ok: false }, { error: e?.message });
    }
  }

  // L2 场景归档: 从新记忆里找需要归档的 (原 agent._archiveScenes)
  archiveScenes() {
    const recent = this.facts.query("", { limit: 5 });
    let assigned = 0;
    for (const f of recent) {
      if (!this.scenes.findByFactId(f.id)) { this.scenes.assign(f); assigned++; }
    }
    if (assigned > 0) this.tracer?.event("memory/scene_assign", { assigned });
  }

  // 用户主动经验学习: 「经验交给皮皮虾: xxx」指令 (原 agent._learnFromTurn)
  learnFromTurn(userMsg, reply) {
    const m = String(userMsg).match(/经验交给皮皮虾[:：]\s*(.+)/i);
    if (m) {
      this.experience.learn({ task: "用户主动分享", lesson: m[1], tags: ["user-shared"] });
      if (this.lifecycle) this.lifecycle.evolve(); // 生命周期: 进化计数 (落盘)
      this.tracer?.event("memory/learn", { lesson: m[1].slice(0, 120), source: "user-shared" });
      info(`学到经验: ${m[1]}`);
    }
  }

  // 升降级协调器: 一轮对话落盘后统一触发 L2 归档 + 经验学习 + L3 画像刷新
  // (原 agent.chat persist 块里散落的三个调用, 收敛于此)
  afterTurn(userMsg, reply) {
    this.archiveScenes();
    this.learnFromTurn(userMsg, reply);
    this.refreshPersona();
  }
}
