// src/hooks/user-hooks.js — 用户配置钩子 (吸收 claude-code settings.json hooks 格式)
// 此前钩子链只能代码注册 (plugin/builtin + agent 内部), 用户没有任何配置入口 ——
// "吸收 claude-code 六事件" 只吸收了一半: 事件模型有了, 用户可编程性没有。这里补上配置格式。
//
// 格式 (claude-code settings.json 对齐, 配在 config/ppx.json 顶层 hooks 键):
//   {
//     "hooks": {
//       "trust_project_roots": ["D:/work/myproj"],  // 项目级钩子信任白名单 (默认空, 防仓库投毒)
//       "PreToolUse": [
//         { "matcher": "run_command|write_file",
//           "hooks": [ { "type": "command", "command": "node scripts/guard.js", "timeout": 10, "fail_closed": false } ] }
//       ],
//       "PostToolUse": [ ... ], "SessionStart": [ ... ], ...  // 事件名同 HOOK_EVENTS
//     }
//   }
//
// 执行契约 (claude-code 语义):
//   - 输入: JSON 从 stdin 喂入 { hook_event_name, tool_name, tool_input, tool_result, cwd, ...原始 payload }。
//     模型数据 (工具名/参数/结果) 只走 stdin 不走 argv —— 命令串不经模型之手, 无注入面。
//   - 退出码 0: stdout 可选 JSON —— PreToolUse: {"decision":"block","reason"} 否决 / {"args":{...}} 改参;
//     PostToolUse: {"additionalContext":...} 附加上下文; 非 JSON stdout = 放行 (透明)。
//   - 退出码 2: blocking error —— PreToolUse 视为否决 (stderr 喂回作理由); 其它事件无否决语义, 记为该钩子错误。
//   - 其它退出码 / spawn 失败 / 超时: 记为该钩子错误 (不阻断链); 仅 fail_closed:true 且 PreToolUse 时故障=拒绝。
//
// 安全模型 (两源分信):
//   - 引擎配置 (config/ppx.json, npm 装机时在 ~/.ppx/config.json) 的 hooks = 用户自己写的,
//     与 api_key_cmd (配置里配执行命令) 同一信任级 → 默认生效。
//   - 项目级 .ppx/settings.json 随仓库分发 = **不可信输入** → 默认不加载;
//     仅当项目根出现在 hooks.trust_project_roots (引擎配置, 仓库自己改不了) 才注册。
//     残余风险: 信任后仓库仍可改钩子内容 —— 与信任整个仓库代码同级, 文档明示。

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { HOOK_EVENTS } from "./index.js";

// hooks 键下的元配置键 (不是事件名, parseUserHooks 跳过)
const META_KEYS = new Set(["trust_project_roots"]);
// 有否决语义的事件 (与 hooks/index.js fail-closed 口径一致: 仅 PreToolUse)
const VETO_EVENTS = new Set(["PreToolUse"]);
// matcher 只对工具事件有意义 (payload 里有 tool); 其它事件永远全量触发
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);
const DEFAULT_TIMEOUT_S = 10;   // 单钩子默认超时 (秒) —— 兼顾 Windows spawn 冷启动与"卡死别拖链"
const MAX_TIMEOUT_S = 120;      // 上限 (秒), 防配置写错把整个工具循环挂住
const MAX_STDOUT = 1024 * 1024; // stdout 捕获上限 1MB, 防失控输出吃内存
export const USER_HOOK_PRIORITY = 200; // 用户钩子排在系统钩子 (默认 100) 之后 —— 安全闸先行

const IS_WIN = process.platform === "win32";

