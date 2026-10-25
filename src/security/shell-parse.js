// src/security/shell-parse.js - 结构化 shell 命令解析 (2026-10-24)
// 设计吸收 ljharb/shell-quote 与 vorpaljs/bash-parser 的"先分词后分析"思路, 源码自研、零依赖。
// 动机: command-guard 旧链路对"规范化副本"做整串正则, 而执行层是 `sh -c 原串` ——
//   检测串 ≠ 执行串。典型逃逸: `echo $(rm -rf /)` 在 allow_all 下穿过全部黑名单直达 shell。
// 本模块提供:
//   tokenizeShell —— 引号/转义感知的分词 (word / operator / redirect), 单引号区标记 literal
//   parseShellCommand —— 切分简单命令段 + 提取每段 argv0 + 检测命令替换/进程替换
// 守卫用分段结果做"逐段 argv0 白名单", 用替换检测结果做硬拦 (等同内联执行, 需 opt-in)。

const OPERATORS = ["&&", "||", ";;", ";", "|", "&", "\n"];
const REDIRECTS = [">>", "<<-", "<<", "<&",">&", "<(", ">", "<"];

// 分词: 返回 [{ text, kind: "word"|"op", quoted, single }]
//  - quoted: 该 token 含引号包裹成分 (检测时不可信任其字面值)
//  - single: 含单引号包裹成分 (bash 语义 = 字面量, 内部不做替换/展开)
export function tokenizeShell(cmd) {
  const s = String(cmd || "");
  const out = [];
  let i = 0;
  let cur = "", curQuoted = false, curSingle = false, hasCur = false;
  const flush = () => {
    if (hasCur) { out.push({ text: cur, kind: "word", quoted: curQuoted, single: curSingle }); cur = ""; curQuoted = false; curSingle = false; hasCur = false; }
  };
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && s[i + 1] !== "\n") {
      cur += c + s[i + 1]; i += 2; hasCur = true; continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== "'") j++;
      cur += s.slice(i + 1, j); i = Math.min(j + 1, s.length);
      curQuoted = true; curSingle = true; hasCur = true; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') { if (s[j] === "\\" && j + 1 < s.length) j++; j++; }
      cur += s.slice(i + 1, j); i = Math.min(j + 1, s.length);
      curQuoted = true; hasCur = true; continue;
    }
    // 操作符 (最长匹配: && || ;; 优先于 & ; |)
    const two = s.slice(i, i + 2);
    if (OPERATORS.includes(two) && two !== "\n") { flush(); out.push({ text: two, kind: "op", quoted: false, single: false }); i += 2; continue; }
    if (c === "\n") { flush(); out.push({ text: "\n", kind: "op", quoted: false, single: false }); i++; continue; }
    if (OPERATORS.includes(c)) { flush(); out.push({ text: c, kind: "op", quoted: false, single: false }); i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { flush(); i++; continue; }
    // 重定向 (含 bash 进程替换 <( >( —— 作为 op 保留, 由替换检测单独定性)
    const three = s.slice(i, i + 2);
    const redir = REDIRECTS.find((r) => (r.length === 2 ? three === r : c === r));
    if (redir) { flush(); out.push({ text: redir, kind: "op", quoted: false, single: false }); i += redir.length; continue; }
    cur += c; i++; hasCur = true;
  }
  flush();
  return out;
}

// 结构化解析:
// {
//   segments: [[{text,quoted,single}...]]   // 按 && || ; | & \n 切开的简单命令 (每段词 token 序列)
//   argv0s:   string[]                      // 每段首词 (去路径/扩展名, 小写) —— 供逐段白名单
//   substitutions: [{ type, at }]           // 命令替换/进程替换出现点 (bash 展开语义 = 代码执行)
// }
export function parseShellCommand(cmd) {
  const tokens = tokenizeShell(cmd);
  const segments = [];
  let seg = [];
  const substitutions = [];
  const SEP = new Set(["&&", "||", ";;", ";", "|", "&", "\n"]);
  for (const tok of tokens) {
    if (tok.kind === "op") {
      if (SEP.has(tok.text)) { if (seg.length) segments.push(seg); seg = []; }
      continue;
    }
    seg.push(tok);
  }
  if (seg.length) segments.push(seg);

  // 命令替换检测: 直接在原串扫 (单引号区是 bash 字面量, 跳过)。
  //   $(   —— POSIX 命令替换   ` —— 旧式命令替换   <( >( —— 进程替换
  //   双引号内仍会展开, 同样算。cmd.exe 下这些是无效语法 → 模型发出即说明意图绕道 shell 语义, fail-closed。
  let single = false, dbl = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'" && !dbl) { single = !single; continue; }
    if (c === '"' && !single) { dbl = !dbl; continue; }
    if (c === "\\" && !single && i + 1 < cmd.length) { i++; continue; }
    if (single) continue;
    const two = cmd.slice(i, i + 2);
    if (two === "$(") { substitutions.push({ type: "$() 命令替换", at: i }); i++; continue; }
    if (c === "`") { substitutions.push({ type: "反引号命令替换", at: i }); continue; }
    if (two === "<(" || two === ">(") { substitutions.push({ type: `${two} 进程替换`, at: i }); i++; continue; }
  }

  const argv0s = segments.map((words) => {
    const first = words[0];
    if (!first) return "";
    return String(first.text || "")
      .replace(/^.*[\\/]/, "")
      .replace(/\.(exe|cmd|bat|ps1)$/i, "")
      .toLowerCase();
  });

  return { segments, argv0s, substitutions };
}
