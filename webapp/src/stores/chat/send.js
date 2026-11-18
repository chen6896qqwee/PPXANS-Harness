// webapp/src/stores/chat/send.js - 发送与 SSE 泵
// 2026-11-13 从 stores/chat.js 拆出: 一轮对话从排队/发送、流式帧分发到收口
//   (轮次统计、通知、提问兜底、队列续发) 全在这里; 状态查询与命令/模型/权限
//   留在 chat/runtime.js, chat.js 只做桶文件。
// 时间线是数据 (items 数组) 而不是 DOM: 审批卡/提问卡是 store 里的记录, 组件按 id
//   渲染, 轮询重绘不会吞掉正在输入的控件, Ctrl+O 全展开只是改一个布尔。
// 会话归属 (2026-11-03 语义保持): 本回合属于发起时的会话, 用户切走后 delta/工具卡
//   不再写进当前画面; 审批/提问是服务端全局事实, 不受会话归属限制。

import { PHASE, toolPhase } from "./machine.js";
import { showToast } from "../toast.js";
import { streamChat } from "../../api/sse.js";
import { interruptApi, rewindApi, uploadApi } from "../../api/endpoints.js";
import { loadSessions } from "../rail.js";
import { dialog } from "../dialog.js";
import { playChime, playFail } from "../../chat/sound.js";
import {
  chat, push, setPhase,
  addError, addPlan, addDiff, addAgentCard, makeThinker, liftAnswer,
} from "./state.js";
import {
  addApproval, closeApproval, addQuestion, closeQuestion, pollApprovals, pollQuestions,
} from "./approval.js";
import { addToolCard, finishToolCard } from "./tools.js";
import { pushHist } from "./history.js";
import { IMG_RE, fmtSize } from "./format.js";
import { loadHistory, newSession } from "./session.js";

/* ---------- 发送 / SSE 泵 ---------- */
let _busyTimer = null;
function setBusy(on) {
  chat.streaming = on;
  if (_busyTimer) { clearInterval(_busyTimer); _busyTimer = null; }
  if (on) {
    chat.busyT0 = Date.now();
    chat.nowTick = chat.busyT0;
    setPhase(PHASE.thinking);
    _busyTimer = setInterval(() => { chat.nowTick = Date.now(); }, 1000);
  } else {
    setPhase(PHASE.idle);
  }
}

/* 通知 + 提示音: 窗口在后台时, 长回合结束后给一条系统通知和一声提示音 */
function notifyTurnDone(hadError) {
  try {
    if (dialog.sound) (hadError ? playFail() : playChime());
    if (typeof Notification === "undefined" || !document.hidden) return;
    const ms = chat.run && chat.run.t0 ? Date.now() - chat.run.t0 : 0;
    if (ms < 5000) return;
    const n = new Notification("皮皮虾", { body: hadError ? "本轮执行结束，有错误需要查看" : "回答已完成", silent: true });
    n.onclick = () => { try { window.focus(); } catch { /* 窗口已关闭 */ } n.close(); };
  } catch { /* 通知失败不影响对话 */ }
}

/** 发送一条消息 (files = @引用的相对路径)。生成中: queue 模式排队, immediate 模式打断后立刻发。 */
export function send(text, files) {
  const t = String(text == null ? chat.input : text).trim();
  const refs = (files || chat.refFiles).slice();
  if (!t && !chat.pendingFiles.length && !refs.length) return;
  const full = chat.pendingFiles.length ? chat.pendingFiles.join(" ") + (t ? "\n" + t : "") : t;
  const label = t || (refs.length && !chat.pendingFiles.length ? "（引用文件）" : "（图片）");
  pushHist(full);
  chat.lastRefFiles = refs;
  if (chat.streaming) {
    if (dialog.sendMode === "immediate") {
      // 立即打断: 中断当前回合, 流收口后由 finally 直接发这条 (不进排队队列)
      chat._pendingImmediate = { text: full, files: refs };
      chat.interrupted = true;
      if (chat._abort) { try { chat._abort.abort(); } catch { /* 已结束 */ } }
      interruptApi(chat.sessionKey).catch(() => {});
      chat.pendingFiles = [];
      chat.refFiles = [];
      chat.input = "";
      showToast("已打断当前回合, 正在切换到新消息");
      return;
    }
    chat.queue.push({ text: full, label, files: refs });
    chat.pendingFiles = [];
    chat.refFiles = [];
    chat.input = "";
    showToast("已排队 · 当前回合结束后发送");
    return;
  }
  chat.pendingFiles = [];
  chat.refFiles = [];
  chat.input = "";
  doSend(full, refs);
}

