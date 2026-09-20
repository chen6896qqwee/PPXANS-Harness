// src/review/index.js - 分级审查流水线 (吸收 OpenCode-Review / OCR 五阶段思路, 纯 JS, 零依赖)
// 五阶段: plan(范围/上下文) -> group(语义分组) -> review(逐组高/中/低) -> relocate(变更换位识别) -> filter(噪音过滤)
// 输出: P0/P1/P2 报告 (high/medium/low 映射)
//
// 设计定位: 这是"静态规则"审查内核, 不调用 LLM。集成层可把本模块产出的 issues 再交给 LLM 做语义精修。

import fs from "node:fs";

// ---- 阶段一: 计划 (范围/上下文估计) ----
export function planReview({ files = [], context = "" } = {}) {
  const fileList = Array.isArray(files) ? files : (files ? [files] : []);
  const estimatedGroups = Math.max(1, Math.ceil(fileList.length / 4));
  return {
    stages: [
      { stage: 1, name: "plan", desc: "确定审查范围与上下文", done: true },
      { stage: 2, name: "group", desc: "按目录/扩展名/变更类型语义分组", done: false },
      { stage: 3, name: "review", desc: "逐组应用静态规则, 产出高/中/低问题", done: false },
      { stage: 4, name: "relocate", desc: "识别变更换位(代码在文件间移动)并去重", done: false },
      { stage: 5, name: "filter", desc: "过滤 lock 文件/生成目录/纯空白噪音", done: false },
    ],
    groups: estimatedGroups,
    summary: `计划审查 ${fileList.length} 个文件, 预估 ${estimatedGroups} 个变更分组, 上下文长度 ${String(context).length}。`,
  };
}

// ---- 阶段二: 语义分组 ----
// 入参可为: diff 文本 (解析 unified diff 得到文件列表) 或 文件路径数组
export function groupChanges(diffTextOrFileList) {
  let files = [];
  if (typeof diffTextOrFileList === "string") {
    files = parseDiffFiles(diffTextOrFileList);
  } else if (Array.isArray(diffTextOrFileList)) {
    files = diffTextOrFileList.map((f) => (typeof f === "string" ? f : f.file || f.path || "")).filter(Boolean);
  }
  if (files.length === 0) return [];

  // 按 "目录::扩展名" 分组 (同目录同类型归一组, 更贴近"语义相邻")
  const map = new Map();
  for (const f of files) {
    const dir = f.includes("/") || f.includes("\\") ? f.replace(/[\\/][^\\/]+$/, "") : "(root)";
    const ext = (f.match(/\.([a-zA-Z0-9]+)$/) || [, ""])[1].toLowerCase();
    const key = `${dir}::${ext || "none"}`;
    if (!map.has(key)) map.set(key, { key, dir, ext, files: [], kind: inferKind(f) });
    map.get(key).files.push(f);
  }
  return [...map.values()];
}

function inferKind(file) {
  if (/\.(test|spec)\./i.test(file)) return "test";
  if (/(\b|_)(config|conf)\b/i.test(file) || /\.(json|ya?ml|toml|ini|env)$/i.test(file)) return "config";
  if (/\.(md|txt|rst)$/i.test(file)) return "doc";
  return "source";
}

// 解析 unified diff 头获取涉及文件 (支持 `diff --git a/x b/y` 与 `+++ b/x`)
function parseDiffFiles(diff) {
  const files = [];
  const seen = new Set();
  for (const line of diff.split(/\r?\n/)) {
    let m = line.match(/^diff --git a\/(.+?) b\/(.+?)\s*$/);
    if (m) { pushUnique(files, seen, m[2]); continue; }
    m = line.match(/^\+\+\+ b\/(.+?)\s*$/);
    if (m) { pushUnique(files, seen, m[1]); continue; }
    m = line.match(/^--- a\/(.+?)\s*$/);
    if (m && !/^\/dev\/null/.test(m[1])) { pushUnique(files, seen, m[1]); }
  }
  return files;
}
function pushUnique(arr, seen, v) { if (!seen.has(v)) { seen.add(v); arr.push(v); } }

