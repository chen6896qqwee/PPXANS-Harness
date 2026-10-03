// src/skills/lint.js - Skill 质量门槛 (零 LLM, 可接 CI)
// 依据《Skill 蓝皮书 2026》: 元数据与描述质量是 skill 分发的第一瓶颈。
//   error = 阻断 (结构/元数据缺失, 不可分发)
//   warning = 建议 (描述过泛/缺反合理化段, 影响模型能否正确选中)
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter, stripFrontmatter, parseSections } from "./loader.js";

export const MIN_DESC_LEN = 8;
export const MIN_BODY_LEN = 40;
const NAME_RE = /^[a-zA-Z0-9-]+$/;

function lintOne(dir, id) {
  const errors = [];
  const warnings = [];
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

  if (!fm.name) errors.push({ id: "missing-name", msg: "frontmatter 缺 name" });
  else if (fm.name !== id) errors.push({ id: "name-mismatch", msg: `name (${fm.name}) 与目录名 (${id}) 不一致` });
  if (fm.name && !NAME_RE.test(fm.name)) errors.push({ id: "bad-name", msg: "name 仅允许字母/数字/横线" });

  if (!fm.description) errors.push({ id: "missing-description", msg: "frontmatter 缺 description (模型选中的唯一依据)" });
  else if (String(fm.description).trim().length < MIN_DESC_LEN) {
    warnings.push({ id: "short-description", msg: `description 过短 (< ${MIN_DESC_LEN} 字), 模型难以判断适用场景` });
  }

  if (!body) errors.push({ id: "empty-body", msg: "正文为空" });
  else if (body.length < MIN_BODY_LEN) {
    warnings.push({ id: "short-body", msg: `正文过短 (< ${MIN_BODY_LEN} 字), 建议补流程/检查点` });
  }

  const secs = parseSections(body);
  if (!secs["流程"]) errors.push({ id: "no-process", msg: '缺 "## 流程" 段' });
  if (!secs["验证"]) errors.push({ id: "no-verify", msg: '缺 "## 验证" 段 (完成后必须提供的证据)' });
  if (!secs["反合理化"]) warnings.push({ id: "no-antirationale", msg: '缺 "## 反合理化" 段 (常见偷懒借口 + 反驳)' });

  return { name: id, ok: errors.length === 0, errors, warnings };
}

export function lintSkillDir(dir) {
  if (!fs.existsSync(dir)) return { results: [], pass: 0, warn: 0, fail: 0, error: `技能目录不存在: ${dir}` };
  let ids = [];
  try {
    ids = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => !n.startsWith("."))
      .sort();
  } catch (e) {
    return { results: [], pass: 0, warn: 0, fail: 0, error: `技能目录不可读: ${String(e?.message || e)}` };
  }

  const results = ids.map((id) => lintOne(dir, id));
  const pass = results.filter((r) => r.ok && !r.warnings.length).length;
  const warn = results.filter((r) => r.ok && r.warnings.length).length;
  const fail = results.filter((r) => !r.ok).length;
  return { results, pass, warn, fail, error: null };
}
