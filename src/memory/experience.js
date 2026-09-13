// src/memory/experience.js - 经验库 (自学习)
// 从每次任务结果中提炼经验, 供后续任务参考 (参考 openhanako experience)
// 跨 agent 共享: 支持全局经验目录 (globalDataDir), 写入用文件锁防并发覆盖
// v1.0.7: 同义经验相似合并 (bigram overlap, 词序/措辞变体命中合并而非新增)
import path from "node:path";
import { ensureDir, readJson, writeJson, nowISO, withFileLock } from "../utils/store.js";

// 同义合并阈值: 经验 lesson 的 bigram overlap 达到此值视为同一条
// 用真实生产变体校准: 同义改写 0.50-0.55, 相关但不同 0.29, 不相关 0.0 → 0.5 能抓同义不误伤
const SIM_THRESHOLD = 0.5;

// bigram 集合 (去空白, 中文按字符)
function _bigrams(s) {
  const chars = Array.from(String(s).replace(/\s+/g, ""));
  const out = new Set();
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
  return out;
}

// overlap 系数: 交集 / 较短者 bigram 数 (对词序变化容忍, 与 FactStore._overlap 同思路)
export function lessonOverlap(a, b) {
  const A = _bigrams(a), B = _bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size);
}

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

  learn({ task, outcome, lesson, tags = [] }) {
    const entry = {
      id: "e_" + Math.random().toString(36).slice(2, 10),
      task: String(task || "").slice(0, 300),
      outcome: String(outcome || "").slice(0, 300),
      lesson: String(lesson || "").slice(0, 500),
      tags,
      ts: nowISO(),
      uses: 0,
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
        writeJson(this.file, this.lessons);
        return existing;
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

  _prune() {
    // 最多保留 200 条
    if (this.lessons.length > 200) {
      this.lessons.sort((a, b) => b.uses - a.uses);
      this.lessons = this.lessons.slice(0, 200);
    }
  }

  context() {
    const recent = [...this.lessons].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 5);
    return recent.map((l) => `- 经验: ${l.lesson}`).join("\n") || "(暂无经验)";
  }
}
