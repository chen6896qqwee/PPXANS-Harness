// src/verify/postcondition.js — 文件可信性的唯一实现 + 回合后置条件闸门
// 背景 (2026-10-05 一周真跑基准): 模型反复宣称"已完成", 而磁盘字节不支持 ——
//   (1) write_file 写进 utils.js 的内容根本没有 export, 却答"已写入并导出";
//   (2) 只在回复里贴代码块、一个写工具都没调, 却答"修复方法是将其替换为加号", calc.js 仍返回 -1;
//   (3) 没发过读请求就答"共 1 行"。
// 已落地的两条缓解都不够: 提示词纪律不是强制 (prompts.js), 写时自查 (tools/builtin.js) 只在
// 单次调用上且只管 .js。本模块补上**回合级后置条件闸门**: 收尾前由 harness 自己跑确定性检查,
// 检查不过就拒绝结束本轮, 把失败当作可行动反馈喂回模型 (Agentless arXiv:2407.01489 的
// validation 阶段 / MAST arXiv:2503.13657 的 "task verification" 类)。
//
// 三条硬约束 (决定了这里的写法):
//   1) 确定性、零依赖、快: 只有本地同步读 (fs/stat) + `node --check` 子进程 + RegExp,
//      不调 LLM、不走网络、不加包。检查条数/子进程数/总耗时三重封顶, 无写工具时整段跳过。
//   2) 注册表驱动: CHECK_REGISTRY 一张表把"文件名通配 → 检查"列出来; 写后即时回执与回合闸门
//      共用同一份实现 (jsExportSelfCheck / jsSyntaxOutcome), 不分两套, 不重复逻辑。
//   3) 反馈而非堵墙: 失败文案可行动 (哪条检查/哪个文件/怎么修), 不贴裸 traceback;
//      修正次数有上限 (策略侧 MAX_POSTCHECK_RETRY), 历史只追加不抹改 (失败的那条 assistant
//      消息仍留在 messages 里)。
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toolResultStatus } from "./tool-result.js";
import { debug } from "../utils/logger.js";

const execFileP = promisify(execFile);

// ---- 预算常量 (闸门"快"的三重封顶; config.agent.* 可覆盖, 默认即生效) ----
export const DEFAULT_MAX_CHECKS_PER_TURN = 6;      // 单回合最多跑几条文件检查 (含子进程与否)
export const DEFAULT_MAX_VERIFY_SPAWNS = 3;        // 单回合最多起几个 `node --check` 子进程
export const DEFAULT_TURN_VERIFY_BUDGET_MS = 1500; // 单回合检查总墙钟预算, 超时后剩余检查跳过
export const DEFAULT_SYNTAX_TIMEOUT_MS = 5000;     // 写后回执的单次 `node --check` 超时 (旧值不变)
export const GATE_SYNTAX_TIMEOUT_MS = 2000;        // 回合闸门内的单次超时 (收尾路径要更快)
const READ_MAX_BYTES = 2 * 1024 * 1024;            // 检查里读文件的上限, 超大文件不读 (只 stat)

// ---- 写后自查 (从 src/tools/builtin.js 迁入, 逻辑逐字保持) ----
// 只在 .js/.mjs/.cjs + 内容非空 + 全无导出时给一句提示; 有导出/非 JS/空内容一律 null。
// 只报告, 不门控: 脚本入口本来就可以没有 export, 缺导出不是"磁盘字节不成立", 不进闸门。
const JS_GLOBS = ["*.js", "*.mjs", "*.cjs"];
export const JS_SELF_CHECK_EXT = new Set([".js", ".mjs", ".cjs"]);

export function jsExportSelfCheck(filePath, content) {
  try {
    if (!JS_SELF_CHECK_EXT.has(path.extname(String(filePath || "")).toLowerCase())) return null;
    const s = String(content || "");
    if (!s.trim()) return null;
    if (/\bexport\b/.test(s) || /module\.exports/.test(s) || /\bexports\./.test(s)) return null;
    return "自查: 未发现 export/module.exports — 此文件无法被 import/require 为模块; 若要作为模块请补充导出。";
  } catch { return null; }
}

