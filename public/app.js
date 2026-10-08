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
          // 401 自助恢复 (2026-10-03): bootstrap 未注入 token 时允许手输一次并重试 ——
          // 原 token 手输是死路: localStorage 读了 ppx_token 但全站无写入点, 401 后无恢复路径。
          if (r.status === 401 && !localStorage.getItem("ppx_token")) {
            var input = window.prompt("需要访问令牌 (服务端 http-token):", "");
            if (input) {
              localStorage.setItem("ppx_token", input.trim());
              return req(path, opts); // 重试一次 (递归时已有 token, 不会再 prompt)
            }
          }
          throw new Error((j && j.error) || ("HTTP " + r.status));
        });
      }
      return r.json().catch(function () { return null; });
    });
  }
  function get(path) { return req(path); }
  function post(path, body) { return req(path, { method: "POST", body: JSON.stringify(body || {}) }); }


  /* ================= 主题 ================= */
  function applyTheme() {
    var t = localStorage.getItem("ppx_theme");
    if (!t) t = "dark"; /* 2026-10-01: 默认暗色 (Codex 风格) */
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
      // 2026-10-07 修复 (P0-3): 会话搜索原先查 [data-key] 但按钮从未写入该属性 → 死代码。补上。
      b.setAttribute("data-key", s.key);
      b.setAttribute("data-title", title);
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

  // 2026-10-07 修复 (P0-1): switchSession() 一直调用 loadHistory(key), 但全文件从未定义 →
  //   点击任意历史会话抛 ReferenceError, 历史消息永远加载不出来 (会话列表的主用法)。
  //   后端已备: GET /sessions/:key/history → { messages: [{role, content}] } (sessionStore.deriveMessages)。
  function loadHistory(key) {
    if (!key) return;
    get("/sessions/" + encodeURIComponent(key) + "/history").then(function (j) {
      var msgs = (j && j.messages) || [];
      clearStream();
      if (!msgs.length) { $("hero").hidden = false; $("stream").hidden = true; return; }
      msgs.forEach(function (m) {
        if (!m) return;
        if (m.role === "user") evUser(m.content || "");
        else {
          var body = evAgent();
          body.innerHTML = renderMd(m.content || "");
        }
      });
      toBottom(true);
    }).catch(function (e) { toast("历史加载失败: " + e.message, true); });
  }

  $("btnNew").onclick = newSession;
  $("btnSessRefresh").onclick = loadSessions;

  // 2026-10-07 (P2-19): 会话重命名 / 清空。后端一直有 (/sessions/rename, /reset),
  //   前端此前只用了 list / delete / 新会话 —— 重命名与清空缺失。
  $("btnSessRename").onclick = function () {
    if (!S.session) return;
    var to = prompt("重命名会话 (新 key):", S.session);
    if (to == null) return;
    to = to.trim();
    if (!to || to === S.session) return;
    post("/sessions/rename", { from: S.session, to: to }).then(function (j) {
      if (j && j.ok === false) { toast("重命名失败 (目标 key 已存在?)", true); return; }
      S.session = to;
      $("sessTitle").textContent = to;
      localStorage.setItem("ppx_session", to);
      toast("已重命名");
      loadSessions();
    }).catch(function (e) { toast(e.message, true); });
  };
  $("btnSessReset").onclick = function () {
    if (!S.session) return;
    if (!confirm("清空当前会话的消息记录? (不可撤销)")) return;
    post("/reset", { sessionId: S.session }).then(function () {
      clearStream();
      $("hero").hidden = false;
      $("stream").hidden = true;
      toast("已清空");
      loadSessions();
    }).catch(function (e) { toast(e.message, true); });
  };
  $("btnSessSearch").onclick = function () {
    var q = prompt("搜索会话 (留空显示全部):");
    if (q == null) return;
    q = q.trim().toLowerCase();
    // 2026-10-07 修复 (P0-3): 原实现的 S.sessions.forEach(...[data-key]...) 恒不命中 (属性从未写入),
    //   是死代码; 真正的过滤是紧随其后的文本筛查。现按 data-title 过滤, 语义明确。
    var items = $("sessList").querySelectorAll(".sess");
    items.forEach(function (it) {
      var txt = (it.getAttribute("data-title") || "").toLowerCase();
      if (!txt && it.querySelector(".t")) txt = it.querySelector(".t").textContent.toLowerCase();
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
  var _toolSeq = 0;         // 无 id 事件的唯一键序号 (2026-10-03 配对修复)
  var _nameQueue = {};      // tool 名 -> 无 id 卡片 key 的 FIFO (同名工具串行配对)
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
    // 2026-10-03 配对修复: 原回退 `ev.id || ev.tool` 用工具名作键 —— 同名工具并发/连续两次时,
    // finishTool 会把状态写到第一张卡。改为 id 优先, 无 id 入同名 FIFO 队列串行配对。
    var key;
    if (ev.id != null) key = "id:" + ev.id;
    else {
      key = "anon:" + (++_toolSeq);
      (_nameQueue[ev.tool] || (_nameQueue[ev.tool] = [])).push(key);
    }
    toolEls[key] = { ev: d, card: card, body: card.querySelector(".tcbody") };
    toBottom();
  }
  function finishTool(ev) {
    var key = ev.id != null ? "id:" + ev.id : null;
    if (!key) {
      var q = _nameQueue[ev.tool];
      if (q && q.length) key = q.shift(); // 无 id: 取最早打开的同名卡 (串行语义)
    }
    var t = key ? toolEls[key] : null;
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
      + '<button class="btn" data-act="always">始终允许此类</button>'
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
      v.textContent = decision === "deny" ? "✗ 已拒绝" : (decision === "always" ? "✓ 已批准 (此类命令本会话不再询问)" : "✓ 已批准");
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
    hideFilePick();
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
                if (j.usage) { S.lastTokens = j.usage; updTokPill(); }
                else if (j.tokens) { S.lastTokens = j.tokens; updTokPill(); }
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
    var t = S.lastTokens;
    if (!t) return;
    // 2026-10-03 修复: 原 `(total || input+"/"+output || "—")` 优先级错误 ——
    // total 为 0 时回退到拼接, 两者都缺时字符串拼接出 "undefined/undefined"。改为显式分支。
    var label;
    if (t.total != null) label = t.total;
    else if (t.tokens != null) label = t.tokens;
    else if (t.input != null && t.output != null) label = t.input + "/" + t.output;
    else return;
    $("tokPill").hidden = false;
    $("tokTxt").textContent = label;
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
      return '<button class="pitem' + (i === 0 ? " sel" : "") + '" role="option" aria-selected="' + (i === 0 ? "true" : "false") + '" data-name="' + esc(c.name) + '">'
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
    items.forEach(function (b, i) { b.classList.toggle("sel", i === palSel); b.setAttribute("aria-selected", i === palSel ? "true" : "false"); });
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
    else if (tab === "task") loadTasks();
    else if (tab === "memory") loadMemory();
    else if (tab === "ops") loadOps();
    else if (tab === "settings") loadSettings();
    else if (tab === "models") loadProviders();
    else if (tab === "cap") loadCapabilities();
  }

  /* --- 文件树 --- */
  function loadTree() {
    var url = "/api/workspace/tree" + (S.wsRoot ? "?root=" + encodeURIComponent(S.wsRoot) : "");
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
        container.appendChild(kids);
        // 2026-10-07 修复 (P2-11): 原实现硬编码 `depth < 2` → 第 3 层以上目录展开恒为空。
        //   现前两层照旧递归预渲染; 更深的目录在首次展开时按需拉取子树
        //   (后端 buildTree 支持 root + maxDepth=1..8)。
        var childNodes = n.children || n.items || [];
        if (depth < 2 && childNodes.length) { renderTree(kids, childNodes, depth + 1); kids._loaded = true; }
        d.onclick = function () {
          kids.hidden = !kids.hidden;
          if (!kids.hidden && !kids._loaded) {
            kids._loaded = true;
            if (childNodes.length) renderTree(kids, childNodes, depth + 1);
            else if (n.path) loadSubTree(n.path, kids);
            else kids.innerHTML = '<div class="empty">空目录</div>';
          }
        };
      } else {
        var f = document.createElement("button");
        f.className = "f";
        f.innerHTML = ico("file", 13) + '<span class="nm">' + esc(n.name || n.path) + "</span>";
        f.onclick = function () { openFile(n.path || n.name); };
        container.appendChild(f);
      }
    });
  }
  // 按需展开: 拉取某目录子树 (root = 工作区相对路径)
  function loadSubTree(rel, container) {
    container.innerHTML = '<div class="empty">加载中…</div>';
    get("/api/workspace/tree?maxDepth=2&root=" + encodeURIComponent(rel)).then(function (j) {
      var nodes = (j && j.tree && j.tree.children) || [];
      container.innerHTML = "";
      if (!nodes.length) { container.innerHTML = '<div class="empty">空目录</div>'; return; }
      renderTree(container, nodes, 1);
    }).catch(function (e) { container.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
  }
  var fvCurrent = "";   // 当前打开文件的路径 (供保存回写)
  function openFile(path) {
    fvCurrent = path;
    get("/api/workspace/read?path=" + encodeURIComponent(path)).then(function (j) {
      $("fileView").hidden = false;
      $("fvPath").textContent = path + (j && j.truncated ? " (已截断)" : "");
      $("fvBody").textContent = (j && (j.content || j.text)) || "(空)";
      $("fvBody").hidden = false;
      $("fvEditBox").hidden = true;
      $("fvSave").hidden = true;
      // 截断文件禁止编辑: 后端只回了前 256KB, 若存回会用截断内容覆盖整文件 (丢数据)。
      $("fvEdit").hidden = !!(j && j.truncated);
    }).catch(function (e) { toast(e.message, true); });
  }
  // 2026-10-07 (P2-11): 文件面板此前完全只读。现支持编辑 + 保存回写。
  $("fvEdit").onclick = function () {
    $("fvEditBox").value = $("fvBody").textContent;
    $("fvBody").hidden = true;
    $("fvEditBox").hidden = false;
    $("fvSave").hidden = false;
    $("fvEdit").hidden = true;
    $("fvEditBox").focus();
  };
  $("fvSave").onclick = function () {
    if (!fvCurrent) return;
    post("/api/workspace/write", { path: fvCurrent, content: $("fvEditBox").value }).then(function () {
      $("fvBody").textContent = $("fvEditBox").value;
      $("fvBody").hidden = false;
      $("fvEditBox").hidden = true;
      $("fvSave").hidden = true;
      $("fvEdit").hidden = false;
      toast("已保存 " + fvCurrent);
    }).catch(function (e) { toast(e.message, true); });
  };
  $("fvClose").onclick = function () { $("fileView").hidden = true; };
  $("btnWsRefresh").onclick = loadTree;
  // 文件搜索 (2026-10-07): 非空时用后端 searchWorkspace 结果替代文件树
  var wsSearchTimer = null;
  $("wsSearch").addEventListener("input", function () {
    clearTimeout(wsSearchTimer);
    var q = $("wsSearch").value.trim();
    wsSearchTimer = setTimeout(function () {
      if (!q) {
        $("fileView").hidden = true;
        $("wsTree").hidden = false;
        $("wsSearchRes").hidden = true;
        return;
      }
      $("wsTree").hidden = true;
      $("fileView").hidden = true;
      var box = $("wsSearchRes");
      box.hidden = false;
      box.innerHTML = '<div class="empty">搜索中…</div>';
      get("/api/workspace/search?limit=60&q=" + encodeURIComponent(q)).then(function (j) {
        var rs = (j && j.results) || [];
        if (!rs.length) { box.innerHTML = '<div class="empty">无匹配</div>'; return; }
        box.innerHTML = rs.map(function (r) {
          return '<button class="f" data-path="' + esc(r.path) + '">' + ico("file", 13) + '<span class="nm">' + esc(r.path) + "</span>"
            + (r.match === "content" ? '<span class="fsub">:' + r.line + " " + esc(r.snippet || "") + "</span>" : "") + "</button>";
        }).join("");
        box.querySelectorAll(".f").forEach(function (b) {
          b.onclick = function () { openFile(b.getAttribute("data-path")); };
        });
      }).catch(function (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
    }, 220);
  });
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
        var st = g.status || "pending";
        // 2026-10-07 (P2-12): 看板从只读升级为可写 (后端 POST /api/goalboard).
        var acts = "";
        if (st !== "in_progress") acts += '<button class="btn xs" data-gst="in_progress" data-gid="' + esc(g.id) + '">推进</button>';
        if (st !== "done") acts += '<button class="btn xs" data-gst="done" data-gid="' + esc(g.id) + '">完成</button>';
        if (st !== "blocked") acts += '<button class="btn xs" data-gst="blocked" data-gid="' + esc(g.id) + '">阻塞</button>';
        var opts = ["P0", "P1", "P2"].map(function (p) {
          return '<option value="' + p + '"' + (String(g.priority).toUpperCase() === p ? " selected" : "") + ">" + p + "</option>";
        }).join("");
        return '<div class="goal"><div class="gt"><span class="gid">' + esc(g.id || "") + "</span>" + pr
          + '<span class="gsts ' + esc(st) + '">' + esc(st) + '</span><span class="flex1"></span>'
          + '<select class="gpri" data-gid="' + esc(g.id) + '">' + opts + "</select></div>"
          + '<div class="gmeta">' + esc(g.title || "") + "</div>"
          + (acts ? '<div class="gacts">' + acts + "</div>" : "") + "</div>";
      }).join("");
      el.querySelectorAll("[data-gst]").forEach(function (b) {
        b.onclick = function () { goalAction(b.getAttribute("data-gid"), { status: b.getAttribute("data-gst") }); };
      });
      el.querySelectorAll(".gpri").forEach(function (s) {
        s.onchange = function () { goalAction(s.getAttribute("data-gid"), { priority: s.value }); };
      });
    }).catch(function () {
      $("goalBoard").innerHTML = '<div class="empty">看板服务未启动</div>';
    });
  }
  function goalAction(id, patch) {
    post("/api/goalboard", Object.assign({ op: "update", id: id }, patch))
      .then(function () { loadGoal(); }).catch(function (e) { toast(e.message, true); });
  }
  $("btnGoalRefresh").onclick = loadGoal;
  $("btnGoalAdd").onclick = function () {
    var title = prompt("目标标题:");
    if (!title) return;
    var pr = (prompt("优先级 P0/P1/P2 (默认 P2):", "P2") || "P2").toUpperCase();
    post("/api/goalboard", { op: "add", title: title.trim(), priority: pr })
      .then(function () { loadGoal(); toast("已添加"); }).catch(function (e) { toast(e.message, true); });
  };

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
  // 2026-10-07 (P2-13): 原实现只把 "/review" 填进输入框当聊天发。现直接打审查 API。
  $("btnReviewRun").onclick = function () {
    $("btnReviewRun").disabled = true;
    $("reviewBody").innerHTML = '<div class="empty">审查中…</div>';
    post("/api/review/run", {}).then(function (j) {
      toast("审查完成: " + ((j && j.total) || 0) + " 个问题");
      loadReview();
    }).catch(function (e) { toast(e.message, true); loadReview(); })
      .then(function () { $("btnReviewRun").disabled = false; });
  };

  /* --- 设置 --- */
  function loadSettings() {
    // 2026-10-07 修复 (P0-2): 原实现把 /api/bootstrap 的 `agent` 当对象读 (ag.approval_mode / ag.sandbox),
    //   但 bootstrap.agent 是【agent 名字字符串】→ 两个下拉恒拿到 undefined, 显示的不是真实配置;
    //   且 setSandbox.value="" 匹配不到任何 option → 沙箱永远停在 read-only。
    //   权限真值只有一个来源: GET /api/permissions (引擎当前态)。bootstrap 只用来填只读信息。
    get("/api/bootstrap").then(function (j) {
      if (!j) return;
      $("setInfo").textContent = "模型: " + (j.model || "-")
        + " · 工具 " + (j.toolsCount != null ? j.toolsCount : "-") + " 个"
        + " · 工作区 " + (j.root || "-");
    }).catch(function () {
      $("setInfo").textContent = "引导信息不可用";
    });
    get("/api/permissions").then(function (p) {
      if (!p || p.ok === false) return;
      if (p.approvalMode) {
        S.perm = p.approvalMode;
        $("setApproval").value = p.approvalMode;
        $("modeTxt").textContent = p.approvalMode;
      }
      if (p.sandbox) $("setSandbox").value = p.sandbox;
      // 2026-10-07 (P2-18): 计划模式真值 (引擎 planEnabled)。前端此前只能手打 /plan。
      $("setPlan").value = p.planEnabled ? "on" : "off";
    }).catch(function () {});
    loadGeneralSettings();
  }
  $("setApproval").onchange = function () {
    S.perm = $("setApproval").value;
    $("modeTxt").textContent = S.perm;
    post("/api/permissions", { approvalMode: S.perm }).catch(function () { toast("已切换本地显示 (服务端模式未变)", false); });
  };
  $("setSandbox").onchange = function () {
    post("/api/permissions", { sandbox: $("setSandbox").value }).catch(function () {});
  };
  $("setPlan").onchange = function () {
    var on = $("setPlan").value === "on";
    post("/api/permissions", { planEnabled: on, sessionKey: S.session || undefined }).then(function () {
      toast(on ? "计划模式已开启 (本会话)" : "计划模式已关闭");
    }).catch(function (e) { toast(e.message, true); });
  };

  /* --- 模型 / 供应商配置 (2026-10-07 新增) ---
     后端早已就绪: GET/POST/PUT/DELETE /api/providers, POST /api/providers/test,
     POST /api/providers/reorder; 前端此前零接线 (设置面板里只有一行只读模型名)。
     约定: providers 数组第 0 个 = 默认供应商; key 明文永不回传, 后端只给 api_key_set 标志。 */
  var provState = { providers: [], editing: null };

  function loadProviders() {
    get("/api/providers").then(function (j) {
      provState.providers = (j && j.providers) || [];
      if (provState.editing && provState.editing !== "__new__"
        && !provState.providers.some(function (p) { return p.id === provState.editing; })) {
        closeProvForm();
      }
      renderProviders();
    }).catch(function (e) {
      $("provList").innerHTML = '<div class="empty">读取失败: ' + esc(e.message) + "</div>";
    });
  }

  function renderProviders() {
    var el = $("provList");
    var list = provState.providers;
    if (!list.length) { el.innerHTML = '<div class="empty">暂无供应商 · 点右上 ＋ 新增</div>'; return; }
    el.innerHTML = list.map(function (p, i) {
      var acts = '<button class="btn xs" data-act="test" data-id="' + esc(p.id) + '">测试</button>';
      if (i > 0) acts += '<button class="btn xs" data-act="default" data-id="' + esc(p.id) + '">设为默认</button>';
      acts += '<button class="btn xs" data-act="edit" data-id="' + esc(p.id) + '">编辑</button>'
        + '<button class="btn xs danger" data-act="del" data-id="' + esc(p.id) + '">删除</button>';
      return '<div class="prov' + (provState.editing === p.id ? " on" : "") + '" data-id="' + esc(p.id) + '">'
        + '<div class="phead"><span class="pid">' + esc(p.id) + "</span>"
        + (i === 0 ? '<span class="badge p0">默认</span>' : "")
        + (p.vision ? '<span class="badge p2">vision</span>' : "")
        + '<span class="flex1"></span>'
        + '<span class="pkey' + (p.api_key_set ? " ok" : "") + '">' + (p.api_key_set ? "key ✓" : "未设 key") + "</span></div>"
        + '<div class="pmeta">' + esc(p.model || "(未设模型)") + " · " + esc(p.base_url || "(未设 base_url)")
        + (p.timeout_ms ? " · " + p.timeout_ms + "ms" : "") + "</div>"
        + '<div class="pacts">' + acts + '<span class="presult" data-res="' + esc(p.id) + '"></span></div>'
        + "</div>";
    }).join("");
    el.querySelectorAll("[data-act]").forEach(function (b) {
      b.onclick = function () { provAction(b.getAttribute("data-act"), b.getAttribute("data-id")); };
    });
  }

  function provAction(act, id) {
    if (act === "test") return testProvider(id);
    if (act === "edit") return openProvForm(id);
    if (act === "del") return deleteProvider(id);
    if (act === "default") return setDefaultProvider(id);
  }

  function provResult(id, text, isErr) {
    var el = $("provList").querySelector('[data-res="' + id + '"]');
    if (el) { el.textContent = text; el.className = "presult" + (isErr ? " err" : " ok"); }
  }

  function testProvider(id) {
    provResult(id, "测试中…");
    post("/api/providers/test", { id: id }).then(function (j) {
      var ok = j && j.healthy;
      provResult(id, ok ? "✓ 连通" : "✗ " + ((j && j.detail) || "探测失败"), !ok);
    }).catch(function (e) { provResult(id, "✗ " + e.message, true); });
  }

  function deleteProvider(id) {
    if (!confirm("删除供应商 " + id + " ?")) return;
    req("/api/providers", { method: "DELETE", body: JSON.stringify({ id: id }) }).then(function () {
      toast("已删除 " + id);
      loadProviders();
    }).catch(function (e) { toast(e.message, true); });
  }

  function setDefaultProvider(id) {
    var order = provState.providers.map(function (p) { return p.id; });
    order = [id].concat(order.filter(function (x) { return x !== id; }));
    post("/api/providers/reorder", { order: order }).then(function () {
      toast(id + " 已设为默认");
      loadProviders();
    }).catch(function (e) { toast(e.message, true); });
  }

  function closeProvForm() { provState.editing = null; $("provForm").hidden = true; renderProviders(); }

  function openProvForm(id) {
    var p = id ? provState.providers.find(function (x) { return x.id === id; }) : null;
    provState.editing = id || "__new__";
    $("provForm").hidden = false;
    $("pvTitle").textContent = p ? "编辑 " + p.id : "新增供应商";
    $("pvId").value = p ? p.id : "";
    $("pvId").disabled = !!p;
    $("pvBase").value = p ? (p.base_url || "") : "";
    $("pvModel").value = p ? (p.model || "") : "";
    $("pvKey").value = "";
    $("pvKey").placeholder = p && p.api_key_set ? "已设置 · 留空不改" : "api_key";
    $("pvEnv").value = p ? (p.api_key_env || "") : "";
    $("pvVision").checked = !!(p && p.vision);
    $("pvTimeout").value = p && p.timeout_ms ? p.timeout_ms : "";
    renderProviders();
  }

  function saveProvForm() {
    var id = $("pvId").value.trim();
    var base = $("pvBase").value.trim();
    if (!id) return toast("请填 id", true);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,29}$/.test(id)) return toast("id 需字母开头, 仅字母/数字/横线/下划线, 2-30 字符", true);
    if (!base) return toast("请填 base_url", true);
    var fields = { id: id, backend: "http", base_url: base, model: $("pvModel").value.trim(), vision: $("pvVision").checked };
    var key = $("pvKey").value;
    if (key) fields.api_key = key; // 留空 = 不改动 (后端把空串视为清空, 这里只在填写时才带)
    fields.api_key_env = $("pvEnv").value.trim();
    var to = parseInt($("pvTimeout").value, 10);
    if (Number.isFinite(to) && to >= 1000) fields.timeout_ms = to;
    var editing = provState.editing;
    var p = editing === "__new__"
      ? post("/api/providers", { provider: fields })
      : req("/api/providers", { method: "PUT", body: JSON.stringify({ id: editing, patch: fields }) });
    p.then(function () { toast("已保存"); closeProvForm(); loadProviders(); })
      .catch(function (e) { toast(e.message, true); });
  }

  $("btnProvRefresh").onclick = loadProviders;
  $("btnProvAdd").onclick = function () { openProvForm(null); };
  $("btnProvCancel").onclick = closeProvForm;
  $("btnProvSave").onclick = saveProvForm;

  /* --- 通用设置 (2026-10-07: /api/settings 此前前端一个控件都没有) --- */
  function loadGeneralSettings() {
    get("/api/settings").then(function (j) {
      var s = j && j.settings;
      if (!s) return;
      if (s.user) $("setUser").value = s.user.name || "";
      if (s.agent) { $("setAgentName").value = s.agent.name || ""; $("setAgentMode").value = s.agent.mode || ""; }
      if (s.http) $("setPort").value = s.http.port != null ? s.http.port : "";
      if (s.security) $("setAllowAll").checked = !!s.security.allow_all;
    }).catch(function () {});
  }
  $("btnSetSave").onclick = function () {
    var patch = { user: {}, agent: {}, security: { allow_all: $("setAllowAll").checked } };
    var un = $("setUser").value.trim();
    if (un) patch.user.name = un;
    var an = $("setAgentName").value.trim();
    if (an) patch.agent.name = an;
    var am = $("setAgentMode").value.trim();
    if (am) patch.agent.mode = am; // 空串会触发后端 mode 正则校验失败, 故仅在非空时下发
    var port = Number($("setPort").value);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) patch.http = { port: port };
    req("/api/settings", { method: "PUT", body: JSON.stringify({ patch: patch }) }).then(function () {
      toast("设置已保存");
    }).catch(function (e) { toast(e.message, true); });
  };

  /* --- 能力面板 (2026-10-07: 技能/专家/工具/MCP; 后端 /api/skills|experts|tools|mcp 同步新增) --- */
  var capState = { seg: "skills" };
  var CAP_URL = { skills: "/api/skills", experts: "/api/experts", tools: "/api/tools", mcp: "/api/mcp" };

  function loadCapabilities(seg) {
    seg = seg || capState.seg;
    capState.seg = seg;
    $("capBody").innerHTML = '<div class="empty">加载中…</div>';
    get(CAP_URL[seg]).then(function (j) { renderCapSeg(seg, j); }).catch(function (e) {
      $("capBody").innerHTML = '<div class="empty">' + esc(e.message) + "</div>";
    });
  }

  function capItem(head, desc, meta, compact) {
    return '<div class="capitem' + (compact ? " compact" : "") + '"><div class="ci-head">' + head + "</div>"
      + (desc ? '<div class="ci-desc">' + desc + "</div>" : "")
      + (meta ? '<div class="ci-meta">' + meta + "</div>" : "") + "</div>";
  }

  function renderCapSeg(seg, j) {
    var el = $("capBody");
    if (seg === "skills") {
      var list = (j && j.skills) || [];
      if (!list.length) { el.innerHTML = '<div class="empty">暂无技能</div>'; return; }
      el.innerHTML = '<div class="capcount">' + list.length + " 个技能 · " + Object.keys((j && j.domains) || {}).length + " 个领域</div>"
        + list.map(function (s) {
          var head = '<span class="ci-name">' + esc(s.name || s.id) + '</span>'
            + '<span class="badge p2">' + esc(s.domain) + "</span><span class=\"flex1\"></span>"
            + '<span class="ci-use">' + (s.uses ? "用 " + s.uses + " 次" : "未用") + "</span>";
          return capItem(head, esc(s.description || ""), esc(s.id) + (s.source ? " · " + esc(s.source) : ""), false);
        }).join("");
      return;
    }
    if (seg === "experts") {
      var ex = (j && j.experts) || [], packs = (j && j.packs) || [];
      var html = '<div class="capcount">' + ex.length + " 位内置专家 · " + packs.length + " 个专家包</div>";
      html += ex.map(function (e) {
        var head = '<span class="ci-name">' + esc(e.name) + '</span>'
          + '<span class="badge p2">' + esc(e.domain) + "</span>"
          + (e.readonly ? '<span class="badge p1">只读</span>' : "")
          + (e.requiresHuman ? '<span class="badge p0">需人工</span>' : "")
          + '<span class="flex1"></span><span class="ci-use">' + esc(e.id) + "</span>";
        return capItem(head, esc(e.perspective || ""), "", false);
      }).join("");
      if (packs.length) {
        html += '<div class="capgroup">专家包</div>' + packs.map(function (p) {
          var head = '<span class="ci-name">' + esc(p.name || p.id) + '</span>'
            + '<span class="badge p2">' + esc(p.category || p.domain || "") + '</span><span class="flex1"></span>'
            + '<span class="ci-use">' + esc(p.id || "") + "</span>";
          return capItem(head, esc(p.description || ""), "", false);
        }).join("");
      }
      el.innerHTML = html;
      return;
    }
    if (seg === "tools") {
      var tools = (j && j.tools) || [];
      var groups = {};
      tools.forEach(function (t) { (groups[t.category] = groups[t.category] || []).push(t); });
      var h = '<div class="capcount">' + (j && j.enabled != null ? j.enabled : tools.length) + " / " + tools.length + " 个工具启用</div>";
      Object.keys(groups).sort().forEach(function (cat) {
        h += '<div class="capgroup">' + esc(cat) + " (" + groups[cat].length + ")</div>";
        h += groups[cat].map(function (t) {
          var head = '<span class="ci-name mono">' + esc(t.name) + '</span><span class="flex1"></span>'
            + '<span class="ci-use ' + (t.enabled ? "ok" : "off") + '">' + (t.enabled ? "启用" : "禁用") + "</span>";
          return capItem(head, esc(t.description || ""), "", true);
        }).join("");
      });
      el.innerHTML = h;
      return;
    }
    // mcp
    var servers = (j && j.servers) || [];
    var h2 = '<div class="capcount">' + (j && j.connected ? "已连接 · " + j.tools + " 个工具" : "未连接")
      + (j && j.autoConnect ? " · 自动连接开" : " · 自动连接关") + "</div>";
    if (!servers.length) h2 += '<div class="empty">config 未配置 MCP 服务器</div>';
    else h2 += servers.map(function (s) {
      var head = '<span class="ci-name">' + esc(s.name) + "</span>"
        + (s.prefix ? '<span class="badge p2">' + esc(s.prefix) + "</span>" : "")
        + '<span class="flex1"></span><span class="ci-use">' + (s.env_set ? "env ✓" : "") + "</span>";
      return capItem(head, "", esc(s.command || s.url || "") + (s.args && s.args.length ? " " + esc(s.args.join(" ")) : ""), false);
    }).join("");
    el.innerHTML = h2;
  }

  document.querySelectorAll("#capSeg .segb").forEach(function (b) {
    b.onclick = function () {
      document.querySelectorAll("#capSeg .segb").forEach(function (x) { x.classList.remove("on"); });
      b.classList.add("on");
      loadCapabilities(b.getAttribute("data-seg"));
    };
  });
  $("btnCapRefresh").onclick = function () { loadCapabilities(capState.seg); };

  /* --- 任务面板 (2026-10-07 新增: 后端 /api/tasks 复用 MCP ppx.task.* 的 TaskBoard) --- */
  function loadTasks() {
    $("taskBody").innerHTML = '<div class="empty">加载中…</div>';
    get("/api/tasks").then(function (j) {
      if (!j || j.ok === false) {
        $("taskBody").innerHTML = '<div class="empty">任务面板不可用' + (j && j.reason ? ": " + esc(j.reason) : "") + "</div>";
        return;
      }
      renderTasks(j);
    }).catch(function (e) { $("taskBody").innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
  }
  function taskBadge(st) { return st === "done" ? "p2" : st === "failed" ? "p0" : st === "running" ? "p1" : "p2"; }
  function renderTasks(j) {
    var tasks = (j && j.tasks) || [], counts = (j && j.counts) || {};
    var el = $("taskBody");
    var html = '<div class="capcount">待办 ' + (counts.todo || 0) + " · 进行 " + (counts.running || 0)
      + " · 完成 " + (counts.done || 0) + " · 失败 " + (counts.failed || 0) + "</div>";
    if (!tasks.length) { el.innerHTML = html + '<div class="empty">暂无任务 · 点右上 ＋ 新建</div>'; return; }
    html += tasks.map(function (t) {
      var steps = (t.steps || []).map(function (s, i) {
        return '<div class="tstep"><span class="tst ' + esc(s.status || "pending") + '"></span>'
          + '<span class="tsname">' + esc(s.title) + "</span><span class=\"flex1\"></span>"
          + (s.status === "done" ? "" : '<button class="btn xs" data-op="step-done" data-task="' + esc(t.id) + '" data-step="' + i + '">完成</button>') + "</div>";
      }).join("");
      return '<div class="capitem"><div class="ci-head"><span class="ci-name">' + esc(t.title) + "</span>"
        + '<span class="badge ' + taskBadge(t.status) + '">' + esc(t.status) + '</span><span class="flex1"></span>'
        + (t.status === "done" ? "" : '<button class="btn xs" data-op="complete" data-task="' + esc(t.id) + '">完成</button>')
        + '<button class="btn xs danger" data-op="delete" data-task="' + esc(t.id) + '">删除</button></div>'
        + (t.description ? '<div class="ci-desc">' + esc(t.description) + "</div>" : "")
        + (steps ? '<div class="tsteps">' + steps + "</div>" : "")
        + (t.result ? '<div class="ci-meta">结果: ' + esc(String(t.result).slice(0, 300)) + "</div>" : "")
        + "</div>";
    }).join("");
    el.innerHTML = html;
    el.querySelectorAll("[data-op]").forEach(function (b) {
      b.onclick = function () { taskAction(b.getAttribute("data-op"), b.getAttribute("data-task"), b.getAttribute("data-step")); };
    });
  }
  function taskAction(op, id, stepIndex) {
    var payload;
    if (op === "delete") { if (!confirm("删除任务 " + id + " ?")) return; payload = { op: "delete", id: id }; }
    else if (op === "complete") payload = { op: "complete", id: id };
    else if (op === "step-done") payload = { op: "step", id: id, index: Number(stepIndex), status: "done" };
    else return;
    post("/api/tasks", payload).then(function (j) { renderTasks(j); }).catch(function (e) { toast(e.message, true); });
  }
  $("btnTaskRefresh").onclick = loadTasks;
  $("btnTaskNew").onclick = function () {
    var title = prompt("新任务标题:");
    if (!title) return;
    var raw = prompt("步骤 (可选, 用 ; 分隔):", "");
    var steps = raw ? raw.split(";").map(function (s) { return s.trim(); }).filter(Boolean) : [];
    post("/api/tasks", { op: "create", title: title.trim(), steps: steps }).then(function (j) { renderTasks(j); toast("已创建"); })
      .catch(function (e) { toast(e.message, true); });
  };

  /* --- 记忆面板 (2026-10-07: 原实现把 /api/memory 的 JSON 直接 dump 进聊天流) --- */
  function loadMemory() {
    $("memBody").innerHTML = '<div class="empty">加载中…</div>';
    get("/api/memory").then(function (j) {
      var facts = (j && j.facts) || [], scenes = (j && j.scenes) || [];
      var html = '<div class="capcount">' + facts.length + " 条事实 (L1) · " + scenes.length + " 个场景 (L2)</div>";
      if (facts.length) {
        html += '<div class="capgroup">事实</div>' + facts.map(function (f) {
          return capItem('<span class="ci-name">' + esc(String(f.content || "").slice(0, 220)) + "</span>"
            + '<span class="flex1"></span><span class="ci-use">' + esc(f.type || "") + (f.score != null ? " · " + Number(f.score).toFixed(2) : "") + "</span>", "", "", true);
        }).join("");
      }
      if (scenes.length) {
        html += '<div class="capgroup">场景</div>' + scenes.map(function (s) {
          var txt = typeof s === "string" ? s : (s.desc || s.summary || s.title || JSON.stringify(s));
          return capItem('<span class="ci-name">' + esc(String(txt).slice(0, 220)) + "</span>", "", "", true);
        }).join("");
      }
      if (!facts.length && !scenes.length) html += '<div class="empty">暂无记忆</div>';
      $("memBody").innerHTML = html;
    }).catch(function (e) { $("memBody").innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
  }
  $("btnMemRefresh").onclick = loadMemory;

  /* --- 运行状态面板 (2026-10-07: /api/stats|traces|proactive|lifecycle 此前全无界面) --- */
  function loadOps() {
    $("opsBody").innerHTML = '<div class="empty">加载中…</div>';
    Promise.all([
      get("/api/stats").catch(function () { return null; }),
      get("/api/traces?limit=30").catch(function () { return null; }),
      get("/api/proactive").catch(function () { return null; }),
      get("/api/lifecycle").catch(function () { return null; }),
    ]).then(function (r) {
      var stats = r[0], traces = r[1], pro = r[2], life = r[3];
      var html = "";
      if (stats) html += '<div class="capgroup">统计</div>' + kvBlock(stats);
      if (life && Object.keys(life).length) html += '<div class="capgroup">生命周期</div>' + kvBlock(life);
      if (pro) {
        var items = pro.items || [];
        html += '<div class="capgroup">主动提醒 (' + items.length + ")</div>";
        if (pro.message) html += '<div class="capitem compact"><div class="ci-desc">' + esc(pro.message) + "</div></div>";
        html += items.map(function (it) {
          return capItem('<span class="ci-name">' + esc(it.title || it.text || JSON.stringify(it)) + "</span>", "", esc(it.id || ""), true);
        }).join("");
      }
      var evs = (traces && (traces.events || traces)) || [];
      if (evs.length) {
        html += '<div class="capgroup">最近轨迹 (' + evs.length + ")</div>" + evs.slice(0, 30).map(function (e) {
          return capItem('<span class="ci-name mono">' + esc(e.name || e.event || e.type || "?") + "</span>"
            + '<span class="flex1"></span><span class="ci-use">' + esc(fmtTs(e.ts || e.time)) + "</span>", "", "", true);
        }).join("");
      }
      $("opsBody").innerHTML = html || '<div class="empty">暂无可观测数据</div>';
    }).catch(function (e) { $("opsBody").innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
  }
  function kvBlock(obj) {
    var rows = "";
    (function walk(o, prefix) {
      Object.keys(o || {}).forEach(function (k) {
        var v = o[k];
        var key = prefix ? prefix + "." + k : k;
        if (v && typeof v === "object" && !Array.isArray(v)) walk(v, key);
        else rows += '<div class="kv"><span class="kvk">' + esc(key) + '</span><span class="kvv">' + esc(Array.isArray(v) ? v.length + " 项" : String(v)) + "</span></div>";
      });
    })(obj, "");
    return '<div class="kvbox">' + (rows || '<div class="empty">—</div>') + "</div>";
  }
  $("btnOpsRefresh").onclick = loadOps;

  /* ================= 侧栏能力入口 ================= */
  $("capFiles").onclick = function () { setDrawer(true); switchTab("files"); };
  $("capGoal").onclick = function () { setDrawer(true); switchTab("goal"); };
  $("capReview").onclick = function () { setDrawer(true); switchTab("review"); };
  // 2026-10-07 (P2-15): 记忆不再把 JSON dump 进聊天流, 改开抽屉记忆面板。
  $("capMemory").onclick = function () { setDrawer(true); switchTab("memory"); };
  $("capTasks").onclick = function () { setDrawer(true); switchTab("task"); };
  $("capOps").onclick = function () { setDrawer(true); switchTab("ops"); };
  $("capSettings").onclick = function () { setDrawer(true); switchTab("settings"); };
  $("capModels").onclick = function () { setDrawer(true); switchTab("models"); };
  $("capAbility").onclick = function () { setDrawer(true); switchTab("cap"); };
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

  /* ================= @ 文件引用 (2026-10-07, P2-11) ================= */
  // 输入框里打 @<关键词> → 拉 /api/workspace/search 弹候选, 点击插入 @路径。
  var filePick = { open: false, items: [], token: "", at: -1 };
  var _fpTimer = null;
  function maybeFilePick() {
    var i = $("inp");
    var before = i.value.slice(0, i.selectionStart);
    var at = before.lastIndexOf("@");
    if (at === -1 || /\s/.test(before.slice(at + 1))) { hideFilePick(); return; }
    var q = before.slice(at + 1);
    if (!q.length) { hideFilePick(); return; }
    filePick.at = at;
    filePick.token = q;
    clearTimeout(_fpTimer);
    _fpTimer = setTimeout(function () {
      get("/api/workspace/search?limit=8&q=" + encodeURIComponent(q)).then(function (j) {
        filePick.open = true;
        filePick.items = (j && j.results) || [];
        renderFilePick();
      }).catch(function () { hideFilePick(); });
    }, 160);
  }
  function renderFilePick() {
    var el = $("filePick");
    if (!filePick.open || !filePick.items.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = filePick.items.map(function (r, i) {
      return '<div class="pitem' + (i === 0 ? " sel" : "") + '" data-path="' + esc(r.path) + '">'
        + ico("file", 13) + '<span class="pname">' + esc(r.path) + "</span>"
        + (r.match === "content" ? '<span class="pdesc">:' + r.line + " " + esc(r.snippet || "") + "</span>" : "") + "</div>";
    }).join("");
    el.querySelectorAll(".pitem").forEach(function (it) {
      it.onclick = function () { insertFileRef(it.getAttribute("data-path")); };
    });
  }
  function insertFileRef(p) {
    var i = $("inp");
    var v = i.value;
    var before = v.slice(0, filePick.at);
    var after = v.slice(filePick.at + 1 + filePick.token.length);
    i.value = before + "@" + p + " " + after.replace(/^\s+/, "");
    hideFilePick();
    i.focus();
    autosize();
    $("btnSend").disabled = !i.value.trim();
  }
  function hideFilePick() { filePick.open = false; var el = $("filePick"); if (el) el.hidden = true; }

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
    if (!S.streaming) maybeFilePick(); else hideFilePick();
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
      if (!$("filePick").hidden) { hideFilePick(); return; }
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
  // 主动提醒 SSE (2026-10-03): 订阅 GET /events, 收到服务端主动推送时弹提醒。
  // EventSource 不能带 Authorization 头 → token 走查询参数 (bootstrap 注入或 localStorage)。
  function showReminder(text) {
    var t = $("toast");
    t.textContent = text;
    t.className = "toast";
    t.hidden = false;
    clearTimeout(t._tm);
    t._tm = setTimeout(function () { t.hidden = true; }, 8000);
  }
  function connectEvents() {
    if (!window.EventSource) return; // 老 IE 无视
    var boot = window.__PPX_BOOTSTRAP__ || {};
    var tok = boot.authToken || localStorage.getItem("ppx_token") || "";
    try {
      var es = new EventSource("/events" + (tok ? "?token=" + encodeURIComponent(tok) : ""));
      es.onmessage = function (ev) {
        try {
          var d = JSON.parse(ev.data);
          if (d && d.type === "reminder" && d.text) showReminder(String(d.text));
          // 协议总线 EQ 结构化事件 (2026-10-03 接线): 审批请求到达时立即提示 (原靠 5s 轮询兜底)
          else if (d && d.type === "event" && d.event && d.event.type === "APPROVAL_REQUESTED") {
            showReminder("收到新的审批请求, 请在审批面板处理");
            if (typeof pollApprovals === "function") pollApprovals();
          }
        } catch (e) { /* 非 JSON 心跳帧忽略 */ }
      };
      es.onerror = function () { /* EventSource 自带 retry: 5s 重连, 无需手动 */ };
    } catch (e) { /* SSE 不可用时静默降级 */ }
  }
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
    connectEvents();
    S.lifeTimer = setInterval(loadLifecycle, 30000);
    S.apprTimer = setInterval(pollApprovals, 5000);
    $("inp").focus();
  }
  init();
})();
