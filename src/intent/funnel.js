// src/intent/funnel.js - 分层漏斗意图识别 (v4.2, 2026-11-01)
// 落地视频《Agent 意图识别怎么做》的核心架构 + 设计溯源 docs/PROVENANCE.md#leizai 的 routeTask 范式:
//
//   L1 规则层 (漏斗最宽): 高频/稳定/歧义极低的指令白名单 —— 零模型调用, 毫秒级直答或转工具。
//     铁律是"做减法": 内置规则冻结在个位数, 用户扩展上限 64 条, 通配规则直接拒绝 ——
//     防止规则数量持续增长导致优先级冲突、维护失控 (规则黑洞)。
//   L2 上下文层: 纯函数打分 (连续性信号 / 技能匹配 / 专家领域 / 当前任务), 输出「分流提示块」。
//     设计溯源 docs/PROVENANCE.md#leizai; 关键设计: 规则层只注入提示、不接管决策 —— 规则错也只是提示错了,
//     最终决策权仍在模型 (注入位置 = user 消息尾部, 守 system 前缀缓存纪律)。
//   L3 工具兜底层: 即 agent 现有 mode 分发 (react 工具循环 = LLM + Function Calling), 不在本层。
//
// 本模块保持纯函数 (无 IO / 无状态), 可单测; 会话状态与统计在 src/intent/state.js。

// ==================== L1 规则层 ====================

export const RULE_LIMIT = 64;
const RULE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,29}$/;

// 内置规则白名单 (延续原 _localIntent 的 5 族正则 + help; 冻结, 不随需求膨胀 ——
// 新的高频稳定指令应优先考虑做成斜杠命令或技能, 而不是往这里堆)
export function builtinRules() {
  return [
    {
      id: "chitchat", intent: "chitchat",
      re: /^(你好|您好|嗨|哈喽|hello|hi|在吗|早上好|晚上好|下午好|再见|拜拜|谢谢|感谢|辛苦了|good\s*(morning|afternoon|evening)|thanks?|bye)\s*[!。？?]*$/i,
      action: { type: "reply", variant: "chitchat" },
    },
    {
      id: "time", intent: "time",
      re: /^(现在)?(几点|时间|日期|几号|今天|星期几)[!?。？]*$/i,
      action: { type: "tool", tool: "get_time", args: {}, prefix: "现在是 " },
    },
    {
      id: "memory_query", intent: "memory.query",
      re: /^(你)?(记得|还记得|上次聊过|关于)[:：]?\s*(.+)/i,
      action: { type: "memory_query", group: 3 },
    },
    {
      id: "memory_add", intent: "memory.add",
      re: /^记住[:：]\s*(.+)$/i,
      action: { type: "memory_add", group: 1 },
    },
    {
      id: "read_file", intent: "file.read",
      re: /^读文件\s+(.+)$/i,
      action: { type: "tool", tool: "read_file", argsFrom: (m) => ({ path: String(m[1] || "").trim() }) },
    },
    {
      id: "list_dir", intent: "file.list",
      // 注意 \s+ 必须保留: 放宽成 \s* 会把「列一下目录」这类自然语言也截胡 (2026-11-01 回归教训)
      re: /^列出?\s+(\S+)?$/i,
      action: { type: "tool", tool: "list_dir", argsFrom: (m) => ({ path: m[1] || "." }) },
    },
    {
      id: "help", intent: "help",
      re: /^(帮助|help|你能做什么|你会什么|你会干嘛)[!?。？]*$/i,
      action: { type: "reply", variant: "help" },
    },
  ];
}

// 通配探测样本: 三条差异极大的输入若全部命中同一 pattern, 视为通配规则 (拒绝 —— 做减法)
const WILDCARD_PROBES = ["", "hello 你好 123 !!!", "随便一段完全不同的长文本内容abcXYZ"];

