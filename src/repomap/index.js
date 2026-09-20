// src/repomap/index.js - 仓库地图 (吸收 aider 思路, 纯 JS 实现, 零依赖)
// 职责: 递归扫描仓库 -> 正则提取 def/ref -> 引用图 -> PageRank 排序 -> token 预算内渲染目录+签名骨架
// 设计目标: 给 LLM 一段"地图", 在长上下文压缩/摘要时保留最重要的定义与引用关系。

import fs from "node:fs";
import path from "node:path";

// 默认跳过的目录 (与既有 .gitignore/构建产物约定一致)
export const DEFAULT_IGNORE = [".git", "node_modules", "dist", "build", ".next", "tmp", "data", ".workbuddy"];

// 参与扫描的扩展名族: js/ts/mjs/cjs/py/md/json/go/java
const SCAN_EXT = [".js", ".mjs", ".cjs", ".ts", ".py", ".md", ".json", ".go", ".java"];

// 常见语言关键字/噪音词, 不作为标识符/定义统计 (避免 if/for/function 等主导 PageRank)
const STOP = new Set([
  "if", "else", "elif", "for", "while", "do", "switch", "case", "default", "break", "continue",
  "function", "return", "class", "const", "let", "var", "new", "await", "async", "yield",
  "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "void", "delete",
  "export", "import", "from", "extends", "implements", "static", "public", "private", "protected",
  "interface", "type", "struct", "enum", "namespace", "using", "package", "func", "def", "go",
  "with", "as", "self", "this", "super", "true", "false", "null", "undefined", "None", "True",
  "False", "print", "console", "log", "warn", "error", "debug", "require", "module", "end",
]);

// 标识符词法 (词边界): 字母/下划线/$ 开头, 后接 字母/数字/_/$
const ID_RE = /\b([A-Za-z_$][\w$]*)\b/g;

// 按扩展名返回"提取定义"的正则列表
function defRegexes(ext) {
  switch (ext) {
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".ts":
      return [
        /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
        /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
        /class\s+([A-Za-z_$][\w$]*)/g,
      ];
    case ".py":
      return [
        /(?:async\s+)?def\s+([A-Za-z_$][\w$]*)/g,
        /class\s+([A-Za-z_$][\w$]*)/g,
      ];
    case ".go":
      return [
        /func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)\s*\(/g,
        /type\s+([A-Za-z_$][\w$]*)\s+/g,
      ];
    case ".java":
      return [
        /class\s+([A-Za-z_$][\w$]*)/g,
        /interface\s+([A-Za-z_$][\w$]*)/g,
        /(?:public|private|protected|static|final|\s)*?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{/g,
      ];
    case ".json":
      return [/"([A-Za-z_$][\w$]*)"\s*:/g];
    default:
      return [];
  }
}

// 从单个文件内容提取 { defs:[{name,line,kind}], refSet:Set, refCounts:Map }
function extractSymbols(content, ext) {
  const lines = content.split(/\r?\n/);
  const defs = [];
  const defLineSet = new Set();
  const defNames = new Set();

  const pushDef = (name, lineNo) => {
    if (!name || STOP.has(name)) return;
    defs.push({ name, line: lineNo, kind: ext });
    defLineSet.add(lineNo);
    defNames.add(name);
  };

  if (ext === ".md") {
    // markdown 标题视为定义节点 (目录锚点)
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^#{1,6}\s+(.+?)\s*#*$/);
      if (m) {
        const name = m[1].trim().toLowerCase().replace(/[^a-z0-9_$]+/g, "_").replace(/^_+|_+$/g, "");
        if (name) pushDef(name, i + 1);
      }
    }
  } else {
    for (const re of defRegexes(ext)) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
          const name = m[1] || m[2] || m[3];
          if (name) pushDef(name, i + 1);
          if (m.index === re.lastIndex) re.lastIndex++; // 防零宽死循环
        }
      }
    }
  }

  // 引用统计: 跳过 def 所在行 (定义自身不计为引用), 词边界统计
  const refSet = new Set();
  const refCounts = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (defLineSet.has(i + 1)) continue; // 跳过定义行
    const line = lines[i];
    let m;
    ID_RE.lastIndex = 0;
    while ((m = ID_RE.exec(line)) !== null) {
      const name = m[1];
      if (STOP.has(name)) continue;
      refSet.add(name);
      refCounts.set(name, (refCounts.get(name) || 0) + 1);
    }
  }

  return { defs, defNames, refSet, refCounts };
}

