// src/memory/experience.js - 经验库 (自学习)
// 从每次任务结果中提炼经验, 供后续任务参考 (设计溯源 docs/PROVENANCE.md#hanaagent)
// 跨 agent 共享: 支持全局经验目录 (globalDataDir), 写入用文件锁防并发覆盖
// v1.0.7: 同义经验相似合并 (bigram overlap, 词序/措辞变体命中合并而非新增)
// 2026-11-15: 知识生命周期补段 —— ① 写入侧冲突检测 (极性相反/明确更正时双向留痕,
//   只标记不删, 与 contradiction.js 同口径); ② 退休标记 (retire/restore, 退休条目
//   退出 recall/context/list, 文件保留供审计) —— 治理扫描见 knowledge-governance.js
import path from "node:path";
import { ensureDir, readJson, writeJson, nowISO, withFileLock } from "../utils/store.js";
import { overlapCoefficient } from "../utils/similarity.js";
import { detectContradiction } from "./contradiction.js";

// 同义合并阈值: 经验 lesson 的 bigram overlap 达到此值视为同一条
// 用真实生产变体校准: 同义改写 0.50-0.55, 相关但不同 0.29, 不相关 0.0 → 0.5 能抓同义不误伤
const SIM_THRESHOLD = 0.5;

// overlap 系数 (交集 / 较短者): 对词序变化容忍, 实现收敛到 utils/similarity
// (与 FactStore._overlap 同思路, 但分词/阈值各自独立)
export const lessonOverlap = overlapCoefficient;

// 模板句判定: 去掉数字后完全相同 (如 "A 经验教训 0" vs "A 经验教训 1")
// 这类"仅编号不同"的条目是不同内容, 不参与同义合并 (防误伤)
function _isTemplateLike(a, b) {
  return String(a).replace(/\d+/g, "#") === String(b).replace(/\d+/g, "#");
}

