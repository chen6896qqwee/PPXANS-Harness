// src/skills/loader.js - 方法技能加载器 (SKILL.md 目录式)
// 来源: Superpowers / addyosmani-agent-skills 模式 —— 技能=目录 + SKILL.md(frontmatter + ## 章节)
// 设计要点:
//  1) 签名缓存 (mtime+size): 内容修改/目录增删后 list()/get() 必须反映变化 (蓝皮书: 发现是生态瓶颈)
//  2) readSection 按需读章节: 只把命中的章节喂给 LLM, 省 token
//  3) 使用追踪 trackUse/useOf/usageAll: 用中自进化 (Hermes) 的前提是知道谁在用、谁闲置
import fs from "node:fs";
import path from "node:path";

// ---- frontmatter / 章节解析 (零依赖) ----

// 解析 `---\nkey: value\n---` 头。无头返回 {}。
export function parseFrontmatter(md) {
  const text = String(md || "").replace(/^\uFEFF/, "");
  const m = text.match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n\s*---\s*(?:\r?\n|$)/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  }
  return out;
}

// 去掉 frontmatter 后的正文
export function stripFrontmatter(md) {
  const text = String(md || "").replace(/^\uFEFF/, "");
  const m = text.match(/^\s*---\s*\r?\n[\s\S]*?\r?\n\s*---\s*(?:\r?\n|$)/);
  return m ? text.slice(m[0].length) : text;
}

// 解析二级标题章节: `## 流程` → { "流程": "正文(不含标题行)" }
export function parseSections(md) {
  const body = stripFrontmatter(md);
  const out = {};
  const lines = body.split(/\r?\n/);
  let cur = null;
  let buf = [];
  const flush = () => {
    if (cur === null) return;
    out[cur] = buf.join("\n").trim();
  };
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    const h1 = line.match(/^#\s+(.+?)\s*$/);
    if (h) {
      flush();
      cur = h[1].trim();
      buf = [];
    } else if (h1) {
      // 一级标题不作为章节, 但结束当前章节
      flush();
      cur = null;
      buf = [];
    } else if (cur !== null) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

const USAGE_FILE = ".usage.json";

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}

export class SkillLoader {
  constructor(dir) {
    this.dir = dir;
    this._cache = new Map(); // id -> { sig, meta }
  }

  // 单技能签名: SKILL.md 的 mtime+size (变更即失效缓存)
  _sigOf(file) {
    try {
      const st = fs.statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  _skillDirs() {
    try {
      return fs
        .readdirSync(this.dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((n) => !n.startsWith(".") && n !== "node_modules");
    } catch {
      return [];
    }
  }

  _load(id) {
    const file = path.join(this.dir, id, "SKILL.md");
    const sig = this._sigOf(file);
    if (sig === null) {
      this._cache.delete(id);
      return null;
    }
    const hit = this._cache.get(id);
    if (hit && hit.sig === sig) return hit.meta;
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      this._cache.delete(id);
      return null;
    }
    const fm = parseFrontmatter(raw);
    const meta = {
      id,
      name: String(fm.name || id),
      description: String(fm.description || ""),
      frontmatter: fm,
      body: stripFrontmatter(raw),
      file,
    };
    this._cache.set(id, { sig, meta });
    return meta;
  }

  // 列出全部技能 (id/name/description), 目录增删与内容修改都会反映
  list() {
    const ids = this._skillDirs().sort();
    const keep = new Set(ids);
    for (const k of [...this._cache.keys()]) if (!keep.has(k)) this._cache.delete(k);
    const out = [];
    for (const id of ids) {
      const m = this._load(id);
      if (m) out.push({ id: m.id, name: m.name, description: m.description });
    }
    return out;
  }

  has(id) {
    return this._load(String(id || "")) !== null;
  }

  get(id) {
    const m = this._load(String(id || ""));
    if (!m) return null;
    return { id: m.id, name: m.name, description: m.description, frontmatter: m.frontmatter };
  }

  // SKILL.md 正文 (去 frontmatter)。未知技能返回 null。
  read(id) {
    const m = this._load(String(id || ""));
    return m ? m.body : null;
  }

  // 按需读章节。章节不存在或技能不存在返回 null。
  readSection(id, section) {
    const body = this.read(id);
    if (body === null) return null;
    const s = parseSections(body);
    const v = s[String(section || "")];
    return v === undefined ? null : v;
  }

  // ---- 使用追踪 (落盘, 跨实例可读回) ----
  _usageFile() {
    return path.join(this.dir, USAGE_FILE);
  }

  _readUsage() {
    return readJsonSafe(this._usageFile(), {});
  }

  _writeUsage(u) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this._usageFile(), JSON.stringify(u, null, 2), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  trackUse(id) {
    const key = String(id || "");
    if (!key) return { uses: 0, lastUsed: null };
    const u = this._readUsage();
    const cur = u[key] && typeof u[key] === "object" ? u[key] : { uses: 0, lastUsed: null };
    const next = { uses: Number(cur.uses || 0) + 1, lastUsed: new Date().toISOString() };
    u[key] = next;
    this._writeUsage(u);
    return next;
  }

  useOf(id) {
    const u = this._readUsage();
    const cur = u[String(id || "")];
    if (!cur || typeof cur !== "object") return { uses: 0, lastUsed: null };
    return { uses: Number(cur.uses || 0), lastUsed: cur.lastUsed || null };
  }

  usageAll() {
    const u = this._readUsage();
    const out = {};
    for (const [k, v] of Object.entries(u)) {
      if (!v || typeof v !== "object") continue;
      out[k] = { uses: Number(v.uses || 0), lastUsed: v.lastUsed || null };
    }
    return out;
  }

  resetUse(id) {
    const key = String(id || "");
    const u = this._readUsage();
    delete u[key];
    return this._writeUsage(u);
  }
}