function flushQueue() {
  if (chat.streaming || !chat.queue.length) return;
  const next = chat.queue.shift();
  setTimeout(() => doSend(next.text, next.files), 30);
}

/** 本地命令短路: /new /help /model */
function localCommand(t) {
  if (t.charAt(0) !== "/") return false;
  const m = /^\/(\w+)\s*(.*)$/.exec(t);
  if (!m) return false;
  if (m[1] === "new") { newSession(); return true; }
  if (m[1] === "help") { showHelp(); return true; }
  if (m[1] === "model") { import("../ui.js").then((u) => { u.ui.settingsModal = "models"; }); return true; }
  return false;
}

function showHelp() {
  const lines = chat.commands.length
    ? chat.commands.map((c) => "**/" + c.name + "**" + (c.argumentHint ? " " + c.argumentHint : "") + " — " + (c.description || "")).join("\n")
    : "命令服务未启动";
  const card = addAgentCard();
  card.streaming = false;
  card.text = "## 命令面板\n" + lines;
}

export function doSend(t, files) {
  if (localCommand(t)) return;
  push({ kind: "user", text: t });
  chat.lastUserText = String(t);
  const card = addAgentCard();
  // 会话归属: 本回合属于发起时的会话, 切走后事件不再写当前画面 (服务端照常跑完入库)
  const mySession = chat.sessionKey;
  const stale = () => chat.sessionKey !== mySession;
  const think = makeThinker();
  let full = "";
  let sawDelta = false;
  let hadError = false;
  let renderTimer = null;
  let lastRenderAt = 0;

  const cancelRender = () => { if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; } };
  const scheduleRender = () => {
    if (renderTimer) return;
    const wait = Math.max(0, 60 - (Date.now() - lastRenderAt));
    renderTimer = setTimeout(() => {
      renderTimer = null;
      lastRenderAt = Date.now();
      if (chat.interrupted) return; // 已点停止: 等 done/error 收口, 不再为旧内容重绘
      card.text = full;
      card.streaming = true;
    }, wait);
  };

  setBusy(true);
  chat.interrupted = false;
  chat.run = { rounds: 0, maxRounds: 0, steps: 0, t0: Date.now(), tokps: 0 };

  const abort = new AbortController();
  chat._abort = abort;

  streamChat({
    message: t,
    sessionId: mySession,
    permission: chat.perm,
    files: files && files.length ? files : undefined,
    signal: abort.signal,
    onFrame(j) {
      if (j.type === "delta") {
        full += j.content;
        if (stale()) return; // 已切走: 内容照收 (离线积累), 不碰当前画面
        if (!sawDelta) { sawDelta = true; liftAnswer(); think.end(); setPhase(PHASE.writing); }
        scheduleRender();
      } else if (j.type === "reasoning") {
        if (stale()) return;
        think.add(j.content);
        setPhase(PHASE.thinking);
      } else if (j.type === "done") {
        cancelRender();
        think.end();
        full = j.content || full;
        if (chat.run) {
          const out = j.tokens && (j.tokens.completion != null ? j.tokens.completion : j.tokens.total);
          const secs = (Date.now() - chat.run.t0) / 1000;
          if (out != null && secs > 0.3) chat.run.tokps = out / secs;
        }
        if (stale()) return;
        liftAnswer();
        card.text = full;
        card.streaming = false;
        if (j.tokens) { chat.lastTokens = j.tokens; }
        if (j.diff) addDiff(j.diff);
      } else if (j.type === "tool") {
        if (stale()) return;
        if (j.status === "start") {
          if (chat.run) chat.run.steps++;
          think.end();
          setPhase(j.tool === "ask_user" ? PHASE.answer : toolPhase(j.tool));
          addToolCard(j);
          liftAnswer();
        } else {
          finishToolCard(j);
          setPhase(PHASE.thinking);
        }
      } else if (j.type === "step") {
        if (stale()) return;
        think.end();
        if (chat.run && typeof j.round === "number") {
          chat.run.rounds = Math.max(chat.run.rounds || 0, j.round + 1);
          if (j.maxRounds) chat.run.maxRounds = j.maxRounds;
        }
        setPhase(PHASE.thinking);
      } else if (j.type === "approval") {
        addApproval(j);
      } else if (j.type === "approval.close") {
        closeApproval(j.id, j.decision);
      } else if (j.type === "question") {
        addQuestion(j);
      } else if (j.type === "question.close") {
        closeQuestion(j.id, j.reason);
      } else if (j.type === "plan") {
        if (stale()) return;
        addPlan(j.content || j.text || "");
      } else if (j.type === "diff") {
        if (stale()) return;
        addDiff(j.content || j.diff || "");
      } else if (j.type === "error") {
        cancelRender();
        think.end();
        hadError = true;
        if (stale()) return;
        addError(j.error || "未知错误");
      }
    },
  }).catch((e) => {
    cancelRender();
    think.end();
    hadError = true;
    if (!stale()) addError(e.message);
  }).finally(() => {
    cancelRender();
    think.end();
    card.streaming = false;
    card.text = card.text || full;
    if (chat._abort === abort) chat._abort = null;
    const interrupted = chat.interrupted;
    chat.interrupted = false;
    setBusy(false);
    if (!interrupted) notifyTurnDone(hadError);
    if (interrupted) {
      card.interrupted = true;
      card.text = card.text || full;
    }
    loadSessions();
    pollApprovals();
    pollQuestions();
    // 回合已收口: 还挂着的提问卡只可能是中断/超时, 服务端也已收口 —— 本地一并落定
    for (const it of chat.items) {
      if (it.kind === "question" && !it.done) closeQuestion(it.qId, "interrupted");
    }
    // immediate 模式: 被打断时抢发的消息优先于排队队列
    if (chat._pendingImmediate) {
      const nxt = chat._pendingImmediate;
      chat._pendingImmediate = null;
      setTimeout(() => doSend(nxt.text, nxt.files), 30);
      return;
    }
    flushQueue(); // 排队消息: 上一回合收口后才发下一条
  });
}

