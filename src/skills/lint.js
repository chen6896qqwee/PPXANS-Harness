// src/skills/lint.js - Skill 质量门槛 (零 LLM, 可接 CI)
// 依据《Skill 蓝皮书 2026》: 元数据与描述质量是 skill 分发的第一瓶颈。
//   error = 阻断 (结构/元数据缺失, 不可分发)
//   warning = 建议 (描述过泛/缺反合理化段, 影响模型能否正确选中)
//
// 2026-10-07 (内置技能层 v2) 两处升级:
//   ① **领域二级目录**: 遍历规则与 SkillLoader 对齐 —— 含 SKILL.md 的目录即技能 (不再下钻),
//      id 为相对路径 (office/docx-report)。旧版只看一层, 会把自己新增的 12 个领域目录
//      整体报成"缺少 SKILL.md"。
//   ② **第三方导入豁免**: 带 frontmatter `source:` (importer 写入的上游仓库标记) 的技能是
//      别人的文本, 我们不重写其章节结构。因此"流程/验证/反合理化"缺失对它们降级为 warning,
//      name 也允许与目录名不同。自研技能仍按原样硬性要求 —— 闸门护的是**自己的**技能库,
//      对上游越俎代庖只会逼出假章节。
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter, stripFrontmatter, parseSections } from "./loader.js";

export const MIN_DESC_LEN = 8;
export const MIN_BODY_LEN = 40;
export const MAX_DEPTH = 2;
const NAME_RE = /^[a-zA-Z0-9-]+$/;

function lintOne(dir, id) {
  const errors = [];
  const warnings = [];
  const leaf = id.includes("/") ? id.split("/").pop() : id;
  const file = path.join(dir, id, "SKILL.md");
  if (!fs.existsSync(file)) {
    errors.push({ id: "no-skill-md", msg: "缺少 SKILL.md" });
    return { name: id, ok: false, errors, warnings };
  }
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    errors.push({ id: "unreadable", msg: "SKILL.md 读取失败: " + String(e?.message || e) });
    return { name: id, ok: false, errors, warnings };
  }
  const fm = parseFrontmatter(raw);
  const body = stripFrontmatter(raw).trim();
  const upstream = !!fm.source; // importer 写入: 第三方来源 (owner/repo)

  if (!fm.name) errors.push({ id: "missing-name", msg: "frontmatter 缺 name" });
  else if (!upstream && fm.name !== leaf) {
    errors.push({ id: "name-mismatch", msg: `name (${fm.name}) 与目录名 (${leaf}) 不一致` });
  } else if (!upstream && !NAME_RE.test(fm.name)) {
    errors.push({ id: "bad-name", msg: "name 仅允许字母/数字/横线 (中文标题请放 name_zh)" });
  }

  if (!fm.description) errors.push({ id: "missing-description", msg: "frontmatter 缺 description (模型选中的唯一依据)" });
  else if (String(fm.description).trim().length < MIN_DESC_LEN) {
    warnings.push({ id: "short-description", msg: `description 过短 (< ${MIN_DESC_LEN} 字), 模型难以判断适用场景` });
  }

  if (!body) errors.push({ id: "empty-body", msg: "正文为空" });
  else if (body.length < MIN_BODY_LEN) {
    warnings.push({ id: "short-body", msg: `正文过短 (< ${MIN_BODY_LEN} 字), 建议补流程/检查点` });
  }

  const secs = parseSections(body);
  const need = (key, code, msg) => {
    if (secs[key]) return;
    if (upstream) warnings.push({ id: `upstream-${code}`, msg: `[第三方技能] ${msg} (上游原文如此, 不代改)` });
    else errors.push({ id: code, msg });
  };
  need("流程", "no-process", '缺 "## 流程" 段');
  need("验证", "no-verify", '缺 "## 验证" 段 (完成后必须提供的证据)');
  if (!secs["反合理化"]) {
    if (upstream) warnings.push({ id: "upstream-no-antirationale", msg: "[第三方技能] 缺 \"## 反合理化\" 段" });
    else warnings.push({ id: "no-antirationale", msg: '缺 "## 反合理化" 段 (常见偷懒借口 + 反驳)' });
  }

  return { name: id, ok: errors.length === 0, errors, warnings, upstream };
}

// 扫描: 含 SKILL.md 的目录即技能 (与 SkillLoader._scan 同规则, id 为 POSIX 相对路径)
export function scanSkillIds(dir, { maxDepth = MAX_DEPTH } = {}) {
  const out = [];
  const walk = (absDir, relDir, depth) => {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    const hasOwn = entries.some((e) => e.isFile() && e.name === "SKILL.md");
    if (hasOwn && relDir) { out.push(relDir); return; }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      walk(path.join(absDir, e.name), relDir ? `${relDir}/${e.name}` : e.name, depth + 1);
    }
  };
  walk(dir, "", 0);
  return out.sort();
}

export function lintSkillDir(dir, { maxDepth = MAX_DEPTH } = {}) {
  if (!fs.existsSync(dir)) return { results: [], pass: 0, warn: 0, fail: 0, error: `技能目录不存在: ${dir}` };

  let ids = [];
  try {
    ids = scanSkillIds(dir, { maxDepth });
  } catch (e) {
    return { results: [], pass: 0, warn: 0, fail: 0, error: `技能目录不可读: ${String(e?.message || e)}` };
  }

  const results = ids.map((id) => lintOne(dir, id));
  const pass = results.filter((r) => r.ok && !r.warnings.length).length;
  const warn = results.filter((r) => r.ok && r.warnings.length).length;
  const fail = results.filter((r) => !r.ok).length;
  return { results, pass, warn, fail, error: null };
}