// 校验一条用户扩展规则; 返回 null 或错误信息
export function validateUserRule(r) {
  if (!r || typeof r !== "object") return "规则必须是对象";
  if (!r.id || typeof r.id !== "string" || !RULE_ID_RE.test(r.id)) {
    return "id 必须以字母开头, 仅含字母/数字/横线/下线 (2-30 字符)";
  }
  if (!r.pattern || typeof r.pattern !== "string") return "缺少 pattern";
  if (r.pattern.length < 2 || r.pattern.length > 200) return "pattern 长度需在 2-200 之间";
  let re;
  try { re = new RegExp(r.pattern, "i"); } catch (e) { return `pattern 编译失败: ${e.message}`; }
  if (WILDCARD_PROBES.every((p) => re.test(p))) {
    return "pattern 命中一切输入 (通配规则禁止) —— 规则层的生命线是准入, 请写明确定型的模式";
  }
  const hasReply = !!(typeof r.reply === "string" && r.reply.length);
  const hasTool = !!(typeof r.tool === "string" && r.tool.length);
  if (hasReply === hasTool) return "reply 与 tool 必须二选一";
  if (hasTool && r.args != null && typeof r.args !== "object") return "args 必须是对象 (支持 $1-$9 捕获组替换)";
  return null;
}

// 编译用户扩展规则 (.ppx/intent-rules.json): 逐条校验, 非法跳过并记录原因, 超限截断
export function compileUserRules(list) {
  const rules = [];
  const errors = [];
  const arr = Array.isArray(list) ? list : [];
  if (arr.length > RULE_LIMIT) errors.push(`规则数超过上限 ${RULE_LIMIT}, 只保留前 ${RULE_LIMIT} 条 (做减法)`);
  for (const raw of arr.slice(0, RULE_LIMIT)) {
    const err = validateUserRule(raw);
    if (err) { errors.push(`${(raw && raw.id) || "(无 id)"}: ${err}`); continue; }
    const re = new RegExp(raw.pattern, "i");
    rules.push({
      id: raw.id,
      intent: `user.${raw.id}`,
      re,
      user: true,
      action: typeof raw.reply === "string" && raw.reply.length
        ? { type: "reply", variant: "literal", text: raw.reply }
        : { type: "tool", tool: raw.tool, args: substituteArgs(raw.args) },
    });
  }
  return { rules, errors };
}

// args 里的 "$1"-"$9" 替换为对应捕获组 (字符串整体替换时保持数字类型字段)
function substituteArgs(tpl) {
  return (m) => {
    if (!tpl || typeof tpl !== "object") return {};
    const out = {};
    for (const k of Object.keys(tpl)) {
      const v = tpl[k];
      out[k] = typeof v === "string"
        ? v.replace(/\$(\d)/g, (_, d) => (m[Number(d)] != null ? String(m[Number(d)]) : ""))
        : v;
    }
    return out;
  };
}

// L1 解析: 纯正则匹配, 不执行。内置规则优先 (冻结的稳定语义), 用户规则兜后。
// 返回 {rule, match, intent} | null
export function layer1Resolve(msg, rules) {
  const m = String(msg || "").trim();
  if (!m || m.length > 500) return null; // 防超长文本被规则误伤 (长句一律交给上层)
  for (const rule of rules || []) {
    let match;
    try { match = rule.re.exec(m); } catch { continue; }
    if (match) return { rule, match, intent: rule.intent };
  }
  return null;
}

// ==================== L2 上下文层 ====================

// 连续性信号: 用户在延续既有任务 (代词/承接词开头, 或明确的"继续"意图)
const CONTINUITY_LEAD = /^(继续|接着|然后|再|换个?|那|这个|刚才|上面|它|按照|顺着)/;
const CONTINUITY_ANY = /(继续|接着(来|做|说)?|刚才(说|的|聊|那个)|上次(说|的|那个)|还是(那个|刚才)|同一个)/;

