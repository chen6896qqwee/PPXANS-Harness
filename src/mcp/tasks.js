// src/mcp/tasks.js - 任务面板存储 (零依赖)
// 轻量任务工作区: 任务 = { id, title, description, status, steps[], result, createdAt, updatedAt }
// 持久化到 <root>/data/tasks.json (原子写), 支持 create/list/get/update/step/delete/complete。
// 供 MCP 工具 ppx.task.* 与 web 前端任务面板使用。
import path from "node:path";
import { readJson, writeJson } from "../utils/store.js";
import { shortId } from "../utils/id.js";

const VALID_TASK_STATUS = new Set(["todo", "running", "done", "failed"]);
const VALID_STEP_STATUS = new Set(["pending", "running", "done", "failed"]);

export class TaskBoard {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, "data", "tasks.json");
    this.tasks = new Map();
    this._load();
  }

  _load() {
    const raw = readJson(this.file, null); // 损坏则从空开始, 下次写入覆盖
    if (raw && Array.isArray(raw.tasks)) {
      for (const t of raw.tasks) {
        if (t && t.id) this.tasks.set(t.id, this._normalize(t));
      }
    }
  }

  _save() {
    try {
      writeJson(this.file, { tasks: [...this.tasks.values()] });
    } catch (e) { /* 持久化失败不阻断内存操作 */ }
  }

  _normalize(t) {
    return {
      id: String(t.id),
      title: String(t.title || "未命名任务"),
      description: String(t.description || ""),
      status: VALID_TASK_STATUS.has(t.status) ? t.status : "todo",
      steps: Array.isArray(t.steps) ? t.steps.map((s, i) => ({
        title: String((s && s.title) || (typeof s === "string" ? s : `步骤 ${i + 1}`)),
        status: VALID_STEP_STATUS.has(s && s.status) ? s.status : "pending",
        detail: String((s && s.detail) || ""),
      })) : [],
      result: String(t.result || ""),
      createdAt: t.createdAt || Date.now(),
      updatedAt: t.updatedAt || Date.now(),
    };
  }

  _touch(t) { t.updatedAt = Date.now(); }

  create({ title, description = "", steps = [] } = {}) {
    if (!title) throw new Error("任务需 title");
    const id = shortId("t_", 5);
    const t = this._normalize({
      id, title, description,
      steps: steps.map((s) => ({ title: String(s) })).filter((s) => s.title),
    });
    this.tasks.set(id, t);
    this._save();
    return t;
  }

  get(id) { return this.tasks.get(String(id)) || null; }

  list() {
    const arr = [...this.tasks.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return {
      tasks: arr,
      counts: {
        todo: arr.filter((t) => t.status === "todo").length,
        running: arr.filter((t) => t.status === "running").length,
        done: arr.filter((t) => t.status === "done").length,
        failed: arr.filter((t) => t.status === "failed").length,
      },
    };
  }

  update({ id, status, title, description } = {}) {
    const t = this.get(id);
    if (!t) throw new Error("任务不存在");
    if (status != null) {
      if (!VALID_TASK_STATUS.has(status)) throw new Error(`非法任务状态: ${status}`);
      t.status = status;
    }
    if (title != null) t.title = String(title);
    if (description != null) t.description = String(description);
    this._touch(t);
    this._save();
    return t;
  }

  step({ id, index, status, detail } = {}) {
    const t = this.get(id);
    if (!t) throw new Error("任务不存在");
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= t.steps.length) throw new Error("步骤 index 越界");
    if (status != null) {
      if (!VALID_STEP_STATUS.has(status)) throw new Error(`非法步骤状态: ${status}`);
      t.steps[i].status = status;
    }
    if (detail != null) t.steps[i].detail = String(detail);
    // 任一步骤 running → 任务 running; 全部 done → 任务 done (自动派生)
    if (t.steps.some((s) => s.status === "running")) t.status = "running";
    else if (t.steps.length && t.steps.every((s) => s.status === "done")) t.status = "done";
    this._touch(t);
    this._save();
    return t;
  }

  complete(id, result = "") {
    const t = this.get(id);
    if (!t) throw new Error("任务不存在");
    for (const s of t.steps) if (s.status !== "failed") s.status = "done";
    t.status = "done";
    if (result) t.result = String(result).slice(0, 20000);
    this._touch(t);
    this._save();
    return t;
  }

  delete({ id } = {}) {
    const ok = this.tasks.delete(String(id || ""));
    if (ok) this._save();
    return { ok };
  }
}

export function createTaskBoard(root) {
  return new TaskBoard(root);
}