export class Experience {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "experience");
    ensureDir(this.dir);
    this.file = path.join(this.dir, "lessons.json");
    this.lessons = readJson(this.file, []);
  }

  learn({ task, outcome, lesson, tags = [], applicability = null }) {
    const entry = {
      id: "e_" + Math.random().toString(36).slice(2, 10),
      task: String(task || "").slice(0, 300),
      outcome: String(outcome || "").slice(0, 300),
      lesson: String(lesson || "").slice(0, 500),
      // 适用条件 (2026-11-15): 这条经验在什么条件下成立。可证伪假设的"前提"半边 ——
      //   没有它, 教训只有"结论"没有"边界", 治理与效果对照都无法区分"不适用"和"失效"。
      applicability: applicability ? String(applicability).slice(0, 200) : null,
      tags,
      ts: nowISO(),
      uses: 0,
      conflicts: [],   // 与既有经验的冲突 (lesson id 列表, 2026-11-15)
      retiredAt: null, // 退休时间戳 (null=在役; 退休由显式动作触发, 不自动)
    };
    if (!entry.lesson || entry.lesson.length < 5) return null;
    // 内容去重: 同一 lesson 已存在则命中加分 (uses+1) 而非新增, 防高频学习路径写放大
    // 归一化: 去首尾空白 + 折叠连续空白 (与 FactStore._norm 同策略)
    const normKey = String(lesson).trim().replace(/\s+/g, " ");
    // 锁内读-改-写: 防止多 agent 共享经验库时并发覆盖
    return withFileLock(this.file, () => {
      this.lessons = readJson(this.file, []);
      const existing = this.lessons.find((l) => String(l.lesson || "").trim().replace(/\s+/g, " ") === normKey);
      if (existing) {
        existing.uses += 1;
        existing.ts = nowISO(); // 刷新时间, 让近期命中经验排到 context 前面
        // 旧条目缺适用条件而新蒸馏带了 → 补上 (适用条件是知识的一部分, 不该因合并丢失)
        if (!existing.applicability && entry.applicability) existing.applicability = entry.applicability;
        writeJson(this.file, this.lessons);
        return existing;
      }
      // 冲突检测 (2026-11-15): 必须在**同义合并之前** —— 更正与被更正者的文本天然高度
      //   相似 (overlap 闸门会把它们认成"同义改写"), 不先判冲突, 更正就会被合并吞掉、
      //   旧错误结论原样留存。命中冲突时跳过合并, 作为新条目入库并双向留痕
      //   (新条目标 conflicts, 旧条目标 challengedBy); 只标记不删 (误删用户事实比留矛盾
      //   更糟, 与 contradiction.js 头注同口径), 是否退休旧条目交给 knowledge-governance。
      //   200 条上限内 O(n) 纯函数扫描, 可接受。
      const conflicts = [];
      for (const l of this.lessons) {
        if (l.retiredAt) continue; // 退休条目不参与冲突判定 (已不在役)
        const c = detectContradiction(entry.lesson, l.lesson);
        if (c.conflict) conflicts.push({ id: l.id, similarity: c.similarity, correction: c.correction });
      }
      if (conflicts.length) {
        entry.conflicts = conflicts.map((c) => c.id);
        for (const l of this.lessons) {
          if (entry.conflicts.includes(l.id)) {
            l.challengedBy = [...(Array.isArray(l.challengedBy) ? l.challengedBy : []), entry.id].slice(-8);
          }
        }
        this.lessons.push(entry);
        writeJson(this.file, this.lessons);
        return entry;
      }
      // 同义合并 (v1.0.7): 措辞/词序不同的变体 (逃过精确去重) 语义相似时合并, 防同义经验堆积
      // 排除"仅编号不同"的模板句 (如 A 经验教训 0/1 → 视为不同条目)
      const similar = this.lessons.find((l) => {
        const la = String(l.lesson || "");
        if (_isTemplateLike(la, entry.lesson)) return false;
        return lessonOverlap(la, entry.lesson) >= SIM_THRESHOLD;
      });
      if (similar) {
        similar.uses += 1;
        similar.ts = nowISO();
        if (!similar.applicability && entry.applicability) similar.applicability = entry.applicability;
        writeJson(this.file, this.lessons);
        return similar;
      }
      this.lessons.push(entry);
      this._prune();
      writeJson(this.file, this.lessons);
      return entry;
    });
  }

  recall(taskDesc) {
    const q = String(taskDesc || "").toLowerCase();
    const scored = this.lessons
      .filter((l) => !l.retiredAt) // 退休经验不回投上下文 (2026-11-15)
      .map((l) => {
        let s = 0;
        const hay = (l.lesson + " " + l.task + " " + l.tags.join(" ")).toLowerCase();
        if (q && hay.includes(q)) s += 10;
        if (l.uses > 0) s += Math.min(l.uses, 5);
        return { ...l, score: s };
      })
      .filter((l) => l.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, 5);
  }

  use(id) {
    withFileLock(this.file, () => {
      this.lessons = readJson(this.file, []);
      const l = this.lessons.find((x) => x.id === id);
      if (l) { l.uses += 1; writeJson(this.file, this.lessons); }
    });
  }

  // 经验清单 (公开读 API): 默认按命中次数降序, 同次数按时间新→旧
  // 供 fork 快照 / 外部观测使用 (调用方无需触碰 this.lessons 内部数组)
  // includeRetired: 治理/审计需要看退休条目时显式要 (默认只出在役)
  list({ limit = 0, sort = "uses", includeRetired = false } = {}) {
    const all = [...this.lessons].filter((l) => includeRetired || !l.retiredAt);
    if (sort === "uses") {
      all.sort((a, b) => (b.uses || 0) - (a.uses || 0) || new Date(b.ts || 0) - new Date(a.ts || 0));
    } else if (sort === "ts") {
      all.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
    }
    const n = Number(limit) || 0;
    return n > 0 ? all.slice(0, n) : all;
  }

  // 退休 (2026-11-15): 只标记不删 —— 条目退出 recall/context/list, 文件保留供审计。
  //   触发方是 knowledge-governance 的显式动作 (或人工), learn 路径绝不自动退休。
  retire(id, reason = "") {
    return withFileLock(this.file, () => {
      this.lessons = readJson(this.file, []);
      const l = this.lessons.find((x) => x.id === id);
      if (!l) return null;
      l.retiredAt = nowISO();
      if (reason) l.retireReason = String(reason).slice(0, 200);
      writeJson(this.file, this.lessons);
      return l;
    });
  }

  // 恢复退休经验 (误判回滚用)
  restore(id) {
    return withFileLock(this.file, () => {
      this.lessons = readJson(this.file, []);
      const l = this.lessons.find((x) => x.id === id);
      if (!l) return null;
      l.retiredAt = null;
      delete l.retireReason;
      writeJson(this.file, this.lessons);
      return l;
    });
  }

  // 条目数 (可观测): 默认只数在役 (退休的不算能力快照); includeRetired 供治理对账
  count({ includeRetired = false } = {}) {
    return includeRetired ? this.lessons.length : this.lessons.filter((l) => !l.retiredAt).length;
  }

  _prune() {
    // 最多保留 200 条; 退休条目优先出清 (审计价值最低, 且文件留有治理报告可回溯)
    if (this.lessons.length > 200) {
      this.lessons.sort((a, b) =>
        (Number(Boolean(a.retiredAt)) - Number(Boolean(b.retiredAt))) || (b.uses - a.uses));
      this.lessons = this.lessons.slice(0, 200);
    }
  }

  context() {
    // 优先命中次数 (高频教训浮上来, 让反复发生的硬拒绝/跨会话坑真正影响行为),
    // 同次数按时间新→旧 (近期教训仍可见)。蒸馏接缝: B3 auto-self-review 教训 uses 随复发上涨,
    // 从而在上下文里越来越突出, 形成「经验→长期准则」的浮升链路。
    // 2026-11-15: 退休条目不注入; 存在冲突的条目带标记注入 (模型自知"这条有异议",
    //   是元认知的最小形态 —— 冲突可见而非静默二选一)。
    const picked = [...this.lessons]
      .filter((l) => !l.retiredAt)
      .sort((a, b) => (b.uses || 0) - (a.uses || 0) || new Date(b.ts || 0) - new Date(a.ts || 0))
      .slice(0, 5);
    return picked
      .map((l) => {
        const conflict = (Array.isArray(l.conflicts) && l.conflicts.length)
          || (Array.isArray(l.challengedBy) && l.challengedBy.length);
        return `- 经验: ${l.lesson}${conflict ? " (⚠ 存在相互冲突的经验, 优先以最近实测为准)" : ""}`;
      })
      .join("\n") || "(暂无经验)";
  }
}
