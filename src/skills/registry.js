// src/skills/registry.js - 技能注册表 (领域分类 + 多源装配 + 覆盖率自述)
//
// 定位: 在 SkillLoader (负责"读") 之上补一层"知道有什么、缺什么、从哪来"。
//   ① 12 个领域域目录 (11 个能力域 + 1 个元能力域): 技能内置进 PPX 后的**能力面坐标**
//   ② 多源装配: 项目级 (.ppx/skills) > 用户级 (~/.ppx/skills) > 内置 (随包) > 附加目录,
//      roots 顺序即优先级 (2026-10-31 队列⑥反转, 旧序为内置优先)
//   ③ coverage(): 每个领域覆盖了几个技能 —— "全能超级 Agent"的自证材料, 也是缺口清单
//
// 与 loader 的分工: 本模块不碰文件读取细节, 只做归一与统计。任何 loader 兼容的目录都能装配。
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { SkillLoader, expandHome } from "./loader.js";
import { scoreSkills } from "./search.js";

// 领域域目录: id 必须与 skills/<id>/ 目录名一致 (frontmatter domain 也可引用这些 id)
export const SKILL_DOMAINS = [
  { id: "knowledge", name: "信息与知识处理", desc: "检索、抓取、事实核查、多源蒸馏" },
  { id: "planning", name: "任务规划与执行", desc: "任务拆解、项目排期、长任务跟踪" },
  { id: "office", name: "办公与生产力", desc: "文档、表格、演示、会议纪要" },
  { id: "code", name: "代码与 IT 自动化", desc: "代码审查、测试、仓库上手、MCP/自动化" },
  { id: "data", name: "数据与决策支持", desc: "数据剖析、指标口径、决策矩阵" },
  { id: "content", name: "内容与创意", desc: "文案、脚本、视觉设计、图像提示词" },
  { id: "research", name: "科研与教育", desc: "文献综述、论文精读、教学方案" },
  { id: "business", name: "商业与专业辅助", desc: "商业分析、品牌与对外沟通" },
  { id: "life", name: "个人生活助理", desc: "行程规划、生活事务" },
  { id: "multimodal", name: "多模态与具身智能", desc: "图像/音频/视频理解与生成" },
  { id: "collab", name: "多 Agent 协作", desc: "军团编排、专家班组、任务分派" },
  { id: "meta", name: "元能力与自进化", desc: "技能创作、能力边界、自我改进" },
];

// 领域 id 集合 (校验用)
export const DOMAIN_IDS = new Set(SKILL_DOMAINS.map((d) => d.id));

// 内置技能根目录 (随 npm 包分发)
export function builtinSkillsDir(root) {
  return path.join(root, "skills");
}

// 用户级技能根目录 (跨项目复用; 与内置隔离, 便于用户自己扩装而不动源码)
export function userSkillsDir() {
  return path.join(os.homedir(), ".ppx", "skills");
}

