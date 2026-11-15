// webapp/src/views/stats/derive.js - 使用统计的纯派生 (窗口 / 折线 / 环形 / 热力 / KPI)
// 2026-11-13 从 StatsView.vue 抽出: 组件只留 ref 与 computed 包装, 几何与文案在这里可单测。
// 本模块零依赖 (只 import fmt), 不碰 DOM / vue / fetch。

import { fmtCn, fmtTokCn, fmtDur } from "../../stores/fmt.js";

export const PALETTE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"];
export const DAY_MS = 86400000;

export function dayOf(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
export function parseDay(s) {
  const p = String(s).split("-");
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}
export function shortDay(s) {
  const d = parseDay(s);
  return (d.getMonth() + 1) + "月" + d.getDate() + "日";
}

/* 按天序列 → 定长窗口 (缺账的日子补 0) */
export function buildWindow(data, range) {
  if (!data) return [];
  const byDay = {};
  (data.daily || []).forEach((x) => { byDay[x.day] = x; });
  const today = parseDay(data.today || dayOf(new Date()));
  const all = Object.keys(byDay).sort();
  let n;
  if (!range) {
    const first = all.length ? parseDay(all[0]) : new Date(today.getTime() - 13 * DAY_MS);
    n = Math.max(2, Math.round((today - first) / DAY_MS) + 1);
  } else n = range;
  n = Math.min(n, 370);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d2 = new Date(today.getTime() - i * DAY_MS);
    const key = dayOf(d2);
    out.push({ day: key, rec: byDay[key] || null });
  }
  return out;
}

export function buildSeries(win) {
  const totals = {};
  for (const w of win) {
    if (!w.rec) continue;
    const bm = w.rec.byModel || {};
    Object.keys(bm).forEach((m) => { totals[m] = (totals[m] || 0) + (Number(bm[m]) || 0); });
  }
  const names = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  const top = names.slice(0, 5);
  const other = names.slice(5);
  const out = top.map((m) => ({
    name: m, tokens: totals[m],
    values: win.map((w) => (w.rec && w.rec.byModel && w.rec.byModel[m]) || 0),
  }));
  if (other.length) {
    out.push({
      name: "其他 " + other.length + " 个模型",
      tokens: other.reduce((s, m) => s + totals[m], 0),
      values: win.map((w) => {
        const bm = (w.rec && w.rec.byModel) || {};
        return other.reduce((s, m) => s + (Number(bm[m]) || 0), 0);
      }),
    });
  }
  return out;
}

/* 趋势折线几何 */
export function buildTrend(win, series) {
  const W = 960, H = 260, PL = 58, PR = 18, PT = 16, PB = 30;
  const iw = W - PL - PR, ih = H - PT - PB;
  let max = 0;
  for (const s of series) for (const v of s.values) if (v > max) max = v;
  if (!(max > 0)) max = 1;
  const step = win.length > 1 ? iw / (win.length - 1) : 0;
  const x = (i) => PL + i * step;
  const y = (v) => PT + ih - (v / max) * ih;
  const lines = series.map((s, si) => ({
    color: PALETTE[si % PALETTE.length],
    pts: s.values.map((v, i) => x(i).toFixed(1) + "," + y(v).toFixed(1)).join(" "),
    last: { cx: x(s.values.length - 1).toFixed(1), cy: y(s.values[s.values.length - 1]).toFixed(1) },
  }));
  const grid = [];
  for (let g = 0; g <= 4; g++) {
    const gv = (max / 4) * g;
    grid.push({ y: y(gv).toFixed(1), label: fmtTokCn(gv) });
  }
  const tickEvery = Math.max(1, Math.ceil(win.length / 7));
  const ticks = [];
  win.forEach((w, i) => {
    if (i % tickEvery && i !== win.length - 1) return;
    ticks.push({ x: x(i).toFixed(1), label: shortDay(w.day) });
  });
  return { W, H, PL, PR, lines, grid, ticks, total: win.reduce((a, w) => a + ((w.rec && w.rec.tokens) || 0), 0) };
}

/* 模型用量环形 */
export function buildDonut(data) {
  if (!data) return null;
  const models = ((data.totals || {}).models || []).slice(0, 6);
  const total = Number((data.totals || {}).tokens) || 0;
  if (!models.length || !total) return null;
  const R = 62, SW = 26, C = 2 * Math.PI * R;
  let acc = 0;
  const segs = models.map((m, i) => {
    const frac = total > 0 ? m.tokens / total : 0;
    const seg = { color: PALETTE[i % PALETTE.length], len: C * frac, off: -C * acc, name: m.model, pctv: frac, calls: m.calls, cost: Number(m.cost) || 0, tokens: m.tokens };
    acc += frac;
    return seg;
  });
  if (acc < 1) segs.push({ color: "var(--border)", len: C * (1 - acc), off: -C * acc });
  return { R, SW, C, segs, total, models };
}

