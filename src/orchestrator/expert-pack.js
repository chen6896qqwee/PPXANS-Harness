// src/orchestrator/expert-pack.js - 专家包体系 (2026-10-07 吸收自 TencentCloud/Octop)
//
// 吸收来源: Octop 的 `infra/agents/experts/catalog.py` + `experts/library/` 目录格式。
//   Octop 的关键判断 (原文): "An *expert* is metadata in ``manifest.json`` plus files on disk
//   under ``library/<id>/``" —— **专家不是代码里的常量, 是可分发的内容资产**。
//   它在服务启动时扫目录建目录册 (ExpertCatalog), 于是"加一个专家"等于"加一个目录",
//   不需要改任何 Python。
//
// 对比 PPX 原状: 23 个专家硬编码在 `experts.js` 的 EXPERTS 对象里。加一个领域专家要改源码、
//   改测试、重新发版; 也没法让别人分享、没法做市场。本模块补的就是这一层。
//
// 与 EXPERTS 的关系 (刻意不替换):
//   EXPERTS 常量保留 —— 它是 `spawn_agent.expert` 的既有契约, 9+14 个 id 被测试与文档引用。
//   专家包是**在其之上**的一层: 解析顺序 = EXPERTS 优先 → 专家包兜底。
//   内置包刻意不与 EXPERTS 的 id 重名 (重名会让"这个名字到底指谁"变成隐患)。
//
// 包目录格式 (最小 = manifest.json + SOUL.md):
//   experts/<id>/
//     manifest.json   元数据 (见 normalizeManifest)
//     SOUL.md         人格/职责正文 (persona 骨架)
//     AGENTS.md       可选: 作业准则 / 禁止事项
//
// 为什么不像 Octop 那样把 skills 一起拷进包:
//   PPX 已有 56 个内置技能 + 多源技能库 (内置/用户/项目/附加)。包内再拷一份 = 同一份方法论
//   存在两个真相源, 升级必然漂移。因此 manifest.skills 只写**技能 id 引用**, 由 manifest 决定
//   "这个专家该用哪些技能", 内容仍归技能库管。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { renderPersona, getProfile, hasProfile } from "./personas.js";
import { DOMAIN_IDS } from "../skills/registry.js";
import { HIGH_RISK_DOMAINS } from "./experts.js";

// 合法的 domain = 12 个技能能力域 ∪ 5 个高风险域。
// 两者是有意分开的: 技能域回答"这块活归谁做", 风险域回答"这块活该不该由 AI 拍板"。
// 一个专家可以同时是生活域的(技能域)与医疗风险的(风险域) —— 但 domain 字段只写一个,
// 风险属性走 requires_human 表达。这里放宽域取值只为让"法务/金融/医疗"这类专家能落到贴切的域。
export const KNOWN_DOMAINS = new Set([...DOMAIN_IDS, ...HIGH_RISK_DOMAINS]);

export const PACK_MANIFEST = "manifest.json";
export const PACK_SOUL = "SOUL.md";
export const PACK_AGENTS = "AGENTS.md";

// 导入包的安全上限 (包是外部不可信内容 —— 与技能导入同一套纪律)
export const PACK_LIMITS = {
  maxFiles: 60,
  maxFileBytes: 512 * 1024,
  maxPackBytes: 4 * 1024 * 1024,
};

// 允许的文本类文件; 其它扩展名一律拒收 (包是内容资产, 不是可执行分发物)
const ALLOWED_EXT = /\.(md|json|txt|ya?ml|csv|jsonl)$/i;

const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;

// 市场分类 (照 Octop 的"分 15 个类目"心意, 收敛到 PPX 用得上的粒度)
export const PACK_CATEGORIES = [
  { id: "assistant", name: "通用助理" },
  { id: "engineering", name: "工程与运维" },
  { id: "content", name: "内容与创意" },
  { id: "data", name: "数据与决策" },
  { id: "office", name: "办公与流程" },
  { id: "knowledge", name: "知识与研究" },
  { id: "life", name: "生活与家庭" },
  { id: "risk", name: "高风险域（需人工把关）" },
  { id: "meta", name: "元能力与协作" },
];

export const CATEGORY_IDS = new Set(PACK_CATEGORIES.map((c) => c.id));

// 本机用户级专家包根 (与内置隔离: 用户加包不动源码)
export function userExpertsDir() {
  return path.join(os.homedir(), ".ppx", "experts");
}

export function builtinExpertsDir(root) {
  return path.join(root, "experts");
}