// 路径等值比较 (Windows 不区分大小写; resolve 吸收相对/分隔符差异)
function samePath(a, b) {
  if (!a || !b) return false;
  const ra = path.resolve(String(a));
  const rb = path.resolve(String(b));
  return IS_WIN ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

// matcher → 锚定正则。claude-code 的 matcher 是正则语义 ("Edit|Write"), 这里整词锚定更可预测;
// 非法正则直接抛错 (校验阶段捕获, fail-visible)。
function compileMatcher(matcher) {
  const m = String(matcher || "").trim();
  if (!m) return null; // 空 = 匹配所有工具
  return new RegExp(`^(?:${m})$`);
}

// 校验单个事件下的钩子组数组 → 展平为钩子描述符列表
// 返回 { hooks: [{event, matcher, matcherRe, command, timeoutMs, failClosed, source}], errors: [string] }
function parseHookGroups(event, groups, source) {
  const hooks = [];
  const errors = [];
  if (!Array.isArray(groups)) {
    errors.push(`hooks.${event} 必须是数组 (得到 ${typeof groups}), 已跳过`);
    return { hooks, errors };
  }
  groups.forEach((group, gi) => {
    const where = `hooks.${event}[${gi}]`;
    if (!group || typeof group !== "object") {
      errors.push(`${where} 不是对象, 已跳过`);
      return;
    }
    let matcherRe = null;
    try {
      matcherRe = compileMatcher(group.matcher);
    } catch (e) {
      errors.push(`${where}.matcher 非法正则 (${e.message}), 已跳过`);
      return;
    }
    const list = group.hooks;
    if (!Array.isArray(list)) {
      errors.push(`${where}.hooks 必须是数组, 已跳过`);
      return;
    }
    list.forEach((h, hi) => {
      const w2 = `${where}.hooks[${hi}]`;
      if (!h || typeof h !== "object") { errors.push(`${w2} 不是对象, 已跳过`); return; }
      if (h.type !== "command") { errors.push(`${w2}.type 仅支持 "command" (得到 ${JSON.stringify(h.type)}), 已跳过`); return; }
      if (typeof h.command !== "string" || !h.command.trim()) { errors.push(`${w2}.command 必须是非空字符串, 已跳过`); return; }
      let t = h.timeout == null ? DEFAULT_TIMEOUT_S : Number(h.timeout);
      if (!Number.isFinite(t) || t <= 0) { errors.push(`${w2}.timeout 非法 (${JSON.stringify(h.timeout)}), 用默认 ${DEFAULT_TIMEOUT_S}s`); t = DEFAULT_TIMEOUT_S; }
      if (t > MAX_TIMEOUT_S) { errors.push(`${w2}.timeout 超上限 (${t}s > ${MAX_TIMEOUT_S}s), 钳到 ${MAX_TIMEOUT_S}s`); t = MAX_TIMEOUT_S; }
      hooks.push({
        event,
        matcher: String(group.matcher || "").trim(),
        matcherRe,
        command: h.command,
        timeoutMs: Math.round(t * 1000),
        failClosed: h.fail_closed === true,
        source,
      });
    });
  });
  return { hooks, errors };
}

// 解析引擎配置里的 hooks 键 (只认 HOOK_EVENTS 事件名, 未知事件 fail-visible)
export function parseUserHooks(hooksCfg, source = "engine-config") {
  const hooks = [];
  const errors = [];
  const cfg = hooksCfg && typeof hooksCfg === "object" ? hooksCfg : {};
  for (const key of Object.keys(cfg)) {
    if (META_KEYS.has(key)) continue;
    if (!HOOK_EVENTS.includes(key)) {
      errors.push(`hooks.${key} 不是合法钩子事件 (可用: ${HOOK_EVENTS.join("/")}), 已跳过`);
      continue;
    }
    const r = parseHookGroups(key, cfg[key], source);
    hooks.push(...r.hooks);
    errors.push(...r.errors);
  }
  return { hooks, errors };
}

// 读项目级 .ppx/settings.json 的 hooks 键; 无文件返回 null (与"有文件但为空"区分开)
export function loadProjectHooks(root) {
  const file = path.join(root, ".ppx", "settings.json");
  if (!fs.existsSync(file)) return null;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { file, hooks: [], errors: [`.ppx/settings.json 解析失败 (${e.message}), 项目级钩子全部跳过`] };
  }
  const parsed = parseUserHooks(raw?.hooks, "project-settings");
  return { file, ...parsed };
}

// 组 stdin JSON 载荷: claude-code 别名 (tool_name/tool_input/tool_result) + 原始 payload 透传
function buildStdinPayload(event, payload, root) {
  const base = {
    hook_event_name: event,
    tool_name: payload?.tool,
    tool_input: payload?.args,
    tool_result: payload?.result,
    ok: payload?.ok,
    session_id: payload?.sessionKey || payload?.sessionId,
    cwd: root,
    timestamp: new Date().toISOString(),
    ...payload,
  };
  try {
    return JSON.stringify(base);
  } catch {
    // result/args 含不可序列化值时降级为最小载荷 (钩子至少知道事件名)
    return JSON.stringify({ hook_event_name: event, cwd: root, timestamp: base.timestamp });
  }
}

// 执行一条钩子命令: 经 shell 执行 (与 claude-code 钩子语义一致, 支持 `node x.js && node y.js`)。
// Windows 走 cmd.exe /d /s /c + verbatim (spawn shell:true 规范路径) —— 手拼 `["/c", cmd]` 数组
// 形式会被引号转义规则绞碎 (实测 `node -e "..."` 内层引号丢失后 node 进 REPL, stdin EOF 即 exit 0
// 静默放行)。模型数据只经 stdin 不进 shell, 命令串是钩子作者写的, shell 解析无注入面。
// 永不 reject, 统一返回 { code, stdout, stderr, killed, error? }
function runHookCommand(command, { root, timeoutMs, input }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, {
        shell: true,
        cwd: root,
        windowsHide: true,
        env: { ...process.env, PPX_PROJECT_DIR: root },
      });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: "", killed: false, error: e.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    }, timeoutMs);
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.stdout.on("data", (d) => { if (stdout.length < MAX_STDOUT) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < MAX_STDOUT) stderr += d; });
    child.on("error", (e) => finish({ code: -1, stdout, stderr, killed, error: e.message }));
    child.on("close", (code, signal) => finish({ code, stdout, stderr, killed, signal }));
    // 钩子不读 stdin (如 echo) 时写入可能 EPIPE —— 只吞错误, 不当作钩子失败
    child.stdin.on("error", () => {});
    try { child.stdin.end(input); } catch { /* 同上 */ }
  });
}

