// src/skills/verify.js - 技能入库前确定性验证闸门
// 背景 (DeepSeek-Harness 自进化四拼图之「可靠验证」):
//   refineSkill 由 LLM 提炼技能后直接 create_skill 落盘, 无独立验收环节 —
//   「完成是自报的, 没有独立验收者」。这会让半成品/幻觉技能污染 skills/。
//   本模块提供确定性验收 (不依赖 LLM, 静态可测, 缺一即拒):
//   - 结构验收: SKILL.md 必须含 ## 流程 + ## 验证
//   - 落地接地: 内容必须真实引用提炼它的高频工具, 且该工具确有 ≥minFreq 条近期成功轨迹
//   - held-out 回归: (P0② Self-Harness) 若提供 heldOutTraces, 要求接地工具在未见过的子集也有背书, 防过拟合
// 用法: verifySkill({ name, content, hotTools, okTraces, minFreq, heldOutTraces })
//   -> { ok: boolean, reason?: string, matchedTool?, traceCount?, heldOutCount? }

// 结构验收: 验收必需段落 (create_skill 契约为 流程/反合理化/验证; 至少 流程+验证 缺一不可)
export function requiredSections(content) {
  const c = String(content || "");
  const need = ["## 流程", "## 验证"];
  const missing = need.filter((s) => !c.includes(s));
  return {
    ok: missing.length === 0,
    missing,
    hasFlow: c.includes("## 流程"),
    hasVerify: c.includes("## 验证"),
  };
}

// 落地接地: 技能内容是否真实基于提炼它的高频工具 (反幻觉)
export function groundedInTools(content, hotTools = []) {
  const c = String(content || "");
  const names = (Array.isArray(hotTools) ? hotTools : []).filter(Boolean);
  if (names.length === 0) return { ok: false, reason: "无高频工具可核对" };
  const hit = names.find((t) => c.toLowerCase().includes(String(t).toLowerCase()));
  return { ok: !!hit, matchedTool: hit || null, hotTools: names.slice(0, 5) };
}

// 轨迹接地: 该工具确有 ≥minFreq 条近期成功轨迹
export function traceBacked(tool, okTraces = [], minFreq = 2) {
  const arr = Array.isArray(okTraces) ? okTraces : [];
  if (!tool) return { ok: false, reason: "无工具名" };
  const n = arr.filter((t) => t && String(t.tool) === tool).length;
  return { ok: n >= minFreq, count: n, minFreq, tool };
}

// held-out 回归闸门 (Self-Harness: 候选改动必须在 held-out 子集也不退化才合并)
// 用途: refineSkill 提炼的技能若只在训练轨迹接地、在未见过的 held-out 轨迹里不接地 = 过拟合 → 拒
export function verifyHeldOut({ tool, heldOutTraces = [], minFreq = 2 } = {}) {
  const need = Math.max(1, Math.floor(minFreq / 2));
  if (!tool) return { ok: false, reason: "无工具名", need };
  const n = (Array.isArray(heldOutTraces) ? heldOutTraces : []).filter((t) => t && String(t.tool) === tool).length;
  return { ok: n >= need, count: n, need, tool };
}

// 总闸门
export function verifySkill({ name, content, hotTools, okTraces, minFreq = 2, heldOutTraces } = {}) {
  // 1. 结构验收
  const s = requiredSections(content);
  if (!s.ok) {
    return { ok: false, reason: `技能缺必需段落: ${s.missing.join(", ")} (SKILL.md 契约要求 ## 流程 + ## 验证)` };
  }
  // 内容太短 (只够段落标题没实质步骤) 也拒
  const body = String(content || "").replace(/##\s*\S+/g, "").trim();
  if (body.length < 20) {
    return { ok: false, reason: "技能内容太短, 缺实质步骤/检查点" };
  }
  // 2. 落地接地: 内容引用高频工具
  const g = groundedInTools(content, hotTools);
  if (!g.ok) {
    return { ok: false, reason: `技能内容未引用提炼它的高频工具 (${g.hotTools.join(", ")})` };
  }
  // 3. 轨迹接地: 该工具有足够近期成功轨迹背书
  const tb = traceBacked(g.matchedTool, okTraces, minFreq);
  if (!tb.ok) {
    return { ok: false, reason: `工具 ${g.matchedTool} 成功轨迹不足 (${tb.count}/${tb.minFreq})` };
  }
  // 4. held-out 回归: 若提供, 要求接地工具在 held-out 子集也有 ≥ceil(minFreq/2) 条成功轨迹背书 (防过拟合训练集)
  if (heldOutTraces && Array.isArray(heldOutTraces)) {
    const ho = verifyHeldOut({ tool: g.matchedTool, heldOutTraces, minFreq });
    if (!ho.ok) {
      return { ok: false, reason: `工具 ${g.matchedTool} held-out 回归轨迹不足 (${ho.count}/${ho.need}), 疑似过拟合训练集` };
    }
  }
  return { ok: true, matchedTool: g.matchedTool, traceCount: tb.count, heldOutCount: (heldOutTraces && Array.isArray(heldOutTraces)) ? traceBacked(g.matchedTool, heldOutTraces, 1).count : null };
}

// 技能升级专用验收 (用中自进化): 不重新做 grounding (创建时已接地验证),
// 重点防止退化: 缺段落 / 正文缩水 / 变空。返回 { ok, reason, changed }
export function verifyUpgradeSkill({ content, prevContent }) {
  const c = String(content || "").replace(/^---[\s\S]*?---\s*/, ""); // 剥 frontmatter (skills.read 返回 ---meta--- 全文)
  const p = String(prevContent || "").replace(/^---[\s\S]*?---\s*/, "");
  // 1. 结构验收 (必须仍含 流程+验证)
  const s = requiredSections(c);
  if (!s.ok) return { ok: false, reason: "升级版缺必需段落: " + s.missing.join(", ") };
  // 2. 正文不缩水 (去段落标题后比旧版短 = 退化)
  const bodyNow = c.replace(/##\s*\S+/g, "").trim();
  const bodyPrev = p.replace(/##\s*\S+/g, "").trim();
  if (bodyNow.length < 20) return { ok: false, reason: "升级版内容太短" };
  if (bodyPrev.length && bodyNow.length < bodyPrev.length * 0.6) {
    return { ok: false, reason: "升级版正文缩水 (" + bodyNow.length + "<" + Math.ceil(bodyPrev.length * 0.6) + "), 疑似退化" };
  }
  const changed = bodyNow !== bodyPrev;
  return { ok: true, changed };
}