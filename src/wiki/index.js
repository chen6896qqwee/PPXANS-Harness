// src/wiki/index.js - 代码库 Wiki 生成器 (2026-10-02 吸收 ZCode Wiki 机制)
// 对齐 ZCode repo-wiki 三要素:
//   1. 每个结论绑定源码位置 (file:line)
//   2. Mermaid 架构/依赖图
//   3. 敏感文件排除 (文件名含 token/secret/credential/password 等一律不读不引)
// 零依赖, 复用 repomap 的扫描与符号索引 (defRecords 已含 file/line/sig)。
import fs from "node:fs";
import path from "node:path";
import { scanRepo, extractSymbols, DEFAULT_IGNORE } from "../repomap/index.js";
import { debug } from "../utils/logger.js";

// 敏感文件名模式 (ZCode Wiki 同款语义): 命中即从 wiki 中排除, 不读不引
export const SENSITIVE_PATTERNS = [
  /token/i, /secret/i, /credential/i, /password/i, /passwd/i,
  /api[-_]?key/i, /\.pem$/i, /\.key$/i, /private[-_]?key/i,
];

export function isSensitiveFile(rel) {
  return SENSITIVE_PATTERNS.some((p) => p.test(path.basename(rel)));
}

// 解析一个 js/ts 文件的内部 import 依赖 (相对路径 → 仓库内文件)
function internalImports(content, rel, root) {
  const out = [];
  const re = /(?:from\s+|require\(\s*|import\s*\(\s*)["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(content))) {
    const spec = m[1];
    if (!spec.startsWith(".")) continue; // 只看相对依赖 (内部模块图)
    try {
      let abs = path.resolve(path.dirname(path.join(root, rel)), spec);
      // 补扩展名 (ESM 无扩展名约定)
      const tries = ["", ".js", ".mjs", ".cjs", ".ts", "/index.js", "/index.ts"];
      const hit = tries.map((t) => abs + t).find((p) => {
        try { return fs.statSync(p).isFile(); } catch { return false; }
      });
      if (!hit) continue;
      const relTo = path.relative(root, hit).split(path.sep).join("/");
      if (relTo && relTo !== rel && !relTo.startsWith("..")) out.push(relTo);
    } catch { /* 解析失败跳过 */ }
  }
  return [...new Set(out)];
}

// 生成 wiki 文本
export function generateWiki(root, opts = {}) {
  const { topPerFile = 5, maxNodes = 40 } = opts;
  const scan = scanRepo(root, { ignore: [...DEFAULT_IGNORE, "test", "tests", "__tests__"] });

  // 敏感文件过滤
  const files = scan.files.filter((f) => !isSensitiveFile(f.rel));
  const skippedSensitive = scan.files.length - files.length;

  // 文件 → 定义列表 (来自 defRecords: name → [{file,line,sig,kind}])
  const defsByFile = new Map(); // rel -> [{name, line, sig, kind}]
  for (const [name, recs] of scan.defRecords) {
    for (const r of recs) {
      if (!defsByFile.has(r.file)) defsByFile.set(r.file, []);
      defsByFile.get(r.file).push({ name, line: r.line, sig: r.sig, kind: r.kind });
    }
  }

  // 内部 import 边 (只读非敏感的 js/ts 文件)
  const edges = new Set();
  const nodeSet = new Set();
  for (const f of files) {
    if (!/\.(js|mjs|cjs|ts)$/.test(f.ext)) continue;
    let content;
    try { content = fs.readFileSync(path.join(root, f.rel), "utf8"); } catch { continue; }
    for (const to of internalImports(content, f.rel, root)) {
      if (isSensitiveFile(to)) continue; // 敏感文件不进图
      edges.add(`${f.rel} -> ${to}`);
      nodeSet.add(f.rel);
      nodeSet.add(to);
    }
  }

  // 渲染
  const L = [];
  const short = (p) => p.replace(/^src\//, "s/").replace(/\.(js|mjs|cjs|ts)$/, "").replace(/[^A-Za-z0-9_]/g, "_");
  L.push(`# ${path.basename(path.resolve(root))} · 代码库 Wiki`);
  L.push("");
  L.push(`> 由皮皮虾自动生成 (ZCode repo-wiki 机制对齐)。每个结论绑定源码位置 (file:line); 敏感文件 (token/secret/credential/password 等) 已排除 ${skippedSensitive} 个。`);
  L.push("");
  L.push(`**规模**: 文件 ${files.length} · 定义 ${[...defsByFile.values()].reduce((s, d) => s + d.length, 0)} · 内部依赖边 ${edges.size}`);
  L.push("");

  // 按目录分组, 每文件列 top 定义 (按引用数排序: 用 refCounts)
  const byDir = new Map();
  for (const f of files) {
    const dir = f.dir;
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(f);
  }
  for (const dir of [...byDir.keys()].sort()) {
    L.push(`## ${dir === "." ? "(根目录)" : dir}`);
    L.push("");
    for (const f of byDir.get(dir).sort((a, b) => a.rel.localeCompare(b.rel))) {
      const defs = (defsByFile.get(f.rel) || [])
        // 噪音过滤 (ZCode wiki 语义: 文档骨架而非全文键值): md 只留一二级标题, json 不进正文
        .filter((d) => {
          if (d.kind === ".json") return false;
          if (d.kind === ".md" && !/^#{1,2} /.test(d.sig || "")) return false;
          return true;
        })
        // 定义类型分级: function/class 是骨架, 裸 const 赋值是噪音 → 降级
        .map((d) => ({ ...d, tier: /^(export\s+)?(async\s+)?(function|class)\b/.test(d.sig || "") ? 0
          : /^(export\s+)?(const|let)\s+\w+\s*=\s*(async\s*)?(\(|function|[A-Za-z])/.test(d.sig || "") ? 1 : 2 }))
        .sort((a, b) => (a.tier - b.tier) || ((scan.refCounts.get(b.name) || 0) - (scan.refCounts.get(a.name) || 0)))
        .slice(0, topPerFile);
      if (!defs.length) continue;
      L.push(`### \`${f.rel}\``);
      L.push("");
      for (const d of defs) {
        L.push(`- \`${d.sig || d.name}\` — ${f.rel}:${d.line}`);
      }
      L.push("");
    }
  }

  // mermaid 依赖图 (节点数限幅)
  if (nodeSet.size) {
    const nodes = [...nodeSet].slice(0, maxNodes);
    const nset = new Set(nodes);
    L.push(`## 模块依赖图 (top ${nodes.length})`);
    L.push("");
    L.push("```mermaid");
    L.push("graph LR");
    for (const e of edges) {
      const [from, to] = e.split(" -> ");
      if (nset.has(from) && nset.has(to)) {
        L.push(`  ${short(from)} --> ${short(to)}`);
      }
    }
    L.push("```");
    L.push("");
  }

  return {
    text: L.join("\n"),
    stats: {
      files: files.length,
      defs: [...defsByFile.values()].reduce((s, d) => s + d.length, 0),
      edges: edges.size,
    },
    sensitiveSkipped: skippedSensitive,
    // ZCode 语义: 代码变化后 wiki 自动标记陈旧 — stale = 源码里最新的 mtime 晚于 wiki 文件
    stale: null, // 由调用方填充 (需要 wiki 文件路径对比)
  };
}

// 陈旧检测: wikiOutPath 不存在 = 从未生成 (stale); 任一源码文件 mtime 更新 = 陈旧
// 返回 { stale: boolean, reason }
export function checkStaleness(wikiOutPath, root) {
  try {
    const wikiMtime = fs.statSync(wikiOutPath).mtimeMs;
    const scan = scanRepo(root, {});
    let newest = 0;
    for (const f of scan.files) {
      try {
        const m = fs.statSync(path.join(root, f.rel)).mtimeMs;
        if (m > newest) newest = m;
      } catch (e) { debug(`[wiki/index] 已忽略异常: ${e && e.message ? e.message : e}`); }
    }
    if (newest > wikiMtime) return { stale: true, reason: "源码在 wiki 生成后有变更" };
    return { stale: false, reason: "wiki 与源码同步" };
  } catch {
    return { stale: true, reason: "wiki 尚未生成" };
  }
}
