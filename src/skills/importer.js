// src/skills/importer.js - GitHub 技能导入器 (零依赖, 用 Node 内建 fetch)
//
// 目的: 把 GitHub 上通用的 Agent Skill 包 (SKILL.md 目录式) 拉进本地技能库, 落成
//   <dest>/<domain>/<skill>/SKILL.md 的领域布局, 由 SkillLoader v2 直接发现。
//
// 为什么做成工具而不仅仅"现在拷一批进去":
//   技能生态在快速演进 (anthropics/skills、obra/superpowers、addyosmani/agent-skills …),
//   一次性的拷贝会立刻过期。给 agent 一条**可复用的获取通道**比自己手工搬更有价值。
//
// 安全约束 (导入的是**别人的代码/文本**, 按不可信输入对待):
//   1) 只接受 https 的 github.com 域名 (防 SSRF 到内网/任意主机)
//   2) 只抓 SKILL.md + references/ 下的文本类小文件; 单文件硬上限, 总量硬上限
//   3) 不做任何自动执行: 导入 = 写文件, 不跑脚本
//   4) 落点限制在 dest 之内 (技能 id 白名单正则, 防 ../ 穿越)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOMAIN_IDS } from "./registry.js";

export const IMPORT_LIMITS = {
  maxFiles: 40,             // 单个技能最多导入的附随文件数
  maxFileBytes: 512 * 1024, // 单文件上限 512KB
  maxSkillBytes: 4 * 1024 * 1024, // 单技能总量上限 4MB
  timeoutMs: 20000,         // 单次请求超时 (无超时的 fetch 会在网络半开时永久挂住整个导入)
};

const ALLOWED_HOSTS = new Set(["github.com", "www.github.com", "raw.githubusercontent.com", "api.github.com"]);

// 技能 id / 目录名白名单 (防路径穿越: 不允许 . / \ 与空)
export function isSafeSegment(s) {
  return typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) && !s.includes("..");
}

// ---- 仓库引用解析 ----
// 支持: owner/repo | owner/repo#branch | https://github.com/owner/repo(/tree/branch(/subpath))
export function parseRepoRef(ref) {
  const raw = String(ref || "").trim();
  if (!raw) throw new Error("仓库引用为空");
  let owner, repo, branch = null, subPath = "";
  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw);
    if (u.protocol !== "https:") throw new Error("只接受 https 的 GitHub 地址");
    if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) throw new Error(`不允许的主机: ${u.hostname} (仅限 github.com / raw.githubusercontent.com)`);
    const seg = u.pathname.split("/").filter(Boolean);
    [owner, repo] = seg;
    // /tree/<branch>/<subpath...> 或 /blob/<branch>/<file>
    const i = seg.findIndex((s) => s === "tree" || s === "blob");
    if (i >= 0 && seg[i + 1]) {
      branch = seg[i + 1];
      subPath = seg.slice(i + 2).join("/");
    }
  } else {
    const hashIdx = raw.indexOf("#");
    const body = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
    if (hashIdx >= 0) branch = raw.slice(hashIdx + 1).trim() || null;
    // 允许 owner/repo/sub/path 形式 (branch 用 # 指定)
    const parts = body.split("/").filter(Boolean);
    [owner, repo] = parts;
    if (parts.length > 2) subPath = parts.slice(2).join("/");
  }
  if (!owner || !repo) throw new Error(`无法解析仓库引用: ${raw} (应为 owner/repo 或 GitHub 地址)`);
  repo = repo.replace(/\.git$/, "");
  if (!isSafeSegment(owner) || !isSafeSegment(repo)) throw new Error(`非法的 owner/repo: ${owner}/${repo}`);
  return { owner, repo, branch: branch || null, subPath };
}

// ---- 领域推断: 把上游技能按内容归到 12 个域目录之一 ----
// 先查"已知技能名"表 (上游知名技能包的人工归类, 命中即确定), 再退回关键词正则。
// 只靠正则的教训: canvas-design / theme-factory 因描述里出现 "document/guide" 被误归 office,
// 领域错了 → 落错目录 → 专家班组的技能绑定也随之错位。
const KNOWN_SKILL_DOMAIN = {
  "skill-creator": "meta", "template": "meta", "discernment-nudge": "meta",
  "canvas-design": "content", "algorithmic-art": "content", "theme-factory": "content",
  "slack-gif-creator": "content", "frontend-design": "content", "web-artifacts-builder": "content",
  "brand-guidelines": "business", "internal-comms": "business",
  "docx": "office", "pdf": "office", "pptx": "office", "xlsx": "office", "doc-coauthoring": "office",
  "mcp-builder": "code", "webapp-testing": "code", "claude-api": "code",
  "academy-guide": "research",
};

