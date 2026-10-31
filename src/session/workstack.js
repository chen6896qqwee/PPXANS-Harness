// src/session/workstack.js — 跨轮任务栈: 「我正在干什么」(2026-10-30)
//
// 为什么需要它:
//   现在每一轮 chat() 都从 _context() 重新拼装身份 (人格 + 画像 + 技能目录 + 记忆检索 + 历史)。
//   拼出来的是「我一贯是谁」和「你刚才说了什么」—— 中间缺一层:**我正在干什么**。
//   结果就是被叫去做别的事、或者会话/上下文被压缩之后回来, 只能靠翻 memory/turns 归档
//   去猜"上一件事做到哪了"。人不是这么运作的: 手头的事是一个一直在的栈。
//
// 与 planning/pwf.js 的分工:
//   PWF 是**计划文件**(进 plan 模式才写, 面向"这个任务分几步"), 这里是**工作内存**
//   (随时可读写, 面向"我此刻手上有几件事、各自停在哪一步")。两者不互相替代。
//
// 契约:
//   · 持久化到 <dataDir>/workstack.json, 原子写 + 文件锁 (多进程共享 dataDir 时不互相覆盖);
//   · 上限 MAX_ITEMS 条未完成项, 超了淘汰最久没动过的 (栈的意义是"手头", 不是档案);
//   · 渲染成 prompt 段时**不含时间戳**(逐字节稳定), 且整段随任务变化 → 只能放动态区,
//     不能进静态前缀 (见 test/prefix-cache-static-region.test.js)。
import path from "node:path";
import { ensureDir, readJson, withFileLock, writeJson, nowISO } from "../utils/store.js";

const MAX_ITEMS = 8;            // 手头最多几件事 (多余的按 updatedAt 淘汰)
const MAX_STEPS = 12;           // 单件事最多几步
const MAX_GOAL_CHARS = 160;     // 目标长度上限
const MAX_NOTE_CHARS = 300;     // 备注长度上限

const STATUS = { ACTIVE: "active", BLOCKED: "blocked", DONE: "done" };
const STATUS_LABEL = { active: "进行中", blocked: "卡住", done: "已完成" };

let _seq = 0;
function nextId() {
  _seq += 1;
  return `w${Date.now().toString(36)}${_seq.toString(36)}`;
}

