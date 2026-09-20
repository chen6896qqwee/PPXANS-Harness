/* public/app.js - 皮皮虾 v3.0 Web UI (codex 风格)
 * 布局: 左栏会话/能力 · 中栏事件时间线(用户/agent/工具卡/审批卡/计划/diff) · 右栏工作区抽屉(文件/目标/审查/设置)
 * 数据通道: REST (/message/stream, /sessions*, /api/*) + MCP (POST /mcp, tools/call)
 * 设计原则: 零依赖 vanilla JS; 所有 v3 新端点(命令面板/审批/目标/审查)失败时优雅降级隐藏
 */
(function () {
  "use strict";

  /* ================= 状态 ================= */
  var S = {
    base: "",
    session: null,
    sessions: [],
    streaming: false,
    interrupted: false,
    perm: "on-request",
    commands: [],          // 斜杠命令 [{name, description, argumentHint}]
    approvals: {},         // id -> 已渲染卡片元素
    drawer: false,
    drawerTab: "files",
    wsRoot: "",
    lifeTimer: null,
    apprTimer: null,
    lastTokens: null,
  };

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ico(name, size) {
    return '<svg width="' + (size || 15) + '" height="' + (size || 15) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><use href="#i-' + name + '"/></svg>';
  }
  function toast(msg, isErr) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.hidden = false;
    clearTimeout(t._tm);
    t._tm = setTimeout(function () { t.hidden = true; }, 2400);
  }
  function fmtTs(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var h = String(d.getHours()).padStart(2, "0"), m = String(d.getMinutes()).padStart(2, "0");
    return h + ":" + m;
  }

  /* ================= HTTP / MCP ================= */
  function headers(json) {
    var h = {};
    if (json) h["Content-Type"] = "application/json";
    // 鉴权: token 由服务端注入 window.__PPX_BOOTSTRAP__ (可信本地免登录)
    var boot = window.__PPX_BOOTSTRAP__;
    if (boot && boot.authToken) h["Authorization"] = "Bearer " + boot.authToken;
    else {
      var saved = localStorage.getItem("ppx_token");
      if (saved) h["Authorization"] = "Bearer " + saved;
    }
    return h;
  }
  function req(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign(headers(opts.body != null), opts.headers || {});
    return fetch(S.base + path, opts).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return null; }).then(function (j) {
          throw new Error((j && j.error) || ("HTTP " + r.status));
        });
      }
      return r.json().catch(function () { return null; });
    });
  }
  function get(path) { return req(path); }
  function post(path, body) { return req(path, { method: "POST", body: JSON.stringify(body || {}) }); }

  function mcpCall(method, params) {
    return post("/mcp", { jsonrpc: "2.0", id: "ui_" + Date.now(), method: method, params: params || {} })
      .then(function (r) {
        if (r && r.error) throw new Error(r.error.message || "MCP error");
        return r && r.result;
      });
  }
  function mcpTool(name, args) {
    return mcpCall("tools/call", { name: name, arguments: args || {} }).then(function (r) {
      var c = (r && r.content) || [];
      var txt = c.filter(function (x) { return x && x.type === "text"; }).map(function (x) { return x.text; }).join("\n");
      try { return JSON.parse(txt); } catch (e) { return txt; }
    });
  }

  /* ================= 主题 ================= */
  function applyTheme() {
    var t = localStorage.getItem("ppx_theme");
    if (!t) t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", t);
    $("btnTheme").innerHTML = ico(t === "dark" ? "sun" : "moon", 16);
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  $("btnTheme").onclick = function () {
    var cur = document.documentElement.getAttribute("data-theme");
    localStorage.setItem("ppx_theme", cur === "dark" ? "light" : "dark");
    applyTheme();
  };

  /* ================= Markdown 渲染 (安全) ================= */
  function renderMd(t) {
    var s = esc(t);
    s = s.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
      return "<pre><code>" + code + "</code></pre>";
    });
    s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    s = s.replace(/^### (.+)$/gm, "<h3>$1</h3>").replace(/^## (.+)$/gm, "<h2>$1</h2>").replace(/^# (.+)$/gm, "<h1>$1</h1>");
    s = s.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
    s = s.replace(/^\s*[-*] (.+)$/gm, "<li>$1</li>").replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>");
    s = s.replace(/^\s*(?:\d+)\. (.+)$/gm, "<li>$1</li>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|\s)\*([^*\n]+)\*/g, "$1<i>$2</i>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.split(/\n{2,}/).map(function (p) {
      p = p.trim();
      if (!p) return "";
      if (/^<(h\d|pre|ul|ol|blockquote|table)/.test(p)) return p;
      return "<p>" + p.replace(/\n/g, "<br>") + "</p>";
    }).join("");
    return s;
  }

  /* ================= 侧栏: 会话 ================= */
  function loadSessions() {
    return get("/sessions").then(function (j) {
      S.sessions = (j && j.sessions) || [];
      renderSessions();
    }).catch(function () {});
  }
  function renderSessions() {
    var el = $("sessList");
    el.innerHTML = "";
    if (!S.sessions.length) { el.innerHTML = '<div class="empty">暂无会话</div>'; return; }
    S.sessions.forEach(function (s) {
      var b = document.createElement("button");
      b.className = "sess" + (s.key === S.session ? " on" : "");
      var title = s.title || s.name || s.key || "(未命名)";
      b.innerHTML = ico("file", 13) + '<span class="t">' + esc(title) + '</span><span class="del">' + ico("trash", 13) + "</span>";
      b.title = title + (s.ts ? " · " + fmtTs(s.ts) : "");
      b.onclick = function (e) {
        if (e.target.closest(".del")) { delSession(s.key); return; }
        switchSession(s.key, title);
      };
      el.appendChild(b);
    });
  }
  function delSession(key) {
    if (!confirm("删除该会话?")) return;
    post("/sessions/delete", { sessionKey: key }).then(function () {
      if (S.session === key) newSession();
      loadSessions();
    }).catch(function (e) { toast(e.message, true); });
  }
  function switchSession(key, title) {
    S.session = key;
    $("sessTitle").textContent = title || key;
    localStorage.setItem("ppx_session", key);
    clearStream();
    loadHistory(key);
    loadSessions();
  }
  function newSession() {
    S.session = "s_" + Date.now();
    $("sessTitle").textContent = "新会话";
    localStorage.setItem("ppx_session", S.session);
    clearStream();
    $("hero").hidden = false;
    $("stream").hidden = true;
    loadSessions();
  }
  function clearStream() { $("stream").innerHTML = ""; }

  $("btnNew").onclick = newSession;
  $("btnSessRefresh").onclick = loadSessions;
  $("btnSessSearch").onclick = function () {
    var q = prompt("搜索会话:");
    if (q == null) return;
    q = q.toLowerCase();
    S.sessions.forEach(function (s) {
      var el = $("sessList").querySelector('[data-key="' + s.key + '"]');
    });
    // 简单实现: 过滤当前列表
    var items = $("sessList").querySelectorAll(".sess");
    items.forEach(function (it) {
      var txt = it.querySelector(".t").textContent.toLowerCase();
      it.style.display = !q || txt.indexOf(q) !== -1 ? "" : "none";
    });
  };

  /* ================= 时间线渲染 ================= */
  var streamEl = null;
  function stream() {
    if (!streamEl) streamEl = $("stream");
    return streamEl;
  }
  function toBottom(force) {
    var el = stream();
    var near = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (near || force) el.scrollTop = el.scrollHeight;
  }
  function showStream() {
    $("hero").hidden = true;
    stream().hidden = false;
  }
  function addEv(cls) {
    showStream();
    var d = document.createElement("div");
    d.className = "ev " + cls;
    stream().appendChild(d);
    return d;
  }

  function evUser(text) {
    var d = addEv("ev-user");
    d.innerHTML = '<div class="bubble">' + esc(text) + "</div>";
    toBottom(true);
    return d;
  }
  function evAgent() {
    var d = addEv("ev-agent");
    d.innerHTML = '<div class="who"><span class="mark">' + ico("mark", 12) + '</span>皮皮虾 <span class="t">' + fmtTs(Date.now()) + "</span></div>"
      + '<div class="body md"></div>';
    return d.querySelector(".body");
  }
  function evStep() {
    var d = addEv("ev-step");
    d.innerHTML = "";
    return d;
  }
  function evError(msg) {
    var d = addEv("ev-error");
    d.innerHTML = '<div class="errbox">' + esc(msg) + "</div>";
    toBottom();
  }

  /* 工具卡 */
  var toolEls = {};
  function agentColor(name) {
    var colors = ["#d97757", "#5b8def", "#3aa76d", "#c78a2d", "#9b6dd6", "#3ba8a0", "#d05f8f", "#7a86c9"];
    var h = 0;
    for (var i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) >>> 0;
    return colors[h % colors.length];
  }
  function addTool(ev) {
    var d = addEv("ev-tool");
    var sum = "";
    if (ev.args) {
      var a = ev.args;
      if (a.path || a.file || a.file_path) sum = a.path || a.file || a.file_path;
      else if (a.command || a.cmd) sum = a.command || a.cmd;
      else if (a.query || a.q) sum = a.query || a.q;
      else if (a.url) sum = a.url;
      else sum = JSON.stringify(ev.args).slice(0, 120);
    }
    var chip = ev.agent ? '<span class="agentchip" style="background:' + agentColor(ev.agent) + '">' + esc(ev.agent) + "</span>" : "";
    d.innerHTML = '<div class="toolcard"><div class="head"><span class="st run"></span>'
      + '<span class="tname">' + esc(ev.tool) + '</span><span class="tsum">' + esc(sum) + "</span>" + chip + "</div>"
      + '<div class="tcbody">' + esc(JSON.stringify(ev.args || {}, null, 2)) + "</div></div>";
    var card = d.querySelector(".toolcard");
    card.querySelector(".head").onclick = function () { card.classList.toggle("open"); };
    toolEls[ev.id || ev.tool] = { ev: d, card: card, body: card.querySelector(".tcbody") };
    toBottom();
  }
  function finishTool(ev) {
    var t = toolEls[ev.id || ev.tool];
    if (!t) return;
    var st = t.card.querySelector(".st");
    st.className = "st " + (ev.ok === false ? "fail" : "ok");
    if (ev.durationMs != null) {
      var sum = t.card.querySelector(".tsum");
      sum.textContent = sum.textContent + " · " + (ev.durationMs / 1000).toFixed(1) + "s";
    }
    if (ev.output) t.body.textContent = String(ev.output).slice(0, 4000);
  }

  /* 审批卡 (codex 式) */
  var APPROVAL_KIND = { bash: "Bash", edit: "Edit", plan: "Plan", tool: "Tool" };
  function evApproval(a) {
    var d = addEv("ev-approval");
    var kind = APPROVAL_KIND[a.kind] || "Tool";
    var body = a.detail || a.summary || "";
    if (a.args) body = body || JSON.stringify(a.args, null, 2);
    d.innerHTML = '<div class="approval" data-aid="' + esc(a.id) + '">'
      + '<div class="ahead">' + ico("shield", 15) + "需要你的批准" + '<span class="akind">' + esc(kind) + "</span></div>"
      + '<div class="abody">' + esc(body) + "</div>"
      + '<div class="aacts"><button class="btn primary" data-act="approve">' + ico("check", 13) + "批准</button>"
      + '<button class="btn danger" data-act="deny">' + ico("close", 13) + "拒绝</button></div></div>";
    var card = d.querySelector(".approval");
    card.querySelectorAll("[data-act]").forEach(function (b) {
      b.onclick = function () { resolveApproval(a.id, b.getAttribute("data-act"), card); };
    });
    S.approvals[a.id] = card;
    toBottom(true);
    return card;
  }
  function resolveApproval(id, decision, card) {
    post("/api/approvals/" + encodeURIComponent(id), { decision: decision }).then(function () {
      card.classList.add("done");
      var v = document.createElement("div");
      v.className = "verdict";
      v.textContent = decision === "approve" ? "✓ 已批准" : "✗ 已拒绝";
      card.appendChild(v);
    }).catch(function (e) { toast(e.message, true); });
  }
  /* 审批轮询兜底 (SSE 事件缺失时也能看到卡片) */
  function pollApprovals() {
    get("/api/approvals/pending").then(function (j) {
      var list = (j && j.approvals) || [];
      list.forEach(function (a) {
        if (!S.approvals[a.id]) evApproval(a);
      });
    }).catch(function () {}); // 端点不存在 → 静默降级
  }

  /* 计划卡 */
  function evPlan(text) {
    var d = addEv("ev-plan");
    d.innerHTML = '<div class="who"><span class="mark">' + ico("list", 12) + '</span>计划</div><div class="plancard md">' + renderMd(text) + "</div>";
    toBottom();
  }

  /* diff 卡 */
  function evDiff(diffText) {
    var d = addEv("ev-diff");
    var lines = String(diffText).split("\n").slice(0, 400).map(function (l) {
      var cls = l.indexOf("+") === 0 ? "add" : (l.indexOf("-") === 0 ? "del" : (l.indexOf("@@") === 0 ? "hunk" : ""));
      return '<div class="dline ' + cls + '">' + esc(l) + "</div>";
    }).join("");
    d.innerHTML = '<div class="who"><span class="mark">' + ico("diff", 12) + '</span>变更</div><div class="diffbox">' + lines + "</div>";
    toBottom();
  }

  /* ================= 发送 / SSE 流 ================= */
  var stepEl = null;
  function setStep(ev) {
    if (!stepEl) { stepEl = addEv("ev-step"); }
    stepEl.innerHTML = '<i class="spin"></i>第 ' + ev.round + " / " + (ev.maxRounds || "?") + " 轮推理…";
    toBottom();
  }
  function clearStep() { if (stepEl) { stepEl.remove(); stepEl = null; } }

  function setBusy(on) {
    S.streaming = on;
    $("composer").classList.toggle("busy", on);
    var b = $("btnSend");
    b.classList.toggle("stop", on);
    b.innerHTML = on ? ico("stop-dot", 16) : ico("send", 16);
    b.title = on ? "停止生成 (Esc)" : "发送 (Enter)";
    b.disabled = on ? false : !$("inp").value.trim();
    $("footNote").textContent = on ? "生成中… Esc 停止" : "Enter 发送 · Shift+Enter 换行 · / 唤起命令面板";
  }

  function send() {
    var t = $("inp").value.trim();
    if (!t) return;
    if (S.streaming) { toast("生成中, 已请求停止"); stopGen(); return; }
    $("inp").value = "";
    autosize();
    hidePalette();
    doSend(t);
  }

  function doSend(t) {
    // 本地命令短路
    if (t.charAt(0) === "/") {
      var m = /^\/(\w+)\s*(.*)$/.exec(t);
      if (m && m[1] === "new") { newSession(); return; }
      if (m && m[1] === "help") { showHelp(); return; }
    }
    evUser(t);
    var body = evAgent();
    var full = "";
    setBusy(true);
    S.interrupted = false;

    fetch(S.base + "/message/stream", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ message: t, sessionId: S.session, permission: S.perm }),
    }).then(function (r) {
      if (!r.ok || !r.body) {
        return r.json().catch(function () { return null; }).then(function (j) {
          throw new Error((j && j.error) || ("请求失败 HTTP " + r.status));
        });
      }
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = "";
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) return;
          buf += dec.decode(res.value, { stream: true });
          var i;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            var chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            chunk.split("\n").forEach(function (line) {
              if (line.indexOf("data:") !== 0) return;
              var j;
              try { j = JSON.parse(line.slice(5).trim()); } catch (e) { return; }
              if (j.type === "delta") { full += j.content; body.innerHTML = renderMd(full) + '<span class="caret"></span>'; toBottom(); }
              else if (j.type === "done") {
                full = j.content || full;
                clearStep();
                body.innerHTML = renderMd(full);
                if (j.tokens) { S.lastTokens = j.tokens; updTokPill(); }
                if (j.diff) evDiff(j.diff);
              }
              else if (j.type === "tool") { if (j.status === "start") addTool(j); else finishTool(j); }
              else if (j.type === "step") setStep(j);
              else if (j.type === "approval") evApproval(j);
              else if (j.type === "plan") evPlan(j.content || j.text || "");
              else if (j.type === "diff") evDiff(j.content || j.diff || "");
              else if (j.type === "error") { clearStep(); evError(j.error || "未知错误"); }
            });
          }
          toBottom();
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      evError(e.message);
    }).finally(function () {
      clearStep();
      setBusy(false);
      loadSessions();
      pollApprovals();
    });
  }

  function stopGen() {
    S.interrupted = true;
    post("/interrupt", { sessionId: S.session }).catch(function () {});
    toast("已请求停止");
  }

  function showHelp() {
    var lines = S.commands.length
      ? S.commands.map(function (c) { return "**/" + c.name + "**" + (c.argumentHint ? " " + c.argumentHint : "") + " — " + (c.description || ""); }).join("\n")
      : "命令服务未启动";
    evAgent().innerHTML = renderMd("## 命令面板\n" + lines);
  }

  function updTokPill() {
    if (!S.lastTokens) return;
    $("tokPill").hidden = false;
    $("tokTxt").textContent = (S.lastTokens.total || S.lastTokens.input + "/" + S.lastTokens.output || "—");
  }

  /* ================= 命令面板 ================= */
  function loadCommands() {
    get("/api/commands").then(function (j) {
      S.commands = (j && j.commands) || [];
    }).catch(function () {
      S.commands = [];
    });
  }
  var palSel = 0;
  function showPalette(filter) {
    var el = $("palette");
    var q = (filter || "").toLowerCase();
    var list = S.commands.filter(function (c) { return !q || c.name.indexOf(q) !== -1 || (c.description || "").toLowerCase().indexOf(q) !== -1; });
    if (!list.length) { hidePalette(); return; }
    palSel = 0;
    el.innerHTML = list.slice(0, 20).map(function (c, i) {
      return '<button class="pitem' + (i === 0 ? " sel" : "") + '" data-name="' + esc(c.name) + '">'
        + '<span class="pname">/' + esc(c.name) + '</span>'
        + '<span class="pdesc">' + esc(c.description || "") + "</span>"
        + (c.argumentHint ? '<span class="phint">' + esc(c.argumentHint) + "</span>" : "") + "</button>";
    }).join("");
    el.hidden = false;
    el.querySelectorAll(".pitem").forEach(function (b) {
      b.onclick = function () { pickCommand(b.getAttribute("data-name")); };
    });
  }
  function pickCommand(name) {
    $("inp").value = "/" + name + " ";
    hidePalette();
    $("inp").focus();
  }
  function hidePalette() { $("palette").hidden = true; }
  function movePalette(dir) {
    var items = $("palette").querySelectorAll(".pitem");
    if (!items.length) return;
    palSel = (palSel + dir + items.length) % items.length;
    items.forEach(function (b, i) { b.classList.toggle("sel", i === palSel); });
    items[palSel].scrollIntoView({ block: "nearest" });
  }

  /* ================= 右栏抽屉 ================= */
  function setDrawer(on) {
    S.drawer = on;
    $("drawer").hidden = !on;
    localStorage.setItem("ppx_drawer", on ? "1" : "0");
    if (on) loadTab(S.drawerTab);
  }
  $("btnDrawer").onclick = function () { setDrawer(!S.drawer); };
  $("btnDrawerClose").onclick = function () { setDrawer(false); };
  document.querySelectorAll(".tab").forEach(function (t) {
    t.onclick = function () {
      document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("on"); });
      t.classList.add("on");
      S.drawerTab = t.getAttribute("data-tab");
      document.querySelectorAll(".dpane").forEach(function (p) { p.classList.remove("on"); });
      $("pane-" + S.drawerTab).classList.add("on");
      loadTab(S.drawerTab);
    };
  });
  function loadTab(tab) {
    if (tab === "files") loadTree();
    else if (tab === "goal") loadGoal();
    else if (tab === "review") loadReview();
    else if (tab === "settings") loadSettings();
  }

  /* --- 文件树 --- */
  function loadTree() {
    var url = "/api/workspace/tree" + (S.wsRoot ? "?path=" + encodeURIComponent(S.wsRoot) : "");
    get(url).then(function (j) {
      var tree = (j && (j.tree || j.items)) || [];
      S.wsRoot = j && j.root ? j.root : S.wsRoot;
      $("wsRoot").textContent = S.wsRoot || "工作区";
      $("wsTree").innerHTML = "";
      renderTree($("wsTree"), tree, 0);
    }).catch(function () {
      $("wsTree").innerHTML = '<div class="empty">工作区不可用</div>';
    });
  }
  function renderTree(container, nodes, depth) {
    (nodes || []).forEach(function (n) {
      if (n.type === "dir" || n.dir) {
        var d = document.createElement("button");
        d.className = "dir";
        d.innerHTML = ico("folder", 13) + '<span class="nm">' + esc(n.name || n.path) + "</span>";
        container.appendChild(d);
        var kids = document.createElement("div");
        kids.className = "kids";
        kids.hidden = depth > 0;
        d.onclick = function () { kids.hidden = !kids.hidden; };
        container.appendChild(kids);
        if (depth < 2) renderTree(kids, n.children || n.items || [], depth + 1);
      } else {
        var f = document.createElement("button");
        f.className = "f";
        f.innerHTML = ico("file", 13) + '<span class="nm">' + esc(n.name || n.path) + "</span>";
        f.onclick = function () { openFile(n.path || n.name); };
        container.appendChild(f);
      }
    });
  }
  function openFile(path) {
    get("/api/workspace/read?path=" + encodeURIComponent(path)).then(function (j) {
      $("fileView").hidden = false;
      $("fvPath").textContent = path;
      $("fvBody").textContent = (j && (j.content || j.text)) || "(空)";
    }).catch(function (e) { toast(e.message, true); });
  }
  $("fvClose").onclick = function () { $("fileView").hidden = true; };
  $("btnWsRefresh").onclick = loadTree;
  $("btnWsRoot").onclick = function () {
    var p = prompt("工作区目录:", S.wsRoot || "");
    if (p) { S.wsRoot = p; loadTree(); }
  };

  /* --- 目标看板 --- */
  function loadGoal() {
    get("/api/goalboard").then(function (j) {
      var goals = (j && (j.goals || j.items)) || [];
      var el = $("goalBoard");
      if (!goals.length) { el.innerHTML = '<div class="empty">暂无目标 · 发送 /goal 创建</div>'; return; }
      el.innerHTML = goals.map(function (g) {
        var pr = g.priority ? '<span class="badge p' + esc(String(g.priority).replace(/^p/i, "")) + '">' + esc(String(g.priority).toUpperCase()) + "</span>" : "";
        return '<div class="goal"><div class="gt"><span class="gid">' + esc(g.id || "") + "</span>" + pr
          + '<span class="gsts ' + esc(g.status || "pending") + '">' + esc(g.status || "pending") + "</span></div>"
          + '<div class="gmeta">' + esc(g.title || "") + "</div></div>";
      }).join("");
    }).catch(function () {
      $("goalBoard").innerHTML = '<div class="empty">看板服务未启动</div>';
    });
  }
  $("btnGoalRefresh").onclick = loadGoal;

  /* --- 审查报告 --- */
  function loadReview() {
    get("/api/review/latest").then(function (j) {
      var el = $("reviewBody");
      var issues = (j && j.issues) || [];
      if (!issues.length && !(j && j.report)) { el.innerHTML = '<div class="empty">尚无报告 · 发送 /review 触发</div>'; return; }
      el.innerHTML = issues.map(function (it) {
        var p = it.severity === "high" ? "p0" : it.severity === "medium" ? "p1" : "p2";
        return '<div class="issue"><div class="ihead"><span class="badge ' + p + '">' + p.toUpperCase() + '</span>'
          + '<span class="ititle">' + esc(it.title || "") + '</span></div>'
          + '<div class="ifile">' + esc((it.file || "") + (it.line ? ":" + it.line : "")) + "</div>"
          + (it.detail ? '<div class="idetail">' + esc(it.detail) + "</div>" : "")
          + (it.suggestion ? '<div class="ifix">→ ' + esc(it.suggestion) + "</div>" : "") + "</div>";
      }).join("") + (j.report ? '<div class="report-md md">' + renderMd(j.report) + "</div>" : "");
    }).catch(function () {
      $("reviewBody").innerHTML = '<div class="empty">审查服务未启动</div>';
    });
  }
  $("btnReviewRun").onclick = function () {
    $("inp").value = "/review";
    send();
  };

  /* --- 设置 --- */
  function loadSettings() {
    get("/api/bootstrap").then(function (j) {
      if (!j) return;
      var ag = j.agent || j.config || {};
      $("setApproval").value = ag.approval_mode || S.perm;
      $("setSandbox").value = ag.sandbox || "";
      $("setInfo").textContent = "模型: " + ((ag.llm && ag.llm.model) || "-") + " · 工具 " + ((j.tools && j.tools.length) || "-") + " 个 · 工作区 " + (j.root || "-");
    }).catch(function () {
      $("setInfo").textContent = "引导信息不可用";
    });
  }
  $("setApproval").onchange = function () {
    S.perm = $("setApproval").value;
    $("modeTxt").textContent = S.perm;
    post("/api/permissions", { approvalMode: S.perm }).catch(function () { toast("已切换本地显示 (服务端模式未变)", false); });
  };
  $("setSandbox").onchange = function () {
    post("/api/permissions", { sandbox: $("setSandbox").value }).catch(function () {});
  };

  /* ================= 侧栏能力入口 ================= */
  $("capFiles").onclick = function () { setDrawer(true); switchTab("files"); };
  $("capGoal").onclick = function () { setDrawer(true); switchTab("goal"); };
  $("capReview").onclick = function () { setDrawer(true); switchTab("review"); };
  $("capMemory").onclick = function () {
    get("/api/memory").then(function (j) {
      evAgent().innerHTML = renderMd("## 记忆\n```json\n" + JSON.stringify(j, null, 2).slice(0, 3000) + "\n```");
      toBottom(true);
    }).catch(function (e) { toast(e.message, true); });
  };
  $("capSettings").onclick = function () { setDrawer(true); switchTab("settings"); };
  function switchTab(tab) {
    var t = document.querySelector('.tab[data-tab="' + tab + '"]');
    if (t) t.click();
  }

  /* ================= 生命周期角标 ================= */
  function loadLifecycle() {
    get("/api/lifecycle").then(function (j) {
      var st = j && (j.stage || j.status) || null;
      if (!st) return;
      $("lifeDot").className = "dot on";
      $("lifeTxt").textContent = "生命周期 " + st + (j.dialog_count != null ? " · 对话 " + j.dialog_count : "");
    }).catch(function () {});
  }

  /* ================= 输入框 ================= */
  function autosize() {
    var i = $("inp");
    i.style.height = "auto";
    i.style.height = Math.min(i.scrollHeight, 180) + "px";
  }
  $("inp").addEventListener("input", function () {
    autosize();
    $("btnSend").disabled = !S.streaming && !$("inp").value.trim();
    var v = $("inp").value;
    if (v.charAt(0) === "/" && !S.streaming) showPalette(v.slice(1).split(/\s/)[0]);
    else hidePalette();
  });
  $("inp").addEventListener("keydown", function (e) {
    if (!$("palette").hidden) {
      if (e.key === "ArrowDown") { e.preventDefault(); movePalette(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); movePalette(-1); return; }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        var sel = $("palette").querySelector(".pitem.sel");
        if (sel) { pickCommand(sel.getAttribute("data-name")); return; }
      }
      if (e.key === "Escape") { hidePalette(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (!$("palette").hidden) { hidePalette(); return; }
      if (S.streaming) stopGen();
    }
  });
  $("btnSend").onclick = send;

  /* ================= 侧栏折叠 ================= */
  function setSide(collapsed) {
    $("side").classList.toggle("collapsed", !!collapsed);
    $("btnSide").hidden = !collapsed;
    $("btnCollapse").setAttribute("aria-expanded", collapsed ? "false" : "true");
    localStorage.setItem("ppx_side", collapsed ? "1" : "0");
  }
  $("btnCollapse").onclick = function () { setSide(true); };
  $("btnSide").onclick = function () { setSide(false); };

  /* ================= hero chips ================= */
  document.querySelectorAll(".chip").forEach(function (c) {
    c.onclick = function () {
      $("inp").value = c.getAttribute("data-q");
      $("inp").focus();
      autosize();
      $("btnSend").disabled = false;
      hidePalette();
    };
  });

  /* ================= 启动 ================= */
  function init() {
    applyTheme();
    setSide(localStorage.getItem("ppx_side") === "1");
    setDrawer(localStorage.getItem("ppx_drawer") === "1");

    get("/health").then(function (j) {
      if (j && j.version) $("brandTag").textContent = "v" + String(j.version).split(".").slice(0, 2).join(".");
    }).catch(function () {});

    var saved = localStorage.getItem("ppx_session");
    loadSessions().then(function () {
      var found = S.sessions.find(function (s) { return s.key === saved; });
      if (found) switchSession(found.key, found.title || found.name);
      else newSession();
    });

    loadCommands();
    loadLifecycle();
    pollApprovals();
    S.lifeTimer = setInterval(loadLifecycle, 30000);
    S.apprTimer = setInterval(pollApprovals, 5000);
    $("inp").focus();
  }
  init();
})();