const DOMAIN_HINTS = [
  ["office", /\b(docx?|pdf|xlsx?|pptx?|slides?|spreadsheet|word|powerpoint|excel)\b/i],
  ["code", /\b(mcp|code|test|testing|debug|refactor|git|repo|ci|deploy|sdk|migration|syntax)\b/i],
  ["content", /\b(design|art|canvas|theme|frontend|ui|ux|gif|image|video|creative|copy|story)\b/i],
  ["data", /\b(data|analytics|metric|sql|chart|visuali[sz]ation|statistic|forecast)\b/i],
  ["research", /\b(research|paper|academic|academy|literature|cite|study|teach|course|tutor)\b/i],
  ["business", /\b(business|market|comms|communication|brand|sales|pitch|contract|finance|legal)\b/i],
  ["collab", /\b(multi-?agent|orchestrat|handoff|delegate|swarm)\b/i],
  ["meta", /\b(skill|meta|self-?evolv|plugin)\b/i],
  ["multimodal", /\b(vision|audio|speech|voice|multimodal|3d|robot|embodied)\b/i],
  ["planning", /\b(plan|roadmap|project|schedul|workflow)\b/i],
  ["knowledge", /\b(search|web|fetch|knowledge|source|citation|summari[sz]e|extract)\b/i],
  ["life", /\b(life|travel|trip|recipe|health|personal|habit|home)\b/i],
];

// 上游仓库里常见的占位/脚手架目录, 不是可用技能
export const SKIP_SKILL_NAMES = new Set(["template", "_template", "templates", "example", "examples", "sample"]);

export function inferDomain(text, leafName = "") {
  const name = String(leafName || "").toLowerCase();
  if (name && KNOWN_SKILL_DOMAIN[name]) return KNOWN_SKILL_DOMAIN[name];
  const s = String(text || "");
  // 名字本身命中已知表以外的, 再看关键词
  for (const [id, re] of DOMAIN_HINTS) {
    if (re.test(s) && DOMAIN_IDS.has(id)) return id;
  }
  return "meta";
}

// ---- 网络 ----
// 所有请求都带超时: 无超时的 fetch 在网络半开 (TCP 建立但对端不回) 时会永久挂住,
// 而导入器是串行抓取的 —— 一次挂住 = 整个导入静默卡死, 用户只看到"没反应"。
function timeoutSignal(ms) {
  try { return AbortSignal.timeout(ms); } catch { return undefined; }
}

async function ghJson(url, token) {
  const headers = { "User-Agent": "ppxans-harness-skill-importer", Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, signal: timeoutSignal(IMPORT_LIMITS.timeoutMs) });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText} (${url})`);
  return res.json();
}

// 列出仓库里全部 SKILL.md 路径 (递归树; 大仓可能被 GitHub 截断, 此时按已返回部分继续)
// 返回 { branch, paths, blobs, truncated } —— blobs 是全部 blob 路径, 供附随文件复用
// (附随文件绝不能再打一次 tree API: 每个技能一次 = 每秒几次就撞 GitHub 限流)
export async function fetchSkillPaths({ owner, repo, branch = null, token = null, subPath = "" } = {}) {
  const br = branch || (await ghJson(`https://api.github.com/repos/${owner}/${repo}`, token)).default_branch || "main";
  const tree = await ghJson(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(br)}?recursive=1`, token);
  const prefix = subPath ? subPath.replace(/^\/+|\/+$/g, "") + "/" : "";
  const blobs = (tree.tree || [])
    .filter((n) => n.type === "blob")
    .map((n) => n.path)
    .filter((p) => !/(^|\/)(node_modules|\.git)\//.test(p));
  const paths = blobs
    .filter((p) => /\/SKILL\.md$/i.test(p))
    .filter((p) => !prefix || p.startsWith(prefix));
  return { branch: br, blobs, paths, truncated: !!tree.truncated };
}

async function fetchText(url, token, { maxBytes = IMPORT_LIMITS.maxFileBytes, retries = 2 } = {}) {
  const headers = { "User-Agent": "ppxans-harness-skill-importer" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: timeoutSignal(IMPORT_LIMITS.timeoutMs) });
      if (!res.ok) throw new Error(`抓取失败 ${res.status} (${url})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`文件超限 (${buf.length} > ${maxBytes} bytes): ${url}`);
      return buf.toString("utf8");
    } catch (e) {
      lastErr = e;
      // 瞬时网络抖动 (fetch failed) 与 5xx 值得重试; 4xx 是确定性错误, 立刻放弃
      if (/抓取失败 4\d\d/.test(e.message)) break;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// 从 SKILL.md 正文抽 description (供改造 frontmatter 时保留上游意图)
export function extractUpstreamMeta(md) {
  const text = String(md || "").replace(/^\uFEFF/, "");
  const m = text.match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n\s*---\s*(?:\r?\n|$)/);
  const fm = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i <= 0) continue;
      const k = line.slice(0, i).trim().toLowerCase();
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k) fm[k] = v;
    }
  }
  const body = m ? text.slice(m[0].length) : text;
  let desc = fm.description || "";
  if (!desc) {
    // 退而求其次: 正文第一段非标题行
    const line = body.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith("#"));
    desc = (line || "").slice(0, 200);
  }
  return { frontmatter: fm, body, description: desc, name: fm.name || "" };
}

