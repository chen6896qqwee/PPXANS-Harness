// src/commands/index.js - 斜杠命令统一模型 (吸收 claude-code types/command 思路, 纯 JS, 零依赖)
// Command = { name, description, argumentHint, isEnabled(ctx), run(ctx, args) -> 结构化意图 }
// run 只返回结构化意图对象 (如 {type:'intent', action:'new_session'}), 不直接操作 agent;
// 真正的落地由集成层(agent/通道)负责。保证内核与"命令做什么"解耦。

import fs from "node:fs";
import path from "node:path";

// ---- 命令注册表 ----
export function createCommandRegistry({ commands = [] } = {}) {
  const map = new Map();
  const register = (cmd) => {
    if (!cmd || !cmd.name) throw new Error("命令缺少 name");
    map.set(cmd.name, cmd);
    return registry;
  };
  const get = (name) => map.get(name) || null;
  const list = (enabledOnly = true) => {
    const all = [...map.values()];
    const filtered = enabledOnly
      ? all.filter((c) => (typeof c.isEnabled === "function" ? c.isEnabled(undefined) !== false : true))
      : all;
    return filtered.map((c) => ({ name: c.name, description: c.description || "", argumentHint: c.argumentHint || "" }));
  };
  // 解析 "/name args..." -> { cmd, args } 或 null
  const parse = (input) => {
    if (typeof input !== "string") return null;
    const s = input.trim();
    if (!s.startsWith("/")) return null;
    const sp = s.indexOf(" ");
    const name = (sp === -1 ? s.slice(1) : s.slice(1, sp)).trim();
    const args = sp === -1 ? "" : s.slice(sp + 1).trim();
    if (!name) return null;
    return { cmd: name, args };
  };
  const execute = (input, ctx = {}) => {
    const parsed = parse(input);
    if (!parsed) return { type: "error", message: "无法解析命令, 应以 '/' 开头" };
    const cmd = get(parsed.cmd);
    if (!cmd) return { type: "error", message: `未知命令: /${parsed.cmd}` };
    if (typeof cmd.isEnabled === "function" && cmd.isEnabled(ctx) === false) {
      return { type: "message", content: `命令 /${cmd.name} 当前不可用` };
    }
    try {
      return cmd.run(ctx, parsed.args, registry);
    } catch (e) {
      return { type: "error", message: `命令执行失败: ${e.message}` };
    }
  };

  const registry = { register, get, list, parse, execute, _map: map };
  for (const c of commands) register(c);
  return registry;
}

// ---- 内置命令 ----
// 每个命令 run 返回结构化意图, 集成层据此行动
export const BUILTIN_COMMANDS = [
  { name: "new", description: "开启全新会话(清空当前上下文)", argumentHint: "", isEnabled: () => true,
    run: () => ({ type: "intent", action: "new_session" }) },
  { name: "resume", description: "恢复最近的会话", argumentHint: "[sessionId]", isEnabled: () => true,
    run: (_ctx, args) => ({ type: "intent", action: "resume_session", sessionId: args || null }) },
  { name: "compact", description: "压缩当前会话历史以节省上下文", argumentHint: "", isEnabled: () => true,
    run: () => ({ type: "intent", action: "compact" }) },
  { name: "plan", description: "进入计划模式(先出计划再执行)", argumentHint: "", isEnabled: () => true,
    run: () => ({ type: "intent", action: "enter_plan_mode" }) },
  { name: "review", description: "对当前变更执行分级代码审查", argumentHint: "[path|diff]", isEnabled: () => true,
    run: (_ctx, args) => ({ type: "intent", action: "review", target: args || "." }) },
  { name: "init", description: "初始化项目上下文/记忆(PPX.md)", argumentHint: "", isEnabled: () => true,
    run: () => ({ type: "intent", action: "init_project" }) },
  { name: "model", description: "查看或切换当前使用的模型", argumentHint: "[modelName]", isEnabled: () => true,
    run: (_ctx, args) => ({ type: "intent", action: "set_model", model: args || null }) },
  { name: "status", description: "显示当前会话/agent 状态", argumentHint: "", isEnabled: () => true,
    run: () => ({ type: "intent", action: "show_status" }) },
  { name: "memory", description: "查看/管理记忆层级", argumentHint: "[clear]", isEnabled: () => true,
    run: (_ctx, args) => ({ type: "intent", action: "memory", sub: args || null }) },
  { name: "skills", description: "列出可用技能", argumentHint: "", isEnabled: () => true,
    run: () => ({ type: "intent", action: "list_skills" }) },
  { name: "agents", description: "列出/派生子 agent(军团)", argumentHint: "[spawn|list]", isEnabled: () => true,
    run: (_ctx, args) => ({ type: "intent", action: "agents", sub: args || "list" }) },
  { name: "goal", description: "打开/更新目标看板(Goal Board)", argumentHint: "[add|update|list]", isEnabled: () => true,
    run: (_ctx, args) => ({ type: "intent", action: "goal_board", sub: args || "list" }) },
  { name: "help", description: "显示命令帮助", argumentHint: "", isEnabled: () => true,
    run: (_ctx, _args, registry) => ({
      type: "message",
      content: "可用命令: " + (registry ? registry.list().map((c) => "/" + c.name).join("  ") : "/new /review /help ..."),
    }) },
];

// 便捷: 创建带全部内置命令的注册表
export function createBuiltinRegistry() {
  return createCommandRegistry({ commands: BUILTIN_COMMANDS });
}

// 解析 .md 命令文件的 frontmatter (复用 skills 的轻量解析思路, 这里内联避免跨模块依赖)
function parseCommandMd(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const mm = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (mm) meta[mm[1].toLowerCase()] = mm[2].trim();
    }
  }
  const body = m ? md.slice(m[0].length) : md;
  return { meta, body: body.trim() };
}

// 从 .ppx/commands/*.md 加载用户命令 (frontmatter: name/description, 正文作为 prompt 模板)
export function loadUserCommands(dir) {
  const cmdsDir = path.join(dir, ".ppx", "commands");
  const out = [];
  if (!fs.existsSync(cmdsDir)) return out;
  let entries;
  try {
    entries = fs.readdirSync(cmdsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const raw = fs.readFileSync(path.join(cmdsDir, e.name), "utf8");
    const { meta, body } = parseCommandMd(raw);
    const name = meta.name || e.name.replace(/\.md$/, "");
    if (!name) continue;
    out.push({
      name,
      description: meta.description || body.slice(0, 60),
      argumentHint: meta.argumenthint || "",
      isEnabled: () => true,
      // 用户命令: 返回 prompt 模板意图, 由集成层注入 system/user
      run: (_ctx, args) => ({ type: "prompt", command: name, template: body, args }),
    });
  }
  return out;
}

// 合并内置 + 用户命令, 返回完整注册表
export function createRegistryWithUserCommands(dir, { extra = [] } = {}) {
  const user = loadUserCommands(dir);
  return createCommandRegistry({ commands: [...BUILTIN_COMMANDS, ...user, ...extra] });
}