// 依配置装配技能源。config.skills:
//   { builtin: true, user_dir: "~/.ppx/skills", project_dir: "<root>/.ppx/skills", extra_dirs: [], max_depth: 2 }
// 优先级 (2026-10-31 队列⑥反转): **项目级 > 用户级 > 内置 > 附加目录**。
//   项目技能 (.ppx/skills, 与 .ppx/commands 同锚点) 是对当前仓库的定制, 必须压过全局用户
//   技能与随包内置 (项目里放同 id 技能 = 有意覆盖); 附加目录 (extra_dirs: 团队共享盘/下载
//   的技能包) 优先级最低。语义由 roots 顺序表达, loader 端同 id 先到的根胜出 (first-wins)。
//   此前顺序是 [builtin, user, project] + first-wins = **内置压住一切** —— 与 v2 文档宣称的
//   "用户覆盖内置"直接相反, 用户级/项目级放同 id 技能形同虚设。
// 可写根: 项目 > 用户。create_skill / 技能导入落这里 —— 用户产物不写进代码树
//   (内置根在 npm 装机时位于 node_modules, 升级替换包目录即冲掉), 内置根只读。
export function skillRootsFromConfig(config, root) {
  const c = config?.skills || {};
  const roots = [];
  // 项目根默认 <root>/.ppx/skills; project_dir: "" 显式关闭 (与 user_dir 同款三态: 未设=默认 / ""=关 / 值=自定义)
  const projectDir = c.project_dir === "" ? "" : expandHome(c.project_dir || path.join(root, ".ppx", "skills"));
  if (projectDir) roots.push({ id: "project", dir: projectDir, kind: "project", writable: true });
  const userDir = c.user_dir === "" ? "" : expandHome(c.user_dir || userSkillsDir());
  if (userDir) roots.push({ id: "user", dir: userDir, kind: "user", writable: true });
  if (c.builtin !== false) {
    roots.push({ id: "builtin", dir: builtinSkillsDir(root), kind: "builtin", writable: false });
  }
  for (const [i, d] of (Array.isArray(c.extra_dirs) ? c.extra_dirs : []).entries()) {
    if (!d) continue;
    roots.push({ id: `extra${i}`, dir: expandHome(d), kind: "extra" });
  }
  // 兜底: 全关也至少留内置 (否则技能系统整体失效, 属配置误用); 兜底根可写, 否则 create_skill 无处落盘
  if (!roots.length) roots.push({ id: "builtin", dir: builtinSkillsDir(root), kind: "builtin", writable: true });
  // 去重 (同目录多 id 只留先到者 —— 先到者优先级更高)
  const seen = new Set();
  return roots.filter((r) => {
    const k = path.resolve(r.dir).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function createSkillLoader(config, root) {
  const roots = skillRootsFromConfig(config, root);
  return new SkillLoader({ roots, maxDepth: config?.skills?.max_depth });
}

// 一步装配: 配置 → (roots + loader + registry)。agent 与 toolsPlugin 共用这一个入口,
// 保证"读技能"的实例只有一份 (两份实例会各自维护缓存与使用计数, 覆盖率与热度统计会分叉)。
// ---- 评测期技能过滤钩子 (2026-10-09 补) ----
// skill-eval 需要"只跑子集"的能力: PPX_DISABLE_SKILLS="a,b" 环境变量按 id 禁用技能。
// 不设该 env 时行为完全不变 (零侵入), 这也是它被设计成 env 而非配置项的原因 —— 评测的临时开关
// 不该污染用户 config。
export function disabledSkillsFromEnv() {
  const raw = process.env.PPX_DISABLE_SKILLS;
  if (!raw) return [];
  return [...new Set(String(raw).split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

// 把 env 里的禁用清单作用到注册表上, 并返回该清单 (无 env → 空数组)
export function applySkillEvalFilter(registry) {
  const list = disabledSkillsFromEnv();
  if (registry) registry.disabledSkills = list;
  return list;
}

export function createSkillRegistry(config, root) {
  const roots = skillRootsFromConfig(config, root);
  const loader = new SkillLoader({ roots, maxDepth: config?.skills?.max_depth });
  const reg = new SkillRegistry({ loader, roots });
  applySkillEvalFilter(reg);
  return reg;
}

export class SkillRegistry {
  constructor({ loader = null, roots = [], domains = SKILL_DOMAINS, disabledSkills = [] } = {}) {
    this.roots = roots;
    this.domains = domains;
    this.loader = loader || new SkillLoader({ roots });
    this.disabledSkills = disabledSkills;
  }

  // 全部技能 (可过滤)
  list({ domain = null, source = null, q = null } = {}) {
    let out = this.loader.list();
    if (this.disabledSkills && this.disabledSkills.length) {
      const off = new Set(this.disabledSkills);
      out = out.filter((s) => !off.has(String(s.id).toLowerCase()));
    }
    if (domain) out = out.filter((s) => s.domain === domain);
    if (source) out = out.filter((s) => s.source === source);
    if (q) {
      const needle = String(q).toLowerCase();
      out = out.filter((s) => `${s.id} ${s.name} ${s.description}`.toLowerCase().includes(needle));
    }
    return out;
  }

  get(id) { return this.loader.get(id); }
  read(id) { return this.loader.read(id); }
  readSection(id, section) { return this.loader.readSection(id, section); }
  has(id) { return this.loader.has(id); }
  trackUse(id) { return this.loader.trackUse(id); }
  useOf(id) { return this.loader.useOf(id); }
  usageAll() { return this.loader.usageAll(); }
  resetUse(id) { return this.loader.resetUse(id); }
  // 检索: 复用 search.js 的打分口径 (name 加权 > description), 不另起一套
  scoreSkills(query, opts) { return scoreSkills(this.loader, query, opts); }

  // 领域覆盖统计: 每个领域有几个技能、来自哪些源、常用度如何
  coverage() {
    const all = this.loader.list();
    const usage = this.loader.usageAll();
    const registered = new Set(this.domains.map((d) => d.id));
    const byDomain = new Map(this.domains.map((d) => [d.id, { ...d, count: 0, skills: [], sources: new Set(), uses: 0 }]));
    // 未登记域名的技能 (misc / 拼错的 domain) 汇到同一个桶里, 但**不冒充一个已覆盖的登记域**
    const others = { id: "uncategorized", name: "未分类", desc: "domain 未在域目录中登记", count: 0, skills: [], sources: new Set(), uses: 0 };
    for (const s of all) {
      const key = s.domain || "misc";
      let bucket = byDomain.get(key);
      if (!bucket) {
        // 只有已登记的域才进 byDomain (键 = 域 id, 与桶的 id 一致性由这里保证);
        // 未登记的统统并入 others。
        if (registered.has(key)) { bucket = { ...SKILL_DOMAINS.find((d) => d.id === key), count: 0, skills: [], sources: new Set(), uses: 0 }; }
        else bucket = others;
      }
      bucket.count += 1;
      bucket.skills.push(s.id);
      bucket.sources.add(s.source || "builtin");
      bucket.uses += Number(usage[s.id]?.uses || 0);
    }
    const toObj = (d) => ({
      id: d.id, name: d.name, desc: d.desc, count: d.count,
      skills: d.skills, sources: [...d.sources], uses: d.uses,
      covered: d.count > 0,
    });
    // 域目录内的登记域 (coverage 的分母只算它们)
    const domains = this.domains.map((d) => toObj(byDomain.get(d.id)));
    const covered = domains.filter((d) => d.covered).length;
    return {
      total: all.length,
      domains,
      unregistered: others.count ? [toObj(others)] : [],
      domainCount: this.domains.length,
      coveredDomains: covered,
      // 覆盖率 = 有技能的登记域 / 登记域总数 ("全能"程度的单一数字)
      coverage: this.domains.length ? covered / this.domains.length : 0,
      uncovered: domains.filter((d) => !d.covered).map((d) => d.id),
      sources: this.roots.map((r) => ({ id: r.id, kind: r.kind, dir: r.dir, exists: this._exists(r.dir) })),
    };
  }

  _exists(dir) {
    try { return fs.existsSync(dir); } catch { return false; }
  }

  // 一段可直接注入 prompt 的领域摘要 (紧凑; 只在 --verbose 场景用)
  domainSummary() {
    const cov = this.coverage();
    return cov.domains
      .map((d) => `${d.name}(${d.count})`)
      .join(" · ");
  }
}

export default { SkillRegistry, SKILL_DOMAINS, DOMAIN_IDS, createSkillLoader, createSkillRegistry, skillRootsFromConfig, builtinSkillsDir, userSkillsDir };