// 重写 frontmatter: 补 domain / source / imported_at / tags, 保留上游 name/description。
// 为什么必须重写: 上游 SKILL.md 普遍没有 domain 字段, 而领域归属决定它落在哪个目录、
// 被哪个专家班组绑定 —— 缺了这一笔, 导进来的技能就只是"一堆文本", 不是能力面的一部分。
export function rewriteFrontmatter(md, { id, domain, source, tags = [], description }) {
  const meta = extractUpstreamMeta(md);
  const name = meta.name || id;
  const desc = String(description || meta.description || "").replace(/\r?\n/g, " ").slice(0, 300);
  const head = [
    "---",
    `name: ${name}`,
    `description: ${desc}`,
    `domain: ${domain}`,
    `tags: ${(tags.length ? tags : [domain]).join(", ")}`,
    `source: ${source}`,
    `imported_at: ${new Date().toISOString().slice(0, 10)}`,
    "---",
  ].join("\n");
  return head + "\n" + meta.body.replace(/^\s+/, "");
}

// 技能附随文件 (scripts/ references/ assets/): 只抓文本类, 二进制跳过 (避免把仓库塞爆)
const TEXT_EXT = /\.(md|txt|json|ya?ml|toml|csv|tsv|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|ps1|rb|go|rs|java|sql|html|css|scss|xml|ini|cfg|env\.example)$/i;

function isTextAsset(p) {
  if (/SKILL\.md$/i.test(p)) return true;
  return TEXT_EXT.test(p);
}

/**
 * 导入技能。
 * opts: {
 *   ref,                    // owner/repo | owner/repo#branch | GitHub URL
 *   dest,                   // 技能库根目录 (会写成 <dest>/<domain>/<skill>/)
 *   skills: [names...],     // 只导这些技能 (默认全部); 名字 = SKILL.md 的父目录名
 *   domain,                 // 强制领域 (默认按路径+描述推断)
 *   withAssets: true,       // 是否连 references/scripts 一起抓
 *   token,                  // GitHub token (可选, 提升速率上限)
 *   dryRun: false,
 * }
 * 返回报告 { repo, branch, imported: [{id, domain, dir, bytes, files}], skipped: [...], failed: [...] }
 */
