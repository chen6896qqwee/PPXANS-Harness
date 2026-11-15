// webapp/src/stores/bot.js - 本体域: /api/bot.state 轮询 / 类型卡 / 轨迹 / 身体 / 本体设置
// 自旧 bot.js 移植。轮询重绘在 Vue 里天然安全 (响应式按需更新, 不再有 innerHTML
// 重建吞焦点的 hasActiveEditor 问题)。

import { reactive } from "vue";
import { showToast } from "./toast.js";
import { botStateApi, botTracesApi, botManageApi, bodyStateApi } from "../api/endpoints.js";

export const BODY_LABEL = { ok: "正常", warn: "注意", bad: "不健康", unknown: "没数据" };
export const OVERALL_LABEL = { ok: "体征正常", warn: "有指标需要看", bad: "有指标不健康", unknown: "数据不全" };

export const bot = reactive({
  s: null,              // /api/bot.state 快照
  loaded: false,
  pollErr: false,
  /* 轨迹 */
  traces: [],
  traceDays: [],
  traceStats: {},
  traceDay: "",
  traceFilter: "",
  tracesLoaded: false,
  /* 身体 */
  body: null,
  bodyErr: null,
  /* 本体设置页编辑态 */
  memPath: null,
  memText: "",
  typeFormOpen: false,
  typeName: "",
  typeBlurb: "",
});

export function manage(action, payload, okMsg) {
  return botManageApi(action, payload).then((j) => {
    if (!j || !j.ok) throw new Error((j && j.error) || "操作失败");
    if (j.state) bot.s = j.state;
    if (okMsg) showToast(okMsg);
    return j;
  }).catch((e) => {
    showToast((e && e.message) || "操作失败", true);
    throw e;
  });
}

export function settingsPatch(patch, okMsg) {
  return manage("settings", { patch }, okMsg || "已保存");
}

export async function loadState(quiet) {
  try {
    const j = await botStateApi(quiet);
    if (!j || !j.ok) throw new Error((j && j.error) || "读取运行状态失败");
    bot.pollErr = false;
    bot.loaded = true;
    bot.s = j;
    return j;
  } catch (e) {
    bot.pollErr = true;
    // 有旧快照就继续显示旧快照 (几秒前的状态比一片空白有用); 从来没读到过才落空态
    if (bot.loaded && bot.s) return e;
    return e;
  }
}

/* 轮询: 5 秒, 失败指数退避到 30s, 页面隐藏暂停 (240/分/IP 限流预算) */
let _timer = null;
let _pollMs = 5000;
export function startBotPoll() {
  stopBotPoll();
  function tick() {
    if (document.hidden) { _timer = setTimeout(tick, 5000); return; }
    loadState(true).then(() => {
      _pollMs = bot.pollErr ? Math.min(30000, (_pollMs || 5000) * 2) : 5000;
      _timer = setTimeout(tick, _pollMs);
    });
  }
  _pollMs = 5000;
  _timer = setTimeout(tick, _pollMs);
}
function stopBotPoll() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

/* ---------- 轨迹 ---------- */
export async function loadTraces(day) {
  if (day !== undefined) bot.traceDay = day;
  try {
    const j = await botTracesApi(bot.traceDay);
    if (!j || !j.ok) throw new Error((j && j.error) || "读不到执行过程");
    bot.traces = j.events || [];
    bot.traceDays = j.days || [];
    bot.traceStats = j.stats || {};
    bot.tracesLoaded = true;
  } catch (e) {
    bot.traces = [];
    bot.traceErr = (e && e.message) || "读取失败";
  }
}

/* ---------- 身体 ---------- */
export async function loadBody() {
  try {
    const s = await bodyStateApi();
    bot.body = s;
    bot.bodyErr = null;
  } catch (e) {
    bot.body = null;
    bot.bodyErr = (e && e.message) || "读取体征失败";
  }
}

/* ---------- 记忆文件 ---------- */
export function openMem(p) {
  botManageApi("memoryRead", { path: p }, undefined).then((j) => {
    if (!j || !j.ok) throw new Error((j && j.error) || "读不了");
    bot.memPath = p;
    bot.memText = j.text || "";
  }).catch((e) => showToast((e && e.message) || "读取失败", true));
}
export function closeMem() {
  bot.memPath = null;
  bot.memText = "";
}