// 依配置装配包根。config.experts:
//   { builtin: true, user_dir: "~/.ppx/experts", project_dir: "", extra_dirs: [] }
export function packRootsFromConfig(config, root) {
  const c = config?.experts || {};
  const roots = [];
  if (c.builtin !== false) roots.push({ id: "builtin", dir: builtinExpertsDir(root), kind: "builtin", writable: true });
  const userDir = c.user_dir === "" ? "" : expandHome(c.user_dir || userExpertsDir());
  if (userDir) roots.push({ id: "user", dir: userDir, kind: "user", writable: true });
  if (c.project_dir) roots.push({ id: "project", dir: expandHome(c.project_dir), kind: "project", writable: true });
  for (const [i, d] of (Array.isArray(c.extra_dirs) ? c.extra_dirs : []).entries()) {
    if (d) roots.push({ id: `extra${i}`, dir: expandHome(d), kind: "extra" });
  }
  if (!roots.length) roots.push({ id: "builtin", dir: builtinExpertsDir(root), kind: "builtin", writable: true });
  const seen = new Set();
  return roots.filter((r) => {
    const k = path.resolve(r.dir).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function expandHome(p) {
  const s = String(p || "");
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
  return s;
}

// 取本地化字段: {zh, en} 或裸字符串; 缺失时回落到中文再回落英文
export function pickLabel(v, locale = "zh") {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v !== "object") return String(v);
  return String(v[locale] ?? v.zh ?? v.en ?? "");
}

function listOf(v, locale = "zh") {
  if (Array.isArray(v)) return v.map(String);
  if (v && typeof v === "object") return Array.isArray(v[locale]) ? v[locale].map(String) : [];
  return [];
}

// ---- manifest 归一化 + 校验 ----
// 返回 { ok: true, pack } 或 { ok: false, errors: [...] }
export function normalizeManifest(raw, { dirId, source = "builtin", dir = "" } = {}) {
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["manifest.json 不是对象"] };
  }
  const id = String(raw.id || dirId || "").trim();
  if (!id) errors.push("缺 id");
  else if (!ID_RE.test(id)) errors.push(`id 非法 (仅小写字母/数字/横线, 2-48 位): ${id}`);
  else if (dirId && id !== dirId) errors.push(`id (${id}) 与目录名 (${dirId}) 不一致`);

  const label = pickLabel(raw.label) || id;
  const description = pickLabel(raw.description);
  if (!description) errors.push("缺 description");

  const domain = String(raw.domain || "");
  if (!domain) errors.push("缺 domain (能力域, 与 skills 域目录 id 对齐)");
  else if (!KNOWN_DOMAINS.has(domain)) errors.push(`domain 未登记: ${domain} (可用: ${[...KNOWN_DOMAINS].join(", ")})`);

  const category = String(raw.category || "assistant");
  if (!CATEGORY_IDS.has(category)) errors.push(`category 未登记: ${category} (可用: ${[...CATEGORY_IDS].join(", ")})`);

  const persona = raw.persona_mbti ? String(raw.persona_mbti).toUpperCase() : "";
  if (persona && !hasProfile(persona)) errors.push(`persona_mbti 未知: ${persona}`);

  const skills = Array.isArray(raw.skills) ? raw.skills.map(String).filter(Boolean) : [];
  const quickPrompts = Array.isArray(raw.quick_prompts)
    ? raw.quick_prompts
        .map((q) => ({ title: pickLabel(q?.title), prompt: pickLabel(q?.prompt), description: pickLabel(q?.description) }))
        .filter((q) => q.title && q.prompt)
    : [];

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    pack: {
      id,
      label,
      labelEn: pickLabel(raw.label, "en") || label,
      description,
      descriptionEn: pickLabel(raw.description, "en"),
      welcome: pickLabel(raw.welcome_message),
      domain,
      category,
      icon: String(raw.icon_name || "bot"),
      color: /^#[0-9a-fA-F]{6}$/.test(String(raw.color || "")) ? raw.color : "#6B7280",
      personaMbti: persona,
      skills,
      readonly: raw.readonly === true,
      requiresHuman: raw.requires_human === true,
      perspective: String(raw.perspective || description),
      quickPrompts,
      taskExamples: listOf(raw.task_examples),
      version: String(raw.version || "1.0.0"),
      source,
      dir,
    },
  };
}

// ---- 目录册 (启动扫描) ----
export class ExpertPackCatalog {
  constructor({ roots = [], maxDepth = 1 } = {}) {
    this.roots = roots;
    this.maxDepth = maxDepth;
    this._cache = null;
  }

