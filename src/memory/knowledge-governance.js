// src/memory/knowledge-governance.js - 技能/教训知识治理 (退休候选扫描) (2026-11-15)
//
// 病根: eviction.js 的治理边界明确只覆盖 L1 FactStore + 会话日志; 自动蒸馏产出的
//   lessons (experience/lessons.json) 和 skills (skills/<name>/SKILL.md) 只进不出 ——
//   唯一的收敛是写入侧同义合并。知识生命周期 (支持/矛盾/替换/退休) 缺最后一段。
//
// 本模块补"报告+标记"那一段, 与 eviction.js 同纪律:
//   1. scan 确定性产出退休候选 (冲突 / 零命中 / 长期闲置), 只读不改任何数据;
//   2. 硬动作 (lesson 退休 / skill 停用) 只经显式调用 (retireLesson / disableSkill),
//      绝不因为扫描结果自动删 —— 误删已验证知识比留着更糟。
//   skill 的持久停用走 config.skills.disabled (设置页同路径); 本模块给的是即时停用 +
//   报告里明确提示"需要写入 config 才跨重启", 不越权改配置。
//
// 零 LLM、零依赖、确定性。接入: bootstrap 挂 agent.knowledgeGovernance.status();
// 消费方 (Web UI / evolve loop / 人工) 拿报告后自行决定是否调用 retire 动作。
import { info } from "../utils/logger.js";
import { noteCatch } from "../utils/catch-log.js";

// 长期闲置阈值 (天): 与 eviction.js COLD_DAYS 同口径, 治理节奏一致
const COLD_DAYS = 14;
// 报告每类最多列几条 (防报告本身膨胀)
const REPORT_LIMIT = 30;
// 命中次数低于此且闲置超期 → 退休候选 (高频在用的闲置不误伤)
const LOW_USE_FLOOR = 1;

const DAY = 86400000;
const ageDays = (ts, now) => (Number.isFinite(ts) ? Math.max(0, Math.floor((now - ts) / DAY)) : null);

function tsOf(v) {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

// ---- 技能教训退休候选扫描 (只读) ----
export function scanKnowledge({ experience, skills, now = Date.now(), coldDays = COLD_DAYS } = {}) {
  const report = {
    scannedAt: new Date(now).toISOString(),
    lessons: { total: 0, active: 0, conflicted: [], zeroUse: [], stale: [], noApplicability: [] },
    skills: { total: 0, disabledCount: 0, zeroUse: [], stale: [] },
    candidatesCount: 0,
  };

  // ---- lessons: 冲突 > 零命中 > 长期闲置, 三类候选互斥归类 (一条只进最严重的那桶) ----
  try {
    const all = experience?.list?.({ includeRetired: true }) || [];
    const active = all.filter((l) => !l.retiredAt);
    report.lessons.total = all.length;
    report.lessons.active = active.length;
    report.lessons.retired = all.length - active.length;
    for (const l of active) {
      const age = ageDays(tsOf(l.ts), now);
      const conflicted = (Array.isArray(l.conflicts) && l.conflicts.length > 0)
        || (Array.isArray(l.challengedBy) && l.challengedBy.length > 0);
      const row = {
        id: l.id, lesson: String(l.lesson || "").slice(0, 100), uses: l.uses || 0,
        ageDays: age, ts: l.ts || null,
      };
      if (conflicted) {
        report.lessons.conflicted.push({ ...row, conflicts: l.conflicts || [], challengedBy: l.challengedBy || [] });
      } else if ((l.uses || 0) < LOW_USE_FLOOR && age !== null && age > coldDays) {
        report.lessons.zeroUse.push(row);
      } else if ((l.uses || 0) < LOW_USE_FLOOR && age === null) {
        report.lessons.zeroUse.push({ ...row, ageDays: null });
      }
      // 适用条件缺失 (2026-11-15, 信息性候选, 不进退休分桶): 无 applicability 的自动教训
      //   是"没有边界的结论" —— 无法被后续效果对照当作可证伪假设检验。只列出提醒补蒸馏,
      //   不自动退休 (缺条件 ≠ 错误)。
      if (Array.isArray(l.tags) && l.tags.includes("auto-refine") && !l.applicability) {
        report.lessons.noApplicability.push({ ...row, tags: l.tags });
      }
    }
    for (const key of ["conflicted", "zeroUse", "noApplicability"]) {
      report.lessons[key] = report.lessons[key].slice(0, REPORT_LIMIT);
    }
  } catch (e) { noteCatch("src/memory/knowledge-governance.js#scan-lessons", e); report.lessons.error = "scan-failed"; }

  // ---- skills: 零使用 / 长期闲置 (uses 来自 loader 的使用追踪, useOf/usageAll) ----
  try {
    const all = skills?.listAll?.() || skills?.list?.() || [];
    report.skills.total = all.length;
    for (const m of all) {
      if (skills.isDisabled?.(m.id)) { report.skills.disabledCount += 1; continue; }
      const u = skills.useOf ? skills.useOf(m.id) : { uses: 0, lastUsed: null };
      const idleDays = ageDays(tsOf(u.lastUsed), now);
      const row = { id: m.id, name: m.name || m.id, uses: u.uses || 0, lastUsed: u.lastUsed || null, idleDays };
      if ((u.uses || 0) === 0 && (idleDays === null || idleDays > coldDays)) {
        report.skills.zeroUse.push(row);
      } else if ((u.uses || 0) > 0 && (u.uses || 0) < LOW_USE_FLOOR + 1 && idleDays !== null && idleDays > coldDays) {
        report.skills.stale.push(row);
      }
    }
    for (const key of ["zeroUse", "stale"]) report.skills[key] = report.skills[key].slice(0, REPORT_LIMIT);
  } catch (e) { noteCatch("src/memory/knowledge-governance.js#scan-skills", e); report.skills.error = "scan-failed"; }

  report.candidatesCount = report.lessons.conflicted.length + report.lessons.zeroUse.length
    + report.skills.zeroUse.length + report.skills.stale.length;
  if (report.candidatesCount > 0) {
    info(`[knowledge-governance] 退休候选 ${report.candidatesCount} 条 (lesson 冲突 ${report.lessons.conflicted.length} / 零命中 ${report.lessons.zeroUse.length}, skill 零用 ${report.skills.zeroUse.length} / 闲置 ${report.skills.stale.length})`);
  }
  return report;
}

// ---- 显式退休动作 (lesson): 走 experience.retire (锁内标记, 文件保留可回滚) ----
export function retireLesson(experience, id, reason = "") {
  const hit = experience?.retire?.(id, reason);
  if (hit) info(`[knowledge-governance] 经验已退休: ${id} (${reason || "未注明原因"})`);
  return hit;
}

// ---- 显式停用动作 (skill): 即时生效 (list() 即不再注入); 跨重启需写入 config.skills.disabled ----
// 返回 {disabled, hint} —— hint 是给调用方的持久化提示, 本模块不写 config (不越权)。
export function disableSkill(skills, id) {
  if (!skills || typeof skills.setDisabled !== "function") return { disabled: false, hint: "skills 加载器不可用" };
  const current = (skills.listAll?.() || skills.list?.() || [])
    .filter((m) => skills.isDisabled?.(m.id))
    .map((m) => m.id);
  const next = [...new Set([...current, String(id)])];
  skills.setDisabled(next);
  info(`[knowledge-governance] 技能已停用: ${id} (即时生效; 跨重启请写入 config.skills.disabled)`);
  return { disabled: true, disabledList: next, hint: "跨重启需将 " + id + " 写入 config.skills.disabled" };
}
