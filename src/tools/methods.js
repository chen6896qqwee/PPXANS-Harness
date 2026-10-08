// src/tools/methods.js - 方法型 Skill (借鉴 7 大神级 Skill)
// 零依赖: 全部通过 LLM 多阶段调用实现, 不引入外部包
// 1. humanize       <- Humanizer-zh   : 去 AI 味
// 2. write_article  <- writing-agent  : 分阶段写作
// 3. clarify        <- Superpowers    : 需求澄清 (信息不足先问)

// 内部: 用 agent 的 LLM 做一次无工具对话
async function llmChat(agent, system, user) {
  if (!agent || !agent.llm) throw new Error("未配置 LLM provider, 方法型 Skill 不可用");
  const r = await agent.llm.chat([
    { role: "system", content: system },
    { role: "user", content: user },
  ]);
  return r.content;
}

function textOf(v, fallback) {
  return String(v ?? fallback).trim();
}

export function registerMethodTools(catalog) {
  // ---------- 1. humanize: 去 AI 味 (Humanizer-zh) ----------
  catalog.register({
    name: "humanize",
    // 纯文本进出: 不改任何状态 (LLM 出口与主对话同一档位) → 只读
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    description: "去除文本的 AI 模板腔。检查宣传腔、过度排比、模糊归因、连接词过多、句式重复、空话套话, 返回改写的自然版本。适合公众号稿、汇报、产品介绍。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要检查改写的文本" },
        mode: { type: "string", enum: ["check", "rewrite"], description: "check=只列问题, rewrite=直接改写(默认)" },
      },
      required: ["text"],
    },
    execute: async (args, ctx) => {
      const text = textOf(args.text, "");
      if (!text) return "[工具错误] humanize: 缺少 text";
      const mode = args.mode === "check" ? "check" : "rewrite";
      const system = "你是文本去AI味专家。检查并消除这些痕迹: ①宣传腔/夸大空话 ②过度排比(句式重复堆叠) ③模糊归因(Experts say/行业报告称 无出处) ④连接词过多(首先/其次/总之/因此 连用) ⑤破折号狂魔 ⑥空洞收尾(未来可期/前景光明) ⑦奉承腔(Great question!/说得太对了)。输出自然、有真人质感的中文。不解释, 直接给结果。";
      const user = mode === "rewrite"
        ? `请改写下面文本, 保留原意但去掉所有AI腔:\n\n${text}`
        : `请逐项检查下面文本的AI痕迹, 用列表列出问题(每项: 位置+问题+修改建议):\n\n${text}`;
      try {
        const out = await llmChat(ctx.agent, system, user);
        return out || "(无输出)";
      } catch (e) {
        return `[工具错误] humanize: ${e.message}`;
      }
    },
  });

  // ---------- 2. write_article: 分阶段写作 (writing-agent) ----------
  catalog.register({
    name: "write_article",
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    description: "分阶段写长文: 选题→结构→初稿→审稿→修改→导出。适合公众号文章、产品介绍、课程内容、需要反复修改的长文。",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "主题" },
        audience: { type: "string", description: "读者是谁 (可选)" },
        length: { type: "string", description: "字数要求 (可选)" },
        tone: { type: "string", description: "语气风格 (可选)" },
      },
      required: ["topic"],
    },
    execute: async (args, ctx) => {
      const topic = textOf(args.topic, "");
      if (!topic) return "[工具错误] write_article: 缺少 topic";
      const audience = textOf(args.audience, "undefined");
      const length = textOf(args.length, "undefined");
      const tone = textOf(args.tone, "undefined");
      const system = "你是资深内容创作总编。写长文必须走完整流程, 先规划再动笔, 每步都交代清楚再进下一步。";
      const user = `写一篇关于「${topic}」的文章。\n读者: ${audience}\n字数: ${length}\n语气: ${tone}\n\n请按流程输出:\n【1.选题确认】一句话说清本文核心观点和读者收益\n【2.结构】列出大纲(标题+各段要点)\n【3.初稿】按结构写出完整正文\n【4.审稿】列出初稿的问题(事实/逻辑/语气)\n【5.修改稿】根据审稿优化后的最终版本\n【6.导出】给出可用标题(3个备选)+文章定稿`;
      try {
        const out = await llmChat(ctx.agent, system, user);
        return out || "(无输出)";
      } catch (e) {
        return `[工具错误] write_article: ${e.message}`;
      }
    },
  });

  // ---------- 3. clarify: 需求澄清 (Superpowers) ----------
  catalog.register({
    name: "clarify",
    // 只出不改 (无人应答时连 LLM 都不调) → 只读; plan 模式本就该用它出题/收敛方案
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    description: "需求澄清: 面对模糊任务先问清需求再动手, 避免返工。传入任务描述, 返回需要澄清的问题清单; 若信息足够则直接给出执行方案。仅当进程有人可答 (Web/CLI) 时才出题; 无人应答进程会返回\"按工作区自行推进\"的指引而非问题。适合改代码/做项目前使用。",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "任务描述" },
        context: { type: "string", description: "已知背景/已了解的信息 (可选)" },
      },
      required: ["task"],
    },
    execute: async (args, ctx) => {
      const task = textOf(args.task, "");
      if (!task) return "[工具错误] clarify: 缺少 task";
      // 2026-10-05 (基准 fix-syntax / write-function 复盘): 本工具产出的"问题清单"会被模型
      // 原样转述给用户, 随后不再发工具调用 —— runToolLoop (core/policy.js) 见到无 tool_calls
      // 的 assistant 消息即返回, 轮次就此终结; headless 进程里根本没人回答, 任务直接死在反问上。
      // 修的是机制而非文案: 无人应答时不再走 LLM 生成问题 (不消费轮次/不产生可转述的问题),
      // 改返回继续推进的指引; 有人在场 (Web 审批面 / CLI 终端) 时行为与今天完全一致。
      const agent = ctx && ctx.agent;
      if (agent && typeof agent.hasHumanChannel === "function" && !agent.hasHumanChannel()) {
        return "[clarify·无人可答] 当前进程没有人能回答反问 (非 Web/CLI 交互会话)。"
          + "不要把问题转述给用户后结束本轮: 先 read_file / search_files / list_dir 查看工作目录"
          + "实际有什么 (任务点名的文件通常就在里面), 在回答里明确写出你的假设, 然后直接完成任务; "
          + "只有真正找遍了才能说\"找不到\"。";
      }
      const context = textOf(args.context, "无额外背景");
      const system = "你是需求澄清专家。面对模糊任务, 先判断信息是否足够执行。若不足, 列出必须澄清的关键问题(≤5个, 只问真正影响执行的问题, 不啰嗦); 若已足够, 给出简明执行方案(步骤+风险+受影响的文件/模块)。不编造, 不确定就列问题。";
      const user = `任务: ${task}\n已知背景: ${context}\n\n请判断信息是否足够, 不足则问关键问题, 足够则给执行方案。`;
      try {
        const out = await llmChat(ctx.agent, system, user);
        return out || "(无输出)";
      } catch (e) {
        return `[工具错误] clarify: ${e.message}`;
      }
    },
  });

  // ---------- 场景系统: 类似灵魂文件的场景设定 ----------
  catalog.register({
    name: "scene_create",
    // 写场景库 (持久状态变更) → 非只读
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "memory" },
    description: "创建/更新一个场景(人设)。每个场景定义智能体在这个情境下能帮用户干什么, 类似灵魂文件。可手动设定名称/介绍/能力。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "场景名称, 如: A股交易助手" },
        description: { type: "string", description: "场景介绍, 说明这个场景是干嘛的" },
        canHelp: { type: "string", description: "这个场景能帮用户干什么(能力清单)" },
        keywords: { type: "array", items: { type: "string" }, description: "触发关键词(可选)" },
      },
      required: ["name", "description", "canHelp"],
    },
    execute: async (args, ctx) => {
      if (!ctx.agent) return "[工具错误] scene_create: 缺少 agent 上下文";
      const s = ctx.agent.scenes.create({
        name: args.name, description: args.description, canHelp: args.canHelp, keywords: args.keywords,
      });
      return JSON.stringify({ ok: true, id: s.id, name: s.name, mode: "manual" });
    },
  });

  catalog.register({
    name: "scene_list",
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    description: "列出所有场景及其介绍/能力。",
    parameters: { type: "object", properties: {} },
    execute: async (args, ctx) => {
      if (!ctx.agent) return "[工具错误] scene_list: 缺少 agent 上下文";
      const list = ctx.agent.scenes.listWithDesc();
      return list.length ? list.map((s) => `- [${s.mode}] ${s.name}: ${s.description} | 能帮: ${s.canHelp} | ${s.facts}条记忆`).join("\n") : "(暂无场景)";
    },
  });

  catalog.register({
    name: "scene_describe",
    // 提炼完会回写 scene.description/canHelp 并 scenes._save() → 持久状态变更, 非只读
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "memory" },
    description: "用 LLM 从历史对话提炼场景介绍和能力。给定场景名, 自动总结该场景的用途和能帮用户干什么。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "要提炼的场景名" } },
      required: ["name"],
    },
    execute: async (args, ctx) => {
      const name = textOf(args.name, "");
      if (!name) return "[工具错误] scene_describe: 缺少 name";
      if (!ctx.agent) return "[工具错误] scene_describe: 缺少 agent";
      // 找场景
      const scene = ctx.agent.scenes.scenes.find((i) => i.name === name || i.name.includes(name));
      if (!scene) return `[工具错误] scene_describe: 未找到场景 ${name}`;
      const facts = (scene.facts || []).map((f) => f.content).slice(-10).join("\n");
      const system = "你是场景分析器。根据场景的历史对话, 提炼出: ①场景简介(一句话) ②这个场景能帮用户干什么(能力清单, 3-5项)。直接给结果, 格式: 简介:xxx\\n能力: - xxx\\n - xxx";
      const user = `场景: ${scene.name}\\n历史对话:\\n${facts || "(无)"}`;
      try {
        const out = await llmChat(ctx.agent, system, user);
        // v1.0.9: LLM 输出未含"能力"段时保留旧值 (原 split("能力")[0] 会拿整段污染 description)
        if (out.includes("能力")) {
          scene.description = out.split("能力")[0].replace("简介:", "").trim().slice(0, 300) || scene.description;
          scene.canHelp = out.split("能力")[1]?.slice(0, 300) || scene.canHelp;
        }
        scene.mode = "manual";
        ctx.agent.scenes._save();
        return out || "(无输出)";
      } catch (e) {
        return `[工具错误] scene_describe: ${e.message}`;
      }
    },
  });

  return catalog;
}
