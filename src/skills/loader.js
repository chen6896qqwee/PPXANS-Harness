// src/skills/loader.js - Skill Catalog + Loader
// 参考 deepseek-harness 的 skill package(catalog + loader): 可枚举、可发现、可加载的技能注册表
// 扫描 <skillsDir>/*/SKILL.md, 解析 frontmatter(name/description), 提供 list/get/loadAll
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "../utils/store.js";

// 解析 SKILL.md 顶部的 --- frontmatter ---
// 支持简单 `key: value` 和 YAML 折叠块（`>` / `|`），保证多行 description 可被解析。
export function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  let key = null;
  let block = null;
  let blockLines = [];
  const flush = () => {
    if (key && block) {
      meta[key] = block === ">"
        ? blockLines.join(" ").replace(/\s+/g, " ").trim()
        : blockLines.join("\n").trim();
    }
    key = null;
    block = null;
    blockLines = [];
  };
  for (const line of lines) {
    const mm = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (mm) {
      flush();
      key = mm[1];
      const val = mm[2].trim();
      if (val === ">" || val === "|") {
        block = val;
      } else {
        meta[key] = val;
        key = null;
      }
    } else if (block && key) {
      blockLines.push(line.trim());
    }
  }
  flush();
  return meta;
}

// 解析 SKILL.md 正文章节: "## 标题" -> 内容
// 供按需加载 (渐进式披露): agent 可只读「反合理化」「验证」等特定段, 不用整篇读入
export function parseSections(md) {
  const sections = {};
  const lines = String(md || "").split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) { cur = m[1].trim(); sections[cur] = ""; continue; }
    if (cur) sections[cur] += line + "\n";
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].trim();
  return sections;
}

export class SkillLoader {
  constructor(skillsDir) {
    this.dir = skillsDir;
    // 技能使用追踪 (source: Hermes "skill self-improves during use")
    this.usageFile = path.join(skillsDir, ".usage.json");
    this._usage = this._readUsage();
  }

  _scan() {
    if (!fs.existsSync(this.dir)) return {};
    const out = {};
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(this.dir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMd)) continue;
      const raw = fs.readFileSync(skillMd, "utf8");
      const meta = parseFrontmatter(raw);
      out[entry.name] = {
        id: entry.name,
        name: meta.name || entry.name,
        description: meta.description || "",
        dir: path.join(this.dir, entry.name),
        path: skillMd,
      };
    }
    return out;
  }

  // 可枚举: 全部技能
  list() {
    return Object.values(this._scan());
  }

  // 可发现: 按 id 查
  get(id) {
    return this._scan()[id] || null;
  }

  has(id) {
    return !!this._scan()[id];
  }

  // 读取某个技能的完整 SKILL.md 内容
  read(id) {
    const s = this.get(id);
    if (!s) return null;
    return fs.readFileSync(s.path, "utf8");
  }

  // 按需读取某个技能的指定章节 (渐进式披露: 只读「反合理化」「验证」等段, 省 token)
  readSection(id, section) {
    const raw = this.read(id);
    if (raw === null) return null;
    const sections = parseSections(raw);
    return sections[section] ?? null;
  }

  _readUsage() {
    const d = readJson(this.usageFile, null);
    return (d && typeof d === "object") ? d : {};
  }

  _saveUsage() {
    try { writeJson(this.usageFile, this._usage); } catch { /* 用量统计落盘失败不影响主流程 */ }
  }

  // 记录一次技能使用 (load_skill 时调用)
  trackUse(id) {
    this._usage = this._readUsage();
    const u = this._usage[id] || { uses: 0, lastUsed: null };
    u.uses = (u.uses || 0) + 1;
    u.lastUsed = new Date().toISOString();
    this._usage[id] = u;
    this._saveUsage();
    return u;
  }

  // 某技能使用统计
  useOf(id) { const u = this._readUsage()[id]; return u ? { uses: u.uses || 0, lastUsed: u.lastUsed || null } : { uses: 0, lastUsed: null }; }

  // 全部技能使用统计
  usageAll() { return this._readUsage(); }

  // 重置某技能使用计数 (用中自进化升级完成后调用, 防连跑)
  resetUse(id) {
    this._usage = this._readUsage();
    if (this._usage[id]) { this._usage[id].uses = 0; this._usage[id].lastUpgraded = new Date().toISOString(); this._saveUsage(); }
  }
}
