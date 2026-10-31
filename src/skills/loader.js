// src/skills/loader.js - 方法技能加载器 (SKILL.md 目录式, v2 多源版)
// 来源: Superpowers / addyosmani-agent-skills 模式 —— 技能=目录 + SKILL.md(frontmatter + ## 章节)
//
// v2 (2026-10-07 全能超级 Agent 内置技能层):
//   ① **多根目录**: 项目级 (.ppx/skills) + 用户级 (~/.ppx/skills) + 内置 (随包分发 skills/) +
//      附加目录。同 id 时**先到的根胜出** (first-wins), roots 顺序即优先级 ——
//      2026-10-31 队列⑥反转为 项目 > 用户 > 内置 (此前内置在前, 同 id 时用户/项目技能被压死)。
//      旧构造函数 `new SkillLoader(dir)` 完全不变。
//   ② **领域二级目录**: `skills/<domain>/<skill>/SKILL.md`。旧扁平 `skills/<skill>/` 继续可用,
//      两者混装 —— 保证已有 12 个技能零迁移。命中 SKILL.md 的目录不再向下递归 (技能内 references/ 不算技能)。
//   ③ 领域来源: frontmatter `domain` 优先; 否则取相对路径首段; 扁平技能归 "misc"。
//
// 设计要点 (沿用 v1):
//  1) 签名缓存 (mtime+size): 内容修改/目录增删后 list()/get() 必须反映变化 (蓝皮书: 发现是生态瓶颈)
//  2) readSection 按需读章节: 只把命中的章节喂给 LLM, 省 token
//  3) 使用追踪 trackUse/useOf/usageAll: 用中自进化 (Hermes) 的前提是知道谁在用、谁闲置
//
// v3 (2026-10-30 OPT-1 扫描缓存): agent 每轮 chat 的 _context() → _skillsPrompt() 都会 list(),
//   而全量 _scan() = 80 次 readdirSync + 67 次 statSync ≈ 5.7ms/轮 (占内核开销 1/3)。
//   readdir 是这里最贵的系统调用 (本机实测 ~70µs/次, stat 仅 ~5µs), 但"目录结构"变化必然
//   改动其父目录的 mtime —— 因此按"扫描时实际 readdir 过的每个目录的 mtimeMs"做有效性签名:
//   下次 _scan() 先 stat 这批目录, 全部未变就复用 index (readdir 80 → 0)。
//   SKILL.md **内容**修改不改变父目录 mtime, 仍由 _load 的 _sigOf (文件 mtime+size) 逐文件检测,
//   语义与 v2 完全一致 (见 test/skills-scan-cache.test.js 的回归)。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

// 目录 mtime 签名的"时间戳合并窗口"护栏 (OPT-1)。
// Windows/NTFS 对**目录**句柄的时间戳更新是合并/延迟的: 实测同一目录在 ~7ms 内的连续条目变更
// 可能只留一个 mtime (刚创建的目录尤其明显 —— 建完目录紧接着往里建子目录, 父目录 mtime 可能
// 永远停在创建那一刻)。因此"扫描时刻距最近一次目录 mtime 太近"时, 该缓存不可信:
// 窗口里紧接的变更可能不改变 mtime。做法: 这种扫描结果标记 provisional, 永不直接复用;
// 下一次调用重扫 (重扫读真实目录, 结果总是对的), 直到窗口过去后的扫描才产出稳定缓存。
// 100ms = 实测最大合并窗口 (~7ms) 的 14 倍余量, 只会让"刚改完技能目录后的头几次 list()"多扫,
// 稳态 (目录长时间未变) 完全走命中路径。
const SCAN_STABLE_MS = 100;

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

// 展开 ~ 前缀 (用户级技能目录: "~/.ppx/skills")
export function expandHome(p) {
  const s = String(p || "");
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
  return s;
}