  // 扫描全部根, 产出 id -> pack。同 id 先到的根胜出 (内置打底 → 用户覆盖 → 附加收尾)。
  scan({ force = false } = {}) {
    if (this._cache && !force) return this._cache;
    const index = new Map();
    const problems = [];
    for (const root of this.roots) {
      let entries;
      try { entries = fs.readdirSync(root.dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
        if (index.has(e.name)) continue; // first-wins
        const dir = path.join(root.dir, e.name);
        const mf = path.join(dir, PACK_MANIFEST);
        if (!fs.existsSync(mf)) continue; // 没有 manifest 的目录不是专家包 (草稿/素材)
        let raw;
        try {
          raw = JSON.parse(fs.readFileSync(mf, "utf8"));
        } catch (err) {
          problems.push({ id: e.name, reason: `manifest.json 解析失败: ${err.message}` });
          continue;
        }
        const r = normalizeManifest(raw, { dirId: e.name, source: root.kind, dir });
        if (!r.ok) { problems.push({ id: e.name, reason: r.errors.join("; ") }); continue; }
        // SOUL.md 是人格正文, 缺了包也能用 (回落 description), 但要如实记录
        const soulFile = path.join(dir, PACK_SOUL);
        const agentsFile = path.join(dir, PACK_AGENTS);
        index.set(e.name, {
          ...r.pack,
          soulFile: fs.existsSync(soulFile) ? soulFile : null,
          agentsFile: fs.existsSync(agentsFile) ? agentsFile : null,
          hasSoul: fs.existsSync(soulFile),
        });
      }
    }
    this._cache = { index, problems };
    return this._cache;
  }

  invalidate() { this._cache = null; }

  list({ domain = null, category = null, source = null, q = null } = {}) {
    let out = [...this.scan().index.values()];
    if (domain) out = out.filter((p) => p.domain === domain);
    if (category) out = out.filter((p) => p.category === category);
    if (source) out = out.filter((p) => p.source === source);
    if (q) {
      const n = String(q).toLowerCase();
      out = out.filter((p) => `${p.id} ${p.label} ${p.description} ${p.domain}`.toLowerCase().includes(n));
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id) { return this.scan().index.get(String(id || "")) || null; }
  has(id) { return this.scan().index.has(String(id || "")); }
  problems() { return this.scan().problems; }

  // 市场视图: 分类计数 + 未登记分类的包
  market() {
    const all = this.list();
    const byCat = new Map(PACK_CATEGORIES.map((c) => [c.id, { ...c, count: 0, experts: [] }]));
    for (const p of all) {
      const b = byCat.get(p.category) || byCat.set(p.category, { id: p.category, name: p.category, count: 0, experts: [] }).get(p.category);
      b.count += 1;
      b.experts.push(p.id);
    }
    return {
      total: all.length,
      categories: [...byCat.values()],
      sources: this.roots.map((r) => ({ id: r.id, kind: r.kind, dir: r.dir, exists: fs.existsSync(r.dir) })),
      problems: this.problems(),
    };
  }

  // 读正文 (SOUL.md / AGENTS.md), 无则回落 description
  read(id, which = "soul") {
    const p = this.get(id);
    if (!p) return null;
    const f = which === "agents" ? p.agentsFile : p.soulFile;
    if (!f) return which === "agents" ? null : p.description;
    try { return fs.readFileSync(f, "utf8"); } catch { return p.description; }
  }

  // 渲染专家的 system 人格块:
  //   有 persona_mbti → 用 personas 模板 (骨架) + SOUL.md 作为"职责说明"拼在后面
  //   无 persona_mbti → 直接用 SOUL.md 原文
  personaOf(id, { agentName = "皮皮虾", userDisplay = "兄弟", custom = "", withAgents = false } = {}) {
    const p = this.get(id);
    if (!p) return null;
    const soul = this.read(id, "soul") || "";
    const parts = [];
    if (p.personaMbti) parts.push(renderPersona(p.personaMbti, { agentName, userDisplay, custom }));
    if (soul && soul !== p.description) parts.push(`## 角色职责（${p.label}）\n${soul.trim()}`);
    else parts.push(`## 角色职责（${p.label}）\n${p.description}`);
    if (withAgents) {
      const ag = this.read(id, "agents");
      if (ag) parts.push(`## 作业准则\n${ag.trim()}`);
    }
    if (!p.personaMbti && String(custom || "").trim()) {
      parts.push(`## 用户补充\n${String(custom).trim()}`);
    }
    return parts.join("\n\n");
  }

  // 转成 EXPERTS 兼容形状 (让 spawn_agent.expert 能接受包 id)
  toExpertEntry(id) {
    const p = this.get(id);
    if (!p) return null;
    return {
      name: p.label,
      perspective: p.perspective,
      skills: p.skills,
      domain: p.domain,
      readonly: p.readonly,
      requiresHuman: p.requiresHuman,
      packId: p.id,
      personaMbti: p.personaMbti,
    };
  }

  // 解析: 专家包 id (大小写不敏感 + 中文名模糊)
  resolve(key) {
    const k = String(key || "").trim();
    if (!k) return null;
    const lower = k.toLowerCase();
    const direct = this.get(lower) || this.get(k);
    if (direct) return direct;
    for (const p of this.list()) {
      if (k.includes(p.label) || p.label.includes(k) || lower.includes(p.id)) return p;
    }
    return null;
  }
}

// ---- 导入 (外部不可信内容, 与技能导入同一套纪律) ----
function collectFiles(dir, out = [], rel = "", depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  if (depth > 4) return out;
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) collectFiles(abs, out, r, depth + 1);
    else if (e.isFile()) out.push({ abs, rel: r });
    if (out.length > PACK_LIMITS.maxFiles) break;
  }
  return out;
}

