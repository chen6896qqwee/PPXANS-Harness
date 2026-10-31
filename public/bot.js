/* public/bot.js - 本体 (bot) 形态控制器 (2026-10-27)
 *
 * 分工: app.js 管「对话怎么跑」(流式、工具卡、审批、会话、抽屉);
 *       bot.js 管「本体是谁、现在什么状态、设置怎么改」。两者只通过 DOM 交汇 ——
 *       对话页的 stream / composer 是 app.js 的地盘, 这里一个像素都不碰。
 *
 * 数据: /api/bot.state 一次取全首屏; /api/bot.manage 单入口写。
 * 轮询: 3 秒一次, 页面隐藏时暂停 (dsh-bot 同款, 但那边是侧栏与页面共享同一次轮询,
 *       避免「各说各话」—— 这里也是: 一次请求同时喂侧栏、首页、对话头部)。
 */
(function () {
  "use strict";

  var B = {
    s: null,            // /api/bot.state 快照
    view: "chat",       // home | chat | settings
    pane: "talk",       // talk | trace
    timer: null,
    pollMs: 5000,       // 当前轮询间隔 (失败指数退避, 成功回到 5s)
    pollErr: false,     // 上一次 /api/bot.state 是否失败
    traces: [],
    traceDays: [],
    traceStats: {},
    traceDay: "",
    tfilter: "",
    memPath: null,      // 设置页正在看的记忆文件
    memText: "",
    typeFormOpen: false,
    plugins: [],        // /api/plugins 列表
    plugEdit: null,     // 正在编辑的插件 (null = 列表; isNew = 新建)
  };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function ico(name, size) {
    return '<svg width="' + (size || 14) + '" height="' + (size || 14) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><use href="#i-' + name + '"/></svg>';
  }

  function toast(msg, isErr) {
    var t = $("toast");
    if (!t) return;
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.hidden = false;
    clearTimeout(t._tm);
    t._tm = setTimeout(function () { t.hidden = true; }, 2600);
  }

  // 引导数据节点见 app.js 的同名函数说明 (CSP 不允许第二个可执行内联脚本)
  function bootData() {
    if (window.__PPX_BOOTSTRAP__) return window.__PPX_BOOTSTRAP__;
    var el = document.getElementById("ppx-boot");
    if (!el) return null;
    try { window.__PPX_BOOTSTRAP__ = JSON.parse(el.textContent || "{}"); } catch (e) { return null; }
    return window.__PPX_BOOTSTRAP__;
  }

  function base() {
    var b = bootData();
    return (b && b.base) || "";
  }

  function headers(json) {
    var h = {};
    if (json) h["Content-Type"] = "application/json";
    var boot = bootData();
    if (boot && boot.authToken) h["Authorization"] = "Bearer " + boot.authToken;
    else {
      var saved = localStorage.getItem("ppx_token");
      if (saved) h["Authorization"] = "Bearer " + saved;
    }
    return h;
  }

  var _unauthShown = false;
  function req(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign(headers(opts.body != null), opts.headers || {});
    var kill = null;
    if (opts.timeout && typeof AbortController !== "undefined") {
      var ctrl = new AbortController();
      opts.signal = ctrl.signal;
      kill = setTimeout(function () { ctrl.abort(); }, opts.timeout);
    }
    return fetch(base() + path, opts).finally(function () { if (kill) clearTimeout(kill); }).then(function (r) {
      if (r.status === 401 && !_unauthShown) {
        _unauthShown = true;
        toast("鉴权失败: 访问令牌无效, 请刷新页面", true);
        throw new Error("鉴权失败 (401)");
      }
      if (!r.ok) {
        return r.json().catch(function () { return null; }).then(function (j) {
          throw new Error((j && j.error) || ("HTTP " + r.status));
        });
      }
      return r.json().catch(function () { return null; });
    });
  }

  function shortAgo(iso) {
    if (!iso) return "";
    var t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    var d = Date.now() - t;
    if (d < 45000) return "刚刚";
    if (d < 3600000) return Math.round(d / 60000) + " 分";
    if (d < 86400000) return Math.round(d / 3600000) + " 时";
    return Math.round(d / 86400000) + " 天";
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + "B";
    if (n < 1048576) return Math.round(n / 1024) + "KB";
    return (n / 1048576).toFixed(1) + "MB";
  }

  function fmtMs(ms) {
    var n = Number(ms) || 0;
    if (n < 1000) return n + "ms";
    return (n / 1000).toFixed(n < 10000 ? 2 : 1) + "s";
  }

  /* ================= 视图 ================= */
  function showView(v) {
    B.view = v;
    ["home", "chat", "settings", "body", "plugins", "stats"].forEach(function (k) {
      var el = $("view-" + k);
      if (el) el.classList.toggle("on", k === v);
    });
    // 进对话页时把焦点还给输入框, 省一次点击
    if (v === "chat") {
      var inp = $("inp");
      if (inp && !(B.s && B.s.live && B.s.live.pendingApprovals)) setTimeout(function () { inp.focus(); }, 30);
    }
    if (v === "settings") renderSettings();
    if (v === "body") loadBody();
    if (v === "plugins") { renderPlugins(); loadPlugins(); }
    if (v === "stats" && window.PPXSTATS) window.PPXSTATS.load();
    try { localStorage.setItem("ppx_view", v); } catch (e) { /* 隐私模式下无所谓 */ }
  }

  /* ================= 身体 (2026-10-30) =================
     四张卡 = 四个体征。数据全部来自 /api/body.state (真实产物), 没跑过就显示 unknown 与"怎么跑",
     不编造健康值 —— 一个会撒谎的仪表盘比没有仪表盘更糟。 */
  var BODY_LABEL = { ok: "正常", warn: "注意", bad: "不健康", unknown: "没数据" };
  var OVERALL_LABEL = { ok: "体征正常", warn: "有指标需要看", bad: "有指标不健康", unknown: "数据不全" };

  function pct(v) { return (v == null || !isFinite(v)) ? "—" : Math.round(v * 100) + "%"; }

  function fillCard(id, state, val, html) {
    var card = $(id);
    if (!card) return;
    card.setAttribute("data-state", state || "unknown");
    var dot = card.querySelector(".bdot");
    if (dot) dot.className = "bdot t-" + (state || "unknown");
    var v = card.querySelector(".bval");
    if (v) v.textContent = val == null ? "—" : String(val);
    var b = card.querySelector(".bcard-b");
    if (b) b.innerHTML = html;
  }

  function setFeel(id, text) {
    var el = $(id);
    if (el) el.textContent = text || "—";
  }

  // 器官点: 状态写到 data-state, 呼吸节奏由 CSS 决定。
  //   unknown **不动** —— "不跳"就是"没量过", 比在图上写"暂无数据"更省事也更诚实。
  function setOrgan(organ, state) {
    var g = document.querySelector('.borgan[data-organ="' + organ + '"]');
    if (g) g.setAttribute("data-state", state || "unknown");
  }

  // 趋势线: 少于 2 个点直接返回空 —— 一个点连不成线, 硬画就是编。
  function spark(vals, tone) {
    if (!vals || vals.length < 2) return "";
    var w = 96, h = 20, pad = 3;
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var span = max - min;
    if (!(span > 0.001)) span = 0.001; // 全等时画一条平线 (那也是信息: 一直没动)
    var pts = vals.map(function (v, i) {
      var x = pad + (i / (vals.length - 1)) * (w - pad * 2);
      var y = h - pad - ((v - min) / span) * (h - pad * 2);
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    var last = pts[pts.length - 1].split(",");
    return '<svg class="bspark t-' + esc(tone || "unknown") + '" viewBox="0 0 ' + w + " " + h + '" width="' + w + '" height="' + h + '" aria-hidden="true">'
      + '<polyline points="' + pts.join(" ") + '"></polyline>'
      + '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="2"></circle></svg>';
  }

  function loadBody() {
    req("/api/body.state", { timeout: 8000 }).then(function (s) {
      var o = $("bodyOverall");
      if (o) o.textContent = OVERALL_LABEL[s.overall] || "—";
      var dot = $("bodyDot");
      if (dot) dot.className = "bdot t-" + (s.overall || "unknown");
      var vd = $("bodyVerdict");
      if (vd) vd.textContent = s.verdict || "—";
      var hist = s.history || {};

      // 痛觉: 离线任务成功率 (harness 能不能把正确计划执行成结果)
      var p = s.pain || {};
      setOrgan("pain", p.state);
      if (p.total) {
        fillCard("cardPain", p.state, pct(p.rate),
          '<div class="brow"><b>' + p.passed + "/" + p.total + "</b> 个任务干成 · 耗时 " + fmtMs(p.ms) + "</div>"
          + '<div class="bsub">最近一次 ' + esc(shortAgo(p.at)) + "前 · " + esc(BODY_LABEL[p.state] || p.state) + "</div>"
          + spark(hist.pain, p.state));
      } else {
        fillCard("cardPain", "unknown", "—", '<div class="bnote">' + esc(p.hint || "还没跑过") + "</div>");
      }
      setFeel("painFeel", p.feeling);

      // 记忆: 库规模 + 召回质量。
      //   recallK 这一栏现在读的是 acceptance (= holdout 留出集), 也就是"换个说法还认不认得出";
      //   recall1 是"原话直接命中"。两个数分开写, 不合成一个看起来体面的分。
      var m = s.memory || {};
      setOrgan("memory", m.state);
      var memHtml = '<div class="brow"><b>' + (m.facts == null ? "?" : m.facts) + "</b> 条有效记忆</div>";
      if (m.recallK != null) {
        // 拆两行: 一行放"两种命中率", 一行放"用的什么向量 + 什么时候跑的"。
        //   挤成一行在窄卡里会被截断 —— 面板宁可多一行, 也不要让人看到 "hash…"。
        memHtml += '<div class="bsub">换个说法认得出来 <b>' + pct(m.recallK) + "</b> · 原话直接命中 " + pct(m.recall1) + "</div>";
        memHtml += '<div class="bsub">向量 ' + esc(m.embedder || "?") + " · 最近一次 " + esc(shortAgo(m.at)) + "前 · " + esc(BODY_LABEL[m.state] || m.state) + "</div>"
          + spark(hist.memory, m.state);
      } else {
        memHtml += '<div class="bnote">' + esc(m.hint || "还没跑过") + "</div>";
      }
      fillCard("cardMemory", m.state, m.recallK == null ? "—" : pct(m.recallK), memHtml);
      setFeel("memFeel", m.feeling);

      // 手头的事: 跨轮任务栈
      var w = s.work || {};
      setOrgan("work", w.state);
      var items = (w.items || []).filter(function (x) { return x.status !== "done"; });
      var workVal = items.length ? items.length + " 件" : "空";
      var workHtml = "";
      if (items.length) {
        workHtml = items.slice(0, 5).map(function (x) {
          var st = x.status === "blocked" ? "⏸" : "▶";
          var pend = (x.steps || []).filter(function (st2) { return !st2.done; }).length;
          return '<div class="bitem">' + st + " " + esc(x.goal) + (pend ? ' <span class="bsub">(' + pend + " 步未完成)</span>" : "") + "</div>";
        }).join("");
      } else {
        workHtml = '<div class="bnote">手头没挂着的事。长任务开工前让皮皮虾 task_stack push 一条。</div>';
      }
      fillCard("cardWork", w.state || "unknown", workVal, workHtml);
      setFeel("workFeel", w.feeling);

      // 负荷
      var l = s.load || {};
      setOrgan("load", l.state || "ok");
      fillCard("cardLoad", "ok", l.tools == null ? "—" : l.tools + " 工具",
        '<div class="brow">会话 <b>' + (l.sessions == null ? "?" : l.sessions) + "</b> · 模型 provider <b>" + (l.providers == null ? "?" : l.providers) + "</b></div>"
        + '<div class="bsub">进程已跑 ' + esc(fmtMs(l.uptimeMs)) + " · " + esc(l.node || "") + "</div>");
      setFeel("loadFeel", l.feeling);
    }).catch(function (e) {
      var o = $("bodyOverall");
      if (o) o.textContent = "读取失败: " + e.message;
      var vd = $("bodyVerdict");
      if (vd) vd.textContent = "拿不到体征 —— 不是「健康」, 是「不知道」。";
    });
  }

  // 点器官 = 把对应卡片亮一下。
  //   画了空间映射就得让它能用: 光靠颜色对应, 人得来回找 "头是哪个指标"。
  function bindOrgans() {
    var map = { pain: "cardPain", memory: "cardMemory", work: "cardWork", load: "cardLoad" };
    var org = document.querySelectorAll(".borgan");
    for (var i = 0; i < org.length; i++) {
      (function (g) {
        g.addEventListener("click", function () {
          var card = $(map[g.getAttribute("data-organ")]);
          if (!card) return;
          card.classList.add("blink");
          setTimeout(function () { card.classList.remove("blink"); }, 1200);
        });
      })(org[i]);
    }
  }

  function showPane(p) {
    B.pane = p;
    document.querySelectorAll("#chatPanes .ptab").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-pane") === p);
    });
    var talk = $("pane-talk"), trace = $("pane-trace");
    if (talk) { talk.classList.toggle("on", p === "talk"); talk.hidden = p !== "talk"; }
    if (trace) { trace.classList.toggle("on", p === "trace"); trace.hidden = p !== "trace"; }
    if (p === "trace") loadTraces();
  }

  function setTone(el, tone) {
    if (!el) return;
    el.setAttribute("data-tone", tone || "quiet");
  }

  /* ================= 状态 ================= */
  function loadState(quiet) {
    return req("/api/bot.state", { timeout: 10000 }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || "读取本体状态失败");
      B.pollErr = false;
      B.s = j;
      renderAll(j);
      return j;
    }).catch(function (e) {
      B.pollErr = true;
      if (!quiet) {
        var box = $("homeErr");
        if (box) { box.hidden = false; box.textContent = e.message; }
        var sub = $("chatSub");
        if (sub) sub.textContent = "状态不可用: " + e.message;
      }
    });
  }

  // 轮询重绘不能吞掉用户正在输入的控件: 内联改名/新建类型等输入框一旦被 innerHTML
  //   重建, 输入到一半的内容和焦点都会消失 (5 秒一次的轮询会反复触发)。
  function hasActiveEditor(container) {
    var ae = document.activeElement;
    if (!container || !ae || !container.contains(ae)) return false;
    var tag = String(ae.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || ae.isContentEditable;
  }

  function renderAll(s) {
    renderSide(s);
    renderHome(s);
    renderChatHead(s);
  }

  /* ================= 侧栏 ================= */
  function renderSide(s) {
    var el = $("botList");
    if (!el) return;
    var list = (s.bots || []).slice().sort(function (a, b) {
      return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    });
    $("botCount").textContent = list.length > 1 ? String(list.length) : "";
    el.innerHTML = '<div class="blist">' + list.map(function (b) {
      var on = b.id === s.bot.id;
      var av = (on && s.bot.avatarUrl)
        ? '<img src="' + esc(s.bot.avatarUrl) + '" alt="">'
        : esc(String(b.name || "皮").slice(0, 1));
      return '<div class="bitem' + (on ? " on" : "") + (b.paused ? " paused" : "") + '" data-bot="' + esc(b.id) + '" title="' + esc(b.name + " · " + b.typeName) + '">'
        + '<span class="bav">' + av + '</span>'
        + '<span class="bnm">' + esc(b.name) + '</span>'
        + (b.pinned ? '<span class="bpin">' + ico("pin", 11) + '</span>' : "")
        + '<span class="btm">' + esc(shortAgo(b.updatedAt)) + '</span>'
        + '</div>';
    }).join("") + '</div>';
  }

  /* ================= 首页 ================= */
  function renderHome(s) {
    setTone($("view-home"), s.live.tone);
    var av = $("homeAvatar");
    if (av) {
      av.innerHTML = s.bot.avatarUrl
        ? '<img src="' + esc(s.bot.avatarUrl) + '" alt="">'
        : esc(String(s.bot.name || "皮").slice(0, 1));
    }
    var nm = $("homeName");
    if (nm) nm.textContent = s.bot.name;
    var sub = $("homeSub");
    if (sub) {
      sub.textContent = [
        s.bot.typeName + (s.bot.paused ? " · 已暂停" : " · 运行中"),
        s.bot.blurb || null,
        s.live.pendingApprovals ? s.live.pendingApprovals + " 个待批准" : null,
      ].filter(Boolean).join(" · ");
    }

    // 类型卡
    var cards = $("typeCards");
    if (cards && !hasActiveEditor(cards)) {
      cards.innerHTML = (s.types || []).map(function (t) {
        var on = t.id === s.bot.type;
        // 类型图标盘: 内置四类各配一图一色 (配色在 app.css .bcard-ico), 自定义类型走通用 spark
        var tico = { companion: "bot", assistant: "zap", researcher: "scan", scribe: "book" }[t.id] || "spark";
        var tcls = { companion: "c-comp", assistant: "c-asst", researcher: "c-rsch", scribe: "c-scrb" }[t.id] || "c-custom";
        return '<button class="bcard" data-type="' + esc(t.id) + '"' + (on ? ' style="border-color:var(--accent)"' : "") + '>'
          + '<span class="bcard-ico ' + tcls + '" aria-hidden="true">' + ico(tico, 15) + '</span>'
          + '<b>' + esc(t.name) + (on ? ' · 现在这个' : "") + '</b>'
          + '<span>' + esc(t.blurb || "—") + '</span>'
          + (!t.builtin ? '<span class="del" data-deltype="' + esc(t.id) + '" title="删除类型">' + ico("close", 12) + '</span>' : "")
          + '</button>';
      }).join("");
    }

    // 已有本体
    var rows = $("botRows");
    if (rows && !hasActiveEditor(rows)) {
      rows.innerHTML = (s.bots || []).map(function (b) {
        var on = b.id === s.bot.id;
        var avHtml = (on && s.bot.avatarUrl)
          ? '<img src="' + esc(s.bot.avatarUrl) + '" alt="">'
          : esc(String(b.name || "皮").slice(0, 1));
        return '<div class="brow" data-open="' + esc(b.id) + '">'
          + '<span class="avavt sm">' + avHtml + '</span>'
          + '<span class="bn">' + esc(b.name) + '</span>'
          + '<span class="bm">' + esc(b.typeName) + ' · ' + esc(shortAgo(b.updatedAt)) + (b.paused ? " · 已暂停" : "") + '</span>'
          + '<span class="bacts">'
          + '<button class="icobtn sm" data-pin="' + esc(b.id) + '" data-pinned="' + (b.pinned ? "1" : "0") + '" title="' + (b.pinned ? "取消置顶" : "置顶") + '">' + ico("pin", 13) + '</button>'
          + '<button class="icobtn sm" data-rename="' + esc(b.id) + '" title="改名">' + ico("edit", 13) + '</button>'
          + '<button class="icobtn sm" data-avatar="' + esc(b.id) + '" title="上传头像">' + ico("image", 13) + '</button>'
          + '<button class="icobtn sm" data-pause="' + esc(b.id) + '" data-paused="' + (b.paused ? "1" : "0") + '" title="' + (b.paused ? "继续运行" : "暂停") + '">' + ico(b.paused ? "play" : "pause", 13) + '</button>'
          + '</span>'
          + '</div>';
      }).join("");
    }
  }

  /* ================= 对话页头部 ================= */
  function renderChatHead(s) {
    setTone($("view-chat"), s.live.tone);
    var av = $("chatAvatar");
    if (av) {
      av.innerHTML = s.bot.avatarUrl
        ? '<img src="' + esc(s.bot.avatarUrl) + '" alt="">'
        : esc(String(s.bot.name || "皮").slice(0, 1));
      av.setAttribute("data-live", s.bot.paused ? "0" : "1");
    }
    var nm = $("chatName");
    if (nm) nm.textContent = s.bot.name;
    var sub = $("chatSub");
    if (sub) {
      var bits = [];
      bits.push(s.bot.typeName);
      bits.push((s.live.traces.count || 0) + " 次工具调用");
      if (s.live.pendingApprovals) bits.push(s.live.pendingApprovals + " 个待批准");
      if (s.live.stage) bits.push("阶段 " + s.live.stage);
      if (s.bot.paused) bits.push("已暂停");
      sub.textContent = bits.join(" · ");
    }
  }

  /* ================= 轨迹 ================= */
  // 轨迹走 /api/bot.traces: 它把「工具调用」与「事件流」两路合并了。
  // (只读 /api/traces 的话, 某天一次工具都没调, 页面就是空白 —— 但那天的记忆提炼、
  //  persona 加载其实是发生过的, 只是记在另一个文件里。)
  function loadTraces(day) {
    if (day !== undefined) B.traceDay = day;
    var q = "/api/bot.traces?limit=400" + (B.traceDay ? "&day=" + encodeURIComponent(B.traceDay) : "");
    return req(q, { timeout: 15000 }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || "读不到轨迹");
      B.traces = j.events || [];
      B.traceDays = j.days || [];
      B.traceStats = j.stats || {};
      renderTraceDays(j);
      renderTraces();
    }).catch(function (e) {
      var el = $("traceList");
      if (el) el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    });
  }

  function renderTraceDays(j) {
    var sel = $("traceDay");
    if (!sel) return;
    var days = j.days || [];
    sel.innerHTML = '<option value="">今天</option>' + days.map(function (d) {
      return '<option value="' + esc(d) + '"' + (B.traceDay === d ? " selected" : "") + '>' + esc(d) + '</option>';
    }).join("");
    sel.value = B.traceDay || "";
  }

  function renderTraces() {
    var el = $("traceList");
    if (!el) return;
    var q = String(B.tfilter || "").trim().toLowerCase();
    var all = B.traces.slice(); // 服务端已按时间倒序, 新的在上
    var list = q
      ? all.filter(function (t) {
        return (String(t.name || "") + " " + String(t.detail || "") + " " + String(t.error || "")).toLowerCase().indexOf(q) >= 0;
      })
      : all;

    var st = $("traceStats");
    var stats = B.traceStats || {};
    if (st) {
      if (all.length) {
        st.textContent = [
          (stats.count || all.length) + " 条",
          "工具 " + (stats.tools || 0),
          "事件 " + (stats.notes || 0),
          stats.failed ? "失败 " + stats.failed : null,
          stats.totalMs ? "耗时 " + fmtMs(stats.totalMs) : null,
        ].filter(Boolean).join(" · ");
      } else {
        st.textContent = B.traceDay ? B.traceDay + " 没有记录" : "今天还没有记录";
      }
    }

    if (!list.length) {
      el.innerHTML = '<div class="empty">' + (q ? "没有匹配的轨迹" : (B.traceDay ? "这一天没有记录" : "今天还没有记录")) + '</div>';
      return;
    }

    el.innerHTML = list.map(function (t) {
      var note = t.kind === "note";
      var name = t.name || "?";
      var detail = t.ok === false ? (t.error || "失败") : (t.detail || "");
      return '<div class="titem' + (t.ok === false ? " bad" : "") + '">'
        + '<span class="tname"' + (note ? ' style="color:var(--text3)"' : "") + '>' + esc(name) + '</span>'
        + '<span class="targ" title="' + esc(detail) + '">' + esc(detail) + '</span>'
        + '<span class="tms">' + esc(t.ms ? fmtMs(t.ms) : "") + '</span>'
        + '</div>';
    }).join("");
  }

  /* ================= 设置页 ================= */
  function srow(label, ctl, hint) {
    return '<div class="srow"><span class="slab">' + esc(label) + '</span><span class="sctl">' + ctl + '</span></div>'
      + (hint ? '<div class="shint">' + esc(hint) + '</div>' : "");
  }

  function seg(name, value, options) {
    return '<span class="seg" data-seg="' + esc(name) + '">' + options.map(function (o) {
      return '<button data-val="' + esc(o[0]) + '"' + (o[0] === value ? ' class="on"' : "") + '>' + esc(o[1]) + '</button>';
    }).join("") + '</span>';
  }

  function numInput(name, value, min, max) {
    return '<input type="number" data-num="' + esc(name) + '" value="' + esc(value) + '" min="' + min + '" max="' + max + '">';
  }

  function renderSettings() {
    var s = B.s;
    var body = $("botSettings");
    if (!body) return;
    if (!s) { body.innerHTML = '<div class="empty">还没读到本体状态</div>'; return; }
    setTone($("view-settings"), s.live.tone);
    var t = $("setTitle");
    if (t) t.textContent = "设置 · " + s.bot.name;
    var sub = $("setSub");
    if (sub) sub.textContent = s.bot.typeName + " · " + s.workspace;

    var st = s.settings || {};
    var rules = st.rules || {};
    var worker = st.worker || {};
    var limits = st.limits || {};
    var auto = st.autonomy || {};
    var brief = st.briefing || {};
    var live = s.live || {};

    var html = "";

    /* --- 运行状态 --- */
    html += '<div class="ssec"><div class="ssec-head">运行状态<span class="flex1"></span>'
      + '<button class="wbtn" data-act="refresh">刷新</button></div>'
      + srow("运行", seg("paused", s.bot.paused ? "paused" : "running", [["running", "运行中"], ["paused", "已暂停"]]),
        s.bot.paused ? "暂停只是让本体不再主动行动, 你发消息它照常回。" : null)
      + srow("生命周期", '<span class="svd">' + esc(
        (live.stage ? "阶段 " + live.stage : "阶段 —") + " · " + (live.chats != null ? live.chats + " 次对话" : "对话数未知")
        + (live.evolved != null ? " · 进化 " + live.evolved + " 次" : "")
      ) + '</span>')
      + srow("心跳", '<span class="svd">' + esc(shortAgo(live.heartbeatAt) + " · 进程已跑 " + Math.round((live.uptimeMs || 0) / 60000) + " 分钟") + '</span>')
      + srow("今天", '<span class="svd">' + esc((live.traces.count || 0) + " 次工具调用 · 失败 " + (live.traces.failed || 0) + " · 失败率 " + (live.traces.failRate || "0%")) + '</span>')
      + '</div>';

    /* --- 名字 / 类型 / 头像 --- */
    html += '<div class="ssec"><div class="ssec-head">身份</div>'
      + srow("名字", '<input type="text" id="setName" class="grow" value="' + esc(s.bot.name) + '" maxlength="40">'
        + '<button class="wbtn primary" data-act="rename">保存</button>')
      + srow("类型", seg("type", s.bot.type, (s.types || []).map(function (x) { return [x.id, x.name]; }))
        + (s.bot.blurb ? '<span class="svd">' + esc(s.bot.blurb) + '</span>' : ""))
      + srow("头像", '<button class="wbtn" data-act="avatarPick">上传图片</button><button class="wbtn danger" data-act="avatarClear">移除</button>',
        "PNG / JPEG / WebP / GIF，≤4MB。按内容类型校验, 不看扩展名。")
      + '</div>';

    /* --- 工作区 --- */
    html += '<div class="ssec"><div class="ssec-head">工作区</div>'
      + srow("路径", '<input type="text" id="setWs" class="grow" value="' + esc(s.bot.workspace) + '" spellcheck="false">'
        + '<button class="wbtn" data-act="workspace">应用</button>',
        "改工作区只改档案记录。真正跑在哪由启动时的 root 决定 —— 换目录请用新工作区重启, 界面不假装已经切过去了。")
      + '</div>';

    /* --- 规则 --- */
    var ruleOpts = [["auto", "自己干"], ["preapproved", "预先批准的才干"], ["ask", "每次问"], ["handoff", "交给别人"]];
    html += '<div class="ssec"><div class="ssec-head">规则</div>'
      + srow("后台干活", seg("rules.background", rules.background, ruleOpts))
      + srow("对外发送", seg("rules.outbound", rules.outbound, ruleOpts),
        "「对外发送」管的是发邮件/发消息这类一旦发出就收不回的动作。默认每次问。")
      + '</div>';

    /* --- 后台执行 --- */
    html += '<div class="ssec"><div class="ssec-head">后台执行</div>'
      + srow("启用", seg("worker.enabled", worker.enabled ? "1" : "0", [["1", "开"], ["0", "关"]]))
      + srow("看队列间隔", numInput("worker.pollSeconds", worker.pollSeconds, 5, 3600) + '<span class="svd">秒</span>')
      + srow("同时做几件", numInput("worker.concurrency", worker.concurrency, 1, 8) + '<span class="svd">件</span>')
      + srow("今日次数", '<span class="svd">' + esc(String(worker.todayRuns || 0)) + ' 次</span>')
      + '</div>';

    /* --- 晨间简报 --- */
    html += '<div class="ssec"><div class="ssec-head">晨间简报</div>'
      + srow("启用", seg("briefing.enabled", brief.enabled ? "1" : "0", [["1", "开"], ["0", "关"]]))
      + srow("时间", '<input type="time" id="setBriefTime" value="' + esc(brief.time || "08:30") + '">'
        + '<button class="wbtn" data-act="briefTime">保存</button>')
      + srow("现在发一条", '<button class="wbtn" data-act="briefNow">立刻生成</button><span class="svd">上次: ' + esc(brief.lastAt ? shortAgo(brief.lastAt) : "从未") + '</span>')
      + '</div>';

    /* --- 日程 --- */
    html += '<div class="ssec"><div class="ssec-head">日程<span class="flex1"></span><span class="svd">' + (s.agenda || []).length + ' 条</span></div>'
      + '<div class="srow"><span class="sctl"><input type="text" id="agText" class="grow" placeholder="要做的事…" maxlength="200">'
      + '<input type="time" id="agAt"><button class="wbtn primary" data-act="agAdd">添加</button></span></div>'
      + ((s.agenda || []).length
        ? (s.agenda || []).map(function (a) {
          return '<div class="ag' + (a.done ? " done" : "") + '">'
            + '<button class="icobtn sm" data-agdone="' + esc(a.id) + '" data-done="' + (a.done ? "1" : "0") + '" title="' + (a.done ? "标记未完成" : "标记完成") + '">'
            + ico(a.done ? "check" : "stop-dot", 13) + '</button>'
            + '<span class="agt">' + esc(a.text) + '</span>'
            + (a.at ? '<span class="agw">' + esc(a.at) + '</span>' : "")
            + '<button class="icobtn sm" data-agdel="' + esc(a.id) + '" title="删除">' + ico("trash", 13) + '</button>'
            + '</div>';
        }).join("")
        : '<div class="shint">还没有日程。日程是给本体自己看的待办，不是日历 —— 到点它会主动提。</div>')
      + '</div>';

    /* --- 限额 --- */
    html += '<div class="ssec"><div class="ssec-head">限额<span class="flex1"></span><button class="wbtn" data-act="saveLimits">保存</button></div>'
      + srow("单任务最多跑", numInput("limits.maxTaskMinutes", limits.maxTaskMinutes, 0, 1440) + '<span class="svd">分钟</span>')
      + srow("每天累计", numInput("limits.dailyMinutes", limits.dailyMinutes, 0, 1440) + '<span class="svd">分钟</span>')
      + srow("单任务最多调工具", numInput("limits.maxToolCalls", limits.maxToolCalls, 0, 10000) + '<span class="svd">次</span>')
      + srow("队列保留", numInput("limits.queueKeep", limits.queueKeep, 0, 10000) + '<span class="svd">条</span>')
      + srow("回放保留", numInput("limits.replayKeep", limits.replayKeep, 0, 10000) + '<span class="svd">条</span>')
      + srow("面板加载", numInput("limits.panelLimit", limits.panelLimit, 0, 1000) + '<span class="svd">条</span>',
        "0 = 不限。这些是给自主行动装的刹车 —— 没人看着的时候, 它最多能花多少时间、调多少次工具。")
      + '</div>';

    /* --- 自主时间 --- */
    html += '<div class="ssec"><div class="ssec-head">自主时间</div>'
      + srow("启用", seg("autonomy.enabled", auto.enabled ? "1" : "0", [["1", "开"], ["0", "关"]]))
      + srow("空闲多久动一次", numInput("autonomy.idleMinutes", auto.idleMinutes, 1, 1440) + '<span class="svd">分钟</span>')
      + srow("每小时最多", numInput("autonomy.maxPerHour", auto.maxPerHour, 1, 120) + '<span class="svd">次</span>')
      + srow("模式", seg("autonomy.mode", auto.mode, [["read", "只读"], ["review", "可动手·每步审查"], ["full", "完全权限"]]),
        "只读 = 只看不动；可动手 = 能改但每步等你点头；完全权限 = 自己决定。默认只读。")
      + srow("现在就去看一眼", '<button class="wbtn" data-act="proactive">立刻扫描</button>')
      + '</div>';

    /* --- 权限 --- */
    html += '<div class="ssec"><div class="ssec-head">权限</div>'
      + srow("审批模式", '<select id="setApproval2">' + ["unless-trusted", "on-request", "on-failure", "never"].map(function (m) {
        return '<option value="' + m + '"' + (live.approvalMode === m ? " selected" : "") + '>' + m + '</option>';
      }).join("") + '</select>')
      + srow("沙箱", '<select id="setSandbox2">' + ["read-only", "workspace-write", "danger-full-access"].map(function (m) {
        return '<option value="' + m + '"' + (live.sandbox === m ? " selected" : "") + '>' + m + '</option>';
      }).join("") + '</select><button class="wbtn primary" data-act="permission">应用</button>')
      + '</div>';

    /* --- 记忆 --- */
    html += '<div class="ssec"><div class="ssec-head">记忆<span class="flex1"></span>'
      + '<span class="svd">事实 ' + esc(s.memory.factCount) + ' · 场景 ' + esc(s.memory.sceneCount) + ' · 文件 ' + esc((s.memory.files || []).length) + '</span></div>'
      + ((s.memory.files || []).length
        ? (s.memory.files || []).map(function (f) {
          return '<div class="memfile" data-mem="' + esc(f.path) + '">' + ico("file", 12) + esc(f.path)
            + '<span class="msz">' + fmtBytes(f.size) + ' · ' + esc(shortAgo(f.mtime)) + '</span></div>';
        }).join("")
        : '<div class="shint">data/memory 下没有可读文件。</div>')
      + (B.memPath ? '<div class="srow"><span class="sctl"><span class="svd">' + esc(B.memPath) + '</span><span class="flex1"></span>'
        + '<button class="wbtn primary" data-act="memSave">保存</button>'
        + '<button class="wbtn" data-act="memClose">关闭</button></span></div>'
        + '<textarea class="mempane" id="memEdit" spellcheck="false">' + esc(B.memText) + '</textarea>' : "")
      + '</div>';

    /* --- 服务 --- */
    html += '<div class="ssec"><div class="ssec-head">服务</div>'
      + ((s.services || []).length
        ? (s.services || []).map(function (x) {
          return '<div class="svc" data-state="' + esc(x.state) + '"><span class="sdot"></span>'
            + '<span class="svn">' + esc(x.name) + '</span><span class="svd">' + esc(x.kind) + ' · ' + esc(x.detail) + '</span></div>';
        }).join("")
        : '<div class="shint">没有可列的服务。</div>')
      + '<div class="shint">灰点 = 没测过，不等于没问题。要测连通性请到「模型配置」页点测试。</div>'
      + '</div>';

    /* --- 关于 --- */
    const tl = live.tools || {};
    html += '<div class="ssec"><div class="ssec-head">关于</div>'
      + srow("版本", '<span class="svd">' + esc(s.version || "未知") + '</span>')
      + srow("工作区", '<span class="svd">' + esc(s.workspace) + '</span>')
      + srow("工具", '<span class="svd">' + esc((tl.total || 0) + " 个 · 启用 " + (tl.enabled || 0)) + '</span>')
      + srow("模型", '<span class="svd">' + esc(live.model || "未配置") + '</span>')
      + srow("今天轮数", '<span class="svd">' + esc(live.turns == null ? "未知" : live.turns) + '</span>')
      + '</div>';

    body.innerHTML = html;
  }

  /* ================= 写操作 ================= */
  function manage(action, payload, okMsg) {
    var body = Object.assign({ action: action }, payload || {});
    return req("/api/bot.manage", { method: "POST", timeout: 25000, body: JSON.stringify(body) }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || "操作失败");
      if (j.state) {
        B.s = j.state;
        renderAll(j.state);
        if (B.view === "settings") renderSettings();
      }
      if (okMsg) toast(okMsg);
      return j;
    }).catch(function (e) {
      toast(e.message, true);
      throw e;
    });
  }

  function settingsPatch(patch, okMsg) {
    return manage("settings", { patch: patch }, okMsg || "已保存");
  }

  /* ================= 交互绑定 ================= */
  function bindSidebar() {
    var bl = $("botList");
    if (bl) {
      bl.onclick = function (e) {
        var it = e.target.closest("[data-bot]");
        if (!it) return;
        showView("chat");
        var sub = $("chatSub");
        if (sub) sub.textContent = "正在切到 " + (B.s && B.s.bot.name || "本体");
      };
    }
    var n = $("btnNewBot");
    if (n) n.onclick = function () { showView("home"); var tc = $("typeCards"); if (tc) tc.scrollIntoView({ block: "start" }); };

    // 侧栏的会话列表与「新会话」由 app.js 管, 但切完会话得回到对话视图 ——
    // 用捕获阶段先切视图, 不改 app.js 的绑定, 也不和它抢事件。
    var sl = $("sessList");
    if (sl) sl.addEventListener("click", function () { showView("chat"); }, true);
    var bn = $("btnNew");
    if (bn) bn.addEventListener("click", function () { showView("chat"); }, true);
  }

  function bindHome() {
    var cards = $("typeCards");
    if (cards) {
      cards.onclick = function (e) {
        var del = e.target.closest("[data-deltype]");
        if (del) {
          e.stopPropagation();
          manage("typeRemove", { typeId: del.getAttribute("data-deltype") }, "类型已删除");
          return;
        }
        var card = e.target.closest("[data-type]");
        if (!card) return;
        var id = card.getAttribute("data-type");
        var types = (B.s && B.s.types) || [];
        var t = types.find(function (x) { return x.id === id; });
        if (!t) return;
        var sameType = B.s && B.s.bot.type === id;
        manage("type", { typeId: id }, "已切到「" + t.name + "」");
        // 切换类型 = 换一种干活的姿态, 那就开一局新的
        if (window.PPX && typeof window.PPX.newSession === "function") window.PPX.newSession();
        showView("chat");
        if (sameType) toast("类型没变, 开了个新会话");
      };
    }

    var tgl = $("btnNewType");
    if (tgl) tgl.onclick = function () {
      var f = $("typeForm");
      if (!f) return;
      f.hidden = !f.hidden;
      if (!f.hidden && $("typeName")) $("typeName").focus();
    };
    var tc = $("typeCancel");
    if (tc) tc.onclick = function () { $("typeForm").hidden = true; };
    var ts = $("typeSave");
    if (ts) ts.onclick = function () {
      var name = ($("typeName").value || "").trim();
      if (!name) { toast("类型名不能为空", true); return; }
      manage("typeAdd", { name: name, blurb: ($("typeBlurb").value || "").trim() }, "类型已保存").then(function () {
        $("typeName").value = "";
        $("typeBlurb").value = "";
        $("typeForm").hidden = true;
      }).catch(function () { /* toast 已弹 */ });
    };

    var rows = $("botRows");
    if (rows) {
      rows.onclick = function (e) {
        var pin = e.target.closest("[data-pin]");
        if (pin) {
          e.stopPropagation();
          manage("pin", { id: pin.getAttribute("data-pin"), pinned: pin.getAttribute("data-pinned") !== "1" });
          return;
        }
        var rn = e.target.closest("[data-rename]");
        if (rn) { e.stopPropagation(); inlineRename(rn.getAttribute("data-rename")); return; }
        var av = e.target.closest("[data-avatar]");
        if (av) { e.stopPropagation(); pickAvatar(av.getAttribute("data-avatar")); return; }
        var pa = e.target.closest("[data-pause]");
        if (pa) {
          e.stopPropagation();
          manage("pause", { id: pa.getAttribute("data-pause"), paused: pa.getAttribute("data-paused") !== "1" });
          return;
        }
        var open = e.target.closest("[data-open]");
        if (open) showView("chat");
      };
    }

    var gear = $("homeGear");
    if (gear) gear.onclick = function () { showView("settings"); };
  }

  function inlineRename(id) {
    var row = document.querySelector('[data-open="' + id + '"]');
    if (!row) return;
    var b = B.s && B.s.bots ? B.s.bots.find(function (x) { return x.id === id; }) : null;
    if (!b) return;
    var span = row.querySelector(".bn");
    var old = span.textContent;
    var inp = document.createElement("input");
    inp.type = "text";
    inp.value = old;
    inp.maxLength = 40;
    inp.style.cssText = "flex:1;border:1px solid var(--accent);background:var(--surface);color:var(--text);border-radius:6px;padding:3px 7px;font:12.5px var(--sans);outline:none";
    span.replaceWith(inp);
    inp.focus();
    inp.select();
    var done = false;
    function commit(ok) {
      if (done) return;
      done = true;
      var v = (inp.value || "").trim();
      if (ok && v && v !== old) manage("rename", { id: id, name: v }, "改好了");
      else renderHome(B.s);
    }
    inp.onkeydown = function (e) {
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      if (e.key === "Escape") { e.preventDefault(); commit(false); }
    };
    inp.onblur = function () { commit(true); };
  }

  function pickAvatar(id) {
    var f = $("fileInput");
    if (f) {
      // 借用 composer 的 input[type=file], 但走自己的 onchange, 完事还原
      var clone = document.createElement("input");
      clone.type = "file";
      clone.accept = "image/png,image/jpeg,image/webp,image/gif";
      clone.onchange = function () {
        var file = clone.files && clone.files[0];
        if (!file) return;
        if (file.size > 4 * 1024 * 1024) { toast("头像不能超过 4MB", true); return; }
        var fr = new FileReader();
        fr.onload = function () {
          manage("avatar", { id: id, dataUrl: String(fr.result) }, "头像已更新");
        };
        fr.readAsDataURL(file);
      };
      clone.click();
    }
  }

  function bindChat() {
    var back = $("btnBack");
    if (back) back.onclick = function () { showView("home"); };
    var gear = $("chatGear");
    if (gear) gear.onclick = function () { showView("settings"); };
    var nn = $("btnChatNew");
    if (nn) nn.onclick = function () {
      if (window.PPX && typeof window.PPX.newSession === "function") window.PPX.newSession();
    };
    document.querySelectorAll("#chatPanes .ptab").forEach(function (b) {
      b.onclick = function () { showPane(b.getAttribute("data-pane")); };
    });
    var ts = $("traceSearch");
    if (ts) ts.oninput = function () { B.tfilter = ts.value; renderTraces(); };
    var tr = $("btnTraceRefresh");
    if (tr) tr.onclick = function () { loadTraces(); };
    var td = $("traceDay");
    if (td) td.onchange = function () { loadTraces(td.value || ""); };
  }

  function bindSettings() {
    var body = $("botSettings");
    if (body) {
      body.onclick = function (e) {
        var segEl = e.target.closest("[data-seg] button");
        if (segEl) {
          var wrap = segEl.parentElement;
          wrap.querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", b === segEl); });
          applySeg(wrap.getAttribute("data-seg"), segEl.getAttribute("data-val"));
          return;
        }
        var agd = e.target.closest("[data-agdone]");
        if (agd) {
          manage("agendaDone", { agendaId: agd.getAttribute("data-agdone"), done: agd.getAttribute("data-done") !== "1" });
          return;
        }
        var agx = e.target.closest("[data-agdel]");
        if (agx) { manage("agendaRemove", { agendaId: agx.getAttribute("data-agdel") }, "已删除"); return; }
        var mem = e.target.closest("[data-mem]");
        if (mem) { openMem(mem.getAttribute("data-mem")); return; }
        var act = e.target.closest("[data-act]");
        if (!act) return;
        doAct(act.getAttribute("data-act"));
      };
    }
    var back = $("setBack");
    if (back) back.onclick = function () { showView("chat"); };
    var rf = $("btnSetRefresh");
    if (rf) rf.onclick = function () { loadState(); toast("已刷新"); };
    // 身体页 (2026-10-30): 左上角入口 + 返回 + 刷新
    var bb = $("btnBody");
    if (bb) bb.onclick = function () { showView("body"); };
    var bk = $("bodyBack");
    if (bk) bk.onclick = function () { showView("home"); };
    var br = $("btnBodyRefresh");
    if (br) br.onclick = function () { loadBody(); toast("已刷新体征"); };
    // 侧栏「本体设置」
    var cap = $("capSettings");
    if (cap) cap.onclick = function () { showView("settings"); };
  }

  function applySeg(name, val) {
    if (!B.s) return;
    if (name === "paused") {
      manage("pause", { paused: val === "paused" }, val === "paused" ? "已暂停" : "继续运行");
    } else if (name === "type") {
      manage("type", { typeId: val }, "类型已切换");
    } else if (name === "rules.background" || name === "rules.outbound") {
      var key = name.split(".")[1];
      var patch = { rules: {} };
      patch.rules[key] = val;
      settingsPatch(patch, "规则已更新");
    } else if (name.indexOf("worker.") === 0) {
      var wk = name.split(".")[1];
      var p = { worker: {} };
      p.worker[wk] = val === "1";
      settingsPatch(p, "已更新");
    } else if (name === "briefing.enabled") {
      settingsPatch({ briefing: { enabled: val === "1" } }, "已更新");
    } else if (name === "autonomy.enabled") {
      settingsPatch({ autonomy: { enabled: val === "1" } }, "已更新");
    } else if (name === "autonomy.mode") {
      settingsPatch({ autonomy: { mode: val } }, "模式已切换");
    }
  }

  function doAct(act) {
    switch (act) {
      case "refresh":
        loadState();
        toast("已刷新");
        break;
      case "rename": {
        var v = (($("setName") || {}).value || "").trim();
        if (!v) { toast("名字不能为空", true); return; }
        manage("rename", { name: v }, "改好了");
        break;
      }
      case "avatarPick":
        pickAvatar(B.s.bot.id);
        break;
      case "avatarClear":
        manage("avatar", { id: B.s.bot.id }, "头像已移除");
        break;
      case "workspace": {
        var ws = (($("setWs") || {}).value || "").trim();
        if (!ws) { toast("路径不能为空", true); return; }
        manage("workspace", { workspace: ws }, "档案已更新（重启后按新目录跑）");
        break;
      }
      case "briefTime": {
        var tm = ($("setBriefTime") || {}).value || "08:30";
        settingsPatch({ briefing: { time: tm } }, "时间已保存");
        break;
      }
      case "briefNow":
        manage("briefingNow", {}, "已生成, 简报会走启用的通道发出");
        break;
      case "agAdd": {
        var text = (($("agText") || {}).value || "").trim();
        if (!text) { toast("写点什么", true); return; }
        var at = ($("agAt") || {}).value || null;
        manage("agendaAdd", { text: text, at: at }, "已加入日程").then(function () {
          if ($("agText")) $("agText").value = "";
        }).catch(function () {});
        break;
      }
      case "saveLimits": {
        var lim = {};
        document.querySelectorAll("[data-num^='limits.']").forEach(function (el) {
          lim[el.getAttribute("data-num").split(".")[1]] = Number(el.value);
        });
        settingsPatch({ limits: lim }, "限额已保存");
        break;
      }
      case "proactive":
        manage("proactive", {}, "扫描完成").then(function (j) {
          if (j && j.message) toast(String(j.message).slice(0, 90));
          else if (j && j.items && j.items.length) toast("扫到 " + j.items.length + " 件可推进的事");
          else toast("没有需要主动做的事");
        }).catch(function () {});
        break;
      case "permission": {
        var am = ($("setApproval2") || {}).value;
        var sb = ($("setSandbox2") || {}).value;
        manage("permission", { approvalMode: am, sandbox: sb }, "权限已更新");
        break;
      }
      case "memSave": {
        var txt = ($("memEdit") || {}).value;
        if (B.memPath == null) return;
        manage("memoryWrite", { path: B.memPath, text: txt }, "已写入").catch(function () {});
        break;
      }
      case "memClose":
        B.memPath = null;
        B.memText = "";
        renderSettings();
        break;
      default:
        break;
    }
  }

  function openMem(p) {
    req("/api/bot.manage", {
      method: "POST", timeout: 20000,
      body: JSON.stringify({ action: "memoryRead", path: p }),
    }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || "读不了");
      B.memPath = p;
      B.memText = j.text || "";
      renderSettings();
      var box = $("memEdit");
      if (box) box.scrollIntoView({ block: "center", behavior: "smooth" });
    }).catch(function (e) { toast(e.message, true); });
  }

  /* ================= 插件 (2026-10-30) =================
     左侧「插件」组 + 管理页。插件 = 工作区 plugins/<id>/ 下的清单 + 入口 .cjs,
     启动时由内核装配一次 —— 保存只落盘, 重启应用才生效。页面把这句话写明白,
     不假装热更新; 代码语法在服务端先过一遍, 错了不落盘。 */

  function accessLabel(p) {
    return p && p.access === "full-access" ? "完整权限" : "受限";
  }

  function plugTemplate(id, name) {
    return "// " + (name || id) + " - 皮皮虾用户插件\n"
      + "//\n"
      + "// 入口在启动时被装配一次。可用能力:\n"
      + "//   ctx.provide(name, service)  注册服务 (供其他插件/内核 consume)\n"
      + "//   ctx.consume(name)           消费其他插件提供的服务\n"
      + "//   ctx.onDispose(fn)           注册卸载钩子\n"
      + "// 默认权限 restricted: 只能注册非敏感服务; 需要完整权限请在插件页显式选择 full-access。\n"
      + "module.exports = function setup(ctx) {\n"
      + "  ctx.provide(\"user." + id + "\", {\n"
      + "    hello() {\n"
      + "      return \"" + (name || id) + " 已就绪\";\n"
      + "    },\n"
      + "  });\n"
      + "};\n";
  }

  function suggestPluginId() {
    var used = {};
    (B.plugins || []).forEach(function (p) { used[p.id] = 1; });
    for (var i = 1; i < 1000; i++) {
      if (!used["plugin_" + i]) return "plugin_" + i;
    }
    return "plugin_" + Date.now();
  }

  function loadPlugins() {
    return req("/api/plugins", { timeout: 10000 }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || "读取插件失败");
      B.plugins = j.plugins || [];
      renderPluginList();
      // 表单打开时不覆盖, 免得正在输入的草稿被轮询冲掉
      if (B.view === "plugins" && !B.plugEdit) renderPlugins();
    }).catch(function (e) {
      var el = $("pluginList");
      if (el) el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    });
  }

  function renderPluginList() {
    var el = $("pluginList");
    if (!el) return;
    var list = B.plugins || [];
    if (!list.length) {
      el.innerHTML = '<div class="empty">还没有插件<br><button class="btn xs" data-pnew>＋ 新建插件</button></div>';
      return;
    }
    el.innerHTML = list.map(function (p) {
      var on = B.view === "plugins" && B.plugEdit && B.plugEdit.id === p.id;
      var tag = p.loose ? "只读" : (!p.enabled ? "停用" : "");
      return '<button class="cap pitem' + (on ? " on" : "") + '" data-popen="' + esc(p.id) + '" title="' + esc((p.description || p.name || p.id) + " · " + accessLabel(p)) + '">'
        + ico("plug", 14)
        + '<span class="t">' + esc(p.name || p.id) + '</span>'
        + (tag ? '<span class="ptag' + (p.loose ? "" : " off") + '">' + esc(tag) + '</span>' : "")
        + '</button>';
    }).join("");
  }

  function openNewPlugin() {
    var id = suggestPluginId();
    B.plugEdit = {
      isNew: true, id: id, name: "新插件", description: "",
      access: "restricted", enabled: true, entry: "index.cjs",
      code: plugTemplate(id, "新插件"),
    };
    renderPluginList();
    renderPlugins();
    var wrap = $("pluginWrap");
    if (wrap) wrap.scrollTop = 0;
  }

  function openPlugin(id) {
    if (!id) return;
    var isLoose = (B.plugins || []).some(function (p) { return p.id === id && p.loose; });
    if (isLoose) { toast("散文件插件是只读的，直接改插件目录里的文件即可", true); return; }
    req("/api/plugins/" + encodeURIComponent(id), { timeout: 10000 }).then(function (j) {
      if (!j || !j.ok || !j.plugin) throw new Error((j && j.error) || "读取插件失败");
      var p = j.plugin;
      B.plugEdit = {
        isNew: false, id: p.id, name: p.name, description: p.description || "",
        access: p.access, enabled: p.enabled, entry: p.entry, code: p.code || "",
      };
      if (B.view !== "plugins") showView("plugins");
      else { renderPluginList(); renderPlugins(); }
    }).catch(function (e) { toast(e.message, true); });
  }

  function renderPlugins() {
    var wrap = $("pluginWrap");
    if (!wrap) return;
    var p = B.plugEdit;
    var sub = $("plugSub");
    if (sub) sub.textContent = p
      ? (p.isNew ? "新建插件 · 保存后重启应用生效" : "编辑 " + (p.name || p.id) + " · 保存后重启应用生效")
      : "用户插件 · 保存后重启应用生效";
    wrap.innerHTML = p ? pluginFormHtml(p) : pluginListHtml(B.plugins || []);
  }

  function pluginListHtml(list) {
    var en = list.filter(function (p) { return p.enabled; }).length;
    var html = '<div class="ssec"><div class="ssec-head">插件<span class="flex1"></span>'
      + '<span class="svd">共 ' + list.length + ' · 启用 ' + en + '</span></div>'
      + '<div class="shint">插件放在工作区 plugins/ 目录, 每个插件一个目录: ppx.plugin.json + 入口 .cjs。保存只落盘, 重启应用后才会被装配。</div>'
      + '<div class="prow"><button class="wbtn primary" data-pnew>新建插件</button>'
      + '<button class="wbtn" data-prefresh>刷新</button></div>'
      + '</div>';

    if (!list.length) {
      return html + '<div class="empty">还没有插件。点「新建插件」写第一个。</div>';
    }

    html += list.map(function (p) {
      var tags = '<span class="ptag acc-' + esc(p.access) + '">' + esc(accessLabel(p)) + '</span>';
      if (!p.enabled) tags += '<span class="ptag off">已停用</span>';
      if (p.loose) tags += '<span class="ptag">散文件·只读</span>';
      if (p.error) tags += '<span class="ptag err">清单错误</span>';
      var acts = "";
      if (!p.loose && !p.error) {
        acts = '<button class="wbtn" data-pedit="' + esc(p.id) + '">编辑</button>'
          + '<button class="wbtn" data-ptoggle="' + esc(p.id) + '" data-enabled="' + (p.enabled ? "1" : "0") + '">'
          + (p.enabled ? "停用" : "启用") + '</button>'
          + '<button class="wbtn danger" data-pdel="' + esc(p.id) + '">删除</button>';
      }
      return '<div class="pcard' + (p.enabled ? "" : " off") + '">'
        + '<div class="pcard-h"><span class="pnm">' + ico("plug", 14) + esc(p.name || p.id) + '</span>' + tags + '</div>'
        + '<div class="pcard-id">' + esc(p.id) + ' · ' + esc(p.entry) + ' · ' + fmtBytes(p.size)
        + (p.mtime ? ' · ' + esc(shortAgo(p.mtime)) : "") + '</div>'
        + (p.description ? '<div class="pcard-b">' + esc(p.description) + '</div>' : "")
        + (p.error ? '<div class="pcard-b perr">' + esc(p.error) + '</div>' : "")
        + (acts ? '<div class="pacts">' + acts + '</div>' : "")
        + '</div>';
    }).join("");

    return html + '<div class="pwarn">插件代码在内核进程里运行, 等于你亲手运行的脚本。只装你读得懂的代码; 拿不准就用「受限」。</div>';
  }

  function pluginFormHtml(p) {
    var accessOpts = [["restricted", "受限（推荐）"], ["full-access", "完整权限"]].map(function (o) {
      return '<option value="' + o[0] + '"' + (p.access === o[0] ? " selected" : "") + '>' + o[1] + '</option>';
    }).join("");
    var html = '<div class="ssec"><div class="ssec-head">' + (p.isNew ? "新建插件" : "编辑插件")
      + '<span class="flex1"></span><span class="svd">' + esc(p.id || "—") + '</span></div>'
      + srow("标识", '<input type="text" id="plugId" class="grow" value="' + esc(p.id)
        + '"' + (p.isNew ? "" : " disabled") + ' spellcheck="false" placeholder="plugin_1">',
        p.isNew ? "2-40 位字母/数字/下划线/短横线，创建后不可改。" : "标识创建后不可改。")
      + srow("名称", '<input type="text" id="plugName" class="grow" value="' + esc(p.name) + '" maxlength="60">')
      + srow("说明", '<input type="text" id="plugDesc" class="grow" value="' + esc(p.description)
        + '" maxlength="500" placeholder="这个插件做什么">')
      + srow("权限", '<select id="plugAccess">' + accessOpts + '</select>',
        "受限 = 只能注册普通服务；完整权限 = 可触碰内核敏感能力，保存前会再确认。")
      + srow("状态", '<select id="plugEnabled"><option value="1"' + (p.enabled ? " selected" : "") + '>启用</option>'
        + '<option value="0"' + (p.enabled ? "" : " selected") + '>停用</option></select>')
      + srow("入口", '<input type="text" id="plugEntry" class="grow" value="' + esc(p.entry || "index.cjs")
        + '"' + (p.isNew ? "" : " disabled") + ' spellcheck="false">',
        "插件目录内的 .cjs 文件名。")
      + '</div>';

    html += '<div class="ssec"><div class="ssec-head">代码<span class="flex1"></span>'
      + '<span class="svd">保存前会做语法检查</span></div>'
      + '<textarea class="pcode" id="plugCode" spellcheck="false">' + esc(p.code || "") + '</textarea>'
      + '<div class="prow"><button class="wbtn primary" data-psave>保存</button>'
      + '<button class="wbtn" data-pcancel>取消</button></div>'
      + '</div>'
      + '<div class="pwarn">保存只落盘, 重启皮皮虾后插件才会被装配。代码在内核进程中运行, 请只写你理解的内容。</div>';
    return html;
  }

  function savePlugin() {
    var p = B.plugEdit;
    if (!p) return;
    var id = (($("plugId") || {}).value || "").trim();
    var name = (($("plugName") || {}).value || "").trim();
    var desc = (($("plugDesc") || {}).value || "").trim();
    var access = (($("plugAccess") || {}).value) || "restricted";
    var enabled = (($("plugEnabled") || {}).value) !== "0";
    var entry = (($("plugEntry") || {}).value || "index.cjs").trim();
    var code = (($("plugCode") || {}).value) || "";

    if (!name) { toast("名称不能为空", true); return; }
    if (p.isNew && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,39}$/.test(id)) {
      toast("标识需为 2-40 位字母/数字/下划线/短横线", true);
      return;
    }
    var submit = function () {
      var body = { name: name, description: desc, access: access, enabled: enabled, code: code };
      if (p.isNew) { body.id = id; body.entry = entry; }
      var path = p.isNew ? "/api/plugins" : "/api/plugins/" + encodeURIComponent(p.id);
      var method = p.isNew ? "POST" : "PUT";

      req(path, { method: method, timeout: 20000, body: JSON.stringify(body) }).then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || "保存失败");
        B.plugins = j.plugins || B.plugins;
        B.plugEdit = null;
        renderPluginList();
        renderPlugins();
        toast(j.message || "已保存，重启应用后生效");
      }).catch(function (e) { toast(e.message, true); });
    };
    // full-access 是危险操作: 用站内弹窗 (可键盘操作/Esc 取消), 而不是会冻结页面的原生 confirm
    if (access === "full-access") {
      if (!window.PPXUI || !window.PPXUI.confirm) {
        if (confirm("完整权限插件能触碰内核敏感能力。仅在你完全信任这段代码时继续，确定保存？")) submit();
        return;
      }
      window.PPXUI.confirm("full-access 插件能触碰内核敏感能力, 只保存你完全信任的代码。", {
        title: "保存完整权限插件?", okText: "保存", danger: true,
      }).then(function (ok) { if (ok) submit(); });
      return;
    }
    submit();
  }

  function togglePlugin(id, enabled) {
    if (!id) return;
    req("/api/plugins/" + encodeURIComponent(id), {
      method: "PUT", timeout: 15000, body: JSON.stringify({ enabled: !!enabled }),
    }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || "操作失败");
      B.plugins = j.plugins || B.plugins;
      renderPluginList();
      renderPlugins();
      toast(enabled ? "已启用，重启应用后生效" : "已停用，重启应用后生效");
    }).catch(function (e) { toast(e.message, true); });
  }

  function deletePlugin(id) {
    var p = (B.plugins || []).filter(function (x) { return x.id === id; })[0];
    var nm = p ? (p.name || p.id) : id;
    var go = function () {
      req("/api/plugins/" + encodeURIComponent(id), { method: "DELETE", timeout: 15000 }).then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || "删除失败");
        B.plugins = j.plugins || B.plugins;
        if (B.plugEdit && B.plugEdit.id === id) B.plugEdit = null;
        renderPluginList();
        renderPlugins();
        toast(j.message || "已移入回收站，重启应用后生效");
      }).catch(function (e) { toast(e.message, true); });
    };
    if (!window.PPXUI || !window.PPXUI.confirm) {
      if (confirm("删除插件「" + nm + "」？目录会移入 data/plugin-trash，可人工找回。")) go();
      return;
    }
    window.PPXUI.confirm("目录会移入 data/plugin-trash, 可人工找回; 重启后生效。", {
      title: "删除插件「" + nm + "」?", okText: "删除", danger: true,
    }).then(function (ok) { if (ok) go(); });
  }

  function bindPlugins() {
    var add = $("btnPluginAdd");
    if (add) add.onclick = function () { showView("plugins"); openNewPlugin(); };

    var pl = $("pluginList");
    if (pl) pl.onclick = function (e) {
      var nw = e.target.closest("[data-pnew]");
      if (nw) { showView("plugins"); openNewPlugin(); return; }
      var it = e.target.closest("[data-popen]");
      if (it) openPlugin(it.getAttribute("data-popen"));
    };

    var back = $("plugBack");
    if (back) back.onclick = function () { B.plugEdit = null; renderPluginList(); showView("home"); };
    var rf = $("plugRefresh");
    if (rf) rf.onclick = function () { loadPlugins(); toast("已刷新"); };

    var wrap = $("pluginWrap");
    if (wrap) wrap.onclick = function (e) {
      var t = e.target.closest("[data-pnew],[data-pedit],[data-ptoggle],[data-pdel],[data-pcancel],[data-psave],[data-prefresh]");
      if (!t) return;
      if (t.hasAttribute("data-psave")) { savePlugin(); return; }
      if (t.hasAttribute("data-pcancel")) { B.plugEdit = null; renderPluginList(); renderPlugins(); return; }
      if (t.hasAttribute("data-prefresh")) { loadPlugins(); toast("已刷新"); return; }
      if (t.hasAttribute("data-pnew")) { openNewPlugin(); return; }
      if (t.hasAttribute("data-pedit")) { openPlugin(t.getAttribute("data-pedit")); return; }
      if (t.hasAttribute("data-ptoggle")) {
        togglePlugin(t.getAttribute("data-ptoggle"), t.getAttribute("data-enabled") !== "1");
        return;
      }
      if (t.hasAttribute("data-pdel")) deletePlugin(t.getAttribute("data-pdel"));
    };
  }

  /* ================= 轮询 ================= */
  // 轮询间隔 5 秒, 不是 3 秒。
  // 服务端按 IP 限 60 请求/分钟 (TokenBucket); 首屏还有 app.js 的审批/任务/生命周期三路
  // 定时器在同一条 IP 上跑 —— 3 秒在这套组合里会周期性撞 429, 表现为面板偶尔空白。
  // 5 秒 + 隐藏页暂停后, 稳态落在 24 请求/分左右, 留足余量。
  function startPoll() {
    stopPoll();
    function tick() {
      if (document.hidden) { B.timer = setTimeout(tick, 5000); return; }
      loadState(true).then(function () {
        // 失败 → 5s/10s/20s/30s 退避, 成功立即回到 5s: 两个标签页 + app.js 的三路定时器
        // 共用同一条 IP 限流 (60/分), 撞 429 时继续 5s 猛打只会让两边都空窗。
        B.pollMs = B.pollErr ? Math.min(30000, (B.pollMs || 5000) * 2) : 5000;
        B.timer = setTimeout(tick, B.pollMs);
      });
    }
    B.pollMs = 5000;
    B.timer = setTimeout(tick, B.pollMs);
  }
  function stopPoll() {
    if (B.timer) { clearInterval(B.timer); B.timer = null; }
  }

  /* ================= 启动 ================= */
  function init() {
    bindSidebar();
    bindHome();
    bindChat();
    bindSettings();
    bindPlugins();

    // 默认进对话页: 打开就能说话。首页从「返回」/「新建本体」/点品牌进。
    var saved = null;
    try { saved = localStorage.getItem("ppx_view"); } catch (e) { /* 无所谓 */ }
    showView(["home", "settings", "plugins", "stats"].indexOf(saved) >= 0 ? saved : "chat");
    showPane("talk");

    loadState().then(function () {
      // 首屏之后再挂轮询, 避免刚打开就打两个请求
    }).catch(function () {});
    startPoll();
    loadPlugins();

    // 身体体征: 首屏后静默拉一次, 只更新左上角状态点 (不打开页面)
    //   —— 打开面板才知道自己健不健康, 等于没有仪表盘。
    bindOrgans();
    loadBody();

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) loadState(true);
    });
  }

  window.PPXBOT = {
    showView: showView,
    showPane: showPane,
    showSettings: function () { showView("settings"); },
    showBody: function () { showView("body"); },
    reload: function () { return loadState(); },
    state: function () { return B.s; },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