// 归一化根目录描述: string 或 { id, dir, kind, writable }
function normalizeRoots(input, cfg = {}) {
  const raw = Array.isArray(input)
    ? input
    : (typeof input === "string" && input ? [input] : (Array.isArray(cfg.roots) ? cfg.roots : (cfg.dir ? [cfg.dir] : [])));
  return raw
    .map((r, i) => {
      const o = typeof r === "string" ? { dir: r } : (r || {});
      const dir = expandHome(o.dir);
      if (!dir) return null;
      return {
        id: o.id || (i === 0 ? (cfg.rootId || "builtin") : `root${i}`),
        dir: path.resolve(dir),
        kind: o.kind || (i === 0 ? "builtin" : "user"),
        // 可写根 = 新技能落盘位置 (selfmod create_skill / refine_skill 写这里)
        writable: o.writable !== undefined ? !!o.writable : i === 0,
      };
    })
    .filter(Boolean);
}

export class SkillLoader {
  constructor(input, opts = {}) {
    const isObj = !!input && typeof input === "object" && !Array.isArray(input);
    const cfg = isObj ? { ...input, ...opts } : { ...opts };
    const rootsInput = typeof input === "string" ? input : (isObj ? input.roots : null);
    this.roots = normalizeRoots(rootsInput, cfg);
    // 向后兼容: 老代码 / 老测试读 loader.dir
    this.dir = this.roots[0]?.dir || "";
    // 领域层级深度: 1 = 只认 skills/<skill>/; 2 = 额外认 skills/<domain>/<skill>/
    this.maxDepth = Number.isFinite(cfg.maxDepth) ? Math.max(1, Math.min(3, Math.floor(cfg.maxDepth))) : 2;
    this._cache = new Map(); // id -> { sig, meta }
    // 目录扫描缓存: { dirs: [{ dir, mtimeMs, unreadable? }], index: Map, provisional: boolean }。
    // dirs = 上次扫描 readdir 过的全部目录 (mtimeMs=null 表示扫描时 stat 不到, 如根不存在)。
    this._indexCache = null;
  }

  // 可写根 (新技能落盘处); 全部只读时回落到第一根
  get writeDir() {
    return (this.roots.find((r) => r.writable) || this.roots[0])?.dir || this.dir;
  }

