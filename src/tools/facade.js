// src/tools/facade.js - 意图门面 (架构优化 ①, 2026-11-13)
//
// 问题 (审计结论): 全仓 107 个工具, 同一种意图有多个人口 —— 团队房间 7 个、记忆治理 6 个、
//   技能管理 5 个、进化自改 9 个、git 7 个。对模型来说这不是"能力强", 是"选哪个"的歧义:
//   每个入口都要单独占一行名单、单独被理解, 而权限/审计/错误识别要在 107 份实现上重复接缝。
//
// 做法 (additive, 不删实现): 把同一族的低频工具收进一个**门面工具**, 用 action 分派。
//   - 门面只是转发: 内部仍走 catalog.call(target, ...), 策略链/审批/审计/参数校验一处不少;
//   - 原工具名保持可调用 (测试、脚本、已有 skills 不受影响), 只是不再出现在对模型下发的名单里;
//   - schema 由真实注册项**运行时合成** (action 枚举 + 参数并集), 不手写第二份定义 ——
//     手写副本一定会和实现漂移。
//
// 结果: 107 → 57 个对模型可见的名词, 长尾名单从 73 行收到 23 行, 而能力一个没少。
const oneLine = (s, n = 64) => {
  const t = String(s || "").split(/[。\n]/)[0].replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// 族定义: 门面名 → {summary, actions{action→目标工具}, category}
// 只收"低频 + 同族"的工具; 高频主干 (读写/命令/检索/记忆查询/委派) 一律不动 ——
// 门面化的收益是名单清晰, 代价是多一跳, 主干不值得付这个代价。
export const FACADE_GROUPS = [
  {
    name: "team_room", summary: "团队房间: 开会、发言、派活、查历史、看成员", category: "agent",
    actions: {
      open: "team_room_open", say: "team_room_say", close: "team_room_close",
      dispatch: "team_room_dispatch", history: "team_room_history",
      manage: "team_room_manage", status: "team_room_status", list: "team_list",
    },
  },
  {
    name: "memory_admin", summary: "记忆治理: 遗忘、软删恢复、按层清理、导入导出", category: "memory",
    actions: {
      forget: "memory_forget", list_deleted: "memory_list_deleted", restore: "memory_restore",
      clear_layer: "memory_clear_layer", export: "memory_export", import: "memory_import",
    },
  },
  {
    name: "skill_admin", summary: "技能管理: 导入、覆盖率、领域清单、新建与精修", category: "skill",
    actions: {
      import: "skill_import", coverage: "skill_coverage", domains: "skill_domains",
      create: "create_skill", refine: "refine_skill",
    },
  },
  {
    name: "expert", summary: "专家包: 列举、查看、安装", category: "agent",
    actions: { list: "expert_list", pack_list: "expert_pack_list", pack_show: "expert_pack_show", install: "expert_pack_install" },
  },
  {
    name: "evolve", summary: "自进化: 自诊断、自改、自验、回卷、自愈、进化曲线", category: "system",
    actions: {
      diagnose: "self_diagnose", edit: "self_edit", improve: "self_improve", verify: "self_verify",
      rewind: "self_rewind", heal: "selfheal_run", status: "evolution_status", refine: "refine",
    },
  },
  {
    name: "git", summary: "版本库: 状态、差异、日志、提交、拉取、克隆 (禁 push)", category: "system",
    actions: {
      status: "git_status", diff: "git_diff", log: "git_log", commit: "git_commit",
      fetch: "git_fetch", pull: "git_pull", clone: "git_clone",
    },
  },
  {
    name: "scene", summary: "场景记忆 (L2): 建立、列举、描述", category: "memory",
    actions: { create: "scene_create", list: "scene_list", describe: "scene_describe" },
  },
  {
    name: "persona", summary: "画像 (L3): 生成、列举、预览、读取", category: "memory",
    actions: { build: "persona_build", list: "persona_list", preview: "persona_preview", read: "persona_read" },
  },
  {
    name: "task_plan", summary: "工件与任务栈: 计划文件、任务栈读写", category: "agent",
    actions: { files: "plan_files", stack: "task_stack" },
  },
  {
    name: "capabilities", summary: "能力开关: 启用、禁用、能力矩阵", category: "system",
    actions: { enable: "enable_capability", disable: "disable_capability", matrix: "capability_matrix" },
  },
  {
    name: "repo", summary: "代码库: 仓库地图、wiki、代码审查", category: "code",
    actions: { map: "repo_map", wiki: "repo_wiki", review: "review_code" },
  },
  {
    name: "audit", summary: "审计与运维: 审计链校验、边界检查、用量、会话回放", category: "system",
    actions: { verify: "audit_verify", boundary: "boundary_check", usage: "usage_stats", replay: "replay_session" },
  },
  {
    name: "legion", summary: "军团: 状态查询、并发调整", category: "agent",
    actions: { status: "legion_status", concurrency: "legion_set_concurrency" },
  },
  {
    name: "voice", summary: "语音: 合成、静音检测、转写", category: "media",
    actions: { speak: "tts", vad: "vad_detect", transcribe: "voice_transcribe" },
  },
  {
    name: "ingest", summary: "资料入库: 文档解析、图片 OCR", category: "media",
    actions: { document: "ingest_document", ocr: "ocr_image" },
  },
];

// 合成门面 schema: action 枚举 + 各目标工具参数的并集 (运行时读真实注册项)。
export function buildFacadeDef(group, catalog) {
  const members = Object.entries(group.actions || {})
    .map(([action, tool]) => ({ action, tool, meta: catalog.metaOf(tool) }))
    .filter((m) => m.meta);
  if (!members.length) return null;

  const properties = {};
  const lines = [];
  const conflicts = [];
  for (const m of members) {
    const props = m.meta.parameters?.properties || {};
    const required = m.meta.parameters?.required || [];
    for (const [key, spec] of Object.entries(props)) {
      if (key === "action") continue; // 与门面自身参数同名, 不让目标工具覆盖
      const prev = properties[key];
      if (prev && spec?.type && prev.type && spec.type !== prev.type) {
        conflicts.push(`${key}(${prev.type}/${spec.type})`);
        continue; // 冲突时保留首次定义, 由 tool_schema 兜底查具体动作
      }
      if (!prev) properties[key] = spec;
    }
    const req = required.length ? ` 必填: ${required.join(", ")}` : "";
    lines.push(`- ${m.action}: ${oneLine(m.meta.description)}${req}`);
  }

  const description = [
    `${group.summary}。用 action 选择动作, 参数按该动作的必填项给。`,
    ...lines,
    conflicts.length ? `(同名参数类型不一致: ${conflicts.join(", ")}; 具体动作的 schema 用 tool_schema 查原工具名)` : "",
  ].filter(Boolean).join("\n");

  // 能力声明由目标工具推导 (capability-guard 要求每个内置工具显式声明):
  //   全只读 → 门面只读; 否则按最高风险 + 是否有破坏性动作收口。门面本身不做事,
  //   真正的拦截仍发生在目标工具的调用点上, 这里给的是"最坏情况"的可审计声明。
  const caps = members.map((m) => catalog.getCapability(m.tool) || {});
  const capability = {
    readOnly: caps.every((c) => c.readOnly === true),
    riskLevel: caps.some((c) => c.riskLevel === "high") ? "high" : caps.some((c) => c.riskLevel === "medium") ? "medium" : "low",
    destructive: caps.some((c) => c.destructive === true),
    sideEffect: caps.some((c) => c.sideEffect === "system") ? "system" : caps.some((c) => c.sideEffect === "workspace") ? "workspace" : caps.some((c) => c.sideEffect === "network") ? "network" : "unknown",
  };

  return {
    name: group.name,
    category: group.category || "meta",
    power: "medium",
    capability,
    description,
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: members.map((m) => m.action) }, ...properties },
      required: ["action"],
    },
    // 门面自身不做业务, 只转发; 目标工具的安全策略照常执行 (deny-wins 不被旁路)
    __facadeActions: Object.fromEntries(members.map((m) => [m.action, m.tool])),
  };
}

// 注册全部门面。返回 { facades, covered } —— covered 是被收进名单 (不再单独下发) 的原工具名。
export function registerFacadeTools(catalog, { groups = FACADE_GROUPS } = {}) {
  const registered = [];
  const covered = [];
  for (const group of groups) {
    if (catalog.has(group.name)) continue; // 用户插件已占用该名: 不抢
    const def = buildFacadeDef(group, catalog);
    if (!def) continue;
    const actions = def.__facadeActions;
    delete def.__facadeActions;
    catalog.register({
      ...def,
      source: "facade",
      execute: async (args, ctx) => {
        const action = String(args?.action || "");
        const target = actions[action];
        if (!target) {
          return `[工具错误] ${group.name}: 未知 action "${action}"。可用: ${Object.keys(actions).join(" / ")}`;
        }
        const { action: _drop, ...rest } = args || {};
        return catalog.call(target, rest, ctx);
      },
    });
    registered.push(group.name);
    covered.push(...Object.values(actions));
  }
  return { facades: registered, covered };
}
