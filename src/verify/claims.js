// src/verify/claims.js — 终稿声称 vs 磁盘证据 (回合后置校验的"声称类"检查)
// 从 postcondition 拆出 (2026-11-03), 2026-11-12 随验证域整体迁出 core, 逻辑与文案逐字保持。
// 两类判定都是纯本地确定性检查 (RegExp + 至多几次 existsSync/readFileSync), 零子进程:
//   (2) 完成声称 — 贴了代码块就答"已修复" (checkClaimEvidence)
//   (3) 行数声称 — 没读过文件就答"共 1 行" (checkLineTotalClaim)
import fs from "node:fs";
import { resolveInRoot, READ_MAX_BYTES } from "./path-evidence.js";

// ---- 完成声称 vs 落盘证据 (真跑复盘的第 (2) 类: 贴了代码块就答"已修复") ----
// 判定完全确定性: 三个条件同时成立才算"无证据的完成声称"
//   a) 本轮没有任何写类/执行类调用成功 (mutationEvidence=false)
//   b) 终稿里出现"写入/创建/修改/替换/删除/导出…"式的完成动词 **且** 点名了一个带扩展名的文件
//   c) 用户本轮任务本身要求改文件 (否则纯问答里提到文件名很常见, 不该拦)
const CLAIM_ZH = /(写入|写进|写到|已写|已经写|创建|新建|建好|保存|存为|生成(了)?(新)?文件|修改|改动|改好|改完|改掉|替换|重命名|改名|导出|修复|修好|补上|加上|删除|删掉|移除|落地|实现(了)?)/;
const CLAIM_EN = /\b(wrote|written|created|saved|updated|fixed|replaced|renamed|exported|deleted|removed|implemented|patched)\b/i;
// 否定式"完成声称"不是声称 (2026-11-04 实测): "未做任何修改 / 没有修改 README.md /
//   did not modify" 曾被 CLAIM_ZH/CLAIM_EN 当作完成动词, 纯只读任务因此被误拦。
//   只剔除否定词紧邻的动作短语, 后面的独立声称 ("没改 A, 但改了 B") 仍会被识别。
const NEGATED_CLAIM_ZH = /(?:未|没有|没|并未|不曾|从未|无需|不需要|不用|不必|请勿|切勿|严禁|勿|不要|禁止|不得|不能|不可)\s*(?:对\s*[^\s，。；,;]{1,60}\s*)?(?:进行|做|作|加以|手动|手|直接|随意|擅自|轻易)?\s*(?:任何|过|任何形式的)?\s*(?:写入|写进|写到|已写|已经写|创建|新建|建好|保存|存为|生成(?:了)?(?:新)?文件|修改|改动|改好|改完|改掉|替换|重命名|改名|导出|修复|修好|补上|加上|删除|删掉|移除|落地|实现(?:了)?)/g;
const NEGATED_CLAIM_EN = /\b(?:did not|didn't|not|never|no)\s+(?:\w+\s+){0,2}(?:write|wrote|written|create|created|save|saved|update|updated|fix|fixed|replace|replaced|rename|renamed|export|exported|delete|deleted|remove|removed|implement|implemented|patch|patched)\b/gi;

// 引用不算声称 (2026-11-04 实测): 只读总结常把原文贴进回复, 原文里的 "改完请重跑" /
//   代码块中的文件名会被误当成"本轮完成声称 + 落盘对象"。声称只应来自模型自己的叙述,
//   因此围栏代码块 / 行内代码 / 引用行在判定前整体剔除 (文件 token 也从同一份干净文本提取)。
const QUOTED_BLOCK = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|^\s*>.*$/gm;
// 首字符必须是词字符或路径分隔符: 拒绝 ".test.js" 这类从通配符/句中碎片里截出来的假 token。
// eslint-disable-next-line no-useless-escape
const FILE_TOKEN_RE = /(?:[\w\-]|\/|\\)[\w.\-\/\\]*\.(?:js|mjs|cjs|json|ts|tsx|jsx|py|go|rs|java|sh|md|txt|html|css|ya?ml|toml|ini|csv|xml|sql)\b/i;
// 运行时/框架产品名不是文件 (2026-11-04 实测): "纯 Node.js、零运行时依赖" 被当成
//   "已修改 Node.js"。这些名字带合法的文件扩展名, 但指向的是语言/框架本身。
const PRODUCT_TOKENS = new Set([
  "node.js", "vue.js", "react.js", "next.js", "nuxt.js", "nest.js", "three.js",
  "d3.js", "express.js", "ember.js", "jquery.js", "chart.js", "electron.js",
]);
const MUTATION_REQUEST_ZH = /(写|添加|新增|创建|建|保存|存|修改|改|替换|重命名|改名|删除|删|移除|修复|修|实现|补|导出|生成)/;
const MUTATION_REQUEST_EN = /\b(write|add|create|save|modify|change|replace|rename|delete|remove|fix|implement|export|patch|update)\b/i;

// 否定指令不算修改意图 (2026-11-04 实测): "读取 README.md，不要修改任何文件" 曾被
//   looksLikeMutationRequest 判成修改请求, 只读任务因此被 claim-without-write 误拦。
//   只剔除"否定词 + 动作"这一对, 不吞后续分句 —— "只读 A, 然后修改 B" 仍应判为修改请求。
//   裸"不"也要算 ("不修改文件" 是真实轨迹里最常见的措辞); 只吃紧邻的"不+动作",
//   所以"不过需要修改"这类句子不会被吞掉。
const NEGATED_ACTION_ZH = /(?:不要|不用|不|无需|不需要|禁止|请勿|切勿|勿|别|不得|不能|不可)\s*(?:再|去|进行|做|作)?\s*(?:写入|写|添加|新增|创建|新建|保存|修改|改动|改|替换|重命名|改名|删除|移除|修复|实现|导出|生成|落地)/g;
const NEGATED_ACTION_EN = /\b(?:do not|don't|dont|never|no need to|without)\s+(?:\w+\s+){0,1}(?:write|add|create|save|modify|change|replace|rename|delete|remove|fix|implement|export|patch|update)\b/gi;

export function looksLikeMutationRequest(userMessage) {
  const s = String(userMessage || "")
    .replace(NEGATED_ACTION_ZH, " ")
    .replace(NEGATED_ACTION_EN, " ");
  return MUTATION_REQUEST_ZH.test(s) || MUTATION_REQUEST_EN.test(s);
}

export function extractClaimedFiles(text) {
  const s = String(text || "");
  const out = [];
  const re = new RegExp(FILE_TOKEN_RE.source, "gi");
  let m;
  while ((m = re.exec(s)) && out.length < 8) {
    const tok = m[0];
    if (m.index > 0 && (s[m.index - 1] === "*" || s[m.index - 1] === ".")) continue; // "*.test.js" 之类的通配/句尾碎片
    if (PRODUCT_TOKENS.has(tok.toLowerCase())) continue;
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

// 返回 failure 条目或 null
export function checkClaimEvidence({ finalMessage, userMessage, mutationEvidence, rootDir }) {
  if (mutationEvidence) return null;
  const draft = String(finalMessage || "")
    .replace(QUOTED_BLOCK, " ")
    .replace(NEGATED_CLAIM_ZH, " ")
    .replace(NEGATED_CLAIM_EN, " ");
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