function clip(s, n) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export class WorkStack {
  constructor(dataDir) {
    this.dir = dataDir;
    ensureDir(this.dir);
    this.file = path.join(this.dir, "workstack.json");
    this.state = { activeId: null, items: [] };
    this._load();
  }

  _load() {
    const raw = readJson(this.file, null);
    if (!raw || typeof raw !== "object") return;
    const items = Array.isArray(raw.items) ? raw.items : [];
    this.state = {
      activeId: raw.activeId || null,
      items: items
        .filter((x) => x && typeof x.goal === "string" && x.goal)
        .slice(-MAX_ITEMS)
        .map((x) => ({
          id: String(x.id || nextId()),
          goal: clip(x.goal, MAX_GOAL_CHARS),
          status: STATUS_LABEL[x.status] ? x.status : STATUS.ACTIVE,
          steps: Array.isArray(x.steps)
            ? x.steps.slice(0, MAX_STEPS).map((s) => ({ text: clip(s?.text ?? s, 120), done: s?.done === true }))
            : [],
          note: x.note ? clip(x.note, MAX_NOTE_CHARS) : "",
          createdAt: x.createdAt || nowISO(),
          updatedAt: x.updatedAt || nowISO(),
        })),
    };
  }

  _save() {
    // 原子写 + 锁: 与 facts/experience 同款 (跨进程共享 dataDir 时不互相覆盖)
    withFileLock(this.file, () => writeJson(this.file, this.state));
  }

  // 加一件手头的事。同 goal 已存在则复用 (幂等), 不制造重复条目。
  push(goal, { steps = [], note = "" } = {}) {
    const g = clip(goal, MAX_GOAL_CHARS);
    if (!g) return { ok: false, error: "goal 不能为空" };
    const existing = this.state.items.find((x) => x.goal === g && x.status !== STATUS.DONE);
    if (existing) {
      this.state.activeId = existing.id;
      this._save();
      return { ok: true, item: existing, reused: true };
    }
    const item = {
      id: nextId(),
      goal: g,
      status: STATUS.ACTIVE,
      steps: Array.isArray(steps)
        ? steps.slice(0, MAX_STEPS).map((s) => ({ text: clip(s?.text ?? s, 120), done: s?.done === true }))
        : [],
      note: note ? clip(note, MAX_NOTE_CHARS) : "",
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    this.state.items.push(item);
    // 超出上限: 淘汰最久没动过的 (DONE 优先, 其次最老)
    while (this.state.items.length > MAX_ITEMS) {
      const done = this.state.items.findIndex((x) => x.status === STATUS.DONE);
      const idx = done >= 0 ? done : 0;
      this.state.items.splice(idx, 1);
    }
    this.state.activeId = item.id;
    this._save();
    return { ok: true, item };
  }

  // 更新: 只改传入的字段 (status / note / steps / 单步勾选)
  update(id, patch = {}) {
    const item = this._find(id);
    if (!item) return { ok: false, error: `没有这件事: ${id}` };
    if (patch.status && STATUS_LABEL[patch.status]) item.status = patch.status;
    if (typeof patch.note === "string") item.note = clip(patch.note, MAX_NOTE_CHARS);
    if (typeof patch.goal === "string" && patch.goal.trim()) item.goal = clip(patch.goal, MAX_GOAL_CHARS);
    if (Array.isArray(patch.steps)) {
      item.steps = patch.steps.slice(0, MAX_STEPS).map((s) => ({ text: clip(s?.text ?? s, 120), done: s?.done === true }));
    }
    // 勾选某一步: step: {index, done}
    if (patch.step && Number.isInteger(patch.step.index) && item.steps[patch.step.index]) {
      item.steps[patch.step.index].done = patch.step.done !== false;
      // 全部步骤完成 → 整件事自动转 done (省一次显式调用)
      if (item.steps.length && item.steps.every((s) => s.done)) item.status = STATUS.DONE;
    }
    item.updatedAt = nowISO();
    if (this.state.activeId === item.id && item.status === STATUS.DONE) this.state.activeId = null;
    this._save();
    return { ok: true, item };
  }

  // 完成 / 移除
  complete(id) { return this.update(id, { status: STATUS.DONE }); }
  remove(id) {
    const i = this.state.items.findIndex((x) => x.id === String(id));
    if (i < 0) return { ok: false, error: `没有这件事: ${id}` };
    const [gone] = this.state.items.splice(i, 1);
    if (this.state.activeId === gone.id) this.state.activeId = null;
    this._save();
    return { ok: true, removed: gone };
  }

  list({ includeDone = true } = {}) {
    const items = includeDone ? this.state.items : this.state.items.filter((x) => x.status !== STATUS.DONE);
    return items.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  active() {
    return this.state.items.find((x) => x.id === this.state.activeId) || null;
  }

  clear() {
    this.state = { activeId: null, items: [] };
    this._save();
    return { ok: true };
  }

  _find(id) {
    const key = String(id || "");
    if (!key) return this.active();
    return this.state.items.find((x) => x.id === key) || null;
  }

  // 渲染成 prompt 段。**不含时间戳/相对时间**(逐字节稳定); 无未完成项时返回空串 (零 token)。
  // 只列未完成的: 手头的事才有意义, 已完成的留在文件里可查。
  render() {
    const items = this.state.items.filter((x) => x.status !== STATUS.DONE);
    if (!items.length) return "";
    const lines = ["【手头的事】(跨轮保持; 用 task_stack 增改, 别在正文里复述)"];
    for (const it of items.slice(0, MAX_ITEMS)) {
      const cur = it.steps.length ? ` — 步骤 ${it.steps.filter((s) => !s.done).length} 项未完成` : "";
      const mark = it.status === STATUS.BLOCKED ? "⏸" : "▶";
      lines.push(`${mark} ${it.goal}${cur}${it.note ? ` (${it.note})` : ""}`);
    }
    return lines.join("\n");
  }

  // 可观测摘要 (面板用)
  status() {
    const items = this.state.items;
    return {
      total: items.length,
      active: items.filter((x) => x.status === STATUS.ACTIVE).length,
      blocked: items.filter((x) => x.status === STATUS.BLOCKED).length,
      done: items.filter((x) => x.status === STATUS.DONE).length,
      current: this.active() ? { id: this.active().id, goal: this.active().goal } : null,
      items: this.list(),
    };
  }
}

export const WORKSTACK_STATUS = STATUS;