/**
 * 安装一个专家包: srcDir (含 manifest.json 的目录) → destRoot/<id>/
 * 返回 { ok, id, dir, files, bytes } 或 { ok:false, reason }
 */
export function installPack(srcDir, { destRoot, force = false, source = "imported" } = {}) {
  if (!srcDir || !fs.existsSync(srcDir)) return { ok: false, reason: `源目录不存在: ${srcDir}` };
  if (!destRoot) return { ok: false, reason: "缺少 destRoot" };
  const st = fs.statSync(srcDir);
  if (!st.isDirectory()) return { ok: false, reason: "源必须是目录" };

  const mf = path.join(srcDir, PACK_MANIFEST);
  if (!fs.existsSync(mf)) return { ok: false, reason: `缺 ${PACK_MANIFEST}` };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(mf, "utf8")); } catch (e) { return { ok: false, reason: `manifest.json 解析失败: ${e.message}` }; }

  const dirId = path.basename(srcDir);
  const r = normalizeManifest(raw, { dirId, source, dir: srcDir });
  if (!r.ok) return { ok: false, reason: `manifest 校验失败: ${r.errors.join("; ")}` };

  const files = collectFiles(srcDir);
  if (files.length > PACK_LIMITS.maxFiles) return { ok: false, reason: `文件数超限 (${files.length} > ${PACK_LIMITS.maxFiles})` };
  let total = 0;
  for (const f of files) {
    if (!ALLOWED_EXT.test(f.rel)) return { ok: false, reason: `不允许的文件类型: ${f.rel} (仅 md/json/txt/yaml/csv/jsonl)` };
    const sz = fs.statSync(f.abs).size;
    if (sz > PACK_LIMITS.maxFileBytes) return { ok: false, reason: `文件超限: ${f.rel} (${sz} > ${PACK_LIMITS.maxFileBytes})` };
    total += sz;
    if (total > PACK_LIMITS.maxPackBytes) return { ok: false, reason: `总大小超限 (${total} > ${PACK_LIMITS.maxPackBytes})` };
  }

  const outDir = path.join(destRoot, r.pack.id);
  // 落点必须在目标根内 (id 正则已挡穿越, 这里再核一次路径 —— 双保险)
  if (!path.resolve(outDir).toLowerCase().startsWith(path.resolve(destRoot).toLowerCase())) {
    return { ok: false, reason: "落点越出专家库目录" };
  }
  if (fs.existsSync(outDir) && !force) return { ok: false, reason: `专家包已存在: ${r.pack.id} (force=true 覆盖)` };

  try {
    fs.mkdirSync(outDir, { recursive: true });
    let bytes = 0;
    const written = [];
    for (const f of files) {
      const dest = path.join(outDir, f.rel);
      if (!path.resolve(dest).toLowerCase().startsWith(path.resolve(outDir).toLowerCase())) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const buf = fs.readFileSync(f.abs);
      fs.writeFileSync(dest, buf);
      bytes += buf.length;
      written.push(f.rel);
    }
    return { ok: true, id: r.pack.id, label: r.pack.label, dir: outDir, files: written, bytes };
  } catch (e) {
    return { ok: false, reason: `写入失败: ${e.message}` };
  }
}

export function createPackCatalog(config, root) {
  return new ExpertPackCatalog({ roots: packRootsFromConfig(config, root) });
}

export default {
  ExpertPackCatalog, createPackCatalog, installPack, normalizeManifest,
  packRootsFromConfig, PACK_CATEGORIES, PACK_LIMITS, builtinExpertsDir, userExpertsDir,
  pickLabel, getProfile,
};
