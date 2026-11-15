// src/utils/json-state.js - agent 作用域 JSON 状态文件 (唯一实现, 2026-09-18 重构收敛)
// 原先 ans/{eviction,proactive,reward}.js 各写一份逐字节相同的 loadState/saveState
// (读: 缺失/损坏 → {}; 写: ensureDir + 同步写, 失败静默降级不打断主流程)。
// 统一后改语义只动这一处; 各模块仍导出自己的 loadState/saveState 保持对外接口不变。
import { noteCatch } from "./catch-log.js";
import path from "node:path";
import { readJson, writeJson } from "./store.js";

// 读: 缺失/损坏 → {} (对象语义); 复用 store.readJson (含去 BOM)
// statePath: 由调用方给出完整路径 (通常 agent.dataDir/memory/<name>.json)
function loadStateFile(file) {
  const s = readJson(file, null);
  return (s && typeof s === "object") ? s : {};
}

// 写: 原子落盘; 失败静默降级不打断主流程
function saveStateFile(file, state) {
  try {
    writeJson(file, state);
  } catch (e) { noteCatch("src/utils/json-state.js#writeJson", e); /* 状态落盘失败不影响主流程 */ }
}

// agent 作用域便捷封装: name 为 memory/<name>.json 的文件名
function agentStatePath(agent, name) {
  return path.join(agent.dataDir, "memory", `${name}.json`);
}

export function loadAgentState(agent, name) {
  return loadStateFile(agentStatePath(agent, name));
}

export function saveAgentState(agent, name, state) {
  return saveStateFile(agentStatePath(agent, name), state);
}
