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
