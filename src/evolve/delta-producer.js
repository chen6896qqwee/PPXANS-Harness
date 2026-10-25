// src/evolve/delta-producer.js - Playbook delta 生产者 (进化闭环的"写入端", 2026-10-24)
// 吸收 ACE (agentic-context-engineering) 的增量语境思想。此前 playbook 引擎只有"注入端"
//   (prompts.js renderBullets), 全仓没有任何代码产生 delta —— 库永远为空, "语境进化"空转。
//   本模块把真实信号源接成闭环 (纯确定性, 零 LLM):
//   ① refine 闸门放行的经验教训 → ADD pitfall/strategy bullet (带 evidence_ref 溯源)
//   ② 工具失败 → 失败病历 (FailureEpisodeStore) 分类记录; refine 提炼时检索相似病历增强
// 门禁: 容量上限 + growAndRefine 有害裁剪 (harmful-helpful >= 阈值的 bullet 自动淘汰)。
import { growAndRefine } from "./playbook.js";

// 失败分类 (确定性关键词规则, 与 FAILURE_CATEGORY 对齐; 零 LLM)
export function categorizeFailure(errorText = "") {
  const t = String(errorText || "").toLowerCase();
  if (!t) return "unknown";
  if (/(429|rate.?limit|限流|throttl|too many)/i.test(t)) return "throttle";
  if (/(econn|enotfound|etimedout|timeout|超时|network|网络|fetch failed|socket|dns)/i.test(t)) return "network";
  if (/(401|403|unauthor|forbidden|api.?key|token|鉴权|未授权|认证)/i.test(t)) return "auth";
  if (/(invalid|参数|校验|schema|required|缺失|非法|validation|422|400)/i.test(t)) return "validation";
  return "unknown";
}

// 经验教训 → delta 操作 (applyDelta 会做词法查重, 重复 ADD 自动拒收)
export function lessonToOps(lesson, { kind = "pitfall", evidenceRef = null } = {}) {
  const text = String(lesson || "").trim();
  if (!text) return [];
  return [{
    op: "ADD",
    kind: ["strategy", "pitfall", "domain"].includes(kind) ? kind : "pitfall",
    content: text,
    evidence_ref: evidenceRef || null,
  }];
}

// 把一条已过验证闸门的经验写进 playbook (带容量+有害裁剪门禁)。
// 返回 PlaybookStore.apply 的结果 { committed, applied, rejected, reason? }。
export async function recordLesson(playbookStore, lesson, opts = {}) {
  if (!playbookStore || typeof playbookStore.apply !== "function") {
    return { committed: false, reason: "no-playbook-store" };
  }
  const ops = lessonToOps(lesson, opts);
  if (!ops.length) return { committed: false, reason: "empty-lesson" };
  const cap = Number(opts.maxBullets) || 200;
  const gate = {
    async commit(store, playbook) {
      // grow-and-refine: 先淘汰持续有害的 bullet, 再查容量
      const { playbook: refined, pruned } = growAndRefine(playbook);
      if (refined.bullets.length > cap) {
        return { committed: false, reason: `容量门禁: bullets ${refined.bullets.length} 超上限 ${cap}`, applied: [] };
      }
      store.save(refined);
      return { committed: true, applied: ops, pruned };
    },
  };
  return playbookStore.apply(ops, { gate });
}