// `node --check` 语法结论 (唯一实现): { ok, text }。
// text 是给用户/模型看的一行回执, 前缀按 SYNTAX_PASS_TEXT / SYNTAX_FAIL_TEXT 判定,
// 回合闸门复用同一段文字并用前缀还原结论 (回执与闸门同源, 不再起第二个实现)。
export const SYNTAX_PASS_TEXT = "语法通过 (node --check)";
export const SYNTAX_FAIL_TEXT = "语法未通过 (node --check)";

export function defaultSyntaxExec(file, timeoutMs) {
  return execFileP(process.execPath, ["--check", file], { timeout: timeoutMs, windowsHide: true })
    .then(() => ({ ok: true }));
}

export async function jsSyntaxOutcome(absPath, { exec = defaultSyntaxExec, timeoutMs = DEFAULT_SYNTAX_TIMEOUT_MS } = {}) {
  try {
    await exec(absPath, timeoutMs);
    return { ok: true, text: SYNTAX_PASS_TEXT, spawned: true };
  } catch (e) {
    const errLines = String((e && e.stderr) || (e && e.message) || "").split("\n");
    const first = errLines.find((l) => /Error/i.test(l)) || errLines.find((l) => l.trim()) || "解析失败";
    return {
      ok: false,
      text: `${SYNTAX_FAIL_TEXT}: ${first.trim().slice(0, 160)} (若是 ESM 语法而目录未配 type:module, 可能是误报)`,
      spawned: true,
    };
  }
}

// 兼容旧签名 (src/tools/builtin.js 的写后回执一直返回字符串)
export async function jsSyntaxCheck(absPath, opts = {}) {
  return (await jsSyntaxOutcome(absPath, opts)).text;
}

// 回执文字 → 结论 (null = 认不出, 需重跑)
export function syntaxReceiptVerdict(text) {
  const s = String(text || "");
  if (s.startsWith(SYNTAX_PASS_TEXT)) return true;
  if (s.startsWith(SYNTAX_FAIL_TEXT)) return false;
  return null;
}

// ---- 文件名通配 (注册表用; 只支持 * / ? 于 basename, 与 search_files 的 glob 同一口径) ----
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const globCache = new Map();
export function matchGlob(glob, file) {
  let re = globCache.get(glob);
  if (!re) {
    const body = String(glob).split("/").pop(); // "src/*.js" 之类只按文件名匹配
    re = new RegExp("^" + escapeRe(body).replace(/\\\*/g, ".*").replace(/\\\?/g, ".") + "$", "i");
    globCache.set(glob, re);
  }
  return re.test(path.basename(String(file || "")));
}

// ---- 单个检查实现 (统一契约: run(ctx) → null(通过) | string(不成立的说明)) ----
// ctx = { abs, rel, kind, call, content, receipt, exec, timeoutMs }
function existsNonEmptyCheck(ctx) {
  const { abs, rel, call } = ctx;
  let st = null;
  try { st = fs.statSync(abs); } catch { st = null; }
  if (!st) return `${rel}: 声称已写入, 但磁盘上没有这个文件 (exists=false)`;
  if (st.isDirectory()) return null; // 目录目标由工具自身拒绝, 这里不重复裁决
  const claimed = call && call.result && typeof call.result.bytes === "number" ? call.result.bytes : null;
  if (claimed !== null && st.size !== claimed) {
    return `${rel}: 声称写入 ${claimed} 字节, 磁盘实际 ${st.size} 字节 — 落盘与回执不一致`;
  }
  const wanted = call && typeof call.args && typeof call.args.content === "string" ? Buffer.byteLength(call.args.content) : 0;
  if (wanted > 0 && st.size === 0) return `${rel}: 声称写入 ${wanted} 字节, 磁盘是 0 字节 (内容为空)`;
  return null;
}