// 领域近义词 (视频"领域打分: 领域词+近义词"的落地): 专家包 domain 往往是英文 id
// (finance/data/code...), 用户嘴里说的是中文 —— 精确子串匹配会全漏, 近义词表补召回。
const DOMAIN_SYNONYMS = {
  finance: ["财务", "金融", "股票", "投资", "理财", "基金", "财报", "记账"],
  legal: ["法律", "合同", "律师", "法务", "合规", "诉讼"],
  medical: ["医疗", "健康", "症状", "用药", "体检"],
  data: ["数据", "分析", "报表", "统计", "图表", "可视化"],
  code: ["代码", "编程", "开发", "重构", "调试", "bug", "报错"],
  compliance: ["合规", "监管", "审计", "风控"],
  writing: ["写作", "文案", "文章", "润色"],
  education: ["教学", "课程", "学习计划", "讲解"],
};

// ctx: {skills: SkillLoader|null, experts: [{id,label,domain,description}]|null, activeTask: string|null, prevState: object|null}
// 返回 signals: {continuity, skill, expert, task, intent, confidence}
export function layer2Signals(msg, ctx = {}) {
  const text = String(msg || "").trim();
  const lower = text.toLowerCase();
  // 1) 连续性
  const continuity = !!(CONTINUITY_LEAD.test(text) || CONTINUITY_ANY.test(text));
  // 2) 技能匹配 (复用 skills/search.js 的高置信 matchSkill: 命中不足或并列歧义都返回 null, 不押注)
  let skill = null;
  if (ctx.skills && typeof ctx.matchSkill === "function") {
    try { skill = ctx.matchSkill(ctx.skills, text); } catch { skill = null; }
  }
  // 3) 专家匹配 (领域词 + 近义词 + id/label 精确子串 —— 高精度优先, 近义词补召回)
  let expert = null;
  const packs = Array.isArray(ctx.experts) ? ctx.experts : [];
  for (const p of packs) {
    const dom = String(p.domain || "").toLowerCase();
    const syn = DOMAIN_SYNONYMS[dom] || [];
    const hit = (dom && lower.includes(dom))
      || syn.some((w) => text.includes(w))
      || (p.label && text.includes(p.label))
      || (p.id && lower.includes(String(p.id).toLowerCase()));
    if (hit) { expert = p; break; }
  }
  // 4) 意图推测 + 置信度 (三信号: 技能/专家命中=高, 仅连续性=中, 无信号=不推测)
  let intent = null;
  let confidence = "low";
  if (skill) { intent = "skill:" + skill.name; confidence = "high"; }
  else if (expert) { intent = "expert:" + expert.id; confidence = "high"; }
  else if (continuity) { intent = "task.continue"; confidence = "mid"; }
  // 上一轮意图 (会话状态唯一消费点): WorkStack 无 activeTask 时, "继续" 类消息靠它补方向感
  const prevIntent = (ctx.prevState && ctx.prevState.lastIntent) || null;
  return { continuity, skill, expert, task: ctx.activeTask || null, intent, confidence, prevIntent };
}

// 渲染分流提示块 (雷仔范式: 注入提示不接管决策; 无信号返回 "" 不注入, 防提示疲劳)
export function buildDispatchHint(signals) {
  if (!signals) return "";
  const lines = [];
  if (signals.intent) {
    lines.push(`- 意图推测: ${signals.intent} (置信:${signals.confidence === "high" ? "高" : signals.confidence === "mid" ? "中" : "低"})`);
  }
  if (signals.skill) lines.push(`- 命中技能: ${signals.skill.name} —— 若确实相关, 先 load_skill 加载后再动手`);
  if (signals.expert) {
    lines.push(`- 命中专家: ${signals.expert.id}${signals.expert.label ? " (" + signals.expert.label + ")" : ""} —— 复杂/跨域任务可 spawn_agent 委派`);
  }
  if (signals.task) {
    lines.push(`- 当前任务: 「${signals.task}」${signals.continuity ? "; 用户在延续该任务" : ""}`);
  } else if (signals.continuity) {
    lines.push("- 上下文: 用户消息带连续性信号, 优先判断是否延续上一任务而非开新任务");
  }
  if (signals.prevIntent && !signals.task) {
    lines.push(`- 上一轮意图: ${signals.prevIntent} —— 若用户在延续话题, 沿该方向继续`);
  }
  if (!lines.length) return "";
  return "[分流提示 · 自动注入, 供决策参考, 非用户输入]\n" + lines.join("\n");
}
