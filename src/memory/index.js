// src/memory/index.js - 记忆系统统一出口 (v0.3 五层架构)
export { FactStore } from "./fact-store.js";
export { MemoryTicker } from "./memory-ticker.js";
export { Experience } from "./experience.js";
export { LegionBoard } from "./legion-board.js";
export { L0Recorder } from "./l0.js";
export { SceneStore } from "./l2.js";
export { PersonaStore } from "./l3.js";
// 架构优化 ③(2026-11-13): 单一检索契约 (多源 → RRF 融合 → 带来源证据)
export { retrieveMemory, fuseSources, buildProviders, formatForPrompt, DEFAULT_SOURCE_WEIGHTS } from "./retrieval.js";
