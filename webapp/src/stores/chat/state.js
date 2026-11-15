// webapp/src/stores/chat/state.js - 对话域数据: 会话/流/时间线状态 + 派生量 + 阶段写入
// 从 stores/chat.js 拆出 (2026-11-13): 这里只有数据与纯时间线操作, 不发起网络请求,
//   也不认识审批/会话切换 —— 那些在 approval.js / session.js, 由 chat.js 汇总后对外导出。

import { reactive, computed } from "vue";
import { checkTransition } from "./machine.js";
import { explain } from "../errors.js";
import { renderMd } from "../../markdown/index.js";

let _uid = 0;
function uid() { _uid += 1; return "e" + _uid; }

export const PERM_LEVELS = [
  { id: "read-only", label: "仅可查看", tone: "ro", icon: "file",
    desc: "只读巡检，写入与执行类工具一律先问你",
    sandbox: "read-only", approvalMode: "on-request" },
  { id: "workspace-write", label: "工作区内修改", tone: "ww", icon: "edit",
    desc: "只改当前工作区，越界拒绝；高危操作先问你 (默认)",
    sandbox: "workspace-write", approvalMode: "on-request" },
  { id: "danger-full-access", label: "完全权限", tone: "full", icon: "gate",
    desc: "不询问、不限路径 —— 高危命令不经审批直接执行，事后无法追回。只用于可丢弃环境 (容器 / 临时机器)",
    sandbox: "danger-full-access", approvalMode: "never" },
];

export const REASON_LABELS = { auto: "自动", off: "关闭", low: "低", medium: "中", high: "高", max: "Max" };

export const chat = reactive({
  /* 会话 */
  sessionKey: null,
  sessionTitle: "新会话",
  showArchived: false,
  /* 流 */
  streaming: false,
  interrupted: false,
  phase: "",
  phaseWarns: [],       // 非法阶段跳变留痕 (最多 20 条, 给开发者看, 不打扰用户)
  busyT0: 0,
  nowTick: 0,          // 生成中每秒 +1, 驱动「等了多久」的真实数字
  run: null,           // {rounds,maxRounds,steps,t0,tokps}
  lastTokens: null,
  ctxWindow: 0,
  /* 时间线: [{id, kind, ...}] kind ∈ user|agent|think|tool|step|error|plan|diff|approval|question */
  items: [],
  /* 队列 */
  queue: [],
  /* 输入 */
  input: "",
  pendingFiles: [],
  refFiles: [],
  lastUserText: "",
  lastRefFiles: [],
  hist: { list: [], idx: -1, draft: "" },
  /* 命令 */
  commands: [],
  /* 模型 / 权限 */
  llm: null,
  providers: [],
  providersLoaded: false,
  perm: "on-request",
  sandbox: "workspace-write",
  wsRoot: null,          // 工作区根 (来自 /api/permissions)
  wsAllow: [],           // 额外允许的目录 (agent.workspace_allow)
  /* hero / 状态 */
  life: null,
  health: null,
  toolsCount: "",
  versionTag: "v5",
  /* 弹层 */
  seatOpen: false,
  permOpen: false,
  paletteOpen: false,     // 斜杠命令面板
  paletteSel: 0,
  atPaletteOpen: false,   // @ 文件引用面板
  atSel: 0,
  atMatches: [],
  atFiles: null,
  atFilesKey: "",
});

/* ---------- 阶段写入唯一入口 ---------- */
// 以前 chat.phase 有 12 处直接赋值, 谁都能改、也容易忘了收口 (表现: 停了状态条还在转)。
// 现在所有写入走这里: 文案从 machine.PHASE 取, 非法跳变 (比如空闲态凭空写回答) 留一条痕。
export function setPhase(p) {
  const r = checkTransition(chat.phase, p);
  if (!r.ok) {
    chat.phaseWarns.push({ at: Date.now(), jump: r.reason });
    if (chat.phaseWarns.length > 20) chat.phaseWarns.shift();
  }
  chat.phase = p;
}

