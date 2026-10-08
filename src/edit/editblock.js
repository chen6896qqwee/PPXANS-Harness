// src/edit/editblock.js — aider 风格 SEARCH/REPLACE 编辑块
// 解析 LLM 输出的编辑块, 应用 (精确/去首尾空行/模糊匹配), 生成回灌提示。
// 纯 Node、零依赖、ESM。

// 2026-10-05: assert 全文件零使用, 删除死导入
// ---- 解析: 容错处理围栏/冒号/反引号/多块 ----
// 路径约定三选一, 均合法 (多文件时每块各带各的):
//   a) aider: 文件名在 <<<<<<< SEARCH 的**上一行** (可带 @@@/[]/反引号/冒号装饰)
//   b) 行内: 文件名在 <<<<<<< SEARCH 的**下一行** —— 仅当该行是无空白的"路径形"
//      单行, 且再下一行仍是 SEARCH 内容时才认定; 否则该行按代码处理。
//      旧实现无条件吃掉紧跟标记的行, 普通无路径块的首行代码被当成路径,
//      search 恒空 → apply_patch 全块报 empty, 工具实际不可用 (见 tools/v3.js)。
//   c) 无路径: path=null, 由调用方兜底 (apply_patch 的 args.path)。
export function parseEditBlocks(text) {
  const blocks = [];
  const lines = String(text || "").split(/\r?\n/);
  let state = "seek"; // seek | path | search | replace
  let cur = null;

  const trimFence = (s) => s.replace(/^`+|`+$/g, "").trim();
  const isDivider = (s) => /^={5,}/.test(s);
  const isEndMarker = (s) => /^>{5,}/.test(s);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = trimFence(raw);

    if (state === "seek") {
      if (/^<{5,}\s*SEARCH/i.test(line)) {
        cur = { path: null, search: "", replace: "" };
        // 约定 a: 前一行整行是裸文件名才算路径 (含空白/标记行/散文一律不算, 不吃内容)
        const prev = i > 0 ? cleanPathCandidate(trimFence(lines[i - 1])) : "";
        if (prev && !isMarkerLine(prev) && looksLikePath(prev)) cur.path = prev;
        state = "path";
      }
      continue;
    }

    if (state === "path") {
      // 约定 b: 已有前置路径时不再猜行内路径; 标记行本身不是候选
      if (!cur.path && !isDivider(line) && !isEndMarker(line)) {
        const p = cleanPathCandidate(line);
        const next = lines[i + 1] === undefined ? "" : trimFence(lines[i + 1]);
        // 确定性判据: 消费后 SEARCH 必须还有内容 (next 非分隔/结束行) ——
        // 这保证"普通无路径形式首行代码永远留在 search 里, 良构块 search 非空"。
        if (looksLikePath(p) && next && !isDivider(next) && !isEndMarker(next)) {
          cur.path = p;
          state = "search";
          continue;
        }
      }
      state = "search"; // 本行不是路径行, 原样落入 SEARCH 内容
    }

    if (state === "search") {
      if (isDivider(line)) {
        state = "replace";
        continue;
      }
      if (isEndMarker(line)) {
        // 异常: 缺少 divider, 放弃当前块
        cur = null;
        state = "seek";
        continue;
      }
      cur.search += (cur.search ? "\n" : "") + raw;
      continue;
    }

    if (state === "replace") {
      if (isEndMarker(line)) {
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

// 去装饰: @@@ 前缀 (SWE-agent/OpenHands 风格)、[] 包裹、反引号、首尾冒号/空白
function cleanPathCandidate(s) {
  return String(s)
    .replace(/^@{2,}\s*/, "")
    .replace(/[\[\]`]/g, "")
    .replace(/^[:\s]+|[:\s]+$/g, "")
    .trim();
}

// 确定性"像路径"判据: 整行无空白, 且含路径分隔符或以 .扩展名 结尾。
// 代码行几乎必带空白/括号/运算符, 散文句子同理 —— 误吃只能发生在"整行恰是裸文件名"
// 的固有歧义上, 该形式本来就该走约定 a 或 args.path, 行内约定只是兼容旧格式。
function looksLikePath(p) {
  if (!p || /\s/.test(p)) return false;
  return /[\/\\]/.test(p) || /\.[A-Za-z0-9]{1,8}$/.test(p);
}

function isMarkerLine(s) {
  return /^<{5,}|^={5,}|^>{5,}/i.test(s);
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

// ---- codex/OpenAI 补丁风格 (*** Begin Patch / *** Update File: p / @@ / -旧 +新 / *** End Patch) ----
// 2026-10-05 (真跑基准 rename-symbol 失败复盘): 模型除本文档的两种 SEARCH/REPLACE 写法外,
// 还会吐第三种 —— codex 的统一 diff 风格。旧行为是 parseEditBlocks 解析出 0 块, 于是
//   · 工具报 "未找到任何 SEARCH/REPLACE 块" (模型无法据此改写),
//   · 权限层 collectPatchPaths 证明不了任何落点 → 升级 ask → headless 即拒 ("权限/策略拦截")。
// 本模块内核仍是 SEARCH/REPLACE; 这里只做两件低风险的事, 完全不进 SR 解析路径:
//   (a) 表头路径抽取 (给权限层当落点清单, 含 Delete/Move 段 —— 路径越多只可能更严, 不会更松);
//   (b) 把 Update/Add 段的 @@ 块还原成等价的 SEARCH/REPLACE 块 (前缀行 ' ' 同时进两侧,
//       '-' 只进 SEARCH, '+' 只进 REPLACE), 交回既有 applyAll/快照回滚/回灌提示, 不新写应用逻辑。
// 认不出的段 (Move/Delete/裸正文行) 一律记进 unsupported 并整份拒绝, 不"猜着应用"半个补丁。
const CODEX_HEADER_RE = /^\s*\*{3,}\s*(Begin\s+Patch|End\s+Patch|Update\s+File|Add\s+File|Delete\s+File|Move\s+File|Move\s+to|End\s+of\s+File)\b\s*:?\s*(.*)$/i;

function codexKeyword(head) {
  return String(head || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function parseCodexPatch(text) {
  const raw = String(text || "");
  const out = { detected: false, blocks: [], paths: [], unsupported: [] };
  if (!/\*{3,}\s*(Begin\s+Patch|Update\s+File|Add\s+File|Delete\s+File|Move\s+File)/i.test(raw)) return out;
  out.detected = true;
  const lines = raw.split(/\r?\n/);
  let cur = null; // { path, kind, search: [], replace: [], touched: bool }

  const pushBlock = (c) => {
    if (!c || !c.path) return;
    if (!c.search.length && !c.replace.length) return; // 空 hunk: 没有可应用的落点, 不产垃圾块
    out.blocks.push({ path: c.path, search: c.search.join("\n"), replace: c.replace.join("\n") });
  };
  const flush = () => { if (cur) pushBlock(cur); cur = null; };

  for (const line of lines) {
    const hm = line.match(CODEX_HEADER_RE);
    if (hm) {
      const kw = codexKeyword(hm[1]);
      const rest = cleanPathCandidate(hm[2] || "");
      if (kw === "begin patch") continue;
      if (kw === "end patch" || kw === "end of file") { flush(); continue; }
      if (kw === "update file" || kw === "add file") {
        flush();
        if (!rest) { out.unsupported.push({ kind: "路径缺失", detail: line.trim() }); cur = null; continue; }
        cur = { path: rest, kind: kw === "add file" ? "add" : "update", search: [], replace: [], touched: false };
        out.paths.push(rest);
        continue;
      }
      // Delete / Move: 语义超出本文 (删文件/改文件名), 只登记落点供权限层证明, 不应用
      flush();
      if (rest) out.paths.push(rest);
      out.unsupported.push({ kind: kw === "delete file" ? "Delete File" : "Move", detail: rest || line.trim() });
      cur = null;
      continue;
    }
    if (!cur) continue;
    if (/^\s*(```|~~~)/.test(line)) continue; // 围栏包裹的补丁: 标记行不是正文
    if (/^\s*@@/.test(line)) {
      // 新 hunk: 前一个 hunk 先成块 (hunk 之间不连续, 合并必然 not-found)
      if (cur.touched) pushBlock(cur);
      cur.search = [];
      cur.replace = [];
      continue;
    }
    const c = line[0];
    if (c === "+" || c === "-") {
      (c === "+" ? cur.replace : cur.search).push(line.slice(1));
      cur.touched = true;
      continue;
    }
    if (c === " ") { cur.search.push(line.slice(1)); cur.replace.push(line.slice(1)); cur.touched = true; continue; }
    if (line === "") {
      // 裸空行 = 空上下文行, 但只在 hunk 已开始后才算 (段间空行不能污染 SEARCH)
      if (cur.touched) { cur.search.push(""); cur.replace.push(""); }
      continue;
    }
    out.unsupported.push({ kind: "非补丁行", detail: line.trim().slice(0, 60) });
    cur = null;
  }
  flush();
  if (out.blocks.length) {
    for (const b of out.blocks) if (!out.paths.includes(b.path)) out.paths.push(b.path);
  }
  return out;
}

// 供 apply_patch 与权限层共用的落点清单 (SR 块路径 ∪ codex 表头路径)
export function codexPatchPaths(text) {
  return parseCodexPatch(text).paths;
}

// 支持的补丁格式说明 (工具错误里回灌给模型, 不进 schema 描述 → 不占每请求上下文)
export const PATCH_FORMAT_HELP =
  "apply_patch 支持两种补丁: " +
  "(1) SEARCH/REPLACE 块 —— 可选一行文件名 + `<<<<<<< SEARCH` / 原文(须与文件现有内容逐字一致) / `=======` / 新文 / `>>>>>>> REPLACE`, 可多块多文件, 省略文件名时传 path 参数, 新建文件则 SEARCH 留空; " +
  "(2) codex 风格 `*** Begin Patch` / `*** Update File: 路径` / `@@` / `-旧行` `+新行` / `*** End Patch` (纯新增用 `*** Add File:`)。" +
  "不支持 `*** Delete File:` 与 `*** Move File:`/`*** Move to:` (删除请改用 delete_file 工具)。所有落点都必须在工作区内。";

// 补丁目标无法确定时的可行动错误 (2026-10-05 "已修复"幻觉复盘): 无目标的 SR 块是最高频
// 写法, headless 下权限层 ask→deny 只给一句通用审批文案, 模型不知道错在哪就放弃编造完成。
// 权限层 (permissions/index.js) 与工具 (tools/v3.js) 共用本常量 + patchTargetPreview,
// 保证模型从哪条路拿到的都是"三种合法写法点名 + 实际收到的内容"。
export const MISSING_TARGET_HELP =
  "无法从补丁内容确定目标文件 (拒绝猜测落点)。请三选一: " +
  "(1) 传 path 参数; " +
  "(2) 在 <<<<<<< SEARCH 的上一行写文件名; " +
  "(3) 用 codex 表头 *** Update File: <路径> (在 *** Begin Patch / *** End Patch 内)。";

// 补丁内容前两行摘录 (给错误文案用, 让模型能对照自己实际吐了什么)
export function patchTargetPreview(content, maxLines = 2, maxChars = 160) {
  const s = String(content || "").split(/\r?\n/).slice(0, maxLines).join(" / ").trim();
  if (!s) return "(未收到任何 content 文本)";
  return s.length > maxChars ? s.slice(0, maxChars) + "…" : s;
}
