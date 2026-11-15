// src/tools/index.js - 工具系统统一出口
export { ToolCatalog, TOOL_ERROR_PREFIX, CORE_TOOL_EXPOSURE, META_TOOLS_ALWAYS } from "./catalog.js";
export { normalizeMeta, runWithPolicy, toDescriptor } from "./seam.js";
export { registerBuiltinTools } from "./builtin.js";
export { registerAdvancedTools } from "./advanced.js";
export { Scheduler } from "./scheduler.js";
export { registerMethodTools } from "./methods.js";
export { registerSelfmodTools } from "./selfmod.js";
export { registerCustomTools } from "./custom.js";
// 链式召回 (2026-11-01 二期③): 超长工具结果全文归档 + 按 spill_id 续读
// (裁剪告示牌纯函数 toolContentWithSpill 在 agent/loop/policy.js —— core 不许 import tools,
//  反向 tools → core 的 re-export 合法)
export { SpillStore } from "./spill.js";
export { registerContextTools } from "./context.js";
export { registerGrepTools, runGrep } from "./grep.js";
export { registerLspTools, LspClient, KNOWN_SERVERS, pickServer } from "./lsp.js";
export { registerShellSessionTools, PersistentShell, findBash } from "./shell-session.js";
// 架构优化 ①(2026-11-13): 意图门面 (同族低频工具 → action 分派, 原实现保留)
export { registerFacadeTools, FACADE_GROUPS, buildFacadeDef } from "./facade.js";
export { registerDocumentTools } from "./document.js";
// 桌面控制 (2026-11-03): computer 工具 —— 截图/鼠标/键盘/打开程序, 默认关闭 (security.computer_control)
export { registerDesktopTools } from "./desktop.js";
// 记忆治理 + 审计 + 运维 (承接自 ppx-v2)
export { registerGovernanceTools } from "./governance.js";
export { registerGitTools } from "./git.js";
// 2026-10-09: 补齐统一出口 —— 以下模块早已实现, 但没从这里再导出,
// 而 v31-embed-local / write-selfcheck / postcondition-gate 等测试按"统一出口"约定 import。
export { jsExportSelfCheck } from "../verify/postcondition.js";
export { runInSandbox, registerSandboxTools } from "./sandbox.js";
export { parseWavPcm16, energyVad, registerVadTools } from "./vad.js";
export { escapePS, buildTTSCommand, speakText, registerVoiceTools, resolveVoice, resolveLocalAsr, voiceStatus } from "./voice.js";