  // 单文件签名: mtime+size (变更即失效缓存)
  _sigOf(file) {
    try {
      const st = fs.statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  // 扫描所有根, 产出 id -> { root, rel, file }。
  // 规则: 目录里有 SKILL.md 即成技能 (不再下钻 —— references/scripts/ 里的 SKILL.md 是素材不是技能)。
  // 同 id 冲突: 先到的根胜出 (内置打底 → 用户覆盖 → 项目收尾 的优先级由 roots 顺序表达)。
  //
  // 缓存 (OPT-1): 命中时零 readdir —— 只 stat 上次扫描过的目录做 mtime 签名校验。
  _scan() {
    const cached = this._indexCache;
    if (cached && this._scanFresh(cached)) return cached.index;
    return this._scanNow();
  }

  // 缓存有效性校验: 上次扫描 readdir 过的每个目录, mtimeMs 必须与扫描时一致。
  // 目录里增/删/改名任何条目都会改动该目录的 mtime, 所以"新增技能目录 / 新增或删除 SKILL.md /
  // 删除技能目录"都能在下一次 list()/get() 被发现并触发重扫。
  // stat 失败 (目录被删 / 根不存在) = 与记录的 null 或旧 mtime 不一致 → 重扫。
  // 另加时间戳合并窗口护栏: 若上次扫描发生在最近一次目录变更的合并窗口内 (见 SCAN_STABLE_MS),
  // 窗口里紧接的变更可能不更新 mtime —— 那次扫描结果一律标记 provisional, 永不直接复用;
  // 直到某次扫描时窗口已过去, 才产出可复用的稳定缓存。
  _scanFresh(cached) {
    if (cached.provisional) return false;
    for (const e of cached.dirs) {
      // 上次扫描时这个目录读不进去 (权限/瞬时错误): 那次结果不能当作"已确认的空目录"复用,
      // 否则权限恢复后新增的技能会永远看不见。一直重扫到能读为止 (与旧版每次重读的行为一致)。
      if (e.unreadable) return false;
      let mtimeMs = null;
      try {
        mtimeMs = fs.statSync(e.dir).mtimeMs;
      } catch {
        mtimeMs = null;
      }
      if (mtimeMs !== e.mtimeMs) return false;
    }
    return true;
  }

  // 真正扫一棵树: 记录每个被 readdir 的目录的 mtimeMs (先 stat 后 readdir)。
  // 先 stat 后 readdir 是有意的安全侧偏差: 两者之间若有写盘, 记录的是写前 mtime,
  // 下一次调用会因此重扫一次 (多扫一次无害; 反之会漏改)。
  _scanNow() {
    const index = new Map();
    const dirs = [];
    let newestMtime = null; // 最近一次目录变更时刻 (决定缓存何时可被信任)
    const walk = (root, absDir, relDir, depth) => {
      let mtimeMs = null;
      try {
        mtimeMs = fs.statSync(absDir).mtimeMs;
      } catch {
        mtimeMs = null; // 根不存在 / 权限失败: 记录 null, 之后出现或消失都能被校验发现
      }
      if (mtimeMs !== null && (newestMtime === null || mtimeMs > newestMtime)) newestMtime = mtimeMs;
      dirs.push({ dir: absDir, mtimeMs });
      let entries;
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        // 读目录失败不抛错。分两种:
        //  - stat 也失败 (mtimeMs=null) → 根不存在 (常见: 未创建的用户级根), 记录 null 即可,
        //    它出现时 stat 会给出数字 → 校验发现不一致 → 重扫; 不得因此让缓存永久失效。
        //  - stat 成功但 readdir 失败 → 权限/瞬时错误, 那次结果不能当成"已确认的空目录"复用,
        //    否则权限恢复后技能永远看不见; 标记 unreadable, 一直重扫到能读为止。
        if (mtimeMs !== null) dirs[dirs.length - 1].unreadable = true;
        return;
      }
      const hasOwn = entries.some((e) => e.isFile() && e.name === "SKILL.md");
      if (hasOwn && relDir) {
        // first-wins: 同 id 出现在多个根时, 先到的根胜出 (roots 顺序 = 优先级, 2026-10-31 起
        // 为 项目 > 用户 > 内置)。用 Map.set 直接写会变成后到者覆盖 —— 那会让
        // "项目技能压过用户/内置"的语义反过来。
        if (!index.has(relDir)) index.set(relDir, { root, rel: relDir, file: path.join(absDir, "SKILL.md") });
        return;
      }
      if (depth >= this.maxDepth) return;
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        walk(root, path.join(absDir, e.name), relDir ? `${relDir}/${e.name}` : e.name, depth + 1);
      }
    };
    for (const root of this.roots) walk(root, root.dir, "", 0);
    const now = Date.now();
    // 扫描时刻离最近一次目录变更太近 → 合并窗口内可能还有"看不见 mtime"的变更:
    // 本次结果标记为临时, 下一次调用必须重扫。
    // 用 |now - mtime| 而不是 now - mtime: NTFS 的 mtime 精度高于 Date.now 的毫秒,
    // 实测刚创建的目录 mtime 可领先 Date.now 数毫秒 (时间戳取整), 减法会错判成"很久以前"。
    // 明显在未来的 mtime (时钟漂移/带未来时间戳的拷贝) 不需要窗口: 后续变更会写成更小的
    // "现在", 相等性校验仍能发现。
    const delta = newestMtime === null ? Infinity : Math.abs(now - newestMtime);
    const provisional = delta < SCAN_STABLE_MS;
    this._indexCache = { dirs, index, provisional };
    return index;
  }

