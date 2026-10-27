// src/selfcode/index.js — 自改闭环统一出口 (2026-10-27)
export { SelfCodeEngine, compactDiff } from "./engine.js";
export { SelfCodeLedger } from "./ledger.js";
export { verifyChange, syntaxGate, testGate, guardPath } from "./verify.js";