// ---- 阶段三: 逐组静态规则审查 ----
// 规则集中在此, 便于扩展。每条规则返回 { rule, severity, title, detail, suggestion } 或可空。
export function reviewGroup(group, opts = {}) {
  const { maxIssues = 20 } = opts;
  const issues = [];
  const files = group.files || [];
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue; // 文件不存在(仅 diff 路径)则跳过
    }
    const rules = STATIC_RULES.filter((r) => !r.ext || r.ext.test(file));
    for (const rule of rules) {
      for (const hit of rule.scan(content, file)) {
        if (issues.length >= maxIssues) return issues;
        issues.push({
          severity: rule.severity,
          file,
          line: hit.line,
          title: rule.title,
          detail: hit.detail,
          suggestion: rule.suggestion,
        });
      }
    }
  }
  return issues;
}

// 规则集: 每条 { severity, title, ext?(正则限定文件), suggestion, scan(content,file)->[{line,detail}] }
const STATIC_RULES = [
  {
    // 硬编码密钥 / api_key / token 字面量
    severity: "high",
    title: "硬编码敏感凭据",
    ext: /\.(js|mjs|cjs|ts|py|go|java|json|ya?ml|env)$/i,
    suggestion: "将密钥移入环境变量或密钥管理服务, 禁止明文提交。",
    scan(content) {
      const re = /(?:api[_-]?key|apikey|secret|token|access[_-]?key|private[_-]?key|password|passwd|client[_-]?secret)\s*[:=]\s*['"][^'"]{6,}['"]/gi;
      const out = [];
      let m;
      while ((m = re.exec(content)) !== null) {
        out.push({ line: lineOf(content, m.index), detail: `疑似硬编码凭据: ${m[0].slice(0, 40)}...` });
      }
      return out;
    },
  },
  {
    // TODO / FIXME / HACK 残留
    severity: "low",
    title: "待办/临时标记残留",
    ext: /\.(js|mjs|cjs|ts|py|go|java|md)$/i,
    suggestion: "跟踪到 issue 后移除标记, 或明确 owner 与截止时间。",
    scan(content) {
      const re = /\b(TODO|FIXME|HACK|XXX)\b/g;
      const out = [];
      let m;
      while ((m = re.exec(content)) !== null) {
        out.push({ line: lineOf(content, m.index), detail: `发现标记: ${m[0]}` });
      }
      return out;
    },
  },
  {
    // 调试残留 console.log / print
    severity: "low",
    title: "调试输出残留",
    ext: /\.(js|mjs|cjs|ts)$/i,
    suggestion: "移除临时 console.log/debug, 改用结构化日志。",
    scan(content) {
      const re = /\b(console\.log|console\.debug|console\.info)\s*\(/g;
      const out = [];
      let m;
      while ((m = re.exec(content)) !== null) {
        out.push({ line: lineOf(content, m.index), detail: `调试输出: ${m[0]}` });
      }
      return out;
    },
  },
  {
    // 调试残留 (python print)
    severity: "low",
    title: "调试输出残留",
    ext: /\.py$/i,
    suggestion: "移除临时 print, 改用 logging 模块。",
    scan(content) {
      const re = /(?<![A-Za-z_.])print\s*\(/g;
      const out = [];
      let m;
      while ((m = re.exec(content)) !== null) {
        out.push({ line: lineOf(content, m.index), detail: `调试输出: print(...)` });
      }
      return out;
    },
  },
  {
    // 超长函数 (>200 行)
    severity: "medium",
    title: "函数过长(>200行)",
    ext: /\.(js|mjs|cjs|ts|go|java)$/i,
    suggestion: "拆分为更小的单一职责函数, 提升可读性与可测试性。",
    scan(content, file) {
      return longFunctions(content, 200, "brace");
    },
  },
  {
    severity: "medium",
    title: "函数过长(>200行)",
    ext: /\.py$/i,
    suggestion: "拆分为更小的单一职责函数, 提升可读性与可测试性。",
    scan(content) {
      return longFunctions(content, 200, "indent");
    },
  },
  {
    // 空 catch
    severity: "medium",
    title: "空 catch 吞掉异常",
    ext: /\.(js|mjs|cjs|ts|java)$/i,
    suggestion: "至少记录异常或显式声明忽略理由, 禁止静默吞掉。",
    scan(content) {
      const re = /catch\s*\([^)]*\)\s*\{\s*\}/g;
      const out = [];
      let m;
      while ((m = re.exec(content)) !== null) {
        out.push({ line: lineOf(content, m.index), detail: "空 catch 块: 异常被静默吞掉" });
      }
      return out;
    },
  },
  {
    severity: "medium",
    title: "空 except 吞掉异常",
    ext: /\.py$/i,
    suggestion: "至少 logging.exception(...) 或显式 pass 加注释说明原因。",
    scan(content) {
      const re = /except\s+[\w.]*(?:\s+as\s+\w+)?\s*:\s*(?:pass\s*)?(?:\n|$)/g;
      const out = [];
      let m;
      while ((m = re.exec(content)) !== null) {
        // 仅匹配后面紧跟 pass 或换行的空 except
        const tail = content.slice(m.index + m[0].length, m.index + m[0].length + 40);
        if (/^\s*(pass\s*)?($|\n)/.test(tail) || /except\s+[\w.]*\s*:\s*pass/.test(m[0])) {
          out.push({ line: lineOf(content, m.index), detail: "空 except 块: 异常被静默吞掉" });
        }
      }
      return out;
    },
  },
  {
    // 松散相等 == (js)
    severity: "low",
    title: "使用松散相等 == (建议 ===)",
    ext: /\.(js|mjs|cjs|ts)$/i,
    suggestion: "使用 === / !== 避免隐式类型转换带来的意外。",
    scan(content) {
      const out = [];
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].replace(/===|!==|=>/g, "   ");
        if (/(^|[^=!])=(?!=)(?![=])(?=.*\S)/.test(t) && /(\w\s*==\s*\w|\w==\w)/.test(t)) {
          out.push({ line: i + 1, detail: "检测到 == 松散相等" });
        }
      }
      return out;
    },
  },
  {
    // 未转义 HTML 拼接 (XSS 风险)
    severity: "high",
    title: "未转义 HTML 拼接(XSS 风险)",
    ext: /\.(js|mjs|cjs|ts|py|java|go)$/i,
    suggestion: "对动态值做 HTML 转义或使用安全模板, 避免 innerHTML 拼接。",
    scan(content) {
      const re = /(innerHTML|outerHTML|document\.write|dangerouslySetInnerHTML|insertAdjacentHTML)\b[^;]*([+`]|\$\{)/gi;
      const out = [];
      let m;
      while ((m = re.exec(content)) !== null) {
        out.push({ line: lineOf(content, m.index), detail: `疑似未转义 HTML 拼接: ${m[0].slice(0, 40)}...` });
      }
      return out;
    },
  },
];

// 计算字符偏移对应的行号
function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

// 长函数检测: brace 模式(花括号配对) / indent 模式(python 缩进)
function longFunctions(content, limit, mode) {
  const lines = content.split(/\r?\n/);
  const out = [];
  const startRe = mode === "indent"
    ? /^\s*(?:async\s+)?def\s+\w+\s*\(/
    : /^\s*(?:async\s+)?function\s+\w+|^\s*(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(?[^=]*\)?\s*=>|^\s*(?:public|private|protected|static|\s)*[\w<>\[\],\s]+\s+\w+\s*\([^;]*\)\s*\{|^\s*func\s+/;

  for (let i = 0; i < lines.length; i++) {
    if (!startRe.test(lines[i])) continue;
    let end = i;
    if (mode === "brace") {
      let depth = 0;
      let entered = false;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === "{") { depth++; entered = true; }
          else if (ch === "}") { depth--; if (entered && depth === 0) { end = j; break; } }
        }
        if (end !== i) break;
      }
    } else {
      const baseIndent = lines[i].match(/^\s*/)[0].length;
      for (let j = i + 1; j < lines.length; j++) {
        const blank = lines[j].trim().length === 0;
        if (!blank && lines[j].match(/^\s*/)[0].length <= baseIndent) { end = j - 1; break; }
        end = j;
      }
    }
    const len = end - i + 1;
    if (len > limit) {
      out.push({ line: i + 1, detail: `函数约 ${len} 行, 超过 ${limit} 行上限` });
    }
  }
  return out;
}

// ---- 阶段四: 变更换位识别 (去重) ----
// moves: 描述"同一段代码从 A 移动到 B"的签名列表。命中签名的重复 issue 只保留一份(优先保留 to 端)。
export function relocateIssues(issues, moves = []) {
  if (!Array.isArray(moves) || moves.length === 0) return issues;
  const movedSigs = new Set();
  for (const mv of moves) {
    if (mv && mv.signature) movedSigs.add(mv.signature);
    else if (mv && mv.from && mv.to) {
      // 以 "from->to" 作为换位特征也加入
      movedSigs.add(`${mv.from}->${mv.to}`);
    }
  }
  const kept = [];
  const seenSigs = new Set();
  for (const it of issues) {
    const sig = it.title + "@" + (it.detail || "");
    if (movedSigs.has(sig) || movedSigs.has(`${it.file}`)) {
      if (seenSigs.has(sig)) continue; // 同签名重复, 去重
      seenSigs.add(sig);
    }
    kept.push(it);
  }
  return kept;
}

// ---- 阶段五: 噪音过滤 ----
export function filterNoise(issues) {
  const LOCK = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock|go\.sum)$/i;
  const GEN = /(^|[\\/])(dist|build|\.next|coverage|node_modules|\.workbuddy)([\\/]|$)/i;
  return issues.filter((it) => {
    const f = it.file || "";
    if (LOCK.test(f)) return false;
    if (GEN.test(f)) return false;
    // 纯空白/空变更: 无 title 或无有效定位
    if (!it.title) return false;
    return true;
  });
}

// ---- 编排: 全流程 ----
export function runReview({ files = [], diff } = {}) {
  const plan = planReview({ files, context: typeof diff === "string" ? diff : "" });
  const groups = groupChanges(diff !== undefined ? diff : files);
  let issues = [];
  for (const g of groups) {
    issues.push(...reviewGroup(g));
  }
  issues = relocateIssues(issues, []);
  issues = filterNoise(issues);

  const graded = { high: [], medium: [], low: [] };
  for (const it of issues) {
    if (it.severity === "high") graded.high.push(it);
    else if (it.severity === "medium") graded.medium.push(it);
    else graded.low.push(it);
  }

  const report = buildReport(graded, plan);
  return { issues, graded, report, plan };
}

function buildReport(graded, plan) {
  const lines = [];
  lines.push("# 代码审查报告");
  lines.push("");
  lines.push(`> 范围: ${plan.summary}`);
  lines.push("");
  lines.push(`## 分级汇总`);
  lines.push(`- P0 (high): ${graded.high.length}`);
  lines.push(`- P1 (medium): ${graded.medium.length}`);
  lines.push(`- P2 (low): ${graded.low.length}`);
  lines.push("");

  const section = (label, list, tag) => {
    if (list.length === 0) return;
    lines.push(`## ${label} (${tag})`);
    for (const it of list) {
      const loc = it.file + (it.line ? `:${it.line}` : "");
      lines.push(`- [${tag}] **${it.title}** \`${loc}\``);
      if (it.detail) lines.push(`  - ${it.detail}`);
      if (it.suggestion) lines.push(`  - 建议: ${it.suggestion}`);
    }
    lines.push("");
  };
  section("P0 严重", graded.high, "P0");
  section("P1 中等", graded.medium, "P1");
  section("P2 轻微", graded.low, "P2");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