  // 显式失效扫描缓存: 供写盘路径 (create_skill / refine_skill / importer / 外部批量落盘) 调用。
  // 不调用也安全 —— 目录 mtime 签名会在下一次 list()/get() 自动发现变化; 这里只是省掉一次校验。
  invalidate() {
    this._indexCache = null;
  }

  // 全部技能 id (排序稳定)
  _ids() {
    return [...this._scan().keys()].sort();
  }

  // index 可选: 批量路径 (list) 复用它, 避免每个技能各扫一遍目录树 (n×readdir → 1×readdir)
  _load(id, index = null) {
    const key = String(id || "");
    if (!key) return null;
    const hit = (index || this._scan()).get(key);
    if (!hit) {
      this._cache.delete(key);
      return null;
    }
    const sig = this._sigOf(hit.file);
    if (sig === null) {
      this._cache.delete(key);
      return null;
    }
    const cached = this._cache.get(key);
    // 2026-10-31 (队列⑥): 缓存命中必须同时比对**文件身份** (hit.file)。多根 first-wins 下,
    //   同 id 会随上层根的增删在不同根的文件间迁移 —— 只按 sig (mtime+size) 比对时, 两个根
    //   的同尺寸 SKILL.md 写进同一 NTFS 时间戳 tick (粒度 ~16ms, FactStore 修过同款) 会被
    //   误判"未变", 迁移后继续返回旧根内容。
    if (cached && cached.file === hit.file && cached.sig === sig) return cached.meta;
    let raw = "";
    try {
      raw = fs.readFileSync(hit.file, "utf8");
    } catch {
      this._cache.delete(key);
      return null;
    }
    const fm = parseFrontmatter(raw);
    const meta = {
      id: key,
      // name_zh: 中文显示名 (name 必须是 ASCII 目录叶子名 —— lint 与创建工具都以它做机器标识)
      name: String(fm.name_zh || fm.name || key),
      slug: String(fm.name || (key.includes("/") ? key.split("/").pop() : key)),
      description: String(fm.description || ""),
      domain: String(fm.domain || (key.includes("/") ? key.split("/")[0] : "misc")),
      tags: String(fm.tags || "").split(",").map((s) => s.trim()).filter(Boolean),
      risk: String(fm.risk || "low"),
      requiresHuman: String(fm.requires_human || "") === "true",
      version: String(fm.version || ""),
      upstream: String(fm.source || ""),
      source: hit.root.kind,
      frontmatter: fm,
      body: stripFrontmatter(raw),
      file: hit.file,
    };
    this._cache.set(key, { sig, meta, file: hit.file });
    return meta;
  }

  // 列出全部技能 (id/name/description/domain/source), 目录增删与内容修改都会反映
  list() {
    const index = this._scan();
    const ids = [...index.keys()].sort();
    const keep = new Set(ids);
    for (const k of [...this._cache.keys()]) if (!keep.has(k)) this._cache.delete(k);
    const out = [];
    for (const id of ids) {
      const m = this._load(id, index);
      if (m) out.push({
        id: m.id, name: m.name, description: m.description,
        domain: m.domain, tags: m.tags, source: m.source, version: m.version,
      });
    }
    return out;
  }

  has(id) {
    return this._load(String(id || "")) !== null;
  }

  get(id) {
    const m = this._load(String(id || ""));
    if (!m) return null;
    return {
      id: m.id, name: m.name, description: m.description,
      domain: m.domain, tags: m.tags, risk: m.risk, requiresHuman: m.requiresHuman,
      source: m.source, version: m.version, frontmatter: m.frontmatter, file: m.file,
    };
  }

  // 领域归属 (供注册表统计覆盖率; id 不存在时返回 null)
  domainOf(id) {
    const m = this._load(String(id || ""));
    return m ? m.domain : null;
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
    return path.join(this.writeDir, USAGE_FILE);
  }

  _readUsage() {
    return readJsonSafe(this._usageFile(), {});
  }

  _writeUsage(u) {
    const dir = this.writeDir;
    try {
      fs.mkdirSync(dir, { recursive: true });
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
