// src/edit/editblock.js — aider 风格 SEARCH/REPLACE 编辑块
// 解析 LLM 输出的编辑块, 应用 (精确/去首尾空行/模糊匹配), 生成回灌提示。
// 纯 Node、零依赖、ESM。

import { strict as assert } from "node:assert";

// ---- 解析: 容错处理围栏/冒号/反引号/多块 ----
// 块格式:
//   <<<<<<< SEARCH
//   [path/to/file.js]
//   旧代码
//   =======
//   新代码
//   >>>>>>> REPLACE
export function parseEditBlocks(text) {
  const blocks = [];
  const lines = String(text || "").split(/\r?\n/);
  let state = "seek"; // seek | path | search | replace
  let cur = null;

  const trimFence = (s) => s.replace(/^`+|`+$/g, "").trim();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = trimFence(raw);

    if (state === "seek") {
      if (/^<{5,}\s*SEARCH/i.test(line)) {
        cur = { path: null, search: "", replace: "" };
        state = "path";
      }
      continue;
    }

    if (state === "path") {
      // SEARCH 之后那一行「可能是」路径, 也可能直接就是 search 正文的第一行。
      // 2026-10-10 修复: 原实现无条件把它当路径吃掉 —— 而工具描述教的正是
      //   「无路径的普通 SEARCH/REPLACE 形式」, 于是首行代码被吞、search 恒空、
      //   apply_patch 实际不可用 (且权限层据此判"无落点"升级 ask, headless 直接拒)。
      // 现与 resolvePatchTargets / 权限层共用同一判据 looksLikePath: 像路径才消费,
      //   不像路径则本行回落为 search 正文首行 (不 continue, 继续走下面的 search 分支)。
      state = "search";
      if (looksLikePath(line)) {
        cur.path = line.replace(/[\[\]`]/g, "").replace(/^[\s:]+|[\s:]+$/g, "").trim() || null;
        continue;
      }
      cur.path = null; // 显式归零, 交由调用方用 args.path / codex 表头补落点
    }

    if (state === "search") {
      if (/^={5,}/.test(line)) {
        state = "replace";
        continue;
      }
      if (/^>{5,}/.test(line)) {
        // 异常: 缺少 divider, 放弃当前块
        cur = null;
        state = "seek";
        continue;
      }
      cur.search += (cur.search ? "\n" : "") + raw;
      continue;
    }

    if (state === "replace") {
      if (/^>{5,}/.test(line)) {
        blocks.push(finalize(cur));
        cur = null;
        state = "seek";
        continue;
      }
      cur.replace += (cur.replace ? "\n" : "") + raw;
      continue;
    }
  }
  return blocks;
}

function finalize(block) {
  return { path: block.path, search: block.search, replace: block.replace };
}

// ---- 工具函数 ----
function stripEdgeBlanks(s) {
  const lines = String(s).split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n");
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let c = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    c++;
    i += needle.length;
  }
  return c;
}

function shortPreview(s) {
  const one = String(s).replace(/\n/g, " ").slice(0, 40);
  return one + (String(s).length > 40 ? "…" : "");
}

// 模糊匹配计划: 按行 trim 后逐行滑动窗口, 统计命中次数并给出替换方案
function fuzzyPlan(content, search, replace) {
  const cLines = content.split("\n");
  const sLines = search.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (sLines.length === 0) return null;
  const n = sLines.length;
  let first = null;
  let count = 0;
  for (let i = 0; i + n <= cLines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (cLines[i + j].trim() !== sLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      count++;
      if (first === null) first = i;
    }
  }
  if (count === 0) return null;
  return { start: first, n, repLines: replace.split("\n"), count };
}

function applyFuzzy(content, plan) {
  const cLines = content.split("\n");
  const out = cLines
    .slice(0, plan.start)
    .concat(plan.repLines, cLines.slice(plan.start + plan.n));
  return out.join("\n");
}

// ---- 最佳匹配窗口诊断 (2026-10-02 深度优化) ----
// not-found 时在文件里找"最像 SEARCH 的区域", 给出行号+相似度, 喂回 LLM 精准自修正,
// 替代原先"未找到+首尾20行"的瞎蒙模式。
// 逐行比较: 相等=1 分, 一方包含另一方=0.6 分 (容忍空格/标点微差), 空白行跳过。
function bestMatchWindow(content, search) {
  const cLines = String(content).split("\n");
  const sLines = String(search).split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (!sLines.length || !cLines.length) return null;
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ");
  const sNorm = sLines.map(norm);
  let best = null;
  for (let i = 0; i + sLines.length <= cLines.length; i++) {
    let hit = 0;
    for (let j = 0; j < sLines.length; j++) {
      const a = norm(cLines[i + j]);
      if (!a && !sNorm[j]) { hit += 1; continue; }
      if (a === sNorm[j]) hit += 1;
      else if (a && (a.includes(sNorm[j]) || sNorm[j].includes(a))) hit += 0.6;
    }
    const score = hit / sLines.length;
    if (!best || score > best.score) best = { line: i + 1, score };
    if (best.score === 1) break;
  }
  return best && best.score >= 0.3 ? best : null;
}

// ---- 应用单个块 ----
// 返回 { ok, content, matched, kind, error?, search }
export function applyEditBlock(content, block, { fuzzy = true } = {}) {
  const search = block.search ?? "";
  const replace = block.replace ?? "";
  const result = { ok: false, content, matched: false, kind: "none", search };

  if (!search) {
    result.error = "搜索内容为空 (empty)";
    result.kind = "empty";
    return result;
  }

  const candidates = [{ s: search, r: replace, kind: "exact" }];
  const s2 = stripEdgeBlanks(search);
  if (s2 && s2 !== search) {
    candidates.push({ s: s2, r: stripEdgeBlanks(replace), kind: "edge-trim" });
  }
  if (fuzzy) {
    const f = fuzzyPlan(content, search, replace);
    if (f) candidates.push({ s: null, r: null, kind: "fuzzy", plan: f });
  }

  for (const c of candidates) {
    if (c.kind === "fuzzy") {
      if (c.plan.count > 1) {
        result.kind = "ambiguous";
        result.error = `多处命中 (ambiguous): ${shortPreview(search)}`;
        return result;
      }
      result.ok = true;
      result.matched = true;
      result.kind = "fuzzy";
      result.content = applyFuzzy(content, c.plan);
      return result;
    }
    const count = countOccurrences(content, c.s);
    if (count === 0) continue;
    if (count > 1) {
      result.kind = "ambiguous";
      result.error = `多处命中 (ambiguous): ${shortPreview(c.s)}`;
      return result;
    }
    result.ok = true;
    result.matched = true;
    result.kind = c.kind;
    result.content = content.replace(c.s, c.r);
    return result;
  }

  result.kind = "not-found";
  result.error = `未找到匹配 (not-found): ${shortPreview(search)}`;
  const hint = bestMatchWindow(content, search);
  if (hint) {
    result.hint = hint;
    result.error += ` — 最接近的位置在第 ${hint.line} 行附近 (相似度 ${Math.round(hint.score * 100)}%), 请对照该区域修正 SEARCH 块`;
  }
  return result;
}

// ---- 顺序应用全部块 ----
export function applyAll(content, blocks) {
  const results = [];
  let cur = content;
  for (const b of blocks) {
    const r = applyEditBlock(cur, b);
    results.push({ path: b.path, ...r });
    if (r.ok) cur = r.content;
    // 失败的块保留原内容继续, 由回灌循环修正
  }
  return { ok: results.every((r) => r.ok), content: cur, results };
}

// ---- 生成回灌 LLM 的失败块修复提示 (aider 回灌循环) ----
// 2026-10-02: 失败块附最佳匹配区域摘录 (±5 行), LLM 拿着原文改 SEARCH, 不再瞎蒙
export function formatRetryFeedback(results, fileContent = "") {
  const failed = (results || []).filter((r) => !r.ok);
  if (failed.length === 0) return "";

  const out = [];
  out.push("以下编辑块应用失败, 请根据当前文件内容修正后重试 (SEARCH 块必须精确匹配现有内容):");
  const fl = String(fileContent || "").split("\n");
  for (const f of failed) {
    out.push(`- 文件 ${f.path || "(未知)"} 失败类型=${f.kind}: ${f.error || ""}`);
    if (f.search) {
      out.push("  原 SEARCH 预览: " + shortPreview(f.search));
    }
    // 带上最像 SEARCH 的原文区域 (±5 行), LLM 照着改即可命中
    if (f.hint && fl.length) {
      const lo = Math.max(0, f.hint.line - 6);
      const hi = Math.min(fl.length, f.hint.line - 1 + 5 + 1);
      out.push(`  当前文件第 ${lo + 1}-${hi} 行 (最接近 SEARCH 的区域):`);
      out.push(fl.slice(lo, hi).map((l, i) => `  ${lo + i + 1} | ${l}`).join("\n"));
    }
  }
  if (fileContent && !failed.some((f) => f.hint)) {
    out.push("== 文件前 20 行 ==");
    out.push(fl.slice(0, 20).join("\n"));
    if (fl.length > 20) {
      out.push("== 文件后 20 行 ==");
      out.push(fl.slice(-20).join("\n"));
    }
  }
  return out.join("\n");
}

// 供测试断言一致性 (非公开 API 也导出以便内部复用验证)
export const __internal = { stripEdgeBlanks, countOccurrences, fuzzyPlan };

// ================= codex 风格统一 diff 解析 (2026-10-09 补) =================
// 背景: 工具描述只教 SEARCH/REPLACE 两种写法, 但模型实测还会吐 codex 风格:
//   *** Begin Patch / *** Update File: 路径 / @@ / -旧行 +新行 / *** End Patch
// 旧行为是"解出 0 块 → 权限层证明不了落点 → 升级 ask → headless 直接拒",
// 而工具那侧只会回一句"未找到任何 SEARCH/REPLACE 块", 模型拿到也无从改写。
// 本函数只做一件事: 把 codex 段还原成【等价 SEARCH/REPLACE 块】, 应用/回滚完全复用既有 SR 主路径。
//
// 刻意不猜的两件事:
//   · Delete File — apply_patch 不承担删除, 交给 delete_file 工具 (避免误删);
//   · Move to     — 移动语义无法用 SR 表达, 猜了就可能改错文件, 整段标为不可应用。

export const PATCH_FORMAT_HELP = [
  "apply_patch 支持两种写法:",
  "A) SEARCH/REPLACE: 首行写文件名, 然后 <<<<<<< SEARCH / ======= / >>>>>>> REPLACE",
  "B) codex: *** Begin Patch / *** Update File: 路径 / @@ / -旧行 +新行 / *** End Patch",
  "删除文件请用 delete_file 工具 (apply_patch 不执行 Delete File)。",
].join("\n");

export const MISSING_TARGET_HELP = [
  "补丁落点无法确定, 因此不能免审批。三种合法写法任选其一:",
  "1) 用 path 参数指定目标文件;",
  "2) 在 <<<<<<< SEARCH 块的【上一行】写明文件名;",
  "3) 用 codex 表头 *** Update File: 文件路径。",
].join("\n");

// 复述"实际收到了什么" —— 空内容与有内容都要说清, 否则模型无从自纠
export function patchTargetPreview(content, maxLines = 2) {
  const s = String(content == null ? "" : content);
  if (!s.trim()) return "(未收到任何 content 文本)";
  return s.split(/\r?\n/).slice(0, maxLines).map((l) => l.trim()).filter(Boolean).join(" / ").slice(0, 160);
}

const CODEX_BEGIN_RE = /^\s*\*{3}\s*Begin Patch\s*$/i;
const CODEX_END_RE = /^\s*\*{3}\s*End Patch\s*$/i;
const CODEX_FILE_RE = /^\s*\*{3}\s*(Update|Add|Delete)\s+File:\s*(.+?)\s*$/i;
const CODEX_MOVE_RE = /^\s*\*{3}\s*Move to:\s*(.+?)\s*$/i;

/**
 * 解析 codex 风格补丁。
 * @returns {{detected:boolean, paths:string[], blocks:Array<{path:string,search:string,replace:string}>, unsupported:Array<{kind:string,path?:string}>}}
 */
export function parseCodexPatch(text) {
  const out = { detected: false, paths: [], blocks: [], unsupported: [] };
  const raw = String(text || "");
  if (!/\*{3}\s*Begin Patch/i.test(raw)) return out;
  out.detected = true;

  const lines = raw.split(/\r?\n/);
  let begin = lines.findIndex((l) => CODEX_BEGIN_RE.test(l));
  if (begin === -1) begin = -1;
  let end = lines.findIndex((l, k) => k > begin && CODEX_END_RE.test(l));
  if (end === -1) end = lines.length;
  const body = lines.slice(begin + 1, end);

  let cur = null;      // { kind, path }
  let hunks = [];      // [[{type,text}]]  当前文件的 hunk
  let curHunk = null;

  const flushHunk = () => { if (curHunk && curHunk.length) hunks.push(curHunk); curHunk = null; };
  const flushFile = () => {
    flushHunk();
    if (cur && cur.kind === "Update") {
      for (const h of hunks) {
        const search = [], replace = [];
        for (const { type, text } of h) {
          if (type === "-") search.push(text);
          else if (type === "+") replace.push(text);
          else { search.push(text); replace.push(text); }   // 上下文行两侧都在
        }
        out.blocks.push({ path: cur.path, search: search.join("\n"), replace: replace.join("\n") });
      }
    } else if (cur && cur.kind === "Add") {
      const added = [];
      for (const h of hunks) for (const { type, text } of h) if (type === "+") added.push(text);
      out.blocks.push({ path: cur.path, search: "", replace: added.join("\n") });
    }
    // Delete / __skip__ (含 Move): 不产出块
    hunks = [];
    curHunk = null;
  };

  for (const line of body) {
    const fm = line.match(CODEX_FILE_RE);
    if (fm) {
      flushFile();
      const kind = fm[1][0].toUpperCase() + fm[1].slice(1).toLowerCase(); // Update / Add / Delete
      cur = { kind, path: fm[2].trim() };
      if (cur.path) out.paths.push(cur.path);
      if (kind === "Delete") out.unsupported.push({ kind: "Delete File", path: cur.path });
      continue;
    }
    const mm = line.match(CODEX_MOVE_RE);
    if (mm) {
      out.unsupported.push({ kind: "Move", path: mm[1].trim() });
      if (cur) cur.kind = "__skip__";   // 移动语义无法用 SR 表达 → 该段整体不应用
      continue;
    }
    if (/^\s*@@/.test(line)) { flushHunk(); curHunk = []; continue; }
    if (/^\\s*No newline at end of file/i.test(line)) continue;
    const c0 = line[0];
    if (c0 === "+" || c0 === "-" || c0 === " ") {
      if (!cur) continue;
      if (!curHunk) curHunk = [];       // 无 @@ 的段 (如 Add File) 自动开一个 hunk
      curHunk.push({ type: c0, text: line.slice(1) });
    }
  }
  flushFile();
  return out;
}

// ---- 补丁落点解析 (2026-10-09 补) ----
// 三种合法写法必须被同等识别, 且绝不能把代码行误当文件名:
//   ① args.path 参数 (调用方显式给) ② <<<<<<< SEARCH 的【上一行】 ③ 块内首行 / codex 表头
// `  return a - b;` 这种代码行含空格与分号, 必须判为"不是路径" —— 否则会去改一个叫
// "return a - b;" 的文件, 或更糟: 权限层据此认为落点可证明而放行。
export function looksLikePath(s) {
  const t = String(s == null ? "" : s).trim().replace(/^[\[\]`"']+|[\[\]`"']+$/g, "");
  if (!t || t.length > 200) return false;
  if (/\s/.test(t)) return false;
  if (/[;=(){}<>|*?"',]/.test(t)) return false;
  // 必须"像文件": 有扩展名或有目录分隔符。
  // 刻意不放过裸词 —— `<<<<<<< SEARCH` 后紧跟的 `old` / `new` 是最常见的误判源,
  // 一旦被当成文件名就会去新建一个叫 old 的文件 (实测复现过), 或让权限层误以为落点可证明。
  return /\.[A-Za-z0-9]+$/.test(t) || /[\\/]/.test(t);
}

/**
 * 为每个 SEARCH/REPLACE 块解析出目标文件。
 * @returns {Array<string|null>} 与 blocks 一一对应, null = 落点不可确定
 */
export function resolvePatchTargets(content, blocks) {
  const text = String(content || "");
  const list = Array.isArray(blocks) ? blocks : parseEditBlocks(text);
  const lines = text.split(/\r?\n/);
  const out = [];
  let cursor = 0;
  for (const b of list) {
    let idx = -1;
    for (let i = cursor; i < lines.length; i++) {
      if (/^<{5,}\s*SEARCH/i.test(lines[i].trim())) { idx = i; break; }
    }
    if (idx === -1) {
      // codex 块 (没有 SEARCH 标记): 直接信块内 path
      out.push(looksLikePath(b && b.path) ? String(b.path).trim() : null);
      continue;
    }
    cursor = idx + 1;
    const inside = String((b && b.path) || "").trim();
    const above = idx > 0 ? lines[idx - 1].trim() : "";
    out.push(looksLikePath(inside) ? inside : (looksLikePath(above) ? above : null));
  }
  return out;
}