// 退出码/stdout → 钩子返回值映射 (见文件头执行契约)
export function mapHookExit(event, r, timeoutMs) {
  if (r.error && r.code === -1 && !r.killed && !r.stdout && !r.stderr) {
    return { error: `spawn 失败: ${r.error}` };
  }
  if (r.killed) return { error: `超时被终止 (>${timeoutMs}ms)`, timedOut: true };
  if (r.code === 2) {
    const reason = (r.stderr || "").trim().slice(0, 500) || "被钩子否决 (exit 2)";
    if (VETO_EVENTS.has(event)) return { block: reason };
    return { error: `exit 2 (blocking error): ${reason}` };
  }
  if (r.code !== 0) {
    return { error: `exit ${r.code}${r.signal ? ` (${r.signal})` : ""}: ${(r.stderr || "").trim().slice(0, 300)}` };
  }
  const s = (r.stdout || "").trim();
  if (!s) return {}; // 无输出 = 放行
  let j = null;
  try { j = JSON.parse(s); } catch { return {}; } // 非 JSON stdout = 放行 (透明)
  if (!j || typeof j !== "object") return {};
  if (VETO_EVENTS.has(event)) {
    if (j.decision === "block") return { block: String(j.reason || "被钩子否决") };
    if (j.args && typeof j.args === "object" && !Array.isArray(j.args)) return { args: j.args };
  }
  if (event === "PostToolUse" && j.additionalContext != null) return { additionalContext: j.additionalContext };
  return {};
}

// 生成注册进钩子链的 runner (闭包持有钩子描述符; matcher 不匹配时零开销直通)
function makeRunner(hook, root, runFn) {
  return async (payload) => {
    if (TOOL_EVENTS.has(hook.event) && hook.matcherRe) {
      const tool = String(payload?.tool || "");
      if (!hook.matcherRe.test(tool)) return undefined;
    }
    const r = await runFn(hook.command, {
      root,
      timeoutMs: hook.timeoutMs,
      input: buildStdinPayload(hook.event, payload, root),
    });
    const m = mapHookExit(hook.event, r, hook.timeoutMs);
    if (m.block) return { decision: "block", reason: m.block };
    if (m.error) throw new Error(m.error); // registry 记 error; fail_closed 钳位由 registry (仅 PreToolUse) 处理
    const out = {};
    if (m.args) out.args = m.args;
    if (m.additionalContext != null) out.additionalContext = m.additionalContext;
    return Object.keys(out).length ? out : undefined;
  };
}

// 把用户配置钩子注册进钩子链。deps.runFn 供测试注入 (默认真实 spawn)。
// 返回 summary: { registered, errors, skipped } —— 无效条目 fail-visible (warn 日志), 不静默。
export function registerUserHooks(registry, { config, root, runFn } = {}) {
  const hooksCfg = config?.hooks;
  const summary = { registered: 0, errors: [], skipped: [] };
  const registerOne = (hook) => {
    registry.on(hook.event, makeRunner(hook, root, runFn || runHookCommand), {
      priority: USER_HOOK_PRIORITY,
      // registry 侧超时给 1s 缓冲: 让 spawn 自身的 kill 先到 (错误信息更准: "超时被终止")
      timeoutMs: hook.timeoutMs + 1000,
      failClosed: hook.failClosed,
    });
    summary.registered++;
  };

  // 源 1: 引擎配置 (用户自己写的 → 可信, 默认生效)
  const engine = parseUserHooks(hooksCfg);
  summary.errors.push(...engine.errors);
  for (const hook of engine.hooks) registerOne(hook);

  // 源 2: 项目级 .ppx/settings.json (随仓库分发 = 不可信, 白名单制)
  if (root) {
    const trustList = Array.isArray(hooksCfg?.trust_project_roots) ? hooksCfg.trust_project_roots : [];
    const trusted = trustList.some((p) => samePath(p, root));
    const proj = loadProjectHooks(root);
    if (proj) {
      if (!trusted) {
        summary.skipped.push(
          `项目级钩子未生效 (${proj.file}): 项目根不在 hooks.trust_project_roots —— 防仓库投毒, 需在引擎配置显式信任`
        );
      } else {
        summary.errors.push(...proj.errors);
        for (const hook of proj.hooks) registerOne(hook);
      }
    }
  }
  return summary;
}