function deletedCheck(ctx) {
  const { abs, rel } = ctx;
  try {
    if (fs.existsSync(abs)) return `${rel}: 声称已删除, 但文件仍在磁盘上`;
  } catch { return null; }
  return null;
}

async function jsSyntaxCheckEntry(ctx) {
  // 成本封顶: 该文件的最后一次写入若已带回语法回执, 且回执之后再没有别的改动碰过它,
  // 就直接采信回执 (零子进程); 否则按当前磁盘字节重跑一次 node --check。
  if (ctx.reuseReceipt) {
    const v = syntaxReceiptVerdict(ctx.receipt);
    if (v === true) return null;
    if (v === false) return `${ctx.rel}: ${String(ctx.receipt).slice(0, 200)}`;
  }
  const r = await jsSyntaxOutcome(ctx.abs, {
    exec: ctx.exec,
    timeoutMs: ctx.timeoutMs,
  });
  if (r.ok) return null;
  return `${ctx.rel}: ${r.text}`;
}

function jsonParseCheck(ctx) {
  const { abs, rel } = ctx;
  let st;
  try { st = fs.statSync(abs); } catch { return null; } // 不存在由 exists 条目报, 不重复
  if (!st || st.isDirectory() || st.size === 0 || st.size > READ_MAX_BYTES) return null;
  let text;
  try { text = fs.readFileSync(abs, "utf8"); } catch { return null; }
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    return `${rel}: JSON 无法解析 — ${String(e.message || e).slice(0, 140)} (整份文件不是合法 JSON)`;
  }
}

function jsExportNoteEntry(ctx) {
  let text;
  try {
    const st = fs.statSync(ctx.abs);
    if (!st || st.isDirectory() || st.size > READ_MAX_BYTES) return null;
    text = fs.readFileSync(ctx.abs, "utf8");
  } catch { return null; }
  return jsExportSelfCheck(ctx.abs, text);
}

// ---- 检查注册表: 文件名通配 → 检查 (加一类文件 = 加一行, 不动闸门主逻辑) ----
// gating:true  = 磁盘字节站不住 → 拒绝收尾 (可行动反馈喂回模型)
// gating:false = 只作说明 (回合内不拦), 与写后即时回执共用同一实现
export const CHECK_REGISTRY = [
  { id: "file-on-disk", globs: ["*"], kind: "write", gating: true, run: existsNonEmptyCheck },
  { id: "js-node-check", globs: JS_GLOBS, kind: "write", gating: true, run: jsSyntaxCheckEntry },
  { id: "json-parse", globs: ["*.json"], kind: "write", gating: true, run: jsonParseCheck },
  { id: "js-export-note", globs: JS_GLOBS, kind: "write", gating: false, run: jsExportNoteEntry },
  { id: "file-removed", globs: ["*"], kind: "delete", gating: true, run: deletedCheck },
];

export function checksFor(fileName, kind) {
  return CHECK_REGISTRY.filter((e) =>
    (e.kind === "any" || e.kind === kind) && e.globs.some((g) => matchGlob(g, fileName)));
}

// ---- 哪些工具算"碰过文件" / "有落盘证据" ----
// 只认声明与名单两道, 不靠"猜工具语义": 未声明能力且名字不在任何名单里的工具, 只有在它带
// path 类参数时才按写入候选处理 (检查只是读盘 + node --check, 最坏是多做一次确定性核对)。
export const READ_ONLY_TOOLS = new Set([
  "read_file", "list_dir", "search_files", "read_image", "ocr_image", "read_document",
  "repo_map", "repo_wiki", "review_code", "web_search", "fetch_page", "http_request",
  "memory_search", "memory_list_deleted", "memory_export", "persona_read", "persona_build",
  "get_time", "list_capabilities", "list_schedules", "replay_session", "usage_stats",
  "self_diagnose", "skill_search", "load_skill", "scene_list", "vad_detect", "audit_verify",
  "git_status", "git_diff", "git_log", "clarify", "notify", "voice_speak", "voice_transcribe",
]);
// 无 path 参数但确实能改盘的执行类工具 (它们的写入无法按文件归因)
export const EXEC_TOOLS = new Set(["run_command", "code_act", "code_run", "shell", "exec", "bash", "spawn_agent"]);
export const DELETE_TOOLS = new Set(["delete_file", "remove_file", "rm_file"]);
const PATH_ARG_KEYS = ["path", "file_path", "filepath", "file", "filename", "target", "destination", "dest", "save_path"];
const CONTENT_ARG_KEYS = ["content", "text", "body", "data", "new_string", "replacement", "append"];

