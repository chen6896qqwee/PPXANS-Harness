// src/skills/verify.js - 技能入库/升级验证闸门 (零 LLM, 确定性)
// 设计依据: self-evolution "reliable verification" —— gate before persist.
//   入库闸门 (verifySkill):      结构(## 流程 + ## 验证) + 接地(正文引用高频工具) + 轨迹背书(该工具有足够成功调用)
//   升级闸门 (verifyUpgradeSkill): 结构不缩水 + 正文不缩水(防退化) + 有实质变化
// 目标: 幻觉技能/退化技能一律拦在落盘之前, 保证 skills/ 目录只进"被真实轨迹背书"的方法。
import { parseSections } from "./loader.js";

// 技能正文必须包含的章节 (与 learning-service 的 "## Process + ## Verify" 语义一致)
export const requiredSections = ["流程", "验证"];

// 正文长度下限 (低于视为"只写了标题没写实质")
export const MIN_CONTENT_LEN = 20;

// 升级版相对旧版的最小长度比 (低于即判"缩水退步")
export const MIN_UPGRADE_RATIO = 0.8;

// 正文是否真实引用了高频工具 (按整词匹配, 避免子串误判)。命中返回工具名, 否则 null。
export function groundedInTools(content, hotTools = []) {
  const text = String(content || "");
  for (const t of hotTools) {
    const name = String(t || "").trim();
    if (!name) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-zA-Z0-9_])${esc}([^a-zA-Z0-9_]|$)`).test(text)) return name;
  }
  return null;
}

// 章节齐全性检查 → 缺失章节数组
export function missingSections(content) {
  const secs = parseSections(String(content || ""));
  return requiredSections.filter((s) => !secs[s] || !String(secs[s]).trim());
}

// 入库闸门: 结构 + 接地 + 轨迹背书
// opts: { name, content, hotTools, okTraces, minFreq, heldOutTraces }
export function verifySkill({ name = "", content = "", hotTools = [], okTraces = [], minFreq = 2, heldOutTraces = null } = {}) {
  const body = String(content || "").trim();
  if (!body) return { ok: false, reason: "内容为空" };

  // 1) 结构: 必需章节齐全
  const missing = missingSections(body);
  if (missing.length) return { ok: false, reason: "缺少必要章节: " + missing.join(" / ") };

  // 2) 实质: 长度下限 (必须在接地检查之前 —— 空壳正文应报"太短"而非"未引用")
  if (body.length < MIN_CONTENT_LEN) return { ok: false, reason: `内容太短 (< ${MIN_CONTENT_LEN} 字), 疑似空壳` };

  // 3) 接地: 必须引用至少一个高频工具
  const matchedTool = groundedInTools(body, hotTools);
  if (!matchedTool) {
    const list = (hotTools || []).filter(Boolean).slice(0, 6).join(", ") || "(无)";
    return { ok: false, reason: `内容未引用任何高频工具, 疑似幻觉技能. 应引用的工具: ${list}` };
  }

  // 4) 轨迹背书: 该高频工具要有足够成功调用 (minFreq 为频次门槛)
  const traceCount = (okTraces || []).filter((t) => t && t.tool === matchedTool).length;
  if (traceCount < minFreq) {
    return { ok: false, reason: `高频工具 ${matchedTool} 的成功轨迹不足 (${traceCount}/${minFreq})`, matchedTool, traceCount };
  }

  // 5) held-out 回归 (可选): 样本够多时切出的未见子集也要有背书, 防过拟合
  if (Array.isArray(heldOutTraces) && heldOutTraces.length) {
    const heldCount = heldOutTraces.filter((t) => t && t.tool === matchedTool).length;
    if (heldCount < 1) {
      return { ok: false, reason: `held-out 子集中无 ${matchedTool} 的背书 (疑似过拟合)`, matchedTool, traceCount };
    }
  }

  return { ok: true, reason: null, matchedTool, traceCount, name };
}

// 升级闸门: 防退化 (结构不缩水 + 正文不缩水) + 必须真的有变化
// opts: { content, prevContent }
export function verifyUpgradeSkill({ content = "", prevContent = "" } = {}) {
  const next = String(content || "").trim();
  const prev = String(prevContent || "");
  if (!next) return { ok: false, reason: "升级结果为空" };

  // 1) 结构: 不得丢掉必需章节 (防"改着改着把验证段删了")
  const missing = missingSections(next);
  if (missing.length) return { ok: false, reason: "升级版缺少必要章节: " + missing.join(" / ") };

  // 2) 实质长度
  if (next.length < MIN_CONTENT_LEN) return { ok: false, reason: `升级版内容太短 (< ${MIN_CONTENT_LEN} 字)` };

  // 3) 缩水检测: 相对旧版大幅变短即判退化
  if (prev.trim() && next.length < prev.trim().length * MIN_UPGRADE_RATIO) {
    return { ok: false, reason: `升级版正文缩水 (${next.length} < ${prev.trim().length} × ${MIN_UPGRADE_RATIO})` };
  }

  const changed = next !== prev.trim();
  if (!changed) return { ok: false, reason: "升级版与旧版完全相同, 无实质变化", changed: false };

  return { ok: true, reason: null, changed: true };
}