// 递归扫描仓库, 返回结构化结果
export function scanRepo(root, opts = {}) {
  const { maxFiles = 400, maxDepth = 12, ignore = DEFAULT_IGNORE } = opts;
  const ignoreSet = new Set(ignore);
  const files = [];
  // 每个文件: { file:rel, defs:Set<name>, symbols:Set<name> } —— symbols = defs ∪ refs (用于同现边)
  const fileSymbols = [];
  const defRecords = new Map(); // name -> [{file, line, kind}]
  const refCounts = new Map();  // name -> 总出现次数 (排除定义行)
  let totalRefs = 0;

  const walk = (dir, depth) => {
    if (files.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // 先文件后目录, 保证 maxFiles 截断时优先保留浅层文件
    const dirs = [];
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (ignoreSet.has(e.name)) continue;
        dirs.push(abs);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!SCAN_EXT.includes(ext)) continue;
        const rel = path.relative(root, abs).split(path.sep).join("/");
        let content;
        try {
          const st = fs.statSync(abs);
          if (st.size > 1024 * 1024) { files.push({ rel, ext, dir: path.dirname(rel) }); continue; } // 超大文件跳过解析
          content = fs.readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        const { defs, defNames, refSet, refCounts: localRefs } = extractSymbols(content, ext);
        const symbols = new Set([...defNames, ...refSet]);
        fileSymbols.push({ file: rel, defs: defNames, symbols });
        files.push({ rel, ext, dir: path.dirname(rel) });
        for (const d of defs) {
          if (!defRecords.has(d.name)) defRecords.set(d.name, []);
          defRecords.get(d.name).push({ file: rel, line: d.line, kind: d.kind });
        }
        for (const [name, c] of localRefs) {
          refCounts.set(name, (refCounts.get(name) || 0) + c);
          totalRefs += c;
        }
      }
    }
    for (const d of dirs) walk(d, depth + 1);
  };

  walk(root, 0);
  return { root, files, fileSymbols, defRecords, refCounts, totalRefs };
}

// 由扫描结果构建有向图: 节点=标识符, 边 = 文件内 def 指向同现的其它标识符
function buildGraph(scan) {
  const adj = new Map(); // node -> Map(neighbor -> weight)
  const nodes = new Set();
  for (const fs of scan.fileSymbols) {
    for (const d of fs.defs) {
      nodes.add(d);
      if (!adj.has(d)) adj.set(d, new Map());
      const w = adj.get(d);
      for (const x of fs.symbols) {
        if (x === d) continue;
        w.set(x, (w.get(x) || 0) + 1);
        nodes.add(x);
      }
    }
  }
  return { adj, nodes };
}

// 纯 JS PageRank (幂迭代): 阻尼 0.85, 默认 20 次迭代, 处理悬挂节点
export function computePageRank(scan, opts = {}) {
  const { damping = 0.85, iterations = 20 } = opts;
  const { adj, nodes } = buildGraph(scan);
  const arr = [...nodes];
  const N = arr.length;
  if (N === 0) return new Map();
  const rank = new Map(arr.map((n) => [n, 1 / N]));
  const outDeg = new Map();

  for (let it = 0; it < iterations; it++) {
    let danglingSum = 0;
    outDeg.clear();
    for (const n of arr) {
      const w = adj.get(n);
      let deg = 0;
      if (w) for (const v of w.values()) deg += v;
      outDeg.set(n, deg);
      if (deg === 0) danglingSum += rank.get(n);
    }
    const next = new Map();
    for (const n of arr) {
      let sum = 0;
      const w = adj.get(n);
      if (w) {
        for (const [m, weight] of w) {
          const od = outDeg.get(m);
          if (od > 0) sum += (rank.get(m) * weight) / od;
        }
      }
      sum += danglingSum / N; // 悬挂节点均分
      next.set(n, (1 - damping) / N + damping * sum);
    }
    rank.clear();
    for (const [k, v] of next) rank.set(k, v);
  }
  return rank;
}

// ---- 渲染 ----

// 极简 token 估算: 按空白切词 (足够用于预算截断)
function approxTokens(s) {
  return s.split(/\s+/).filter(Boolean).length || 1;
}

// 渲染仓库地图为树形文本, 超 tokenBudget 截断; root 维度内存缓存 30s
const _cache = new Map(); // root -> { t, value }

export function renderRepoMap(root, opts = {}) {
  const { tokenBudget = 1024, maxFiles, maxDepth, ignore, topPerDir = 8, scan } = opts;
  const cached = _cache.get(root);
  if (cached && Date.now() - cached.t < 30000) return cached.value;

  const s = scan || scanRepo(root, { maxFiles, maxDepth, ignore });
  const rank = computePageRank(s);

  // 定义节点按所在目录分组 (同名取最高 rank)
  const byDir = new Map(); // dir -> Map(name -> score)
  for (const [name, recs] of s.defRecords) {
    const dir = path.dirname(recs[0].file);
    const score = rank.get(name) || 0;
    if (!byDir.has(dir)) byDir.set(dir, new Map());
    const m = byDir.get(dir);
    if (!m.has(name) || score > m.get(name)) m.set(name, score);
  }

  const lines = [];
  lines.push(`仓库地图 (${s.root})`);
  lines.push(`文件: ${s.files.length} · 定义: ${s.defRecords.size} · 引用: ${s.totalRefs}`);
  lines.push("");

  let used = approxTokens(lines.join("\n"));
  let truncated = false;

  const dirs = [...byDir.keys()].sort();
  for (const dir of dirs) {
    if (truncated) break;
    const head = dir === "." ? "(root)" : dir;
    lines.push(head);
    used += approxTokens(head);
    const entries = [...byDir.get(dir).entries()].sort((a, b) => b[1] - a[1]).slice(0, topPerDir);
    for (const [name, score] of entries) {
      const line = `  ${name}  (rank ${score.toFixed(4)})`;
      const tk = approxTokens(line);
      if (used + tk > tokenBudget) { truncated = true; break; }
      lines.push(line);
      used += tk;
    }
  }

  const text = lines.join("\n");
  const value = {
    text,
    stats: { files: s.files.length, defs: s.defRecords.size, refs: s.totalRefs },
    truncated,
  };
  _cache.set(root, { t: Date.now(), value });
  return value;
}

// 测试/调试辅助: 清空缓存
export function clearRepoMapCache() {
  _cache.clear();
}
