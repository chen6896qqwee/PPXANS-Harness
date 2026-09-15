// src/memory/experience.js - 经验库 (自学习)
// 从每次任务结果中提炼经验, 供后续任务参考 (参考 openhanako experience)
import path from "node:path";
import { ensureDir, readJson, writeJson, nowISO } from "./store.js";

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
    this.lessons.push(entry);
    this._prune();
    writeJson(this.file, this.lessons);
    return entry;
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
    const l = this.lessons.find((x) => x.id === id);
    if (l) { l.uses += 1; writeJson(this.file, this.lessons); }
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
