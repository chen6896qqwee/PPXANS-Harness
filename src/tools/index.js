// src/tools/index.js - 工具系统统一出口
export { ToolCatalog, TOOL_ERROR_PREFIX } from "./catalog.js";
export { normalizeMeta, runWithPolicy, toDescriptor } from "./seam.js";
export { registerBuiltinTools } from "./builtin.js";
export { registerAdvancedTools, Scheduler } from "./advanced.js";
export { registerMethodTools } from "./methods.js";
export { registerSelfmodTools } from "./selfmod.js";
export { registerCustomTools } from "./custom.js";
export { registerDocumentTools } from "./document.js";
// 记忆治理 + 审计 + 运维 (吸收自 ppx-v2)
export { registerGovernanceTools } from "./governance.js";
export { registerGitTools } from "./git.js";
// 2026-10-09: 补齐统一出口 —— 以下模块早已实现, 但没从这里再导出,
// 而 v31-embed-local / write-selfcheck / postcondition-gate 等测试按"统一出口"约定 import。
export { jsExportSelfCheck } from "../core/postcondition.js";
export { runInSandbox, registerSandboxTools } from "./sandbox.js";
export { parseWavPcm16, energyVad, registerVadTools } from "./vad.js";
export { escapePS, buildTTSCommand, speakText, registerVoiceTools, resolveVoice, resolveLocalAsr, voiceStatus } from "./voice.js";