function isErrorResult(result) {
  const s = String(result == null ? "" : result);
  if (!s) return true;
  return !toolResultStatus(result).ok;
}

function parseResult(result) {
  const s = String(result == null ? "" : result);
  if (!s.startsWith("{")) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function isReadOnly(name, cap) {
  if (READ_ONLY_TOOLS.has(name)) return true;
  if (cap && (cap.readOnly === true || cap.sideEffect === "none")) return true;
  return false;
}

function pathArgsOf(args) {
  const out = [];
  if (!args || typeof args !== "object") return out;
  for (const k of PATH_ARG_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  return out;
}

function hasContentArg(args) {
  if (!args || typeof args !== "object") return false;
  return CONTENT_ARG_KEYS.some((k) => typeof args[k] === "string" && args[k].trim());
}

// 从一次成功的写入回执里抽出它碰过的文件 (apply_patch 的目标藏在 content 里, 只有结果里
// 的 results[].file 才是权威落点; write_file 用 args.path)
function resultFilesOf(obj) {
  const out = [];
  if (!obj || typeof obj !== "object") return out;
  if (typeof obj.file === "string" && obj.file) out.push(obj.file);
  for (const key of ["files", "paths"]) {
    const v = obj[key];
    if (Array.isArray(v)) for (const p of v) if (typeof p === "string" && p) out.push(p);
  }
  if (Array.isArray(obj.results)) {
    for (const r of obj.results) if (r && typeof r.file === "string" && r.file) out.push(r.file);
  }
  return out;
}

// 工作区包含判断 (与 builtin.safePath 同一不变量, 但不 import 它: 避免 tools↔verify 环)
const IS_WIN = process.platform === "win32";
function cmpPath(p) {
  const s = String(p);
  return IS_WIN ? s.toLowerCase().replace(/[\\/]+/g, "/") : s;
}
function isInside(child, parent) {
  const a = cmpPath(child);
  const b = cmpPath(parent);
  if (a === b) return true;
  return a.startsWith(b.endsWith("/") ? b : b + "/");
}
function resolveInRoot(rootDir, p) {
  const abs = path.resolve(rootDir, String(p));
  if (!isInside(abs, path.resolve(rootDir))) return null; // 越界路径不检查 (工具层已拒绝)
  return abs;
}

// ---- 回合账本用的"调用摘要" (内存护栏) ----
// 闸门需要的是回执里的几个字段 (bytes/syntax/file...), 不需要整份工具结果 —— 而结果原文
// 最大能到几百 KB (read_file / run_command)。20 并发 × 8 轮全存原文会把压测的堆吃穿,
// 所以入队前先蒸馏成一小段 JSON。蒸馏后仍以字符串形态保存, 下游 parseResult/isErrorResult 照旧。
const DISTILL_KEYS = ["ok", "error", "bytes", "file", "deleted", "syntax", "selfcheck", "path"];
const DISTILL_ARRAYS = ["files", "paths"];
export function distillTurnResult(result, maxText = 600) {
  const s = String(result == null ? "" : result);
  if (!s.startsWith("{")) return s.length > maxText ? s.slice(0, maxText) : s;
  let o = null;
  try { o = JSON.parse(s); } catch { return s.length > maxText ? s.slice(0, maxText) : s; }
  if (!o || typeof o !== "object") return s.slice(0, maxText);
  const out = {};
  for (const k of DISTILL_KEYS) {
    const v = o[k];
    if (v !== undefined && (v === null || typeof v !== "object")) out[k] = typeof v === "string" ? v.slice(0, 240) : v;
  }
  for (const k of DISTILL_ARRAYS) {
    if (Array.isArray(o[k])) out[k] = o[k].filter((x) => typeof x === "string").slice(0, 16);
  }
  if (Array.isArray(o.results)) {
    out.results = o.results.slice(0, 16).map((r) => (r && typeof r === "object" && typeof r.file === "string" ? { file: r.file } : {}));
  }
  return JSON.stringify(out);
}

// ---- 从本回合的工具调用序列归因出"被改过的文件" (回合闸门唯一的文件清单来源) ----
// calls: [{ name, args, result }] 按发生顺序
// 返回 { files: [...], mutationEvidence, touchedCount }
//   mutationEvidence 的含义刻意收窄为"**工作区字节可能变过**":
//     成功的路径类写调用, 或成功的执行类调用 (run_command/code_act 能改盘但改的是哪个文件
//     无法按调用归因)。memory_add / goal_board 这类"非文件副作用"不算证据 —— 否则模型只记
//     一条记忆就能给"我已改好 utils.js"这种无落盘声称放行。
export function collectTurnFiles(calls, { rootDir, capabilityOf = null } = {}) {
  const list = Array.isArray(calls) ? calls : [];
  const lastByFile = new Map();
  let lastExecIndex = -1;
  let mutationEvidence = false;

  list.forEach((c, i) => {
    const name = String(c && c.name || "");
    const cap = capabilityOf ? safeCap(capabilityOf, name) : null;
    const readOnly = isReadOnly(name, cap);
    const failed = c?.status && typeof c.status.ok === "boolean" ? !c.status.ok : isErrorResult(c && c.result);
    const obj = parseResult(c && c.result);
    const exec = EXEC_TOOLS.has(name) || (!!cap && cap.sideEffect === "system" && !readOnly);
    if (exec) lastExecIndex = i;
    if (readOnly || failed) return;

    const paths = pathArgsOf(c.args).concat(resultFilesOf(obj));
    if (!paths.length) {
      // 无路径可归因, 但执行类工具确实跑成功了 → 算落盘证据 (只是不知道改了哪个文件)
      if (exec) mutationEvidence = true;
      return;
    }
    const kind = DELETE_TOOLS.has(name) || (obj && typeof obj.deleted === "string") ? "delete" : "write";
    let inRoot = false;
    for (const raw of paths) {
      const abs = resolveInRoot(rootDir, raw);
      if (!abs) continue;
      inRoot = true;
      lastByFile.set(abs, {
        abs,
        rel: path.relative(rootDir, abs).split(path.sep).join("/"),
        kind,
        call: { name, args: c.args, result: obj },
        index: i,
        receipt: obj && typeof obj.syntax === "string" ? obj.syntax : null,
      });
    }
    // 只有落在工作区内的路径才算"工作区字节变过"。越界路径 (工具层本就该拒绝) 不能反过来
    // 给"我已改好 utils.js"这种声称提供证据 —— 否则伪造一条 out-of-root 回执就能洗白声称。
    if (inRoot) mutationEvidence = true;
  });

  const files = [...lastByFile.values()];
  for (const f of files) {
    // 回执之后若还有执行类调用 (run_command/code_act) 碰过工作区, 那次写入的回执就不代表
    // 当前字节了 → 重跑检查 (诚实优先于省一次子进程)
    f.receiptReusable = !!(f.receipt && f.index > lastExecIndex);
  }
  return { files, mutationEvidence, touchedCount: files.length };
}

function safeCap(capabilityOf, name) {
  try { return capabilityOf(name); } catch { return null; }
}

// ---- 完成声称 vs 落盘证据 (真跑复盘的第 (2) 类: 贴了代码块就答"已修复") ----
// 判定完全确定性: 三个条件同时成立才算"无证据的完成声称"
//   a) 本轮没有任何写类/执行类调用成功 (mutationEvidence=false)
//   b) 终稿里出现"写入/创建/修改/替换/删除/导出…"式的完成动词 **且** 点名了一个带扩展名的文件
//   c) 用户本轮任务本身要求改文件 (否则纯问答里提到文件名很常见, 不该拦)
const CLAIM_ZH = /(写入|写进|写到|已写|已经写|创建|新建|建好|保存|存为|生成(了)?(新)?文件|修改|改动|改好|改完|改掉|替换|重命名|改名|导出|修复|修好|补上|加上|删除|删掉|移除|落地|实现(了)?)/;
const CLAIM_EN = /\b(wrote|written|created|saved|updated|fixed|replaced|renamed|exported|deleted|removed|implemented|patched)\b/i;
const FILE_TOKEN_RE = /[\w.\-\/\\]+\.(?:js|mjs|cjs|json|ts|tsx|jsx|py|go|rs|java|sh|md|txt|html|css|ya?ml|toml|ini|csv|xml|sql)\b/i;
const MUTATION_REQUEST_ZH = /(写|添加|新增|创建|建|保存|存|修改|改|替换|重命名|改名|删除|删|移除|修复|修|实现|补|导出|生成)/;
const MUTATION_REQUEST_EN = /\b(write|add|create|save|modify|change|replace|rename|delete|remove|fix|implement|export|patch|update)\b/i;

export function looksLikeMutationRequest(userMessage) {
  const s = String(userMessage || "");
  return MUTATION_REQUEST_ZH.test(s) || MUTATION_REQUEST_EN.test(s);
}

export function extractClaimedFiles(text) {
  const s = String(text || "");
  const out = [];
  const re = new RegExp(FILE_TOKEN_RE.source, "gi");
  let m;
  while ((m = re.exec(s)) && out.length < 8) {
    const tok = m[0];
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

// 返回 failure 条目或 null
export function checkClaimEvidence({ finalMessage, userMessage, mutationEvidence, rootDir }) {
  if (mutationEvidence) return null;
  const draft = String(finalMessage || "");
  if (!draft.trim()) return null;
  if (!CLAIM_ZH.test(draft) && !CLAIM_EN.test(draft)) return null;
  const tokens = extractClaimedFiles(draft);
  if (!tokens.length) return null;
  if (!looksLikeMutationRequest(userMessage)) return null;

  const missing = [];
  for (const tok of tokens) {
    if (!rootDir) continue;
    const abs = resolveInRoot(rootDir, tok);
    if (!abs) continue;
    let exists = false;
    try { exists = fs.existsSync(abs); } catch { exists = false; }
    if (!exists) missing.push(tok);
  }
  const tail = missing.length
    ? `并且点名的 ${missing.join(", ")} 在磁盘上根本不存在。`
    : "而磁盘状态没有任何写入回执可依据。";
  return {
    id: "claim-without-write",
    file: null,
    gating: true,
    message: `本轮没有任何成功的写类工具调用 (write_file / apply_patch / append_file / run_command 等一个都没有), ` +
      `但回复声称已对 ${tokens.slice(0, 4).join(", ")} 完成修改 — ${tail}` +
      `只在回复里贴代码不等于已落盘。`,
  };
}

// ---- 行数声称 vs 磁盘内容 (真跑复盘的第 (3) 类: 没读过文件就答"共 1 行") ----
// 只认"总数"句式 (共/总计/一共有 N 行 / has N lines), 并且:
//   · 紧邻前文出现"改动/新增/删除…"这类差分语境时跳过 —— "本次改动共 3 行"说的是 diff 不是文件;
//   · 终稿点名的现存工作区文件必须**恰好一个**, 多个就放弃判定 (宁可不判, 不猜对象);
//   · 文件读不到/超 2MB 一律不判。
// 判定纯本地: 读一次字节 + 数一次分隔符, 零子进程。错了就给磁盘真值, 可行动。
const LINE_TOTAL_ZH = /(?:共|总计|总共|一共有|共有)\s*(\d+)\s*(?:行|个行)/g;
const LINE_TOTAL_EN = /\b(?:has|contains|of|total)\s+(\d+)\s+lines\b|\b(\d+)\s+lines\s+(?:in\s+total|total)\b/gi;
const DIFF_CONTEXT = /(改动|变更|新增|增加|减少|删除|修改|补|diff|patch)/i;

export function extractLineTotalClaims(text) {
  const s = String(text || "");
  const out = [];
  for (const re of [new RegExp(LINE_TOTAL_ZH.source, "g"), new RegExp(LINE_TOTAL_EN.source, "gi")]) {
    let m;
    while ((m = re.exec(s))) {
      const back = s.slice(Math.max(0, m.index - 10), m.index);
      if (DIFF_CONTEXT.test(back)) continue; // 差分语境: 数字描述的是改动量不是文件行数
      const n = Number(m[1] || m[2]);
      if (Number.isFinite(n) && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

// 与 `wc -l` 同口径的文本行数: 以 \r?\n 分隔, 末行仅为换行时不计空行
export function countDiskLines(content) {
  const parts = String(content).split(/\r?\n/);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

export function checkLineTotalClaim({ finalMessage, rootDir }) {
  const draft = String(finalMessage || "");
  if (!draft.trim() || !rootDir) return null;
  const counts = extractLineTotalClaims(draft);
  if (!counts.length) return null;
  const present = [];
  for (const tok of extractClaimedFiles(draft)) {
    const abs = resolveInRoot(rootDir, tok);
    if (!abs) continue;
    let st = null;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st || !st.isFile() || st.size > READ_MAX_BYTES) continue;
    present.push({ tok, abs });
  }
  if (present.length !== 1) return null; // 对象不明确 → 不判
  const { tok, abs } = present[0];
  let content = "";
  try { content = fs.readFileSync(abs, "utf8"); } catch { return null; }
  const real = countDiskLines(content);
  const wrong = counts.filter((n) => n !== real);
  if (!wrong.length) return null;
  return {
    id: "claim-vs-disk-lines",
    file: tok,
    gating: true,
    message: `回复说 ${tok} ${wrong.join("/")} 行, 但磁盘当前是 ${real} 行 — 这个数字没有任何读取/写入依据。`,
  };
}

// ---- 回合后置条件主入口 ----// 返回 { ran, spawns, skipped, failures, notes, claimFailures, ms, checked }
//   failures: 需要门控的确定性失败 (含 claim-without-write)
//   notes:    只说明不门控 (如缺 export)
export async function runPostChecks({
  rootDir,
  calls = [],
  finalMessage = "",
  userMessage = "",
  capabilityOf = null,
  exec = defaultSyntaxExec,
  maxChecks = DEFAULT_MAX_CHECKS_PER_TURN,
  maxSpawns = DEFAULT_MAX_VERIFY_SPAWNS,
  budgetMs = DEFAULT_TURN_VERIFY_BUDGET_MS,
  syntaxTimeoutMs = GATE_SYNTAX_TIMEOUT_MS,
  checkClaim = true,
  checkLines = true,
  now = () => Date.now(),
} = {}) {
  const t0 = now();
  const failures = [];
  const notes = [];
  let ran = 0;
  let spawns = 0;
  let skipped = 0;

  const touched = rootDir ? collectTurnFiles(calls, { rootDir, capabilityOf }) : { files: [], mutationEvidence: false };

  // 成本护栏 1: 本轮没有任何文件被写类工具碰过 → 文件检查整段跳过 (零 spawn / 零读盘)
  if (touched.files.length) {
    for (const file of touched.files) {
      const entries = checksFor(file.abs, file.kind);
      for (const entry of entries) {
        // 成本护栏 2/3: 条数封顶 + 子进程封顶 + 墙钟预算
        if (ran >= maxChecks) { skipped++; continue; }
        const needsSpawn = entry.id === "js-node-check" && !file.receiptReusable;
        if (needsSpawn && spawns >= maxSpawns) { skipped++; continue; }
        if (now() - t0 > budgetMs) { skipped++; continue; }
        ran++;
        if (needsSpawn) spawns++;
        let msg = null;
        try {
          msg = await entry.run({
            abs: file.abs,
            rel: file.rel,
            kind: file.kind,
            call: file.call,
            receipt: file.receipt,
            reuseReceipt: file.receiptReusable,
            exec,
            timeoutMs: syntaxTimeoutMs,
          });
        } catch (e) {
          debug(`[verify/postcondition] 检查 ${entry.id} 异常跳过: ${e && e.message ? e.message : e}`);
          continue; // 检查自身故障绝不拦轮 (闸门失效好过误杀)
        }
        if (!msg) continue;
        (entry.gating ? failures : notes).push({ id: entry.id, file: file.rel, gating: entry.gating, message: String(msg) });
      }
    }
  }

  // 完成声称核对 (纯 RegExp + 至多几次 existsSync, 不起子进程)
  let claimFailures = [];
  if (checkClaim && rootDir) {
    const f = checkClaimEvidence({
      finalMessage,
      userMessage,
      mutationEvidence: touched.mutationEvidence,
      rootDir,
    });
    if (f) { claimFailures.push(f); failures.push(f); }
  }
  // 行数声称核对 (复盘第 (3) 类: 一次读请求都没发就答"共 1 行")
  // 与写类检查相互独立: 本轮纯只读也要能发现"数字与磁盘不符"。仍受同一墙钟预算约束。
  if (checkLines && rootDir && now() - t0 <= budgetMs) {
    try {
      const lf = checkLineTotalClaim({ finalMessage, rootDir });
      if (lf) { claimFailures.push(lf); failures.push(lf); }
    } catch (e) {
      debug(`[verify/postcondition] 行数核对异常跳过: ${e && e.message ? e.message : e}`);
    }
  }

  const ms = now() - t0;
  const stats = { ran, spawns, skipped, checked: touched.files.length, ms };
  bumpStats({ runs: 1, checks: ran, spawns, failures: failures.length, claims: claimFailures.length });
  return { ...stats, failures, notes, claimFailures, mutationEvidence: touched.mutationEvidence, files: touched.files };
}

// ---- 只读观测计数 (供测试与 self_diagnose 断言"无写工具时零检查/零 spawn") ----
const STATS = { runs: 0, checks: 0, spawns: 0, failures: 0, claims: 0 };
export function verifyStats() {
  return Object.freeze({ ...STATS });
}
function bumpStats(d) {
  for (const [k, v] of Object.entries(d)) STATS[k] = (STATS[k] || 0) + (Number(v) || 0);
}

// ---- 反馈文案 (可行动, 不贴裸 traceback; 走既有 steering 通道注入, 不进 system prompt) ----
export function buildVerifyFeedback({ failures = [], notes = [], attempt = 1, max = 1 }) {
  const lines = failures.map((f) => `- [${f.id}] ${f.message}`);
  const noteLines = notes.map((n) => `- [${n.id}] ${n.message}`);
  return `[后置校验未通过] 本轮结束前 harness 自己跑了确定性检查, 下列结论与磁盘字节不符 (第 ${attempt}/${max} 次修正机会):
${lines.join("\n")}
请二选一, 不要原样重复上一条回复:
1) 真的把它改对 — 用 write_file/apply_patch 修正上述文件后重新作答;
2) 确实不需要改文件 — 如实说明"未做修改"以及原因, 不要用完成式措辞。
${noteLines.length ? "另 (只提示, 不拦): \n" + noteLines.join("\n") : ""}`.replace(/\n\n+/g, "\n");
}

// 修正机会用尽后的用户可见文案 (规则: 没有哪个工具可以宣称自己证明不了的成功)
export function formatGateFailure({ failures = [], notes = [], attempts = 0, draft = "" }) {
  const lines = failures.map((f) => `- [${f.id}] ${f.message}`);
  return `[后置校验未通过 × ${failures.length} 项, 已给 ${attempts} 次修正机会] 本轮的"已完成"不成立, 请勿当作交付:
${lines.join("\n")}

以下是模型本轮的回复原文 (未经上述校验, 仅供参照):
${String(draft || "(无回复内容)").trim()}`;
}
