/* public/stats.js — 使用统计页 (2026-10-31)
 *
 * 一次 /api/usage/stats 取全, 图表全部手写 SVG (本项目零运行时依赖, 不引图表库)。
 *
 * 口径:
 *  - 累计 token / 模型占比: 模型调用账本 (data/usage-stats.json), 升级前就有数。
 *  - 按天趋势 / 活动热力: 账本的 days 分桶, 2026-10-31 才加 —— 空就是空,
 *    不拿累计值去补某一天的柱子 (页脚把这句话写在页面上)。
 *  - 聊天时长: data/sessions/*.jsonl 的事件间隔累加, 30 分钟以上空档不计入。
 */
(function () {
  "use strict";

  var S = { data: null, range: 30, heat: "day", busy: false };
  var PALETTE = ["#e8764f", "#3f8ee6", "#2fa864", "#9a6ff0", "#e0a437", "#4bb3bd"];
  var DAY_MS = 86400000;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function bootData() {
    if (window.__PPX_BOOTSTRAP__) return window.__PPX_BOOTSTRAP__;
    var el = $("ppx-boot");
    if (!el) return null;
    try { window.__PPX_BOOTSTRAP__ = JSON.parse(el.textContent || "{}"); } catch (e) { return null; }
    return window.__PPX_BOOTSTRAP__;
  }

  function req(path) {
    var h = {};
    var boot = bootData();
    var tok = (boot && boot.authToken) || localStorage.getItem("ppx_token");
    if (tok) h.Authorization = "Bearer " + tok;
    var base = (boot && boot.base) || "";
    return fetch(base + path, { headers: h }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
        return j;
      });
    });
  }

  /* ---------- 读数格式化 ---------- */
  // 中文计数: 亿 / 万 —— 参考的是「5 亿」「8736.3万」这种读法, 不是 1e8 科学计数
  function fmtCn(n) {
    n = Number(n) || 0;
    if (n >= 1e8) return trimZero((n / 1e8).toFixed(n >= 1e9 ? 1 : 2)) + " 亿";
    if (n >= 1e4) return trimZero((n / 1e4).toFixed(1)) + " 万";
    return String(Math.round(n));
  }
  function trimZero(s) { return s.replace(/\.?0+$/, ""); }

  function fmtTok(n) {
    n = Number(n) || 0;
    if (n >= 1e8) return trimZero((n / 1e8).toFixed(2)) + "亿";
    if (n >= 1e4) return trimZero((n / 1e4).toFixed(1)) + "万";
    return String(Math.round(n));
  }

  function fmtDur(ms) {
    ms = Number(ms) || 0;
    if (ms < 1000) return ms > 0 ? "不足 1 分" : "—";
    var min = Math.round(ms / 60000);
    if (min < 60) return min + " 分钟";
    var h = Math.floor(min / 60);
    var m = min % 60;
    if (h < 24) return m ? h + " 小时 " + m + " 分" : h + " 小时";
    return Math.floor(h / 24) + " 天 " + (h % 24) + " 小时";
  }

  function fmtPct(v, digits) {
    if (v == null || !isFinite(v)) return "—";
    return (v * 100).toFixed(digits == null ? 0 : digits) + "%";
  }

  function dayOf(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var x = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + x;
  }
  function parseDay(s) { var p = String(s).split("-"); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
  function shortDay(s) { var d = parseDay(s); return (d.getMonth() + 1) + "月" + d.getDate() + "日"; }

  /* ---------- 按天序列 → 定长窗口 (缺账的日子补 0, 否则折线会把空白天跳过) ---------- */
  function windowDays(data, rangeDays) {
    var byDay = {};
    (data.daily || []).forEach(function (d) { byDay[d.day] = d; });
    var today = parseDay(data.today || dayOf(new Date()));
    var all = Object.keys(byDay).sort();
    var n;
    if (!rangeDays) {
      // 全部 = 从有账的第一天到今天; 一天都没有就先给两周空窗, 免得图塌成一条线
      var first = all.length ? parseDay(all[0]) : new Date(today.getTime() - 13 * DAY_MS);
      n = Math.max(2, Math.round((today - first) / DAY_MS) + 1);
    } else {
      n = rangeDays;
    }
    n = Math.min(n, 370);
    var out = [];
    for (var i = n - 1; i >= 0; i--) {
      var d = new Date(today.getTime() - i * DAY_MS);
      var key = dayOf(d);
      out.push({ day: key, rec: byDay[key] || null });
    }
    return out;
  }

  function seriesOf(win) {
    var totals = {};
    win.forEach(function (w) {
      if (!w.rec) return;
      var bm = w.rec.byModel || {};
      Object.keys(bm).forEach(function (m) { totals[m] = (totals[m] || 0) + (Number(bm[m]) || 0); });
    });
    var names = Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; });
    var top = names.slice(0, 5);
    var other = names.slice(5);
    var series = top.map(function (m) {
      return { name: m, tokens: totals[m], values: win.map(function (w) {
        return (w.rec && w.rec.byModel && w.rec.byModel[m]) || 0;
      }) };
    });
    if (other.length) {
      series.push({ name: "其他 " + other.length + " 个模型", tokens: other.reduce(function (s, m) { return s + totals[m]; }, 0),
        values: win.map(function (w) {
          var bm = (w.rec && w.rec.byModel) || {};
          return other.reduce(function (s, m) { return s + ((Number(bm[m]) || 0)); }, 0);
        }) });
    }
    return series;
  }

  /* ---------- KPI ---------- */
  function kpiHtml(d) {
    var t = d.totals || {};
    var p = d.peak || {};
    var st = d.streak || {};
    var c = d.chat || {};
    function cell(val, lab, tip, dim) {
      return '<div class="st-kpi' + (dim ? " dim" : "") + '"' + (tip ? ' title="' + esc(tip) + '"' : "") + ">"
        + "<b>" + esc(val) + "</b><span>" + esc(lab) + "</span></div>";
    }
    return '<div class="st-kpis">'
      + cell(fmtCn(t.tokens), "累计 Token 数", (t.calls || 0) + " 次模型调用 · 折算 $" + (Number(t.cost) || 0).toFixed(4))
      + cell(p.tokens ? fmtCn(p.tokens) : "—", "峰值 Token 数", p.day ? "出现在 " + p.day : "还没有按天账本", !p.day)
      + cell(c.longestMs ? fmtDur(c.longestMs) : "—", "最长聊天时长",
        c.longestSession ? (c.longestSession.title || c.longestSession.id) + " · 共 " + c.sessions + " 个会话" : "还没有会话记录", !c.longestMs)
      + cell(st.current ? st.current + " 天" : "0 天", "当前连续天数", "有模型调用或有会话的自然日 · 最近一次 " + (st.lastDay || "—"))
      + cell(st.longest ? st.longest + " 天" : "0 天", "最长连续天数", "累计活跃 " + (st.activeDays || 0) + " 天 · 最早 " + (st.firstDay || "—"))
      + "</div>";
  }

  /* ---------- 活动热力格 ---------- */
  function heatHtml(d) {
    var byDay = {};
    (d.daily || []).forEach(function (x) { byDay[x.day] = Number(x.tokens) || 0; });
    // 一天账本都没有: 画空网格只会让人以为「这些天都是 0」, 直接说明数据从哪开始
    if (!(d.daily || []).length) {
      return card("Token 活动", "暂无按天账本", "",
        '<div class="empty">还没有按天记录 —— 分桶自本次升级起累积, 跑过一轮模型调用这里就有热力了</div>');
    }
    var today = parseDay(d.today || dayOf(new Date()));
    // 起点: 最早活跃日 (含会话日), 但最多回看一年
    var earliest = d.streak && d.streak.firstDay ? d.streak.firstDay : null;
    var start = earliest ? parseDay(earliest) : new Date(today.getTime() - 83 * DAY_MS);
    var floor = new Date(today.getTime() - 363 * DAY_MS);
    if (start < floor) start = floor;
    start = new Date(start.getTime() - start.getDay() * DAY_MS); // 对齐到周日
    var weeks = [];
    var cur = new Date(start.getTime());
    while (cur <= today) {
      var col = [];
      for (var i = 0; i < 7; i++) {
        var day = new Date(cur.getTime() + i * DAY_MS);
        col.push(day > today ? null : { key: dayOf(day), date: day });
      }
      weeks.push({ cells: col, month: cur.getMonth(), label: cur.getDate() <= 7 });
      cur = new Date(cur.getTime() + 7 * DAY_MS);
    }
    // 每周 / 累计两种视图先把值算出来, 再统一分级
    var weekTotal = {};
    weeks.forEach(function (w) {
      var s = 0;
      w.cells.forEach(function (c) { if (c && byDay[c.key]) s += byDay[c.key]; });
      if (w.cells[0]) weekTotal[w.cells[0].key] = s;
    });
    var run = 0, cum = {};
    weeks.forEach(function (w) {
      w.cells.forEach(function (c) { if (!c) return; run += byDay[c.key] || 0; cum[c.key] = run; });
    });
    var valOf = function (key) {
      if (S.heat === "week") return weekTotal[key] || 0;
      if (S.heat === "cum") return cum[key] || 0;
      return byDay[key] || 0;
    };
    var max = 0;
    weeks.forEach(function (w) { w.cells.forEach(function (c) { if (c) max = Math.max(max, valOf(c.key)); }); });
    var level = function (v) {
      if (!(v > 0) || !(max > 0)) return "";
      var r = v / max;
      return r > 0.7 ? "l4" : r > 0.4 ? "l3" : r > 0.12 ? "l2" : "l1";
    };
    var html = '<div class="st-heat" role="img" aria-label="按天 token 活动热力图">';
    weeks.forEach(function (w) {
      html += '<div class="st-heat-col"><div class="st-heat-mo">' + (w.label ? esc((w.month + 1) + "月") : "") + "</div>";
      w.cells.forEach(function (c) {
        if (!c) { html += '<div class="st-cell future"></div>'; return; }
        var v = valOf(c.key);
        html += '<div class="st-cell ' + level(v) + '" title="' + esc(c.key + " · " + fmtTok(v) + " tokens") + '"></div>';
      });
      html += "</div>";
    });
    html += "</div>";
    var firstKey = weeks.length && weeks[0].cells[0] ? weeks[0].cells[0].key : dayOf(start);
    html += '<div class="st-heat-foot"><span>' + esc(firstKey) + '</span><span class="flex1"></span><span>少</span>'
      + '<div class="st-cell"></div><div class="st-cell l1"></div><div class="st-cell l2"></div><div class="st-cell l3"></div><div class="st-cell l4"></div>'
      + "<span>多</span><span>" + esc(d.today || "") + "</span></div>";
    return card("Token 活动", d.ledger && d.ledger.since ? "账本自 " + d.ledger.since : "暂无按天账本",
      '<div class="seg" data-heat role="group" aria-label="热力口径">'
      + segBtn("heat", "day", "每日", S.heat) + segBtn("heat", "week", "每周", S.heat) + segBtn("heat", "cum", "累计", S.heat)
      + "</div>", html);
  }

  function segBtn(group, val, lab, current) {
    return '<button type="button" data-' + group + '="' + esc(val) + '"'
      + (val === current ? ' class="on"' : "") + ">" + esc(lab) + "</button>";
  }

  /* ---------- 每日趋势折线 ---------- */
  function trendHtml(d) {
    var win = windowDays(d, S.range);
    var series = seriesOf(win);
    var W = 960, H = 260, PL = 58, PR = 18, PT = 16, PB = 30;
    var iw = W - PL - PR, ih = H - PT - PB;
    var max = 0;
    series.forEach(function (s) { s.values.forEach(function (v) { if (v > max) max = v; }); });
    if (!(max > 0)) max = 1;
    var step = win.length > 1 ? iw / (win.length - 1) : 0;
    var x = function (i) { return PL + i * step; };
    var y = function (v) { return PT + ih - (v / max) * ih; };
    var svg = '<svg viewBox="0 0 ' + W + " " + H + '" aria-label="每日 token 趋势折线图">';
    for (var g = 0; g <= 4; g++) {
      var gv = (max / 4) * g, gy = y(gv);
      svg += '<line class="st-grid" x1="' + PL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + gy.toFixed(1) + '"/>';
      svg += '<text class="st-axis" x="' + (PL - 9) + '" y="' + (gy + 3.5).toFixed(1) + '" text-anchor="end">' + esc(fmtTok(gv)) + "</text>";
    }
    var tickEvery = Math.max(1, Math.ceil(win.length / 7));
    win.forEach(function (w, i) {
      if (i % tickEvery && i !== win.length - 1) return;
      svg += '<text class="st-axis" x="' + x(i).toFixed(1) + '" y="' + (H - 9) + '" text-anchor="middle">' + esc(shortDay(w.day)) + "</text>";
    });
    series.forEach(function (s, si) {
      var col = PALETTE[si % PALETTE.length];
      var pts = s.values.map(function (v, i) { return x(i).toFixed(1) + "," + y(v).toFixed(1); });
      svg += '<polyline points="' + pts.join(" ") + '" fill="none" stroke="' + col
        + '" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round"/>';
      var li = s.values.length - 1;
      svg += '<circle cx="' + x(li).toFixed(1) + '" cy="' + y(s.values[li]).toFixed(1) + '" r="3.4" fill="' + col + '"/>';
    });
    svg += "</svg>";
    var legend = series.length
      ? '<div class="st-legend">' + series.map(function (s, si) {
        return '<span><i style="background:' + PALETTE[si % PALETTE.length] + '"></i>' + esc(s.name)
          + "<em>" + esc(fmtTok(s.tokens)) + "</em></span>";
      }).join("") + "</div>"
      : "";
    var body = series.length
      ? '<div class="st-chart">' + svg + "</div>" + legend
      : '<div class="empty">这段时间没有模型调用记录</div>';
    var total = win.reduce(function (a, w) { return a + ((w.rec && w.rec.tokens) || 0); }, 0);
    return card("每日 Token 趋势图", "窗口合计 " + fmtTok(total) + " tokens", "", body);
  }

  /* ---------- 模型用量环形 ---------- */
  function modelsHtml(d) {
    var models = ((d.totals || {}).models || []).slice(0, 6);
    var total = Number((d.totals || {}).tokens) || 0;
    if (!models.length || !total) return card("模型用量", "累计", "", '<div class="empty">还没有模型调用记录</div>');
    var R = 62, SW = 26, C = 2 * Math.PI * R;
    var acc = 0;
    var segs = models.map(function (m, i) {
      var frac = total > 0 ? m.tokens / total : 0;
      var seg = { color: PALETTE[i % PALETTE.length], len: C * frac, off: -C * acc, name: m.model, pct: frac };
      acc += frac;
      return seg;
    });
    // 只画前 6 个模型, 剩下的并进一段中性色 —— 不补的话环形会缺一口
    if (acc < 1) segs.push({ color: "var(--border2)", len: C * (1 - acc), off: -C * acc });
    var svg = '<svg class="st-donut" width="168" height="168" viewBox="0 0 168 168" role="img" aria-label="模型用量占比环形图">'
      + '<g transform="translate(84,84) rotate(-90)">';
    segs.forEach(function (s) {
      if (!(s.len > 0)) return;
      // stroke 走 style 而不是属性: 补位段用的是 var(--border2), 属性里写不了 CSS 变量
      svg += '<circle r="' + R + '" fill="none" style="stroke:' + s.color + '" stroke-width="' + SW
        + '" stroke-dasharray="' + s.len.toFixed(2) + " " + (C - s.len).toFixed(2) + '" stroke-dashoffset="' + s.off.toFixed(2) + '"/>';
    });
    svg += "</g>"
      + '<text x="84" y="80" text-anchor="middle" font-size="19" font-weight="650">' + esc(fmtTok(total)) + "</text>"
      + '<text class="dt-sub" x="84" y="99" text-anchor="middle">tokens</text></svg>';
    var rows = models.map(function (m, i) {
      return '<div class="st-mrow"><span class="nm"><b>' + esc(m.model) + "</b>"
        + "<i>" + esc(String(m.calls || 0)) + " 次调用 · 折算 $" + esc((Number(m.cost) || 0).toFixed(4)) + "</i></span>"
        + '<span class="tk"><i style="display:inline-block;width:9px;height:9px;border-radius:99px;background:'
        + PALETTE[i % PALETTE.length] + ';margin-right:6px"></i>' + esc(fmtTok(m.tokens)) + " tokens</span>"
        + '<span class="pc">' + esc(fmtPct(m.tokens / total, 1)) + "</span></div>";
    }).join("");
    return card("模型用量", "累计 · 共 " + models.length + " 个模型", "",
      '<div class="st-models">' + svg + '<div class="st-mlist">' + rows + "</div></div>");
  }

  /* ---------- 会话明细 ---------- */
  function sessionsHtml(d) {
    var list = (d.chat || {}).recent || [];
    if (!list.length) return "";
    var rows = list.map(function (s) {
      return '<div class="st-srow"><span class="d">' + esc(s.day || "—") + "</span>"
        + '<span class="t" title="' + esc(s.title || s.id) + '">' + esc(s.title || s.id) + "</span>"
        + '<span class="m">' + esc(String(s.messages || 0)) + " 条 · " + esc(fmtDur(s.activeMs)) + "</span></div>";
    }).join("");
    return card("会话", "最近 " + list.length + " 个 · 时长已扣掉 30 分钟以上的空档", "",
      '<div class="st-srows">' + rows + "</div>");
  }

  function card(title, hint, tools, body) {
    return '<div class="st-card"><div class="st-card-h"><h3>' + esc(title) + "</h3>"
      + (hint ? '<span class="hint">' + esc(hint) + "</span>" : "")
      + '<span class="flex1"></span>' + (tools || "") + "</div>" + body + "</div>";
  }

  function noteHtml(d) {
    var t = d.totals || {};
    var lg = d.ledger || {};
    var hit = t.cacheHitPct == null ? "未上报" : fmtPct(t.cacheHitPct, 1);
    return '<p class="st-note">'
      + "累计 <b>" + esc(fmtTok(t.tokens)) + "</b> tokens · <b>" + esc(String(t.calls || 0)) + "</b> 次调用 · 折算 <b>$"
      + esc((Number(t.cost) || 0).toFixed(4)) + "</b> · 缓存命中 <b>" + esc(hit) + "</b><br>"
      + (lg.since
        ? "按天账本自 <b>" + esc(lg.since) + "</b> 起，共 <b>" + esc(String(lg.days || 0)) + "</b> 天有记录。"
        : "按天账本还没有记录 —— 分桶自本次升级起累积，跑过一轮模型调用后这里就有数了。")
      + " 趋势与热力只读按天账本，不拿累计值补历史。"
      + "</p>";
  }

  /* ---------- 渲染 ---------- */
  function render() {
    var wrap = $("statsWrap");
    if (!wrap) return;
    var d = S.data;
    if (!d) return;
    var sub = $("statsSub");
    if (sub) {
      sub.textContent = [
        (d.totals && d.totals.calls ? fmtTok(d.totals.tokens) + " tokens · " + d.totals.calls + " 次调用" : "还没有模型调用"),
        d.chat && d.chat.sessions ? d.chat.sessions + " 个会话" : null,
        d.streak && d.streak.current ? "连续 " + d.streak.current + " 天" : null,
      ].filter(Boolean).join(" · ");
    }
    wrap.innerHTML = '<div class="st-col">' + kpiHtml(d) + heatHtml(d) + trendHtml(d) + modelsHtml(d)
      + sessionsHtml(d) + noteHtml(d) + "</div>";
    // 选中态在这里统一补 (真值只有 S.range / S.heat 两处, 不在 HTML 字符串里各写一份)
    var seg = $("statsRange");
    if (seg) seg.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("on", Number(b.getAttribute("data-range")) === S.range);
    });
    wrap.querySelectorAll("[data-heat]").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-heat") === S.heat);
    });
  }

  function load() {
    if (S.busy) return Promise.resolve(null);
    S.busy = true;
    var wrap = $("statsWrap");
    return req("/api/usage/stats").then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || "读不到用量账本");
      S.data = j;
      render();
      S.busy = false;
      return j;
    }).catch(function (e) {
      S.busy = false;
      if (wrap) wrap.innerHTML = '<div class="empty">读取失败：' + esc(e.message) + "</div>";
      var sub = $("statsSub");
      if (sub) sub.textContent = "用量账本不可用";
      return null;
    });
  }

  function bind() {
    var cap = $("capStats");
    if (cap) cap.onclick = function () { if (window.PPXBOT) window.PPXBOT.showView("stats"); };
    var back = $("statsBack");
    if (back) back.onclick = function () { if (window.PPXBOT) window.PPXBOT.showView("chat"); };
    var rf = $("statsRefresh");
    if (rf) rf.onclick = function () { load(); };
    var seg = $("statsRange");
    if (seg) seg.onclick = function (e) {
      var b = e.target.closest("[data-range]");
      if (!b) return;
      S.range = Number(b.getAttribute("data-range"));
      render();
    };
    var wrap = $("statsWrap");
    if (wrap) wrap.onclick = function (e) {
      var b = e.target.closest("[data-heat]");
      if (!b) return;
      S.heat = b.getAttribute("data-heat");
      render();
    };
  }

  function init() {
    bind();
    // 首屏不抢请求: 侧栏 / 本体状态那三路轮询已经在同一条 IP 限流里了,
    // 统计页只在真正进页时拉一次。
    var saved = null;
    try { saved = localStorage.getItem("ppx_view"); } catch (e) { /* 隐私模式下无所谓 */ }
    if (saved === "stats") load();
  }

  window.PPXSTATS = { load: load, render: render };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
