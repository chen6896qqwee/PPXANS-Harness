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
    traces: [],
    traceDays: [],
    traceStats: {},
    traceDay: "",
    tfilter: "",
    memPath: null,      // 设置页正在看的记忆文件
    memText: "",
    typeFormOpen: false,
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
    ["home", "chat", "settings"].forEach(function (k) {
      var el = $("view-" + k);
      if (el) el.classList.toggle("on", k === v);
    });
    // 进对话页时把焦点还给输入框, 省一次点击
    if (v === "chat") {
      var inp = $("inp");
      if (inp && !(B.s && B.s.live && B.s.live.pendingApprovals)) setTimeout(function () { inp.focus(); }, 30);
    }
    if (v === "settings") renderSettings();
    try { localStorage.setItem("ppx_view", v); } catch (e) { /* 隐私模式下无所谓 */ }
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
      B.s = j;
      renderAll(j);
      return j;
    }).catch(function (e) {
      if (!quiet) {
        var box = $("homeErr");
        if (box) { box.hidden = false; box.textContent = e.message; }
        var sub = $("chatSub");
        if (sub) sub.textContent = "状态不可用: " + e.message;
      }
    });
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
    if (cards) {
      cards.innerHTML = (s.types || []).map(function (t) {
        var on = t.id === s.bot.type;
        return '<button class="bcard" data-type="' + esc(t.id) + '"' + (on ? ' style="border-color:var(--accent)"' : "") + '>'
          + '<b>' + esc(t.name) + (on ? ' · 现在这个' : "") + '</b>'
          + '<span>' + esc(t.blurb || "—") + '</span>'
          + (!t.builtin ? '<span class="del" data-deltype="' + esc(t.id) + '" title="删除类型">' + ico("close", 12) + '</span>' : "")
          + '</button>';
      }).join("");
    }

    // 已有本体
    var rows = $("botRows");
    if (rows) {
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

  /* ================= 轮询 ================= */
  // 轮询间隔 5 秒, 不是 3 秒。
  // 服务端按 IP 限 60 请求/分钟 (TokenBucket); 首屏还有 app.js 的审批/任务/生命周期三路
  // 定时器在同一条 IP 上跑 —— 3 秒在这套组合里会周期性撞 429, 表现为面板偶尔空白。
  // 5 秒 + 隐藏页暂停后, 稳态落在 24 请求/分左右, 留足余量。
  function startPoll() {
    stopPoll();
    B.timer = setInterval(function () {
      if (document.hidden) return;
      loadState(true);
    }, 5000);
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

    // 默认进对话页: 打开就能说话。首页从「返回」/「新建本体」/点品牌进。
    var saved = null;
    try { saved = localStorage.getItem("ppx_view"); } catch (e) { /* 无所谓 */ }
    showView(saved === "home" || saved === "settings" ? saved : "chat");
    showPane("talk");

    loadState().then(function () {
      // 首屏之后再挂轮询, 避免刚打开就打两个请求
    }).catch(function () {});
    startPoll();

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) loadState(true);
    });
  }

  window.PPXBOT = {
    showView: showView,
    showPane: showPane,
    showSettings: function () { showView("settings"); },
    reload: function () { return loadState(); },
    state: function () { return B.s; },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
