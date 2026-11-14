// webapp/src/i18n/lexicon.js - 界面文案唯一出口 (v5.1)
//
// 为什么有这个文件:
//   内核用「本体 / 空间 / 工单 / 身体 / 轨迹 / 姿态 / 生命周期」这套内部叫法,
//   它们是给开发者看的。用户在界面上第一次见到这些词时无法建立任何映射 ——
//   2026-11-08 盘点: 本体 22 处 / 8 文件, 工单 29 处 / 6 文件, 空间 25 处 / 4 文件。
//   把「内部叫法 → 用户词」收敛到一张表, 好处有三:
//     1) 改一处, 全站生效, 不会再出现两个页面叫法不一致;
//     2) 以后要做「专家模式」开关, 只需要换这张表, 不动组件;
//     3) 新增页面直接引用 T.xxx, 不再手打中文, 也就不会再把内部词漏出去。
//
// 约束: 只放「用户看得到的短标签」。句子级的说明文字留在组件里 (它们需要上下文)。

export const T = {
  /* 主体 */
  brand: "皮皮虾",
  assistant: "助手",            // 内部: 本体 (bot)
  assistants: "助手",
  assistantSettings: "助手设置", // 内部: 本体设置

  /* 空间与工作区 */
  project: "项目",              // 内部: 空间 (space)
  projects: "项目",
  workspace: "工作区",
  addProject: "添加文件夹",

  /* 任务 */
  task: "任务",                 // 内部: 工单 (ticket) / task
  tasks: "任务",
  taskRecord: "任务记录",

  /* 运行态 */
  runState: "运行状态",         // 内部: 身体 (body) / 生命体征
  stage: "运行阶段",            // 内部: 生命周期 (lifecycle)
  trace: "执行过程",            // 内部: 轨迹 (trace)
  mode: "工作模式",             // 内部: 姿态 (mode/type)

  /* 导航 */
  chat: "对话",
  newChat: "新对话",            // 内部: 新开一局
  recentChats: "最近对话",
  capabilities: "能力",
  settings: "设置",
  guide: "使用向导",            // 内部: 新手指引

  /* 能力页分组 */
  capWork: "用它干活",
  capObserve: "看它做了什么",
  capSystem: "系统",
};

/**
 * 内部叫法 → 用户词。给"专家模式"或日志翻译用; 界面上不要直接引用。
 * 一致性校验: 组件里出现这些词应由 lint 提醒 (见 scripts/lexicon-check.js)。
 */
export const INTERNAL_ALIAS = {
  本体: "助手",
  空间: "项目",
  工单: "任务",
  身体: "运行状态",
  轨迹: "执行过程",
  姿态: "工作模式",
  生命周期: "运行阶段",
  新开一局: "新对话",
  新手指引: "使用向导",
};

/** 取标签: t("assistant") → "助手"; 未知 key 返回 fallback 或原 key (便于发现遗漏) */
export function t(key, fallback) {
  return T[key] || fallback || key;
}
