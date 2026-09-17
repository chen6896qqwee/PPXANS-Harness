/* public/app.js - 皮皮虾 Web UI 逻辑 (零依赖, 原生 ES2020)
 *
 * 架构: 内核 src/server.js 单进程同时提供界面与接口 → 前端所有请求走同源相对路径。
 * 启动数据 (版本/端口/token) 由服务端注入 window.__PPX_BOOTSTRAP__; 非回环访问时
 * 注入里没有 token, 界面会提示手填。
 *
 * 数据通道: 对话/会话/观测走 REST (/message/stream, /sessions*, /api/*);
 *          提供方与设置走标准 MCP (POST /mcp, tools/call) —— 与后端 v2.6+ 的 MCP-first 一致。
 */
(function () {
  "use strict";

  var BS = window.__PPX_BOOTSTRAP__ || {};
  var MCP_PROTOCOL = "2026-07-28";

  var S = {
    base: BS.base || location.origin,
    token: BS.authToken || localStorage.getItem("ppx_token") || "",
    tokenRequired: !!BS.tokenRequired,
    version: BS.version || "—",
    agentName: BS.agent || "皮皮虾",
    session: localStorage.getItem("ppx_sid") || "default",
    perm: localStorage.getItem("ppx_perm") || "workspace",
    theme: localStorage.getItem("ppx_theme") || "system",
    fs: Number(localStorage.getItem("ppx_fs")) || 14,
    dense: localStorage.getItem("ppx_dense") || "dense",
    queueWhenBusy: localStorage.getItem("ppx_queue") !== "0",
    wsRoot: localStorage.getItem("ppx_wsroot") || "",
    providers: [],
    defaultProvider: null,
    sessions: [],
    streaming: false,
    interrupted: false,
  };

  /* ================= 基础工具 ================= */
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ico(name, size) {
    return '<svg width="' + (size || 16) + '" height="' + (size || 16) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><use href="#i-' + name + '"/></svg>';
  }
  function toast(msg, isErr) {
    var t = document.createElement("div");
    t.className = "toast" + (isErr ? " err" : "");
    t.textContent = msg;
    $("toasts").appendChild(t);
    setTimeout(function () { t.style.opacity = "0"; t.style.transition = "opacity .25s"; }, 2600);
    setTimeout(function () { t.remove(); }, 3000);
  }
  function fmtTs(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    var now = new Date();
    var hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    if (d.toDateString() === now.toDateString()) return hm;
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
  }
  function fmtSize(n) {
    if (n == null) return "";
    if (n < 1024) return n + "B";
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + "K";
    return (n / 1048576).toFixed(1) + "M";
  }
  function renderMd(t) {
    var raw;
    try { raw = window.marked ? window.marked.parse(String(t || "")) : esc(t).replace(/\n/g, "<br>"); }
    catch (e) { raw = esc(t).replace(/\n/g, "<br>"); }
    return sanitizeHtml(raw);
  }

  /* 渲染层净化 (2026-09-17 体检修复, UX-6):
   * marked v12 对原始 HTML **原样透传**, 且不过滤 javascript: / data:text/html 链接
   * (实测: `<img src=x onerror=alert(1)>` 会原样输出)。
   * 而进入 renderMd 的文本来源不受控 —— 模型回复、read_file 读到的文件、
   * fetch_page 抓回的网页、文档解析结果都会流到这里。
   * 一旦执行脚本即可读取 localStorage.ppx_token 并调用本机 API。
   * 这里在写入 innerHTML 之前做一次白名单净化: 去掉可执行标签 / 所有 on* 事件属性 /
   * 危险协议 (http/https/mailto/tel/# 及相对路径之外一律摘除)。
   */
  var BAD_TAGS = ["script", "iframe", "frame", "frameset", "object", "embed", "applet",
    "form", "input", "button", "textarea", "select", "link", "meta", "base", "style", "template", "svg", "math"];
  var SAFE_URL = /^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/|data:image\/)/i;
  function sanitizeHtml(html) {
    try {
      var doc = new DOMParser().parseFromString("<body>" + html + "</body>", "text/html");
      var body = doc.body;
      BAD_TAGS.forEach(function (tag) {
        Array.prototype.slice.call(body.querySelectorAll(tag)).forEach(function (n) { n.remove(); });
      });
      Array.prototype.slice.call(body.querySelectorAll("*")).forEach(function (el) {
        // ① 摘掉全部事件处理器属性 + 危险的 srcdoc/style 注入面
        Array.prototype.slice.call(el.attributes).forEach(function (a) {
          var n = a.name.toLowerCase();
          if (n.indexOf("on") === 0) { el.removeAttribute(a.name); return; }
          if (n === "srcdoc") { el.removeAttribute(a.name); return; }
          // ② 链接与资源协议白名单
          if (n === "href" || n === "src" || n === "xlink:href" || n === "formaction") {
            var v = String(a.value || "").replace(/[\u0000-\u0020]/g, "");
            if (!SAFE_URL.test(v)) el.removeAttribute(a.name);
          }
        });
        // ③ 外链补 rel, 防被打开页反向控制本页
        if (el.tagName === "A" && el.getAttribute("href") && /^https?:/i.test(el.getAttribute("href"))) {
          var rel = el.getAttribute("rel") || "";
          if (rel.indexOf("noopener") < 0) el.setAttribute("rel", (rel + " noopener noreferrer").trim());
        }
      });
      return body.innerHTML;
    } catch (e) {
      // 净化失败时退回纯文本转义, 宁可丢排版也不执行脚本
      return esc(String(html || ""));
    }
  }

  /* ================= 网络 ================= */
  function headers(json) {
    var h = {};
    if (json) h["Content-Type"] = "application/json";
    if (S.token) h["Authorization"] = "Bearer " + S.token;
    return h;
  }
  function req(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign(headers(opts.body != null), opts.headers || {});
    return fetch(S.base + path, opts).then(function (r) {
      if (r.status === 401) {
        // 2026-09-17 (UX-16): token 轮换后旧值会一直卡在 localStorage 里反复撞 401,
        // 这里主动清掉, 让用户下次刷新能重新取到服务端下发的 token。
        localStorage.removeItem("ppx_token");
        S.token = "";
        throw new Error("鉴权失败 (401): token 不正确或已更换");
      }
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok) throw new Error((j && (j.error || j.message)) || ("HTTP " + r.status));
        return j;
      });
    });
  }
  function get(path) { return req(path); }
  function post(path, body) { return req(path, { method: "POST", body: JSON.stringify(body || {}) }); }

  // ---- MCP 调用 (提供方 / 设置 / 任务面板) ----
  var _mcpId = 1;
  function mcpCall(method, params) {
    var body = {
      jsonrpc: "2.0", id: _mcpId++, method: method,
      params: Object.assign({}, params || {}, {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL,
          "io.modelcontextprotocol/clientInfo": { name: "ppx-web", version: S.version },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      }),
    };
    var h = Object.assign(headers(true), {
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL,
    });
    return fetch(S.base + (BS.mcpPath || "/mcp"), { method: "POST", headers: h, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (j) {
        if (!j) throw new Error("MCP 无响应");
        if (j.error) {
          if (String(j.error.message || "").indexOf("unauthor") >= 0) throw new Error("鉴权失败: token 不正确");
          throw new Error(j.error.message || ("MCP 错误 " + j.error.code));
        }
        return j.result;
      });
  }
  function mcpTool(name, args) {
    return mcpCall("tools/call", { name: name, arguments: args || {} }).then(function (r) {
      var c = r && r.content;
      if (Array.isArray(c)) {
        var txt = c.filter(function (x) { return x && x.type === "text"; }).map(function (x) { return x.text; }).join("\n");
        if (txt) { try { return JSON.parse(txt); } catch (e) { return txt; } }
      }
      return r;
    });
  }

  /* ================= 主题 / 字号 ================= */
  function applyTheme() {
    var t = S.theme;
    if (t === "system") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", t);
    document.documentElement.style.setProperty("--fs", S.fs + "px");
    document.body.classList.toggle("dense", S.dense === "dense");
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
    if (S.theme === "system") applyTheme();
  });

  var PERMS = [
    { id: "readonly", label: "只读", desc: "只读文件与检索, 不执行命令、不改文件", patch: { allow_all: false, code_act: false } },
    { id: "workspace", label: "工作区内修改", desc: "可读写工作区文件、执行命令", patch: { allow_all: false, code_act: true } },
    { id: "full", label: "完全访问", desc: "放开命令白名单限制 (谨慎)", patch: { allow_all: true, code_act: true } },
  ];
  function permLabel() {
    for (var i = 0; i < PERMS.length; i++) if (PERMS[i].id === S.perm) return PERMS[i].label;
    return "标准模式";
  }

  /* ================= 弹出菜单 / 表单 ================= */
  var menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function openMenu(anchor, items, opts) {
    closeMenu();
    opts = opts || {};
    var m = document.createElement("div");
    m.className = "menu";
    items.forEach(function (it) {
      if (it.sep) { var sp = document.createElement("div"); sp.className = "sep"; m.appendChild(sp); return; }
      if (it.head) { var hd = document.createElement("div"); hd.className = "mh"; hd.textContent = it.head; m.appendChild(hd); return; }
      var b = document.createElement("button");
      b.className = "mi" + (it.on ? " on" : "");
      b.innerHTML = (it.icon ? '<span style="color:var(--fg3)">' + ico(it.icon, 15) + "</span>" : "") +
        '<span class="lab">' + esc(it.label) + "</span>" +
        (it.desc ? '<span class="desc">' + esc(it.desc) + "</span>" : "") +
        (it.on ? ico("check", 14) : "");
      b.onclick = function () { closeMenu(); if (it.run) it.run(); };
      m.appendChild(b);
    });
    document.body.appendChild(m);
    menuEl = m;
    var r = anchor.getBoundingClientRect();
    var mw = m.offsetWidth, mh = m.offsetHeight;
    var left = Math.min(Math.max(8, r.left), innerWidth - mw - 8);
    var top = (opts.up ? r.top - mh - 6 : r.bottom + 6);
    if (top < 8) top = r.bottom + 6;
    if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    m.style.left = left + "px";
    m.style.top = top + "px";
  }
  document.addEventListener("click", function (e) {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  });
  window.addEventListener("resize", closeMenu);
  window.addEventListener("scroll", closeMenu, true);

  // 通用表单弹窗: fields = [{k,label,type,value,placeholder,options,desc}]
  var formCtx = null;
  // 弹窗焦点管理 (2026-09-17 无障碍修复): 打开时把焦点移入弹窗, 关闭时归还给触发元素,
  // 并在弹窗内做 Tab 循环 —— 否则键盘用户 Tab 会跑到弹窗背后的页面上。
  function focusInto(mask) {
    var modal = mask.querySelector(".modal");
    var first = modal && modal.querySelector("input,select,textarea,button");
    if (first) { try { first.focus(); } catch (e) {} }
    return modal;
  }
  var lastFocus = null;
  function restoreFocus() {
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
  }
  function trapTab(mask, e) {
    if (e.key !== "Tab") return;
    var modal = mask.querySelector(".modal");
    if (!modal) return;
    var items = Array.prototype.filter.call(
      modal.querySelectorAll("button,input,select,textarea,[tabindex]:not([tabindex='-1']),a[href]"),
      function (el) { return !el.disabled && el.offsetParent !== null; }
    );
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  ["setMask", "formMask"].forEach(function (id) {
    $(id).addEventListener("keydown", function (e) { trapTab(this, e); });
  });

  function openForm(title, fields, onOk) {
    $("formTitle").textContent = title;
    var b = $("formBody");
    b.innerHTML = fields.map(function (f) {
      var l = '<div class="lbl"><div class="n">' + esc(f.label) + "</div>" + (f.desc ? '<div class="d">' + esc(f.desc) + "</div>" : "") + "</div>";
      var c;
      if (f.type === "textarea") c = '<textarea class="ta" data-k="' + f.k + '" placeholder="' + esc(f.placeholder || "") + '">' + esc(f.value || "") + "</textarea>";
      else if (f.type === "select") c = '<select class="sel" data-k="' + f.k + '">' + (f.options || []).map(function (o) {
        return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(f.value) ? " selected" : "") + ">" + esc(o.label) + "</option>";
      }).join("") + "</select>";
      else if (f.type === "switch") c = '<button class="switch' + (f.value ? " on" : "") + '" data-k="' + f.k + '"></button>';
      else c = '<input class="txt" data-k="' + f.k + '" type="' + (f.type || "text") + '" value="' + esc(f.value == null ? "" : f.value) + '" placeholder="' + esc(f.placeholder || "") + '">';
      return f.type === "textarea" ? '<div class="setrow col">' + l + '<div class="ctl">' + c + "</div></div>"
        : '<div class="setrow">' + l + '<div class="ctl">' + c + "</div></div>";
    }).join("");
    b.querySelectorAll(".switch").forEach(function (sw) {
      sw.onclick = function () { sw.classList.toggle("on"); };
    });
    formCtx = { onOk: onOk };
    lastFocus = document.activeElement;
    $("formMask").classList.add("show");
    focusInto($("formMask"));
  }
  function formValues() {
    var out = {};
    $("formBody").querySelectorAll("[data-k]").forEach(function (el) {
      var k = el.getAttribute("data-k");
      if (el.classList.contains("switch")) out[k] = el.classList.contains("on");
      else out[k] = el.value;
    });
    return out;
  }
  function closeForm() { $("formMask").classList.remove("show"); formCtx = null; restoreFocus(); }
  $("btnFormClose").onclick = closeForm;
  $("btnFormCancel").onclick = closeForm;
  $("btnFormOk").onclick = function () {
    if (!formCtx) return;
    try { var r = formCtx.onOk(formValues()); if (r !== false) closeForm(); } catch (e) { toast(e.message, true); }
  };
  $("formMask").addEventListener("click", function (e) { if (e.target === $("formMask")) closeForm(); });

  /* ================= 连接状态 ================= */
  function setConn(state, text) {
    var c = $("conn");
    c.className = "conn" + (state ? " " + state : "");
    c.querySelector(".txt").textContent = text;
  }
  function checkHealth() {
    return get("/health").then(function (j) {
      setConn("ok", "内核在线 · v" + (j.version || S.version));
      return j;
    }).catch(function (e) {
      setConn("bad", S.tokenRequired && !S.token ? "需要 token" : "未连接");
      throw e;
    });
  }

  /* ================= 会话 ================= */
  // 自动生成的会话 key (s_<base36时间戳><随机>) 对用户没有可读性, 统一显示为「新会话」
  function isAutoKey(k) { return /^s_[0-9a-z]{6,}$/.test(String(k || "")); }
  function sessionTitle(key) {
    for (var i = 0; i < S.sessions.length; i++) if (S.sessions[i].key === key) return S.sessions[i].title || S.sessions[i].key;
    if (key === "default" || isAutoKey(key)) return "新会话";
    return key;
  }
  function loadSessions() {
    return get("/sessions").then(function (j) {
      S.sessions = (j && j.sessions) || [];
      renderSessions();
      $("tbTitle").textContent = sessionTitle(S.session);
      // 首次进入: 没有落盘会话则用 default
      if (!S.sessions.length && !localStorage.getItem("ppx_sid")) S.session = "default";
    }).catch(function () {
      $("sessList").innerHTML = '<div class="hint">会话服务不可用</div>';
    });
  }
  var sessFilter = "";
  function renderSessions() {
    var el = $("sessList");
    var list = S.sessions.slice().sort(function (a, b) { return (b.lastTs || 0) - (a.lastTs || 0); });
    if (sessFilter) list = list.filter(function (s) { return (s.title || s.key).toLowerCase().indexOf(sessFilter) >= 0; });
    if (!list.length) {
      el.innerHTML = '<div class="hint">' + (sessFilter ? "无匹配会话" : "暂无历史会话") + "</div>";
      return;
    }
    el.innerHTML = list.map(function (s) {
      var on = s.key === S.session ? " active" : "";
      return '<div class="nav' + on + '" data-k="' + esc(s.key) + '">' +
        '<span class="ico">' + ico("activity", 14) + "</span>" +
        '<span class="lab">' + esc(s.title || s.key) + "</span>" +
        '<span class="sub">' + (s.count || 0) + " 条</span>" +
        '<span class="acts">' +
        '<button class="icobtn sm" data-act="ren" title="重命名">' + ico("edit", 13) + "</button>" +
        '<button class="icobtn sm" data-act="del" title="删除">' + ico("trash", 13) + "</button>" +
        "</span></div>";
    }).join("");
    el.querySelectorAll(".nav").forEach(function (n) {
      var key = n.getAttribute("data-k");
      n.onclick = function (e) {
        var act = e.target.closest("[data-act]");
        if (act) {
          e.stopPropagation();
          if (act.getAttribute("data-act") === "ren") renameSession(key);
          else delSession(key);
          return;
        }
        switchSession(key);
      };
    });
  }
  function newSession() {
    S.session = "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    localStorage.setItem("ppx_sid", S.session);
    clearStream();
    renderSessions();
    $("tbTitle").textContent = "新会话";
    $("inp").focus();
  }
  function switchSession(key) {
    if (S.streaming) { toast("正在生成, 请先停止", true); return; }
    S.session = key;
    localStorage.setItem("ppx_sid", key);
    renderSessions();
    $("tbTitle").textContent = sessionTitle(key);
    loadHistory(key);
  }
  function renameSession(key) {
    openForm("重命名会话", [{ k: "title", label: "新名称", value: sessionTitle(key), placeholder: "给这个会话起个名字" }], function (v) {
      var to = (v.title || "").trim();
      if (!to || to === key) return false;
      post("/sessions/rename", { from: key, to: to }).then(function () {
        if (S.session === key) { S.session = to; localStorage.setItem("ppx_sid", to); }
        toast("已重命名");
        loadSessions();
      }).catch(function (e) { toast("重命名失败: " + e.message, true); });
    });
  }
  function delSession(key) {
    openForm("删除会话", [{ k: "ok", label: "确认删除「" + sessionTitle(key) + "」?", desc: "该会话的历史将不可恢复", type: "switch", value: false }], function (v) {
      if (!v.ok) return false;
      post("/sessions/delete", { key: key }).then(function () {
        if (S.session === key) newSession();
        toast("已删除");
        loadSessions();
      }).catch(function (e) { toast("删除失败: " + e.message, true); });
    });
  }

  /* ================= 工作区文件树 ================= */
  function loadWorkspace() {
    var el = $("wsList");
    el.innerHTML = '<div class="hint">加载中…</div>';
    var q = "/api/workspace/tree?maxDepth=1" + (S.wsRoot ? "&root=" + encodeURIComponent(S.wsRoot) : "");
    return get(q).then(function (j) {
      var t = (j && j.tree) || { children: [] };
      var kids = t.children || [];
      if (!kids.length) { el.innerHTML = '<div class="hint">目录为空</div>'; return; }
      el.innerHTML = kids.map(function (n) {
        var icon = n.type === "dir" ? "folder" : "file";
        return '<div class="nav" data-path="' + esc(n.path) + '" data-type="' + n.type + '">' +
          '<span class="ico">' + ico(icon, 14) + "</span>" +
          '<span class="lab">' + esc(n.name) + "</span>" +
          (n.type === "file" ? '<span class="sub">' + fmtSize(n.size) + "</span>" : "") +
          "</div>";
      }).join("");
      el.querySelectorAll(".nav").forEach(function (n) {
        n.onclick = function () {
          var p = n.getAttribute("data-path");
          if (n.getAttribute("data-type") === "dir") {
            S.wsRoot = p;
            localStorage.setItem("ppx_wsroot", p);
            $("wsLabel").textContent = p.split("/").pop() || "工作区";
            loadWorkspace();
          } else {
            previewFile(p);
          }
        };
      });
      $("wsLabel").textContent = S.wsRoot ? (S.wsRoot.split("/").pop() || "工作区") : "工作区";
    }).catch(function (e) {
      el.innerHTML = '<div class="hint">' + esc(e.message) + "</div>";
    });
  }
  function previewFile(p) {
    $("drawer").classList.add("open");
    var body = $("drawerBody");
    body.innerHTML = '<div class="hint">读取中…</div>';
    get("/api/workspace/read?path=" + encodeURIComponent(p)).then(function (j) {
      body.innerHTML = '<div class="card"><div class="ct">文件 · ' + esc(p) + "</div>" +
        '<div class="cc" style="font-family:var(--mono);font-size:11.5px;white-space:pre-wrap;max-height:60vh;overflow:auto">' +
        esc((j.content || "").slice(0, 6000)) + (j.truncated ? "\n\n… (已截断)" : "") + "</div></div>";
    }).catch(function (e) { body.innerHTML = '<div class="hint">读取失败: ' + esc(e.message) + "</div>"; });
  }

  /* ================= 对话流 ================= */
  var col = $("col"), streamEl = $("stream"), heroEl = $("hero");
  var toolCards = {}, toolSeq = 0;

  function clearStream() {
    col.innerHTML = "";
    toolCards = {};
    streamEl.hidden = true;
    heroEl.hidden = false;
  }
  function ensureStream() {
    if (!heroEl.hidden) { heroEl.hidden = true; streamEl.hidden = false; }
  }
  function atBottom() { return streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 90; }
  function toBottom(force) { if (force || atBottom()) streamEl.scrollTop = streamEl.scrollHeight; }

  function addMsg(role, text) {
    ensureStream();
    var wrap = document.createElement("div");
    wrap.className = "msg " + role;
    var av = role === "user" ? "你" : (role === "err" ? "!" : "虾");
    if (role === "err") wrap.className = "msg err";
    wrap.innerHTML =
      '<div class="av">' + esc(role === "agent" ? (S.agentName[0] || "虾") : av) + "</div>" +
      '<div class="body"></div>';
    var body = wrap.querySelector(".body");
    if (role === "agent") body.innerHTML = renderMd(text);
    else body.textContent = text;
    col.appendChild(wrap);
    toBottom(true);
    return body;
  }
  function addTool(ev) {
    ensureStream();
    // 2026-09-17 修复 (UX-5): 优先用后端下发的唯一 callId 配对起止事件。
    // 旧实现只能按"工具名"回填, 同一轮里出现两个同名工具 (如两次 read_file) 时结果会贴错卡片。
    var id = ev.id || (ev.tool + "#" + (++toolSeq));
    var open = S.dense !== "dense";
    var d = document.createElement("details");
    d.className = "tool run";
    if (open) d.open = true;
    d.innerHTML =
      "<summary>" +
      '<span class="tstat"><i class="d"></i></span>' +
      '<span class="tname">' + esc(ev.tool) + "</span>" +
      '<span class="targs">' + esc(JSON.stringify(ev.args || {})).slice(0, 160) + "</span>" +
      "</summary>" +
      '<div class="tbody">调用中…</div>';
    col.appendChild(d);
    toBottom(true);
    toolCards[id] = { el: d, tool: ev.tool, t0: Date.now() };
    d.setAttribute("data-tool", ev.tool);
    if (ev.id) d.setAttribute("data-callid", ev.id);
    return d;
  }
  function finishTool(ev) {
    var key = null;
    if (ev.id && toolCards[ev.id]) {
      key = ev.id; // 精确配对 (首选)
    } else {
      // 兼容旧服务端: 无 id 时按工具名回填最后一个未完成的
      Object.keys(toolCards).forEach(function (k) {
        if (!key && toolCards[k].tool === ev.tool && toolCards[k].el.classList.contains("run")) key = k;
      });
    }
    if (!key) return;
    var c = toolCards[key];
    c.el.classList.remove("run");
    c.el.classList.add(ev.ok ? "ok" : "fail");
    var st = c.el.querySelector(".tstat");
    st.innerHTML = '<i class="d"></i>' + (ev.ok ? "完成" : "失败") + (ev.durationMs != null ? " · " + ev.durationMs + "ms" : "");
    var tb = c.el.querySelector(".tbody");
    tb.textContent = ev.result != null ? String(ev.result) : (ev.ok ? "已完成 (无回显)" : "调用失败");
    delete toolCards[key];
    toBottom();
  }
  var stepEl = null;
  function setStep(ev) {
    ensureStream();
    if (!stepEl) {
      stepEl = document.createElement("div");
      stepEl.className = "step";
      col.appendChild(stepEl);
    }
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
    $("footNote").textContent = on ? "生成中… Esc 停止 · Enter 排队追加" : "Enter 发送 · Shift+Enter 换行 · Esc 停止生成";
  }

  function send() {
    var t = $("inp").value.trim();
    if (!t) return;
    if (S.streaming) {
      if (!S.queueWhenBusy) { stopGen(); }
      else { pendingQueue.push(t); $("inp").value = ""; autosize(); toast("已排入队列"); return; }
    }
    $("inp").value = "";
    autosize();
    doSend(t);
  }
  var pendingQueue = [];
  function doSend(t) {
    addMsg("user", t);
    var body = addMsg("agent", "");
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
              else if (j.type === "done") { full = j.content || full; clearStep(); body.innerHTML = renderMd(full); }
              else if (j.type === "tool") { if (j.status === "start") addTool(j); else finishTool(j); }
              else if (j.type === "step") { setStep(j); }
              else if (j.type === "error") { clearStep(); body.textContent = "错误: " + (j.error || "未知"); }
            });
          }
          toBottom();
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      if (!full) body.textContent = "";
      var m = document.createElement("div");
      m.className = "msg err";
      m.innerHTML = '<div class="av">!</div><div class="body">' + esc(e.message) + "</div>";
      col.appendChild(m);
      toBottom(true);
    }).finally(function () {
      clearStep();
      setBusy(false);
      loadSessions();
      if (pendingQueue.length) {
        var n = pendingQueue.shift();
        doSend(n);
      }
    });
  }
  function stopGen() {
    S.interrupted = true;
    post("/interrupt", { sessionId: S.session }).catch(function () {});
    toast("已请求停止");
  }

  function loadHistory(key) {
    get("/sessions/" + encodeURIComponent(key) + "/history").then(function (j) {
      var msgs = (j && j.messages) || [];
      clearStream();
      if (!msgs.length) { return; }
      heroEl.hidden = true; streamEl.hidden = false;
      msgs.forEach(function (m) {
        var role = m.role === "user" ? "user" : "agent";
        addMsg(role, m.content || m.text || "");
      });
      toBottom(true);
    }).catch(function () { clearStream(); });
  }

  /* ================= 侧栏折叠 ================= */
  // 2026-09-17 体检修复 (P0-4): HTML 里有 #btnCollapse / #btnSide 两个按钮,
  // CSS 里也有 .side.collapsed 规则, 但 app.js 从未绑定任何事件 —— 点"收起侧栏"毫无反应。
  // 顺手补上状态持久化, 刷新后保持用户选择。
  function setSide(collapsed) {
    $("side").classList.toggle("collapsed", !!collapsed);
    $("btnSide").hidden = !collapsed;
    $("btnCollapse").setAttribute("aria-expanded", collapsed ? "false" : "true");
    localStorage.setItem("ppx_side", collapsed ? "1" : "0");
  }
  $("btnCollapse").onclick = function () { setSide(true); };
  $("btnSide").onclick = function () { setSide(false); };

  /* ================= 输入区 ================= */
  var inp = $("inp");

  /* ================= @ 引用文件 ================= */
  // 2026-09-17 体检修复 (UX-2): 输入框此前已经在 placeholder 里承诺"（@ 引用文件）",
  // 但代码里根本没有 @ 解析 —— 用户按提示敲 @ 什么都不会发生。这里把它真正实现:
  // 输入 @ 或 @前缀 时弹出工作区文件候选 (复用 /api/workspace/tree), 方向键选择, Enter 插入路径。
  var mention = (function () {
    var el = null, items = [], idx = 0, at = -1, seq = 0;
    var INDEX_TTL = 15000; // 文件索引缓存 15s, 避免每次敲字都打接口
    var index = null, indexAt = 0;

    function flatten(node, out, prefix, depth) {
      if (!node || depth > 6 || out.length > 800) return out;
      var kids = node.children || [];
      for (var i = 0; i < kids.length; i++) {
        var n = kids[i];
        var p = n.path || (prefix ? prefix + "/" + n.name : n.name);
        if (n.type === "dir") flatten(n, out, p, depth + 1);
        else out.push(p);
      }
      return out;
    }
    function loadIndex() {
      var now = Date.now();
      if (index && now - indexAt < INDEX_TTL) return Promise.resolve(index);
      var q = "/api/workspace/tree?maxDepth=5" + (S.wsRoot ? "&root=" + encodeURIComponent(S.wsRoot) : "");
      return get(q).then(function (j) {
        index = flatten((j && j.tree) || { children: [] }, [], "", 0).sort();
        indexAt = Date.now();
        return index;
      }).catch(function () { index = []; indexAt = Date.now(); return index; });
    }
    function currentQuery() {
      var pos = inp.selectionStart;
      if (pos == null) return null;
      var before = inp.value.slice(0, pos);
      // @ 片段: 行首或空白之后的 @ 到行尾 (不含空白/@), 字符类里不放括号, 保证圆括号配平
      var m = before.match(/(?:^|\s)@([^\s@]*)$/);
      return m ? { q: m[1], start: pos - m[1].length - 1 } : null;
    }
    function pos() {
      var r = $("composer").getBoundingClientRect();
      return {
        left: Math.max(8, r.left + 12),
        width: Math.max(260, Math.min(r.width - 24, 420)),
        bottom: Math.max(8, innerHeight - r.top + 8),
      };
    }
    function render() {
      if (!el) return;
      var p = pos();
      el.style.left = p.left + "px";
      el.style.width = p.width + "px";
      el.style.bottom = p.bottom + "px";
      el.style.top = "auto";
      el.innerHTML = '<div class="mh">引用工作区文件</div>' + items.map(function (f, i) {
        return '<button class="mi' + (i === idx ? " on" : "") + '" data-i="' + i + '">' +
          '<span class="ico">' + ico("file", 14) + '</span><span class="lab">' + esc(f) + "</span></button>";
      }).join("");
      el.querySelectorAll(".mi").forEach(function (b) {
        b.onmousedown = function (e) { e.preventDefault(); pick(Number(b.getAttribute("data-i"))); };
      });
      var on = el.querySelector(".mi.on");
      if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
    }
    function open(list, startPos) {
      at = startPos;
      items = list.slice(0, 14);
      idx = 0;
      if (!el) {
        el = document.createElement("div");
        el.className = "menu mention";
        el.setAttribute("role", "listbox");
        document.body.appendChild(el);
      }
      render();
    }
    function close() { if (el) { el.remove(); el = null; } items = []; at = -1; }
    function isOpen() { return !!el; }
    function pick(i) {
      var f = items[i];
      if (f == null) return;
      var posn = inp.selectionStart;
      var before = inp.value.slice(0, at);
      var after = inp.value.slice(posn);
      inp.value = before + f + " " + after;
      var caret = before.length + f.length + 1;
      inp.focus();
      try { inp.setSelectionRange(caret, caret); } catch (e) {}
      close();
      autosize();
      inp.dispatchEvent(new Event("input"));
    }
    function handleKey(e) {
      if (!el) return false;
      if (e.key === "ArrowDown") { e.preventDefault(); idx = (idx + 1) % items.length; render(); return true; }
      if (e.key === "ArrowUp") { e.preventDefault(); idx = (idx - 1 + items.length) % items.length; render(); return true; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(idx); return true; }
      if (e.key === "Escape") { e.preventDefault(); close(); return true; }
      return false;
    }
    // 由 input 事件驱动: 判断当前是否处在 @ 片段里
    function sync() {
      var cur = currentQuery();
      if (!cur) { close(); return; }
      var mySeq = ++seq;
      loadIndex().then(function (all) {
        if (mySeq !== seq) return; // 已有更新的输入, 丢弃这次结果
        var q = cur.q.toLowerCase();
        var hits = q ? all.filter(function (f) { return f.toLowerCase().indexOf(q) >= 0; }) : all;
        if (!hits.length) { close(); return; }
        open(hits, cur.start);
      });
    }
    window.addEventListener("resize", function () { if (el) render(); });
    return { sync: sync, handleKey: handleKey, isOpen: isOpen, close: close };
  })();
  function syncMention() { try { mention.sync(); } catch (e) {} }

  document.addEventListener("click", function (e) {
    if (mention.isOpen() && !e.target.closest(".menu.mention")) mention.close();
  });

  function autosize() {
    inp.style.height = "auto";
    inp.style.height = Math.min(inp.scrollHeight, 190) + "px";
  }
  inp.addEventListener("input", function () { autosize(); if (!S.streaming) $("btnSend").disabled = !inp.value.trim(); syncMention(); });
  inp.addEventListener("keydown", function (e) {
    if (mention.handleKey(e)) return; // @ 引用文件菜单优先消费方向键/Enter/Esc
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (mention.isOpen()) { mention.close(); return; }
      if ($("formMask").classList.contains("show")) { closeForm(); return; }
      if ($("setMask").classList.contains("show")) { closeSet(); return; }
      if (menuEl) { closeMenu(); return; }
      if (S.streaming) stopGen();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); newSession(); }
    if ((e.ctrlKey || e.metaKey) && e.key === ",") { e.preventDefault(); openSet("general"); }
  });
  $("btnSend").onclick = function () { if (S.streaming) stopGen(); else send(); };
  $("btnNew").onclick = function () { if (S.streaming) { toast("正在生成, 请先停止", true); return; } newSession(); };
  $("btnPlus").onclick = function (e) {
    openMenu(e.currentTarget, [
      { head: "快捷操作" },
      { label: "新建会话", icon: "plus", run: newSession },
      { label: "清空当前会话上下文", icon: "refresh", run: function () {
        post("/reset", { sessionId: S.session }).then(function () { clearStream(); toast("上下文已清空"); });
      } },
      { sep: true },
      { label: "刷新工作区", icon: "folder-open", run: loadWorkspace },
      { label: "打开面板", icon: "panel", run: function () { $("drawer").classList.add("open"); } },
      { label: "打开设置", icon: "settings", run: function () { openSet("general"); } },
    ], { up: true });
  };

  // 模型 chip
  function loadProviders() {
    return get("/api/providers").then(function (j) {
      S.providers = (j && j.providers) || [];
      S.defaultProvider = (j && j.default_id) || (S.providers[0] && S.providers[0].id) || null;
      renderModelChip();
    }).catch(function () { $("modelLabel").textContent = "模型不可用"; });
  }
  function providerById(id) { for (var i = 0; i < S.providers.length; i++) if (S.providers[i].id === id) return S.providers[i]; return null; }
  function renderModelChip() {
    var p = providerById(S.defaultProvider) || S.providers[0];
    $("modelLabel").textContent = p ? (p.id + " · " + (p.model || "?")) : "未配置模型";
  }
  $("chipModel").onclick = function (e) {
    var items = S.providers.map(function (p) {
      return {
        label: p.id, desc: p.model || "", on: p.id === S.defaultProvider, icon: "cube",
        run: function () {
          var order = [p.id].concat(S.providers.map(function (x) { return x.id; }).filter(function (x) { return x !== p.id; }));
          mcpTool("ppx.providers.reorder", { order: order }).then(function () {
            S.defaultProvider = p.id;
            renderModelChip();
            toast("已切换到 " + p.id);
          }).catch(function (er) { toast("切换失败: " + er.message, true); });
        },
      };
    });
    if (!items.length) items = [{ label: "尚未配置提供方", run: function () { openSet("model"); } }];
    items.push({ sep: true });
    items.push({ label: "管理模型…", icon: "settings", run: function () { openSet("model"); } });
    openMenu(e.currentTarget, items, { up: true });
  };

  // 权限 chip
  $("chipPerm").onclick = function (e) {
    openMenu(e.currentTarget, PERMS.map(function (p) {
      return {
        label: p.label, on: p.id === S.perm, icon: "check",
        run: function () {
          S.perm = p.id;
          localStorage.setItem("ppx_perm", p.id);
          $("permLabel").textContent = p.label;
          mcpTool("ppx.settings.update", { patch: { security: p.patch } }).then(function () {
            toast("权限模式: " + p.label);
          }).catch(function (er) { toast("设置失败: " + er.message, true); });
        },
      };
    }), { up: true });
  };

  // 工作区 chip
  function wsMenu(anchor) {
    var items = [{ label: "项目根目录", on: !S.wsRoot, icon: "folder", run: function () {
      S.wsRoot = ""; localStorage.setItem("ppx_wsroot", ""); loadWorkspace();
    } }];
    items.push({ sep: true });
    items.push({ label: "自定义目录…", icon: "edit", run: function () {
      openForm("切换工作区目录", [{ k: "root", label: "相对项目根的目录", value: S.wsRoot, placeholder: "例如 src 或 web/src (留空 = 项目根)" }], function (v) {
        S.wsRoot = (v.root || "").trim();
        localStorage.setItem("ppx_wsroot", S.wsRoot);
        loadWorkspace();
      });
    } });
    items.push({ label: "在面板中打开…", icon: "panel", run: function () { $("drawer").classList.add("open"); setDrawerTab("env"); } });
    openMenu(anchor, items, { up: true });
  }
  $("chipWs").onclick = function (e) { wsMenu(e.currentTarget); };
  $("btnWsRoot").onclick = function (e) { wsMenu(e.currentTarget); };

  // 工具 chip
  $("chipTools").onclick = function (e) {
    mcpTool("ppx.settings.get").then(function (r) {
      var st = (r && r.settings) || {};
      var disabled = (st.tools && st.tools.disabled) || [];
      openForm("工具开关", [
        { k: "disabled", label: "禁用的工具", type: "textarea", value: disabled.join(", "), desc: "逗号分隔; 留空 = 全部启用", placeholder: "run_command, write_file" },
      ], function (v) {
        var arr = (v.disabled || "").split(/[,，\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
        mcpTool("ppx.settings.update", { patch: { tools: { disabled: arr } } }).then(function () {
          $("toolsLabel").textContent = arr.length ? "工具 " + (arr.length) + " 禁用" : "工具";
          toast(arr.length ? "已禁用 " + arr.length + " 个工具" : "已启用全部工具");
        }).catch(function (er) { toast("保存失败: " + er.message, true); });
      });
    }).catch(function () { toast("读取设置失败", true); });
  };
  $("chipTools").oncontextmenu = function (e) { e.preventDefault(); };

  /* ================= 抽屉面板 ================= */
  var dtabNow = "memory";
  function setDrawerTab(p, cb) {
    dtabNow = p;
    document.querySelectorAll(".dtab").forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-p") === p); });
    loadDrawer(p).then(cb || function () {});
  }
  document.querySelectorAll(".dtab").forEach(function (t) {
    t.onclick = function () { setDrawerTab(t.getAttribute("data-p")); };
  });
  $("btnDrawer").onclick = function () { $("drawer").classList.toggle("open"); if ($("drawer").classList.contains("open")) setDrawerTab(dtabNow); };
  $("btnDrawerClose").onclick = function () { $("drawer").classList.remove("open"); };

  function kv(k, v, tag) {
    return '<div class="kv"><span class="k">' + esc(k) + "</span><span class=\"v\">" + esc(v) + (tag || "") + "</span></div>";
  }
  function loadDrawer(p) {
    var b = $("drawerBody");
    b.innerHTML = '<div class="hint">加载中…</div>';
    if (p === "memory") return get("/api/memory").then(function (j) {
      var scenes = (j && j.scenes) || [], facts = (j && j.facts) || [];
      var h = '<div class="card"><div class="ct">场景 · ' + scenes.length + "</div>";
      h += scenes.length ? scenes.map(function (s) {
        return '<div style="padding:7px 0;border-bottom:1px solid var(--line)"><div style="font-size:12.5px;font-weight:500">' + esc(s.name || "未命名") +
          '<span class="tag plain">' + esc(s.mode === "manual" ? "自定义" : "自动") + "</span></div>" +
          '<div class="cc" style="color:var(--fg2);margin-top:3px">' + esc(s.description || "—") + "</div>" +
          (s.canHelp ? '<div class="cc" style="color:var(--accent);margin-top:3px">能帮: ' + esc(s.canHelp) + "</div>" : "") + "</div>";
      }).join("") : '<div class="hint">暂无场景</div>';
      h += "</div>";
      h += '<div class="card"><div class="ct">关键事实 · ' + facts.length + "</div>";
      h += facts.length ? facts.map(function (f) {
        return '<div style="padding:6px 0;border-bottom:1px solid var(--line);font-size:12.5px">' + esc(f.content) + "</div>";
      }).join("") : '<div class="hint">暂无事实</div>';
      h += "</div>";
      b.innerHTML = h;
    }).catch(function (e) { b.innerHTML = '<div class="hint">' + esc(e.message) + "</div>"; });

    if (p === "traces") return get("/api/traces?limit=60").then(function (j) {
      var list = j || [];
      if (!list.length) { b.innerHTML = '<div class="hint">暂无工具轨迹</div>'; return; }
      b.innerHTML = list.map(function (t) {
        return '<div class="card hoverable"><div class="ct">' + esc(t.tool) +
          '<span class="tag ' + (t.ok ? "ok" : "fail") + '">' + (t.ok ? "OK" : "FAIL") + "</span>" +
          (t.durationMs != null ? '<span class="tag plain">' + t.durationMs + "ms</span>" : "") + "</div>" +
          '<div class="cc" style="font-family:var(--mono);font-size:11px;color:var(--fg2)">' + esc(String(t.args || "").slice(0, 220)) + "</div></div>";
      }).join("");
    }).catch(function (e) { b.innerHTML = '<div class="hint">' + esc(e.message) + "</div>"; });

    if (p === "stats") return get("/api/stats").then(function (j) {
      j = j || {};
      var mem = j.memory || {};
      var h = '<div class="card"><div class="ct">运行</div>' +
        kv("工具调用", String(j.count == null ? "—" : j.count)) +
        kv("失败", String(j.failed == null ? "—" : j.failed)) +
        kv("失败率", String(j.failRate == null ? "—" : j.failRate)) +
        (j.agent ? kv("模式", j.agent.mode || "—") + kv("模型通道", j.agent.llm || "—") : "") + "</div>";
      if (mem.l0 || mem.l1) {
        h += '<div class="card"><div class="ct">记忆分层</div>' +
          (mem.l0 ? kv("L0 事件", String(mem.l0.events_total == null ? "—" : mem.l0.events_total)) + kv("L0 会话", String(mem.l0.sessions == null ? "—" : mem.l0.sessions)) : "") +
          (mem.l1 ? kv("L1 事实", (mem.l1.live == null ? "—" : mem.l1.live) + " / " + (mem.l1.total == null ? "—" : mem.l1.total)) : "") +
          "</div>";
      }
      if ((j.slowTools || []).length) {
        h += '<div class="card"><div class="ct">慢工具 Top</div>' + j.slowTools.map(function (s) {
          return kv(s.tool, s.avgMs + "ms");
        }).join("") + "</div>";
      }
      b.innerHTML = h;
    }).catch(function (e) { b.innerHTML = '<div class="hint">' + esc(e.message) + "</div>"; });

    if (p === "tasks") return mcpTool("ppx.task.list").then(function (r) {
      var list = (r && (r.tasks || r.items)) || (Array.isArray(r) ? r : []);
      if (!list.length) { b.innerHTML = '<div class="hint">暂无定时任务</div>'; return; }
      b.innerHTML = list.map(function (t) {
        var n = (t.steps || []).length;
        return '<div class="card hoverable"><div class="ct">' + esc(t.title || t.name || t.id) +
          '<span class="tag ' + (t.status === "done" ? "ok" : t.status === "failed" ? "fail" : "warn") + '">' + esc(t.status || "todo") + "</span></div>" +
          '<div class="cc" style="color:var(--fg2)">' + (n ? n + " 个步骤" : esc(t.goal || t.description || "")) + "</div></div>";
      }).join("");
    }).catch(function (e) { b.innerHTML = '<div class="hint">任务面板暂不可用: ' + esc(e.message) + "</div>"; });

    if (p === "env") return Promise.all([
      get("/health").catch(function () { return {}; }),
      get("/api/lifecycle").catch(function () { return {}; }),
      get("/api/proactive").catch(function () { return {}; }),
    ]).then(function (rs) {
      var health = rs[0] || {}, life = rs[1] || {}, pro = rs[2] || {};
      var h = '<div class="card"><div class="ct">内核</div>' +
        kv("版本", health.version || S.version) +
        kv("智能体", health.agent || S.agentName) +
        kv("端口", String(BS.port || location.port || "—")) +
        kv("MCP 端点", health.mcp || "—") +
        kv("运行时长", health.uptime_ms != null ? Math.round(health.uptime_ms / 1000) + "s" : "—") +
        kv("认证", S.tokenRequired ? (S.token ? "已就绪" : "缺 token") : "未启用") + "</div>";
      var lifeKeys = Object.keys(life || {});
      if (lifeKeys.length) {
        h += '<div class="card"><div class="ct">生命周期</div>' + lifeKeys.map(function (k) {
          var v = life[k];
          return kv(k, typeof v === "object" ? JSON.stringify(v).slice(0, 80) : String(v));
        }).join("") + "</div>";
      }
      if (pro.items && pro.items.length) {
        h += '<div class="card"><div class="ct">主动提醒</div>' + pro.items.map(function (it) {
          return '<div class="cc" style="padding:4px 0">· ' + esc(it.text || it.title || JSON.stringify(it)) + "</div>";
        }).join("") + "</div>";
      }
      b.innerHTML = h;
    }).catch(function (e) { b.innerHTML = '<div class="hint">' + esc(e.message) + "</div>"; });
  }

  /* ================= 设置 ================= */
  var setTab = "general";
  function openSet(tab) { setTab = tab || "general"; lastFocus = document.activeElement; $("setMask").classList.add("show"); renderSet(); focusInto($("setMask")); }
  function closeSet() { $("setMask").classList.remove("show"); restoreFocus(); }
  $("btnSettings").onclick = function () { openSet("general"); };
  $("btnSettings2").onclick = function () { openSet("general"); };
  $("btnSetClose").onclick = closeSet;
  $("setMask").addEventListener("click", function (e) { if (e.target === $("setMask")) closeSet(); });
  $("btnOpenCfg").onclick = function () {
    var p = (BS.root || "") + "";
    toast("配置文件: config/ppx.json · 设置目录: " + (location.host));
    get("/api/settings").then(function (j) {
      openForm("当前配置 (只读快照)", [{ k: "json", label: "config/ppx.json 生效值", type: "textarea", value: JSON.stringify(j && j.settings, null, 2) }], function () {});
    });
  };
  document.querySelectorAll(".mrow").forEach(function (m) {
    m.onclick = function () {
      setTab = m.getAttribute("data-s");
      document.querySelectorAll(".mrow").forEach(function (x) { x.classList.toggle("active", x === m); });
      renderSet();
    };
  });

  var setCache = null;
  function renderSet() {
    document.querySelectorAll(".mrow").forEach(function (x) { x.classList.toggle("active", x.getAttribute("data-s") === setTab); });
    var body = $("setBody");
    var titles = { general: "通用设置", model: "模型", plugin: "插件", agent: "Agent 预设", about: "关于 / 体检" };
    $("setTitle").textContent = titles[setTab] || "设置";
    if (setTab === "general") return renderGeneral(body);
    if (setTab === "model") return renderModel(body);
    if (setTab === "plugin") return renderPlugin(body);
    if (setTab === "agent") return renderAgent(body);
    return renderAbout(body);
  }
  function savePatch(patch, msg) {
    return mcpTool("ppx.settings.update", { patch: patch }).then(function () {
      toast(msg || "已保存");
      if (msg === undefined) setCache = null;
      return true;
    }).catch(function (e) { toast("保存失败: " + e.message, true); return false; });
  }

  function renderGeneral(body) {
    body.innerHTML = '<div class="hint">加载中…</div>';
    get("/api/settings").then(function (j) {
      var st = (j && j.settings) || {};
      setCache = st;
      var sec = st.security || {};
      var cur = st.tools && st.tools.disabled ? st.tools.disabled.length : 0;
      body.innerHTML =
        '<div class="setrow"><div class="lbl"><div class="n">权限</div><div class="d">选择新会话的默认权限模式 (写入 config/ppx.json 的 security 段)</div></div>' +
        '<div class="ctl"><select class="sel" id="sPerm">' + PERMS.map(function (p) {
          return '<option value="' + p.id + '"' + (p.id === S.perm ? " selected" : "") + ">" + p.label + "</option>";
        }).join("") + "</select></div></div>" +

        '<div class="setrow"><div class="lbl"><div class="n">语言</div><div class="d">界面语言 (当前仅提供简体中文)</div></div>' +
        '<div class="ctl"><select class="sel" disabled><option>中文</option></select></div></div>' +

        '<div class="setrow col"><div class="lbl"><div class="n">外观</div><div class="d">切换界面配色, 立即生效并记住选择</div></div>' +
        '<div class="ctl"><div class="themes">' +
        [["light", "sun", "浅色"], ["dark", "moon", "深色"], ["system", "monitor", "跟随系统"]].map(function (t) {
          return '<button class="theme-opt' + (S.theme === t[0] ? " active" : "") + '" data-theme="' + t[0] + '">' + ico(t[1], 20) + "<span>" + t[2] + "</span></button>";
        }).join("") + "</div></div></div>" +

        '<div class="setrow"><div class="lbl"><div class="n">字号大小</div><div class="d">仅影响对话内容的字号</div></div>' +
        '<div class="ctl"><input class="txt" id="sFs" type="number" min="12" max="20" value="' + S.fs + '" style="width:74px"><span style="font-size:12px;color:var(--fg3)">px</span></div></div>' +

        '<div class="setrow"><div class="lbl"><div class="n">对话显示</div><div class="d">控制工具调用卡片的默认展开方式</div></div>' +
        '<div class="ctl"><select class="sel" id="sDense"><option value="dense"' + (S.dense === "dense" ? " selected" : "") + ">紧凑</option>" +
        '<option value="comfy"' + (S.dense !== "dense" ? " selected" : "") + ">舒适 (展开)</option></select></div></div>" +

        '<div class="setrow"><div class="lbl"><div class="n">繁忙时的发送行为</div><div class="d">生成中按 Enter 的行为: 排队发送, 或先中断再发送</div></div>' +
        '<div class="ctl"><select class="sel" id="sQueue"><option value="1"' + (S.queueWhenBusy ? " selected" : "") + ">排队发送</option>" +
        '<option value="0"' + (!S.queueWhenBusy ? " selected" : "") + ">中断并发送</option></select></div></div>" +

        '<div class="setrow"><div class="lbl"><div class="n">命令白名单</div><div class="d">当前 allow_all = ' + String(!!sec.allow_all) +
        " · 命令超时 " + (sec.command_timeout_ms || "—") + "ms · code_act = " + String(!!sec.code_act) + "</div></div>" +
        '<div class="ctl"><button class="mini-btn" id="sSec">查看/编辑</button></div></div>' +

        '<div class="setrow"><div class="lbl"><div class="n">禁用的工具</div><div class="d">' + (cur ? "已禁用 " + cur + " 个" : "全部工具启用中") + "</div></div>" +
        '<div class="ctl"><button class="mini-btn" id="sTools">编辑</button></div></div>';
      setTimeout(function () {
        $("sPerm").onchange = function () {
          var id = this.value;
          for (var i = 0; i < PERMS.length; i++) if (PERMS[i].id === id) {
            S.perm = id; localStorage.setItem("ppx_perm", id); $("permLabel").textContent = PERMS[i].label;
            savePatch({ security: PERMS[i].patch }, "权限模式: " + PERMS[i].label);
          }
        };
        body.querySelectorAll(".theme-opt").forEach(function (b) {
          b.onclick = function () {
            S.theme = b.getAttribute("data-theme");
            localStorage.setItem("ppx_theme", S.theme);
            applyTheme();
            body.querySelectorAll(".theme-opt").forEach(function (x) { x.classList.toggle("active", x === b); });
          };
        });
        $("sFs").onchange = function () {
          var n = Math.min(20, Math.max(12, Number(this.value) || 14));
          S.fs = n; localStorage.setItem("ppx_fs", String(n)); this.value = n; applyTheme(); toast("字号 " + n + "px");
        };
        $("sDense").onchange = function () { S.dense = this.value; localStorage.setItem("ppx_dense", this.value); applyTheme(); };
        $("sQueue").onchange = function () { S.queueWhenBusy = this.value === "1"; localStorage.setItem("ppx_queue", this.value); toast("已更新发送行为"); };
        $("sTools").onclick = function () { $("chipTools").click(); };
        $("sSec").onclick = function () {
          openForm("安全设置", [
            { k: "allow_all", label: "放开命令白名单", type: "switch", value: !!sec.allow_all, desc: "开启后 run_command 不再受白名单限制" },
            { k: "code_act", label: "允许 code_act", type: "switch", value: !!sec.code_act, desc: "允许生成并执行代码片段" },
            { k: "command_timeout_ms", label: "命令超时 (ms)", type: "number", value: sec.command_timeout_ms || 30000 },
            { k: "deny", label: "额外拒绝规则", type: "textarea", value: ((sec.deny || []).length ? JSON.stringify(sec.deny, null, 1) : ""), desc: "JSON 数组, 留空表示不追加" },
          ], function (v) {
            var patch = { allow_all: v.allow_all, code_act: v.code_act, command_timeout_ms: Number(v.command_timeout_ms) || 30000 };
            if ((v.deny || "").trim()) {
              try { patch.deny = JSON.parse(v.deny); } catch (e) { toast("deny 不是合法 JSON", true); return false; }
            }
            savePatch({ security: patch }, "安全设置已保存").then(function () { renderSet(); });
          });
        };
      }, 0);
    }).catch(function (e) { body.innerHTML = '<div class="hint">' + esc(e.message) + "</div>"; });
  }

  function renderModel(body) {
    body.innerHTML = '<div class="hint">加载中…</div>';
    Promise.all([get("/api/providers"), get("/api/settings")]).then(function (rs) {
      S.providers = (rs[0] && rs[0].providers) || [];
      S.defaultProvider = (rs[0] && rs[0].default_id) || null;
      renderModelChip();
      body.innerHTML =
        '<div class="sep-note">填入各提供方的 API 密钥即可使用其模型。列表第一项为当前默认模型 (点击「设为默认」调整)。</div>' +
        S.providers.map(function (p) {
          var isDef = p.id === S.defaultProvider;
          return '<div class="listrow"><div class="info">' +
            '<div class="nm">' + esc(p.id) + (isDef ? '<span class="tag ok">默认</span>' : "") +
            (p.api_key_set ? '<span class="tag plain">密钥已配</span>' : '<span class="tag warn">缺密钥</span>') + "</div>" +
            '<div class="meta">' + esc(p.model || "未指定模型") + " · " + esc(p.base_url || "—") + (p.vision ? " · 支持视觉" : "") + "</div></div>" +
            '<div class="acts">' +
            (isDef ? "" : '<button class="mini-btn" data-a="def" data-id="' + esc(p.id) + '">设为默认</button>') +
            '<button class="mini-btn" data-a="test" data-id="' + esc(p.id) + '">测试</button>' +
            '<button class="mini-btn" data-a="edit" data-id="' + esc(p.id) + '">编辑</button>' +
            '<button class="mini-btn danger" data-a="del" data-id="' + esc(p.id) + '">删除</button>' +
            "</div></div>";
        }).join("") +
        '<div style="display:flex;gap:9px;margin-top:12px">' +
        '<button class="ghost" id="mAdd" style="flex:1;height:34px">+ 添加提供方</button>' +
        '<button class="ghost" id="mAddCustom" style="flex:1;height:34px">+ 添加自定义提供方</button></div>';
      var PRESETS = {
        deepseek: { base_url: "https://api.deepseek.com/v1", model: "deepseek-chat", api_key_env: "DEEPSEEK_API_KEY" },
        openai: { base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", api_key_env: "OPENAI_API_KEY" },
        dashscope: { base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", api_key_env: "DASHSCOPE_API_KEY" },
        zhipu: { base_url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-plus", api_key_env: "ZHIPU_API_KEY" },
        moonshot: { base_url: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", api_key_env: "MOONSHOT_API_KEY" },
        lmstudio: { base_url: "http://127.0.0.1:1234/v1", model: "your-local-model", api_key: "lm-studio" },
      };
      function providerForm(title, init, id) {
        return [
          { k: "id", label: "标识 id", value: init.id || "", placeholder: "deepseek" },
          { k: "base_url", label: "接口地址", value: init.base_url || "", placeholder: "https://api.deepseek.com/v1" },
          { k: "model", label: "模型名", value: init.model || "", placeholder: "deepseek-chat" },
          { k: "api_key", label: "API 密钥", value: "", type: "password", desc: "留空则不修改已保存的密钥", placeholder: init.api_key_set ? "已配置 (留空保持不变)" : "sk-…" },
          { k: "api_key_env", label: "或读取环境变量", value: init.api_key_env || "", placeholder: "DEEPSEEK_API_KEY" },
          { k: "timeout_ms", label: "超时 (ms)", type: "number", value: init.timeout_ms || 180000 },
          { k: "vision", label: "支持视觉输入", type: "switch", value: !!init.vision },
        ];
      }
      function submitProvider(v, id) {
        var patch = {
          base_url: v.base_url, model: v.model, timeout_ms: Number(v.timeout_ms) || 180000, vision: v.vision,
        };
        if (v.api_key) patch.api_key = v.api_key;
        if (v.api_key_env) patch.api_key_env = v.api_key_env;
        var p = id
          ? mcpTool("ppx.providers.update", { id: id, patch: patch })
          : mcpTool("ppx.providers.add", { provider: Object.assign({ id: v.id }, patch) });
        return p.then(function () { toast(id ? "已更新 " + id : "已添加 " + v.id); renderSet(); })
          .catch(function (e) { toast("操作失败: " + e.message, true); return false; });
      }
      body.querySelectorAll("[data-a]").forEach(function (b) {
        var id = b.getAttribute("data-id"), a = b.getAttribute("data-a"), p = providerById(id);
        b.onclick = function () {
          if (a === "def") {
            var order = [id].concat(S.providers.map(function (x) { return x.id; }).filter(function (x) { return x !== id; }));
            mcpTool("ppx.providers.reorder", { order: order }).then(function () { S.defaultProvider = id; renderModelChip(); renderSet(); toast("默认模型: " + id); })
              .catch(function (e) { toast(e.message, true); });
          } else if (a === "test") {
            b.textContent = "测试中…";
            mcpTool("ppx.providers.test", { id: id }).then(function (r) {
              toast(id + ": " + ((r && (r.detail || r.source)) || (r && r.healthy ? "连通" : "不通")), !(r && r.healthy));
              renderSet();
            }).catch(function (e) { toast("探测失败: " + e.message, true); b.textContent = "测试"; });
          } else if (a === "edit") {
            openForm("编辑提供方 · " + id, providerForm("", p || {}, id), function (v) { return submitProvider(v, id) === false ? false : undefined; });
          } else if (a === "del") {
            openForm("删除提供方", [{ k: "ok", label: "确认删除「" + id + "」?", type: "switch", value: false, desc: "配置文件中的该提供方会被移除" }], function (v) {
              if (!v.ok) return false;
              mcpTool("ppx.providers.delete", { id: id }).then(function () { toast("已删除 " + id); renderSet(); })
                .catch(function (e) { toast(e.message, true); });
            });
          }
        };
      });
      $("mAdd").onclick = function (e) {
        openMenu(e.currentTarget, Object.keys(PRESETS).map(function (k) {
          return { label: k, desc: PRESETS[k].model, icon: "cube", run: function () {
            var init = Object.assign({ id: k }, PRESETS[k]);
            openForm("添加提供方 · " + k, providerForm("", init, null), function (v) { submitProvider(v, null); });
          } };
        }));
      };
      $("mAddCustom").onclick = function () {
        openForm("添加自定义提供方", providerForm("", {}, null), function (v) { submitProvider(v, null); });
      };
    }).catch(function (e) { body.innerHTML = '<div class="hint">' + esc(e.message) + "</div>"; });
  }

  function renderPlugin(body) {
    body.innerHTML = '<div class="hint">加载中…</div>';
    mcpTool("ppx.settings.get").then(function (r) {
      var st = (r && r.settings) || {};
      var mcp = st.mcp || { auto_connect: false, servers: [] };
      var servers = mcp.servers || [];
      body.innerHTML =
        '<div class="setrow"><div class="lbl"><div class="n">自动连接</div><div class="d">启动时自动连接下列 MCP 服务并把它们的工具并入工具集</div></div>' +
        '<div class="ctl"><button class="switch' + (mcp.auto_connect ? " on" : "") + '" id="pAuto"></button></div></div>' +
        '<div class="sep-note">已配置的 MCP 服务 · ' + servers.length + " 个</div>" +
        (servers.length ? servers.map(function (s, i) {
          return '<div class="listrow"><div class="info"><div class="nm">' + esc(s.name || "未命名") +
            '<span class="tag plain">' + esc(s.url ? "HTTP" : "stdio") + "</span></div>" +
            '<div class="meta">' + esc(s.url || ((s.command || "") + " " + ((s.args || []).join(" ")))) + "</div></div>" +
            '<div class="acts"><button class="mini-btn" data-a="edit" data-i="' + i + '">编辑</button>' +
            '<button class="mini-btn danger" data-a="del" data-i="' + i + '">删除</button></div></div>';
        }).join("") : '<div class="hint">还没有接入 MCP 服务</div>') +
        '<button class="ghost" id="pAdd" style="width:100%;height:34px;margin-top:6px">+ 添加 MCP 服务</button>';
      function saveServers(next) {
        return mcpTool("ppx.settings.update", { patch: { mcp: { servers: next } } })
          .then(function () { toast("已保存"); renderSet(); })
          .catch(function (e) { toast(e.message, true); });
      }
      $("pAuto").onclick = function () {
        this.classList.toggle("on");
        mcpTool("ppx.settings.update", { patch: { mcp: { auto_connect: this.classList.contains("on") } } })
          .then(function () { toast("已更新"); }).catch(function (e) { toast(e.message, true); });
      };
      function serverForm(init) {
        return [
          { k: "name", label: "名称", value: init.name || "", placeholder: "filesystem" },
          { k: "command", label: "启动命令 (stdio)", value: init.command || "", placeholder: "npx" },
          { k: "args", label: "参数 (空格分隔)", value: (init.args || []).join(" "), placeholder: "-y @modelcontextprotocol/server-filesystem D:/ws" },
          { k: "url", label: "或 HTTP 地址", value: init.url || "", placeholder: "http://127.0.0.1:8930/mcp" },
          { k: "prefix", label: "工具前缀", value: init.prefix || "", placeholder: "fs" },
          { k: "timeout", label: "超时 (ms)", type: "number", value: init.timeout || 30000 },
        ];
      }
      function pack(v) {
        var o = { name: v.name.trim(), timeout: Number(v.timeout) || 30000 };
        if (v.url && v.url.trim()) o.url = v.url.trim();
        else { o.command = v.command.trim(); o.args = (v.args || "").split(/\s+/).filter(Boolean); }
        if (v.prefix) o.prefix = v.prefix.trim();
        return o;
      }
      $("pAdd").onclick = function () {
        openForm("添加 MCP 服务", serverForm({}), function (v) {
          if (!v.name || (!v.url && !v.command)) { toast("名称与命令/地址必填", true); return false; }
          saveServers(servers.concat([pack(v)]));
        });
      };
      body.querySelectorAll("[data-a]").forEach(function (b) {
        var i = Number(b.getAttribute("data-i"));
        b.onclick = function () {
          if (b.getAttribute("data-a") === "edit") openForm("编辑 MCP 服务", serverForm(servers[i]), function (v) {
            var next = servers.slice(); next[i] = pack(v); saveServers(next);
          });
          else openForm("删除 MCP 服务", [{ k: "ok", label: "确认删除「" + (servers[i].name || "该服务") + "」?", type: "switch", value: false }], function (v) {
            if (!v.ok) return false;
            saveServers(servers.filter(function (_, k) { return k !== i; }));
          });
        };
      });
    }).catch(function (e) { body.innerHTML = '<div class="hint">' + esc(e.message) + "</div>"; });
  }

  function renderAgent(body) {
    body.innerHTML = '<div class="hint">加载中…</div>';
    mcpTool("ppx.settings.get").then(function (r) {
      var st = (r && r.settings) || {};
      var ag = st.agent || {}, user = st.user || {};
      var modes = ["react", "plan", "ask", "legion"];
      body.innerHTML =
        '<div class="setrow"><div class="lbl"><div class="n">智能体名称</div><div class="d">出现在界面头像与日志中的名字</div></div>' +
        '<div class="ctl"><input class="txt" id="aName" value="' + esc(ag.name || "") + '" style="width:150px"></div></div>' +
        '<div class="setrow"><div class="lbl"><div class="n">称呼</div><div class="d">智能体对你的称呼</div></div>' +
        '<div class="ctl"><input class="txt" id="aUser" value="' + esc(user.name || "") + '" style="width:150px"></div></div>' +
        '<div class="setrow"><div class="lbl"><div class="n">工作模式</div><div class="d">react 边想边做 · plan 先出计划再执行 · ask 只答不做 · legion 多智能体军团</div></div>' +
        '<div class="ctl"><select class="sel" id="aMode">' + modes.map(function (m) {
          return '<option value="' + m + '"' + (m === ag.mode ? " selected" : "") + ">" + m + "</option>";
        }).join("") + "</select></div></div>" +
        '<div class="setrow col"><div class="lbl"><div class="n">价值观 / 原则</div><div class="d">每行一条, 会注入系统提示</div></div>' +
        '<div class="ctl"><textarea class="ta" id="aValues" placeholder="诚实优先&#10;不确定就说不确定">' + esc((ag.values || []).join("\n")) + "</textarea></div></div>" +
        '<div class="setrow col"><div class="lbl"><div class="n">附加系统提示</div><div class="d">追加在内置人格之后</div></div>' +
        '<div class="ctl"><textarea class="ta" id="aExtra" placeholder="例如: 回答保持简体中文, 结论先行">' + esc(ag.system_extra || "") + "</textarea></div></div>" +
        '<div class="setrow"><div class="lbl"><div class="n">引用规则</div><div class="d">回答中引用资料的要求</div></div>' +
        '<div class="ctl"><input class="txt" id="aCite" value="' + esc(ag.citation_rule || "") + '" style="width:220px"></div></div>' +
        '<div class="setrow"><div class="lbl"></div><div class="ctl"><button class="ghost primary" id="aSave">保存</button></div></div>';
      $("aSave").onclick = function () {
        savePatch({
          agent: {
            name: $("aName").value.trim(), mode: $("aMode").value, citation_rule: $("aCite").value.trim(),
            system_extra: $("aExtra").value, values: $("aValues").value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean),
          },
          user: { name: $("aUser").value.trim() },
        }, "Agent 预设已保存").then(function () { checkHealth(); });
      };
    }).catch(function (e) { body.innerHTML = '<div class="hint">' + esc(e.message) + "</div>"; });
  }

  function renderAbout(body) {
    body.innerHTML = '<div class="hint">体检中…</div>';
    Promise.all([
      get("/health").catch(function () { return {}; }),
      get("/api/stats").catch(function () { return {}; }),
      get("/api/bootstrap").catch(function () { return {}; }),
    ]).then(function (rs) {
      var h = rs[0] || {}, st = rs[1] || {}, bs = rs[2] || {};
      var mem = st.memory || {};
      body.innerHTML =
        '<div class="card"><div class="ct">内核</div>' +
        kv("应用", bs.app || "ppxans-harness") +
        kv("版本", h.version || S.version) +
        kv("智能体", h.agent || S.agentName) +
        kv("端口", String(bs.port || "—")) +
        kv("MCP 端点", bs.mcpPath || "/mcp") +
        kv("REST 兼容层", bs.legacyRest ? "开" : "关") +
        kv("运行时长", h.uptime_ms != null ? Math.round(h.uptime_ms / 1000) + " 秒" : "—") + "</div>" +

        '<div class="card"><div class="ct">认证</div>' +
        kv("本机免 token", bs.authToken ? "已注入" : "未注入") +
        kv("回环访问", bs.tokenLoopback ? "是" : "否") +
        kv("token 校验", bs.tokenRequired ? "开启" : "关闭") + "</div>" +

        '<div class="card"><div class="ct">记忆与轨迹</div>' +
        kv("工具调用", String(st.count == null ? "—" : st.count)) +
        kv("失败率", String(st.failRate == null ? "—" : st.failRate)) +
        (mem.l0 ? kv("L0 事件", String(mem.l0.events_total)) : "") +
        (mem.l1 ? kv("L1 事实", String(mem.l1.live)) : "") + "</div>" +

        '<div class="card"><div class="ct">快捷入口</div>' +
        '<div class="cc" style="display:flex;gap:8px;flex-wrap:wrap;padding-top:4px">' +
        '<button class="mini-btn" id="abHealth">/health</button>' +
        '<button class="mini-btn" id="abStats">/api/stats</button>' +
        '<button class="mini-btn" id="abTrace">/api/traces</button>' +
        '<button class="mini-btn" id="abMcp">/mcp</button>' +
        "</div></div>" +

        '<div class="setrow"><div class="lbl"><div class="n">手动指定 token</div><div class="d">非本机访问时, 把后端启动日志里的 token 填到这里</div></div>' +
        '<div class="ctl"><input class="txt" id="abTok" type="password" placeholder="未设置" style="width:190px">' +
        '<button class="mini-btn" id="abTokSave">保存</button></div></div>';
      function openUrl(u) { window.open(S.base + u, "_blank"); }
      $("abHealth").onclick = function () { openUrl("/health"); };
      $("abStats").onclick = function () { openUrl("/api/stats"); };
      $("abTrace").onclick = function () { openUrl("/api/traces?limit=50"); };
      $("abMcp").onclick = function () { toast("MCP 端点为 POST " + (bs.mcpPath || "/mcp") + " (Streamable HTTP)"); };
      $("abTok").value = localStorage.getItem("ppx_token") || "";
      $("abTokSave").onclick = function () {
        var t = $("abTok").value.trim();
        if (t) localStorage.setItem("ppx_token", t); else localStorage.removeItem("ppx_token");
        S.token = t;
        toast("token 已更新, 正在重连…");
        boot();
      };
    }).catch(function (e) { body.innerHTML = '<div class="hint">' + esc(e.message) + "</div>"; });
  }

  /* ================= 初始化 ================= */
  function quickPrompts() {
    return [
      "看看当前项目状态, 有什么值得改进的",
      "列出你现在的工具能力",
      "帮我把这个项目的 README 精简一版",
      "跑一次自愈体检, 汇报结果",
    ];
  }
  function renderQuick() {
    $("quick").innerHTML = quickPrompts().map(function (q) {
      return "<button>" + esc(q) + "</button>";
    }).join("");
    $("quick").querySelectorAll("button").forEach(function (b) {
      b.onclick = function () {
        $("inp").value = b.textContent;
        autosize();
        $("btnSend").disabled = false;
        $("inp").focus();
      };
    });
  }
  function boot() {
    applyTheme();
    setSide(localStorage.getItem("ppx_side") === "1"); // 恢复上次的侧栏折叠状态
    $("heroVer").textContent = "v" + S.version;
    $("permLabel").textContent = permLabel();
    $("brandTag").textContent = "v" + S.version;
    $("heroSub").textContent = "零依赖智能体内核 · 记忆 / 工具 / 军团 / 自愈 · " + S.agentName;
    document.title = S.agentName + " · PPX Agent";
    checkHealth().then(function () {
      loadSessions().then(function () {
        if (S.session && S.session !== "default" && S.sessions.some(function (s) { return s.key === S.session; })) {
          $("tbTitle").textContent = sessionTitle(S.session);
          loadHistory(S.session);
        } else {
          $("tbTitle").textContent = "新会话";
        }
      });
      loadProviders();
      loadWorkspace();
    }).catch(function (e) {
      addMsg("err", "无法连接内核: " + e.message + "\n请确认服务已启动 (node bin/ppx-web.js)。");
    });
    // 无 token 时提醒
    if (S.tokenRequired && !S.token) {
      toast("未取得本地 token, 已切换到只读模式; 可在设置 → 关于 手动填入", true);
    }
  }
  renderQuick();
  boot();
})();
