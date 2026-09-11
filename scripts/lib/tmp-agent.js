#!/usr/bin/env node
// scripts/lib/tmp-agent.js - 临时隔离 agent 的统一 helper (零依赖)
// 背景: v1.0.9 review 发现 P0 bug — `new PPXAgent({root})` 的 dataDir 优先读 PPX_DATA_DIR
//       环境变量, 脚本收尾 rmSync(agent.dataDir) 在环境变量指向生产时误删生产数据.
// 职责: 把所有「构造临时隔离 agent + 安全清理」逻辑收敛到一处, 杜绝脚本各自 mkdtemp/dataDir/rmSync
//       (从而重蹈误删生产的覆辙). 唯一安全出口 = cleanupTmp, 删除前强制断言路径位于系统临时目录
//       或本项目自建 .tmp 目录内, 否则抛错绝不删.
//
// 对外 API (尽量叫脚本方极简):
//   makeTmpRoot(prefix, config)          -> root(string)            创建临时根(含 config/ppx.json)
//   makeTmpAgent(prefix, overrides)      -> { root, agent }         临时根 + 显式 dataDir 覆盖的 agent
//   cleanupTmp(rootOrAgent, {quiet})     -> boolean                 安全删除临时根 (不在安全区则抛错)
//   SAFE_TMP_ROOTS                       -> string[]                许可的安全临时根 (供调试/扩展)
//
// config 参数: 可选, 覆盖 config/ppx.json 的完整内容; 默认 { providers: [] }.
// overrides:  透传给 new PPXAgent 的额外参数; dataDir/globalDataDir 恒被强制落到临时根内 (不可被覆盖).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../../src/agent/index.js";

// ---- 安全区: 允许被 cleanupTmp 删除的根 ----
// 1. 系统临时目录 (os.tmpdir()) — 本次所有脚本的临时根都在这里
// 2. 本项目自建 .tmp 目录 (scripts/.tmp) — 供将来想留在工作区内的脚本使用
const LIB_DIR = path.dirname(fileURLToPath(import.meta.url)); // scripts/lib
const SCRIPT_DIR = path.dirname(LIB_DIR);                       // scripts
const PROJECT_ROOT = path.dirname(SCRIPT_DIR);                  // 项目根

export const SAFE_TMP_ROOTS = [
  path.resolve(os.tmpdir()),
  path.resolve(path.join(SCRIPT_DIR, ".tmp")),
];

// path.relative 判断 child 是否真正位于 parent 内 (避免 "C:\tmp\evil" 与 "C:\tmp" 前缀误判)
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  const up = /^(\.\.(\/|\\)|$)/; // 相对路径为 .. 或空 → 不在 parent 的子树内
  return rel !== "" && rel !== "." && !up.test(rel);
}

// ---- 创建客户端配置目录结构 (config/ppx.json) ----
function initConfigDir(root, configOverride) {
  const configDir = path.join(root, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const content = configOverride === undefined
    ? { providers: [] }
    : configOverride;
  fs.writeFileSync(path.join(configDir, "ppx.json"), JSON.stringify(content, null, 2), "utf8");
  return root;
}

/**
 * 创建临时根目录: os.tmpdir()/ppx-<prefix>-XXXX (mkdtemp)
 * @param {string} prefix  目录名前缀 (如 "eval" → "ppx-eval-")
 * @param {object} [config] config/ppx.json 内容覆盖; 默认 { providers: [] }
 * @returns {string}       临时根绝对路径
 */
export function makeTmpRoot(prefix, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${prefix}-`));
  return initConfigDir(root, config);
}

function ensureInsideSafeRoot(root) {
  const resolved = path.resolve(root);
  for (const safe of SAFE_TMP_ROOTS) {
    if (isInside(resolved, safe)) return true;
  }
  return false;
}

/**
 * 在一个已存在的临时根上创建「隔离 agent」(多 agent 共享同一临时根时的便捷口)
 * 与 makeTmpAgent 不同: root 由调用方传入 (如先 makeTmpRoot 建一次根, 再在其上建多个 agent);
 * dataDir/globalDataDir 仍强制落在该 root 内、不可被 overrides 覆盖。
 * @param {string} root   已存在的临时根绝对路径 (须位于 SAFE_TMP_ROOTS)
 * @param {object} [overrides] 额外透传给 new PPXAgent 的参数
 * @returns {PPXAgent}
 */
export function makeAgentOnRoot(root, overrides = {}) {
  const resolved = path.resolve(root);
  if (!ensureInsideSafeRoot(resolved)) {
    throw new Error(
      `[安全护栏] makeAgentOnRoot 要求 root 位于安全临时目录: ${resolved}. 允许: ${SAFE_TMP_ROOTS.join(", ")}.`
    );
  }
  return new PPXAgent({
    root,
    ...overrides,
    dataDir: path.join(root, "data"),
    globalDataDir: path.join(root, "data"),
  });
}

/**
 * 创建临时根 + 隔离 agent (dataDir/globalDataDir 强制落在临时根内, 覆盖 PPX_DATA_DIR 环境变量)
 * @param {string} prefix   目录名前缀
 * @param {object} [overrides] 额外透传给 new PPXAgent 的参数 (如 llm, plugins)
 * @returns {{root: string, agent: PPXAgent}}
 */
export function makeTmpAgent(prefix, overrides = {}) {
  const root = makeTmpRoot(prefix);
  const agent = makeAgentOnRoot(root, overrides);
  return { root, agent };
}

/**
 * 安全删除临时根 (必走安全护栏): 路径不在 SAFE_TMP_ROOTS 内 → 抛错绝不删
 * 接受传入 root 路径或 { root, agent } 对象; agent 若存在先 shutdown.
 * @param {string|{root:string,agent:object}} rootOrAgent
 * @param {{quiet?: boolean}} [opts]
 * @returns {boolean} 删除是否成功 (存在即删成功; 不存在视为已清理, 返回 true)
 */
export function cleanupTmp(rootOrAgent, { quiet = false } = {}) {
  const isObj = !!rootOrAgent && typeof rootOrAgent === "object";
  const root = isObj ? rootOrAgent.root : rootOrAgent;
  const agent = isObj ? rootOrAgent.agent : null;

  if (!root) {
    if (!quiet) throw new Error("cleanupTmp 需要 root 路径或 { root, agent } 对象");
    return false;
  }

  const resolved = path.resolve(root);
  if (!ensureInsideSafeRoot(resolved)) {
    // 安全护栏触发: 明确抛错, 绝不静默放过 (防误删生产数据)
    throw new Error(
      `[安全护栏] 拒绝删除 ${resolved}: 不在安全临时目录内. ` +
      `允许的根: ${SAFE_TMP_ROOTS.join(", ")}. 请确认传入的是 makeTmpRoot/makeTmpAgent 创建的临时根.`
    );
  }

  // 先释放 agent 持有的文件句柄 (rolling 日志/事实缓存等)
  if (agent && typeof agent.shutdown === "function") {
    try { agent.shutdown(); } catch { /* 清理时 shutdown 失败可忽略 */ }
  }

  if (!fs.existsSync(resolved)) return true; // 已被清理或本就不存在

  fs.rmSync(resolved, { recursive: true, force: true });
  return true;
}