/* ---------- 派生 ---------- */
export const pendingApprovalItem = computed(() => chat.items.find((x) => x.kind === "approval" && !x.done && !x.settling) || null);
export const pendingQuestionItem = computed(() => chat.items.find((x) => x.kind === "question" && !x.done && !x.settling) || null);
const phaseNow = computed(() => {
  if (pendingQuestionItem.value) return "等待你的回答";
  if (pendingApprovalItem.value) return "等待你的批准";
  return chat.phase || "思考中";
});
const busySecs = computed(() => (chat.streaming ? Math.max(0, Math.floor((chat.nowTick - chat.busyT0) / 1000)) : 0));
export const footHint = computed(() => {
  if (!chat.streaming) return "Enter 发送 · Shift+Enter 换行 · / 唤起命令面板";
  const esc = pendingQuestionItem.value ? "Esc 跳过" : pendingApprovalItem.value ? "Esc 拒绝" : "Esc 停止";
  return phaseNow.value + " · " + busySecs.value + "s · " + esc + " · Enter 排队";
});
export const hasUsableModel = computed(() => (chat.providers || []).some((p) => {
  if (!p || p.enabled === false) return false;
  if (p.api_key_set || p.api_key_env) return true;
  return /(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(String(p.base_url || ""));
}));
export function providerLabel(p) {
  if (!p) return "—";
  const name = p.display_name || p.id || "";
  const first = Array.isArray(p.models) && p.models.length ? p.models[0] : null;
  const m = (first && (first.label || first.id)) || p.model || "";
  if (name && m && m !== name) return name + " · " + m;
  return m || name || "未指定模型";
}

/* ---------- 时间线操作 ---------- */
export function push(item) {
  const it = Object.assign({ id: uid() }, item);
  chat.items.push(it);
  return it;
}
export function clearTimeline() {
  chat.items = [];
}
export function addError(msg) {
  // 原文照旧保留 (排查要看), 另带一句人话的下一步 —— 三级: 会自愈 / 需要你处理 / 需要上报
  const text = String(msg || "未知错误");
  const e = explain(text);
  push({ kind: "error", msg: text, hint: e.hint, tier: e.tier });
}
export function addPlan(text) {
  push({ kind: "plan", html: renderMd(text || "") });
}
/** /events 总线 plan_updated → 实时计划卡 (v5.0 update_plan 工具)。已有计划卡就地更新。 */
export function addPlanLiveCard(steps) {
  const list = (Array.isArray(steps) ? steps : []).slice(0, 20);
  if (!list.length) return null;
  const existing = chat.items.find((x) => x.kind === "planlive");
  if (existing) {
    existing.steps = list;
    return existing;
  }
  return push({ kind: "planlive", steps: list });
}
export function addDiff(diffText) {
  const lines = String(diffText).split("\n").slice(0, 400).map((l) => {
    const cls = l.indexOf("+") === 0 ? "add" : (l.indexOf("-") === 0 ? "del" : (l.indexOf("@@") === 0 ? "hunk" : ""));
    return { cls, text: l };
  });
  push({ kind: "diff", lines });
}
export function addAgentCard() {
  return push({ kind: "agent", text: "", streaming: true, interrupted: false });
}
/** 外部入口 (侧栏任务卡/新手指引): 直接在时间线落一张完成的 agent 卡 */
export function addAgentMarkdown(text) {
  const card = addAgentCard();
  card.streaming = false;
  card.text = String(text || "");
  return card;
}
export function liftAnswer() {
  // 新思考段落位后把正文卡顶到末尾 —— 纯直答回答的思考段不能落在正文之下 (顺序倒置)。
  const items = chat.items;
  const lastAgent = items.findLast ? items.findLast((x) => x.kind === "agent") : null;
  if (!lastAgent) return;
  const idx = items.indexOf(lastAgent);
  if (idx === items.length - 1) return;
  items.splice(idx, 1);
  items.push(lastAgent);
}

/* ---------- 思考分段 (对齐 dsh: 思考→工具→思考 交替成段) ---------- */
export function makeThinker() {
  let cur = null;
  function newSeg() {
    const it = push({ kind: "think", text: "", ended: false, secs: 0, open: true, began: Date.now() });
    liftAnswer();
    return {
      item: it,
      add(t) {
        it.text += t;
        it.secs = Math.max(1, Math.round(((it.ended ? it.endedTs : Date.now()) - it.began) / 1000));
      },
      end() {
        if (it.ended) return;
        it.ended = true;
        it.endedTs = Date.now();
        it.secs = Math.max(1, Math.round((it.endedTs - it.began) / 1000));
        it.open = false; // 收口后只留一行, 细节留给点击
      },
      get ended() { return it.ended; },
    };
  }
  return {
    add(t) {
      if (!t) return;
      if (!cur || cur.ended) cur = newSeg();
      cur.add(t);
    },
    end() { if (cur && !cur.ended) cur.end(); },
  };
}
