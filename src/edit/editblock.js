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
      // 第一行即路径 (可能带 [] 或反引号围栏)
      let p = line.replace(/[\[\]`]/g, "").replace(/^[\s:]+|[\s:]+$/g, "").trim();
      cur.path = p || null;
      state = "search";
      continue;
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
export function formatRetryFeedback(results, fileContent = "") {
  const failed = (results || []).filter((r) => !r.ok);
  if (failed.length === 0) return "";

  const out = [];
  out.push("以下编辑块应用失败, 请根据当前文件内容修正后重试 (SEARCH 块必须精确匹配现有内容):");
  for (const f of failed) {
    out.push(`- 文件 ${f.path || "(未知)"} 失败类型=${f.kind}: ${f.error || ""}`);
    if (f.search) {
      out.push("  原 SEARCH 预览: " + shortPreview(f.search));
    }
  }
  if (fileContent) {
    const fl = String(fileContent).split("\n");
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
