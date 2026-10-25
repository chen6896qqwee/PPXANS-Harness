// src/plugin/v3.js - v3.0 新层装配插件 (protocol/session/permissions/hooks/commands/evidence)
// codex 对齐升级: 权限引擎 + 钩子链 + 斜杠命令 + 目标看板, 全部走「一切皆插件」装配, 可被用户插件替换。
import path from "node:path";
import { createHookRegistry } from "../hooks/index.js";
import {
  createPermissionEngine,
  AskForApproval,
  SandboxPolicy,
} from "../permissions/index.js";
import { createRegistryWithUserCommands } from "../commands/index.js";
import { createGoalBoard } from "../evidence/index.js";
import { createProtocolBus } from "../protocol/index.js";
import { info } from "../utils/logger.js";

// 钩子链插件: claude-code 六事件 (PreToolUse/PostToolUse/PreCompact/SessionStart/...)
export const hooksPlugin = (ctx) => {
  ctx.provide("hooks", createHookRegistry());
};

// 权限引擎插件: codex AskForApproval 四档 + SandboxPolicy 三档 + opencode 规则链
// 配置: config.agent.approval_mode / config.agent.sandbox / config.agent.network_access
export const permissionsPlugin = (ctx) => {
  const config = ctx.consume("config");
  const agentCfg = config.agent || {};
  const engine = createPermissionEngine({
    approvalMode: agentCfg.approval_mode || AskForApproval.ON_REQUEST,
    sandbox: agentCfg.sandbox || SandboxPolicy.WORKSPACE_WRITE,
    workspaceRoot: ctx.consume("root"),
    networkAccess: agentCfg.network_access !== false,
    rules: Array.isArray(agentCfg.permission_rules) ? agentCfg.permission_rules : [],
  });
  // 用户自定义规则: [{pattern, action}] (opencode 风格, 有序 last-match-wins)
  for (const r of Array.isArray(agentCfg.permission_rules) ? agentCfg.permission_rules : []) {
    if (r && r.pattern && r.action) engine.addRule(r.pattern, r.action);
  }
  ctx.provide("permissions", engine);
};

// 斜杠命令插件: claude-code 统一命令模型 + 用户命令目录 .ppx/commands/*.md
export const commandsPlugin = (ctx) => {
  const root = ctx.consume("root");
  // 2026-10-10 修复: createRegistryWithUserCommands(dir) 内部自行拼 `.ppx/commands`,
  //   原调用传的已是 root/.ppx/commands → 实际拼成 root/.ppx/commands/.ppx/commands,
  //   用户命令目录永远读不到 (注册表里永远只有内置命令)。这里传 root 即可。
  const registry = createRegistryWithUserCommands(root);
  ctx.provide("commands", registry);
};

// 证据/看板插件: OMH prepared/observed 边界 + goal board 目标看板
// 2026-10-05: 看板从"进程内 Map"改为**文件后端** —— 军团/CLI+Web 是多个进程共用一个 dataDir 的
// 真实形态, 旧形态下计划随进程退出蒸发 (goal_board 工具因此长期"每次调用都抛错")。
export const evidencePlugin = (ctx) => {
  ctx.provide("goalBoard", createGoalBoard({ dataDir: ctx.consume("dataDir") }));
};

// 协议总线插件: codex SQ/EQ 双队列 (WAL 默认落盘 data/protocol/eq.wal.jsonl)
export const protocolPlugin = (ctx) => {
  // 2026-10-10 修复: 原 walPath 硬编码 null → EQ 事件从不落盘, replay() 恒空 (WAL 名存实亡)。
  //   改为落到 data/protocol/eq.wal.jsonl, 与 src/protocol/index.js 的 JSONL 语义一致, 可 replay。
  const dataDir = ctx.consume("dataDir") || path.join(ctx.consume("root"), "data");
  const walPath = path.join(dataDir, "protocol", "eq.wal.jsonl");
  const bus = createProtocolBus({ walPath });
  ctx.provide("protocolBus", bus);
  info("[v3] 协议总线就绪 (SQ/EQ)");
};

// v3 全量插件组 (builtinPlugins 之后追加装配)
export const v3Plugins = [
  hooksPlugin,
  permissionsPlugin,
  commandsPlugin,
  evidencePlugin,
  protocolPlugin,
];
