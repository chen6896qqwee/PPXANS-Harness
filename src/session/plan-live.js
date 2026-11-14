// src/session/plan-live.js - 回合内计划工件 (v5.0 P2.3)
// 现代工具循环标配 (TodoWrite 语义): 模型在干活过程中用 update_plan 工具维护一个
// 分步计划 (pending / in_progress / done), 注入 system 动态区让"接下来做什么"跨轮可见,
// 并以 EQ plan_updated 事件推给 UI 实时渲染计划卡。
//
// 位置契约 (与 workstack 同规): 内容随任务变化 ⇒ 只进动态区, 绝不进静态前缀 ——
// 每次改计划不得作废 provider 前缀缓存。段内不含时间戳 (逐字节稳定)。
// 持久化: data/plans/<sessionKey>.json (会话重开计划还在); 缺目录惰性创建。
import fs from "node:fs";
import path from "node:path";
import { noteCatch } from "../utils/catch-log.js";

const STATUSES = ["pending", "in_progress", "done"];

function safeName(sk) {
  return String(sk || "default").replace(/[^\w.-]/g, "_").slice(0, 80) || "default";
}

export class PlanLive {
  constructor(dataDir) {
    this.dir = path.join(String(dataDir || "."), "plans");
    this._cache = new Map(); // sessionKey -> plan | null
  }

  _file(sessionKey) {
    return path.join(this.dir, safeName(sessionKey) + ".json");
  }

  get(sessionKey) {
    const k = String(sessionKey || "default");
    if (this._cache.has(k)) return this._cache.get(k);
    let plan = null;
    try {
      const raw = JSON.parse(fs.readFileSync(this._file(k), "utf8"));
      if (raw && Array.isArray(raw.steps)) plan = raw;
    } catch (e) {
      // 首次读取没有计划文件是常态, 不留痕; 坏 JSON/IO 错误才进异常账
      if (e && e.code !== "ENOENT") noteCatch(e);
      /* 无计划/坏文件 = null (坏文件不阻断, 下次 set 覆盖) */
    }
    this._cache.set(k, plan);
    return plan;
  }

  // 整体替换计划 (TodoWrite 语义: 每次提交全量步骤列表)。
  // 规范化: 标题截断 200 字符; 状态白名单外回落 pending; 恰好一个 in_progress 纠偏。
  set(sessionKey, steps) {
    const k = String(sessionKey || "default");
    const list = (Array.isArray(steps) ? steps : [])
      .map((s) => {
        const t = s && typeof s === "object" ? s : { title: s };
        return {
          title: String(t.title || "").slice(0, 200),
          status: STATUSES.includes(t.status) ? t.status : "pending",
        };
      })
      .filter((s) => s.title);
    if (list.length > 20) list.length = 20;
    const inProgress = list.filter((s) => s.status === "in_progress").length;
    if (inProgress > 1) {
      // 只保第一个 in_progress, 其余回落 pending (计划语义: 同一时刻只干一件)
      let seen = false;
      for (const s of list) {
        if (s.status === "in_progress") {
          if (seen) s.status = "pending";
          else seen = true;
        }
      }
    }
    const plan = { steps: list, updatedAt: new Date().toISOString() };
    if (!list.length) {
      this._cache.set(k, null);
      try { if (fs.existsSync(this._file(k))) fs.unlinkSync(this._file(k)); } catch (e) { noteCatch(e); /* 清理失败不阻断 */ }
      return null;
    }
    this._cache.set(k, plan);
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this._file(k), JSON.stringify(plan), "utf8");
    } catch (e) { noteCatch(e); /* 落盘失败不阻断 (本轮内存里仍可见) */ }
    return plan;
  }

  clear(sessionKey) {
    return this.set(sessionKey, []);
  }

  // system 动态区渲染: 空计划返回 "" (零 token)。
  render(sessionKey) {
    const plan = this.get(sessionKey);
    if (!plan || !plan.steps.length) return "";
    const mark = (s) => (s.status === "done" ? "[x]" : s.status === "in_progress" ? "[~]" : "[ ]");
    const lines = plan.steps.map((s) => `- ${mark(s)} ${s.title}`);
    return "【当前计划】(用 update_plan 工具维护; [x]已完成 [~]进行中 [ ]待办)\n" + lines.join("\n");
  }
}