/* 活动热力 (mode: day | week | cum) */
export function buildHeat(data, mode) {
  if (!data || !(data.daily || []).length) return null;
  const byDay = {};
  (data.daily || []).forEach((x) => { byDay[x.day] = Number(x.tokens) || 0; });
  const today = parseDay(data.today || dayOf(new Date()));
  let start = data.streak && data.streak.firstDay ? parseDay(data.streak.firstDay) : new Date(today.getTime() - 83 * DAY_MS);
  const floor = new Date(today.getTime() - 363 * DAY_MS);
  if (start < floor) start = floor;
  start = new Date(start.getTime() - start.getDay() * DAY_MS);
  const weeks = [];
  const cur = new Date(start.getTime());
  while (cur <= today) {
    const col = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(cur.getTime() + i * DAY_MS);
      col.push(day > today ? null : { key: dayOf(day) });
    }
    weeks.push({ cells: col, month: cur.getMonth(), label: cur.getDate() <= 7 });
    cur.setTime(cur.getTime() + 7 * DAY_MS);
  }
  const weekTotal = {};
  weeks.forEach((w) => {
    let s = 0;
    w.cells.forEach((c) => { if (c && byDay[c.key]) s += byDay[c.key]; });
    if (w.cells[0]) weekTotal[w.cells[0].key] = s;
  });
  const cum = {};
  let run = 0;
  weeks.forEach((w) => w.cells.forEach((c) => { if (!c) return; run += byDay[c.key] || 0; cum[c.key] = run; }));
  const valOf = (key) => {
    if (mode === "week") return weekTotal[key] || 0;
    if (mode === "cum") return cum[key] || 0;
    return byDay[key] || 0;
  };
  let max = 0;
  weeks.forEach((w) => w.cells.forEach((c) => { if (c) max = Math.max(max, valOf(c.key)); }));
  for (const w of weeks) {
    w.vals = w.cells.map((c) => {
      if (!c) return { future: true, level: "" };
      const v = valOf(c.key);
      let level = "";
      if (v > 0 && max > 0) {
        const r = v / max;
        level = r > 0.7 ? "l4" : r > 0.4 ? "l3" : r > 0.12 ? "l2" : "l1";
      }
      return { key: c.key, level, tip: c.key + " · " + fmtTokCn(v) + " tokens" };
    });
  }
  return { weeks, firstKey: weeks.length && weeks[0].cells[0] ? weeks[0].cells[0].key : dayOf(start) };
}

export function buildKpis(data) {
  if (!data) return [];
  const t = data.totals || {}, p = data.peak || {}, st = data.streak || {}, c = data.chat || {};
  const unpriced = Array.isArray(t.unpriced) ? t.unpriced : [];
  // 2026-11-14 (评测 P2-6): 成本三口径进 UI —— API 层 (2026-11-13) 已吐 recordedCost /
  //   estimatedCost / effectiveCost, 此前前端只显示记录成本, 历史 $0 账会被误读成"用得省"。
  //   costIsEstimated 时展示 effectiveCost 并明标"含估算, 仅供量级参考"。
  const costTip = (t.calls || 0) + " 次模型调用 · "
    + (t.costIsEstimated
      ? "记录 $0 + 按现价估算 $" + (Number(t.estimatedCost) || 0).toFixed(4)
        + " = $" + (Number(t.effectiveCost) || 0).toFixed(4) + "（含估算, 仅供量级参考, 不是账单）"
      : "折算 $" + (Number(t.cost) || 0).toFixed(4))
    + (unpriced.length ? " (另有 " + unpriced.length + " 个模型无价格数据, 未计入)" : "");
  return [
    { val: fmtCn(t.tokens), lab: "累计 Token 数", tip: costTip, dim: false },
    { val: p.tokens ? fmtCn(p.tokens) : "—", lab: "峰值 Token 数", tip: p.day ? "出现在 " + p.day : "还没有按天账本", dim: !p.day },
    { val: c.longestMs ? fmtDur(c.longestMs) : "—", lab: "最长聊天时长", tip: c.longestSession ? (c.longestSession.title || c.longestSession.id) + " · 共 " + c.sessions + " 个会话" : "还没有会话记录", dim: !c.longestMs },
    { val: st.current ? st.current + " 天" : "0 天", lab: "当前连续天数", tip: "有模型调用或有会话的自然日 · 最近一次 " + (st.lastDay || "—"), dim: false },
    { val: st.longest ? st.longest + " 天" : "0 天", lab: "最长连续天数", tip: "累计活跃 " + (st.activeDays || 0) + " 天 · 最早 " + (st.firstDay || "—"), dim: false },
  ];
}

/* 未定价模型提示 + 账本对账 (2026-11-14, 评测 P2-6):
   1) 未定价模型: 折算金额不含它们, 不能让"账很低"被当成"用得省";
   2) reconciliation.unbucketedCalls: 累计 calls 与按天 calls 的历史差额 —— 显式带出,
      防止被读者当成丢账 (API 层注释原文: "不再让读者把 240 vs 250 当成丢账")。 */
export function buildUnpricedNote(data) {
  const t = (data && data.totals) || {};
  const list = Array.isArray(t.unpriced) ? t.unpriced : [];
  const rec = (data && data.reconciliation) || {};
  const parts = [];
  if (list.length) {
    const names = list.slice(0, 3).map((m) => m.model).join(", ") + (list.length > 3 ? " 等" : "");
    parts.push("有 " + list.length + " 个模型没有价格数据（" + names + "），共 "
      + fmtTokCn(t.unpricedTokens) + " tokens，折算金额不含这部分。"
      + "在 config 的 budget.model_prices 里配置单价（支持 currency: \"CNY\"），或用 budget.assume_price 兜底后金额才完整。");
  }
  if (Number(rec.unbucketedCalls) > 0) {
    parts.push("账本对账: " + rec.unbucketedCalls + " 次早期调用未入按天分桶 —— 分桶上线前的历史累计差额, 不是丢账。");
  }
  return parts.join(" ");
}