export function stopGen() {
  chat.interrupted = true;
  if (chat._abort) { try { chat._abort.abort(); } catch { /* 已结束 */ } }
  interruptApi(chat.sessionKey).catch(() => {});
  showToast("已请求停止");
}

/* ---------- 重新生成 / 编辑重发 (回卷 1 轮 → fork 分支) ---------- */
export async function rewindAndSend(text, files) {
  if (chat.streaming) { showToast("生成中, 请先停止", true); return; }
  const msg = String(text || "").trim();
  if (!msg) { showToast("消息不能为空", true); return; }
  try {
    const j = await rewindApi(chat.sessionKey, 1);
    if (!j || !j.ok) throw new Error((j && j.reason) || "回卷失败");
    chat.sessionKey = j.newKey || chat.sessionKey;
    try { localStorage.setItem("ppx_session", chat.sessionKey); } catch { /* 忽略 */ }
    chat.items = [];
    await loadHistory(chat.sessionKey);
    doSend(msg, files || []);
  } catch (e) {
    showToast("操作失败: " + ((e && e.message) || "未知错误"), true);
  }
}
export function regenerate() {
  if (!chat.lastUserText) { showToast("没有可重新生成的提问", true); return; }
  rewindAndSend(chat.lastUserText, chat.lastRefFiles);
}

/* ---------- 附件上传 ---------- */
export function uploadFile(file) {
  const isImg = IMG_RE.test(file.name) || (file.type || "").indexOf("image/") === 0;
  const limit = isImg ? 8 * 1024 * 1024 : 20 * 1024 * 1024;
  if (file.size > limit) { showToast((isImg ? "图片" : "文件") + "超过 " + (isImg ? 8 : 20) + "MB", true); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const b64 = String(reader.result).split(",")[1] || "";
    uploadApi(file.name, b64).then((j) => {
      if (j && j.path) {
        chat.pendingFiles.push(j.path);
        showToast((j.kind === "image" ? "图片" : "文件") + "已就绪: " + j.path.split("/").pop() + " (" + fmtSize(j.bytes) + ")");
      }
    }).catch((e) => showToast("上传失败: " + e.message, true));
  };
  reader.readAsDataURL(file);
}