export async function importSkills(opts = {}) {
  const { dest, skills = null, domain = null, withAssets = true, token = null, dryRun = false } = opts;
  if (!dest) throw new Error("importSkills: 缺少 dest (技能库根目录)");
  const repo = parseRepoRef(opts.ref);
  const { branch, paths, blobs, truncated } = await fetchSkillPaths({ ...repo, token });

  // 每个 SKILL.md 的所属技能目录名
  const skillDirs = paths.map((p) => p.split("/").slice(0, -1).join("/")).filter(Boolean);
  const wanted = Array.isArray(skills) && skills.length ? new Set(skills.map(String)) : null;

  const report = { repo: `${repo.owner}/${repo.repo}`, branch, truncated, imported: [], skipped: [], failed: [] };

  for (const skillPath of skillDirs) {
    const segs = skillPath.split("/");
    const leaf = segs[segs.length - 1];
    if (!isSafeSegment(leaf)) { report.skipped.push({ path: skillPath, reason: "目录名不安全" }); continue; }
    if (SKIP_SKILL_NAMES.has(leaf.toLowerCase())) { report.skipped.push({ path: skillPath, reason: "占位/脚手架目录" }); continue; }
    if (wanted && !wanted.has(leaf)) { report.skipped.push({ path: skillPath, reason: "未在导入名单内" }); continue; }

    const skillMdPath = `${skillPath}/SKILL.md`;
    let raw;
    try {
      raw = await fetchText(`https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodeURIComponent(branch)}/${skillMdPath}`, token);
    } catch (e) {
      report.failed.push({ path: skillPath, error: e.message });
      continue;
    }
    const inferred = domain && DOMAIN_IDS.has(domain) ? domain : inferDomain(`${skillPath} ${extractUpstreamMeta(raw).description}`, leaf);
    const outDir = path.join(dest, inferred, leaf);
    // 落点必须在 dest 内 (last-mile 的穿越防线)
    if (!path.resolve(outDir).toLowerCase().startsWith(path.resolve(dest).toLowerCase())) {
      report.failed.push({ path: skillPath, error: "落点越出技能库目录" });
      continue;
    }

    const entry = { id: `${inferred}/${leaf}`, domain: inferred, dir: outDir, bytes: 0, files: [] };
    if (dryRun) { entry.bytes = raw.length; entry.files.push("SKILL.md"); report.imported.push(entry); continue; }

    try {
      fs.mkdirSync(outDir, { recursive: true });
      const rewritten = rewriteFrontmatter(raw, {
        id: leaf, domain: inferred, source: `${repo.owner}/${repo.repo}`,
        tags: [`imported`, repo.repo],
      });
      fs.writeFileSync(path.join(outDir, "SKILL.md"), rewritten, "utf8");
      entry.bytes += rewritten.length;
      entry.files.push("SKILL.md");

      if (withAssets) {
        const prefix = skillPath + "/";
        const assetPaths = blobs
          .filter((p) => p.startsWith(prefix))
          .map((p) => p.slice(prefix.length))
          .filter((rel) => rel && rel !== "SKILL.md" && isTextAsset(rel))
          .slice(0, IMPORT_LIMITS.maxFiles);
        for (const rel of assetPaths) {
          const parts = rel.split("/");
          // 路径安全: 任一段为空/以点开头/含 .. → 丢弃 (防 ../ 穿越与隐藏文件)
          if (!parts.length || parts.some((p) => !p || p.startsWith(".") || p.includes(".."))) continue;
          if (entry.bytes > IMPORT_LIMITS.maxSkillBytes) break;
          try {
            const body = await fetchText(`https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodeURIComponent(branch)}/${skillPath}/${rel}`, token);
            const abs = path.join(outDir, rel);
            if (!path.resolve(abs).toLowerCase().startsWith(path.resolve(outDir).toLowerCase())) continue;
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, body, "utf8");
            entry.bytes += body.length;
            entry.files.push(rel);
          } catch { /* 单个附随文件失败不影响技能本体 */ }
        }
      }
      report.imported.push(entry);
    } catch (e) {
      report.failed.push({ path: skillPath, error: e.message });
    }
  }
  return report;
}

// ---- 可信上游源清单 (2026-10-07 评估报告 P1-3) ----
// 原来的"装技能"要求用户先知道 GitHub 上有个 repo 才能装 (skill_import 必须给 repo 参数),
//   这在生态里等于没有市场。这里补一份**离线随包分发**的白名单: 只列手工验证过的源,
//   不做在线搜索 —— 在线搜索意味着"一句话把任意第三方代码拉进本地", 与本项目对待
//   不可信输入的一贯约束冲突。宁可少列几个源, 也不开这个口子。
const UPSTREAM_FILE = "upstream-sources.json";

export function upstreamSources(rootDir = null) {
  try {
    // 定位: <repo>/skills/upstream-sources.json (本文件在 src/skills/ 下, 上两级是仓库根)。
    // 用 fileURLToPath 而不是手拼 pathname —— Windows 上 file:// URI 带盘符 (/C:/...)
    // 直接 join 会得到 "C:\C:\..."。
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = path.join(rootDir || path.resolve(here, "..", ".."), "skills", UPSTREAM_FILE);
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!j || !Array.isArray(j.sources)) return { sources: [], known_skills: {} };
    return { sources: j.sources, known_skills: j.known_skills || {} };
  } catch {
    return { sources: [], known_skills: {} }; // 清单缺失/损坏 = 没有清单, 不影响手工给 repo 的导入
  }
}

// 按名字解析: 接受源 id ("anthropics") 或技能名 ("pdf")。
// 返回 { repo, skills? } —— skills 省略表示"该源全部"。
export function resolveUpstream(name, rootDir = null) {
  const q = String(name || "").trim().toLowerCase();
  if (!q) return null;
  const { sources, known_skills } = upstreamSources(rootDir);
  const byId = sources.find((s) => String(s.id).toLowerCase() === q);
  if (byId) return { repo: byId.repo, source: byId, skills: null };
  const srcId = known_skills[q] || Object.entries(known_skills).find(([k]) => k.toLowerCase() === q)?.[1];
  if (srcId) {
    const s = sources.find((x) => String(x.id).toLowerCase() === String(srcId).toLowerCase());
    if (s) return { repo: s.repo, source: s, skills: [q] };
  }
  // 兜底: 名字在任一源的已导入清单里出现过也算 (known_skills 是手工维护的, 会滞后)
  return null;
}

export default { importSkills, parseRepoRef, fetchSkillPaths, inferDomain, rewriteFrontmatter, extractUpstreamMeta, isSafeSegment, upstreamSources, resolveUpstream, IMPORT_LIMITS };
