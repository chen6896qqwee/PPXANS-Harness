/* public/app.js - 皮皮虾 v3.3 Web UI (codex 风格)
 * 布局: 左栏会话/能力 · 中栏事件时间线(用户/agent/工具卡/审批卡/计划/diff) · 右栏工作区抽屉(文件/模型/目标/审查/设置)
 * 数据通道: REST (/message/stream, /sessions*, /api/*) + MCP (POST /mcp, tools/call)
 * 设计原则: 零依赖 vanilla JS; 所有新端点失败时优雅降级隐藏
 *
 * v3.3 变更 (2026-10-09):
 *  - 新增「模型配置」模块: provider 增删改查 / 厂商预设快选 / 连通性测试 / 设为默认 (对接 /api/providers*)
 *  - 主题升级三态 (亮 / 暗 / 跟随系统), 设置面板可切
 *  - 修复: 若干按钮 aria-label 写在标签外导致按钮内出现可见文本
 *  - 体验: markdown 表格真解析 / 代码块与消息一键复制 / hero 运行状态条 / 窄屏抽屉遮罩
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
    providers: [],         // 模型服务列表 (key 已被后端抹掉)
    providerPresets: [],   // 厂商预设库
    editingId: null,       // 非空 = 表单处于编辑态
    clearKey: false,       // 编辑态: 用户点了"清除已存 Key"
    lifeTimer: null,
    apprTimer: null,
    lastTokens: null,
    pendingFiles: [],   // 已上传待发送的图片相对路径 (uploads/xx.png)
    activeSpace: null, // 当前选中的空间名 (新会话自动归入)
    wsSub: "",         // 工作区子目录 (相对路径; 空 = 整个工作区)
    llm: null,         // /api/llm 状态快照 (模型/思考强度/语音能力)
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
    t._tm = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function fmtTs(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var h = String(d.getHours()).padStart(2, "0"), m = String(d.getMinutes()).padStart(2, "0");
    return h + ":" + m;
  }
  function copyText(text) {
    var done = function () { toast("已复制"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text, done); });
    } else {
      legacyCopy(text, done);
    }
  }
  function legacyCopy(text, done) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { toast("复制失败, 请手动选择", true); }
    ta.remove();
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
  // 401 处理 (2026-10-09 补): 此前只弹一条错误气泡, token 不清、登录态不回,
  // 后续所有请求继续带着失效 token 打服务端 (无限失败)。改为: 清 token → 尝试刷新 →
  // 仍拿不到就引导重新填入, 并用 _unauthBusy 防止并发请求把流程打爆。
  var _unauthBusy = false;
  function handleUnauthorized() {
    if (_unauthBusy) return;
    _unauthBusy = true;
    try { localStorage.removeItem("ppx_token"); } catch (e) {}
    fetch(S.base + "/api/bootstrap")
      .then(function (r) { return r.json(); })
      .then(function (j) {
        _unauthBusy = false;
        if (j && j.authToken) {
          window.__PPX_BOOTSTRAP__ = j;   // 可信本地: 服务端重新下发, 免手填
          toast("登录态已刷新");
          init();
        } else {
          askToken(j);
        }
      })
      .catch(function () { _unauthBusy = false; askToken(null); });
  }
  function askToken(boot) {
    var need = boot && boot.tokenRequired === false ? "服务端未启用令牌, 请检查服务是否正常" : "请在服务端启动日志或 data/http-token 中查看访问令牌";
    var t = prompt("需要访问令牌。\n" + need);
    if (t && t.trim()) {
      try { localStorage.setItem("ppx_token", t.trim()); } catch (e) {}
      location.reload();
    } else {
      toast("未提供令牌, 已停留在只读状态", true);
    }
  }
  function req(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign(headers(opts.body != null), opts.headers || {});
    return fetch(S.base + path, opts).then(function (r) {
      if (r.status === 401) {
        handleUnauthorized();
        throw new Error("鉴权失败 (401): 访问令牌无效或已过期, 请重新提供");
      }
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

  /* ================= 主题 (三态: system / light / dark) ================= */
  var THEME_LABEL = { system: "跟随系统", light: "浅色", dark: "深色" };
  function themePref() {
    var p = localStorage.getItem("ppx_theme_pref");
    if (p === "system" || p === "light" || p === "dark") return p;
    // 兼容旧版单值 key (ppx_theme)
    var old = localStorage.getItem("ppx_theme");
    return old === "light" ? "light" : "dark";
  }
  function applyTheme() {
    var pref = themePref();
    var dark = pref === "system" ? matchMedia("(prefers-color-scheme: dark)").matches : pref === "dark";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    $("btnTheme").innerHTML = ico(pref === "system" ? "monitor" : (dark ? "sun" : "moon"), 16);
    $("btnTheme").title = "主题: " + THEME_LABEL[pref] + " (点击切换)";
    if ($("setTheme")) $("setTheme").value = pref;
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
    if (themePref() === "system") applyTheme();
  });
  $("btnTheme").onclick = function () {
    var order = ["system", "light", "dark"];
    var next = order[(order.indexOf(themePref()) + 1) % order.length];
    localStorage.setItem("ppx_theme_pref", next);
    try { localStorage.removeItem("ppx_theme"); } catch (e) {}
    applyTheme();
    toast("主题: " + THEME_LABEL[next]);
  };

  /* ================= Markdown 渲染 (安全) ================= */
  var LANG_ALIAS = { js: "javascript", ts: "typescript", py: "python", sh: "bash", yml: "yaml", md: "markdown" };
  function codeBlockHtml(lang, code) {
    var l = String(lang || "").trim();
    return '<div class="codewrap"><div class="codebar"><span class="clang">' + esc(LANG_ALIAS[l] || l || "text") + "</span>"
      + '<button type="button" class="cbtn" data-copy="code">' + ico("copy", 12) + "复制</button></div>"
      + "<pre><code>" + code + "</code></pre></div>";
  }
  function mdTable(block) {
    var rows = String(block).replace(/\n+$/, "").split("\n").filter(function (r) { return r.trim(); });
    if (rows.length < 2) return null;
    var sep = rows[1].trim();
    if (!/^\|[\s:|-]+\|$/.test(sep) || sep.indexOf("-") === -1) return null;
    var cells = function (r) {
      return r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); });
    };
    var head = cells(rows[0]);
    var body = rows.slice(2).map(cells);
    return "<table><thead><tr>" + head.map(function (c) { return "<th>" + c + "</th>"; }).join("") + "</tr></thead><tbody>"
      + body.map(function (r) {
        return "<tr>" + head.map(function (_, i) { return "<td>" + (r[i] == null ? "" : r[i]) + "</td>"; }).join("") + "</tr>";
      }).join("") + "</tbody></table>";
  }
  function renderMd(t) {
    var s = esc(t);
    s = s.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) { return codeBlockHtml(lang, code); });
    // 表格: 连续以 | 开头结尾的行, 且第二行是分隔行
    s = s.replace(/(?:^\|.*\|[ \t]*\n?)+/gm, function (block) { return mdTable(block) || block; });
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
      if (/^<(h\d|pre|div|ul|ol|blockquote|table)/.test(p)) return p;
      return "<p>" + p.replace(/\n/g, "<br>") + "</p>";
    }).join("");
    return s;
  }

  /* 时间线内的复制按钮 (代码块 + 整条消息) —— 事件委托, 免疫动态插入 */
  $("stream").addEventListener("click", function (e) {
    var codeBtn = e.target.closest && e.target.closest('[data-copy="code"]');
    if (codeBtn) {
      var wrap = codeBtn.closest(".codewrap");
      var code = wrap && wrap.querySelector("code");
      if (code) copyText(code.textContent);
      return;
    }
    var msgBtn = e.target.closest && e.target.closest('[data-copy="msg"]');
    if (msgBtn) {
      var body = msgBtn.closest(".ev") && msgBtn.closest(".ev").querySelector(".body");
      if (body) copyText(body.innerText);
    }
  });

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
    // 字段名必须与后端一致 (http.js /sessions/delete 读 data.key)。
    // 曾因这里发 sessionKey、后端读 key, 导致"删某个会话"实际删掉 default 主会话 (误删数据)。
    post("/sessions/delete", { key: key }).then(function () {
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
    // 空间绑定: 从空间进入的新会话自动归属该空间, 同项目不再重复建散会话
    if (S.activeSpace) {
      var list = spaces();
      var sp = list.find(function (x) { return x.name === S.activeSpace; });
      if (sp) { sp.sessionKey = S.session; saveSpaces(list); }
    }
    clearStream();
    $("hero").hidden = false;
    $("stream").hidden = true;
    loadSessions();
  }
  function clearStream() { $("stream").innerHTML = ""; }

  // 加载并回放指定会话的历史 (2026-10-09 补: 此前 switchSession 调用了本函数但从未定义,
  // 每次点侧栏切会话都抛 ReferenceError → 历史永不渲染, 且紧随的 loadSessions() 被异常中断)。
  // 后端契约: GET /sessions/:key/history → { sessionId, messages: [{role:"user"|"assistant", content}] }
  function loadHistory(key) {
    return get("/sessions/" + encodeURIComponent(key) + "/history").then(function (j) {
      var msgs = (j && j.messages) || [];
      stream().innerHTML = "";
      if (!msgs.length) {
        // 无历史 → 回落到空态首屏, 不展示空时间线
        $("hero").hidden = false;
        stream().hidden = true;
        return;
      }
      showStream();
      msgs.forEach(function (m) {
        if (!m || typeof m.content !== "string" || !m.content) return;
        if (m.role === "user") {
          evUser(m.content);
        } else {
          evAgent().innerHTML = renderMd(m.content);
        }
      });
      toBottom(true);
    }).catch(function () {
      // 历史加载失败不阻断会话切换: 保留空时间线并提示, 不静默吞掉用户可感知的异常
      showStream();
      evError("历史加载失败, 可能是会话不存在或服务未响应");
    });
  }

  $("btnNew").onclick = newSession;

  /* ================= 侧栏: 任务 (TaskBoard 只读视图) ================= */
  function loadTasks() {
    get("/api/tasks").then(function (j) {
      var tasks = (j && j.tasks) || [];
      var el = $("taskList");
      $("taskCount").textContent = tasks.length ? String(tasks.length) : "";
      if (!tasks.length) { el.innerHTML = '<div class="empty">暂无任务 · 发送 /task 创建</div>'; return; }
      var ST = { todo: "待办", running: "进行", done: "完成", failed: "失败" };
      el.innerHTML = "";
      tasks.slice(0, 30).forEach(function (t) {
        var b = document.createElement("button");
        b.className = "sess task-" + (t.status || "todo");
        b.innerHTML = ico("list", 13) + '<span class="t">' + esc(t.title || t.id) + '</span><span class="badge ts-' + esc(t.status || "todo") + '">' + esc(ST[t.status] || t.status || "") + "</span>";
        b.title = (t.description || t.title || "") + (t.steps && t.steps.length ? " · 步骤 " + t.steps.filter(function (s) { return s.status === "done"; }).length + "/" + t.steps.length : "");
        b.onclick = function () {
          var lines = ["## 任务 · " + (t.title || t.id), "状态: **" + (ST[t.status] || t.status) + "**"];
          if (t.description) lines.push(t.description);
          (t.steps || []).forEach(function (s, i) { lines.push((s.status === "done" ? "- [x]" : "- [ ]") + " " + (s.title || ("步骤 " + (i + 1)))); });
          if (t.result) lines.push("结果: " + t.result);
          evAgent().innerHTML = renderMd(lines.join("\n"));
          toBottom(true);
        };
        el.appendChild(b);
      });
    }).catch(function () {
      $("taskList").innerHTML = '<div class="empty">任务面板不可用</div>';
      $("taskCount").textContent = "";
    });
  }

  /* ================= 侧栏: 空间 (按项目聚合会话, 防止重复开新会话) ================= */
  // 空间 = { name, root(相对路径, 空 = 皮皮虾根目录), sessionKey(绑定的会话) }。
  // 点空间: 工作区面板聚焦到该子目录 + 复用已绑定会话 (没有才建新) → 同一项目不散落重复会话。
  function bootRoot() {
    try { return (window.__PPX_BOOTSTRAP__ && window.__PPX_BOOTSTRAP__.root) || ""; } catch (e) { return ""; }
  }
  function rootName() {
    var r = bootRoot();
    return r ? r.split(/[\\/]/).filter(Boolean).pop() || "皮皮虾" : "皮皮虾";
  }
  // 兼容旧数据: 早期空间存的是绝对路径 → 落回相对路径 (相对皮皮虾根目录)
  function relOfRoot(root) {
    var r = String(root || "").trim().replace(/^[\\/]+|[\\/]+$/g, "");
    if (!r) return "";
    var base = bootRoot().replace(/[\\/]+$/, "");
    if (/^[a-zA-Z]:[\\/]/.test(r) || r.startsWith("/")) {
      if (base && r.toLowerCase().startsWith(base.toLowerCase() + "\\")) return r.slice(base.length + 1).replace(/\\/g, "/");
      if (base && r.toLowerCase().startsWith(base.toLowerCase() + "/")) return r.slice(base.length + 1);
      return r; // 工作区外的绝对路径: 后端越界拦截, 保留原样以显式失败
    }
    return r;
  }
  function spaces() {
    try { return JSON.parse(localStorage.getItem("ppx_spaces") || "[]"); } catch (e) { return []; }
  }
  function saveSpaces(list) {
    try { localStorage.setItem("ppx_spaces", JSON.stringify(list)); } catch (e) {}
  }
  function renderSpaces() {
    var el = $("spaceList");
    var list = spaces();
    if (!list.length) {
      var em = document.createElement("div");
      em.className = "empty";
      em.innerHTML = "暂无空间<br><button class=\"btn xs\" id=\"spaceEmptyAdd\">＋ 新建空间</button>";
      el.innerHTML = ""; el.appendChild(em);
      em.querySelector("#spaceEmptyAdd").onclick = function () { openDirModal("space"); };
      return;
    }
    el.innerHTML = "";
    list.forEach(function (sp, i) {
      var rel = relOfRoot(sp.root);
      var b = document.createElement("button");
      b.className = "sess" + (S.activeSpace === sp.name ? " on" : "");
      b.innerHTML = ico("space", 13) + '<span class="t">' + esc(sp.name) + '</span><span class="del">' + ico("trash", 13) + "</span>";
      b.title = "目录: " + (rel ? rootName() + " / " + rel : rootName() + " (根目录)") + "\n点击进入该空间 (切工作区 + 复用会话)";
      b.onclick = function (e) {
        if (e.target.closest(".del")) {
          if (!confirm("删除空间「" + sp.name + "」? (会话不会被删除)")) return;
          list.splice(i, 1); saveSpaces(list);
          if (S.activeSpace === sp.name) S.activeSpace = null;
          renderSpaces();
          return;
        }
        S.activeSpace = sp.name;
        S.wsSub = rel;                 // 工作区面板聚焦到该空间目录
        loadTree();
        var bound = sp.sessionKey && S.sessions.find(function (s) { return s.key === sp.sessionKey; });
        if (bound) switchSession(bound.key, bound.title || bound.name);
        else { newSession(); }         // newSession 会把新会话绑回该空间
        renderSpaces();
      };
      el.appendChild(b);
    });
  }

  /* ---- 空间 / 目录选择弹层 (替代原生 prompt) ---- */
  var dirPick = { mode: "space", rel: "" };
  function openDirModal(mode, preset) {
    dirPick.mode = mode;
    dirPick.rel = String(preset || "");
    $("dirTitle").textContent = mode === "space" ? "新建空间" : "选择工作区目录";
    $("dirNameRow").hidden = mode !== "space";
    $("dirOk").textContent = mode === "space" ? "创建" : "确定";
    $("dirName").value = "";
    $("dirMask").hidden = false;
    $("dirModal").hidden = false;
    loadDirModal();
    if (mode === "space") setTimeout(function () { $("dirName").focus(); }, 30);
  }
  function closeDirModal() { $("dirMask").hidden = true; $("dirModal").hidden = true; }
  function loadDirModal() {
    var rel = dirPick.rel;
    var parts = rel ? rel.split("/").filter(Boolean) : [];
    var crumbs = ['<button data-p="">' + esc(rootName()) + "</button>"];
    var acc = "";
    parts.forEach(function (p) {
      acc = acc ? acc + "/" + p : p;
      crumbs.push('<i>/</i><button data-p="' + esc(acc) + '">' + esc(p) + "</button>");
    });
    $("dirCrumb").innerHTML = crumbs.join("");
    $("dirCrumb").querySelectorAll("button").forEach(function (b) {
      b.onclick = function () { dirPick.rel = b.getAttribute("data-p"); loadDirModal(); };
    });
    $("dirPickTxt").textContent = rel ? rootName() + " / " + rel : rootName() + " (根目录)";
    $("dirList").innerHTML = '<div class="empty">加载中…</div>';
    get("/api/workspace/tree?maxDepth=1" + (rel ? "&root=" + encodeURIComponent(rel) : "")).then(function (j) {
      var t = j && j.tree;
      var nodes = Array.isArray(t) ? t : ((t && t.children) || (j && j.items) || []);
      var dirs = (nodes || []).filter(function (n) { return (n.type === "dir" || n.dir) && !String(n.name || "").startsWith("."); });
      var el = $("dirList");
      if (!dirs.length) { el.innerHTML = '<div class="empty">' + (rel ? "该目录下没有子文件夹" : "根目录下没有子文件夹") + "</div>"; return; }
      el.innerHTML = "";
      dirs.forEach(function (d) {
        var b = document.createElement("button");
        b.className = "mdir";
        b.innerHTML = ico("folder", 13) + '<span class="nm">' + esc(d.name) + "</span>" + ico("chev-r", 12);
        b.onclick = function () { dirPick.rel = d.path || (rel ? rel + "/" + d.name : d.name); loadDirModal(); };
        el.appendChild(b);
      });
    }).catch(function (e) {
      $("dirList").innerHTML = '<div class="empty">目录读取失败: ' + esc(e && e.message || "未知错误") + "</div>";
    });
  }
  $("btnSpaceAdd").onclick = function () { openDirModal("space"); };
  $("dirClose").onclick = closeDirModal;
  $("dirCancel").onclick = closeDirModal;
  $("dirMask").onclick = closeDirModal;
  $("dirModal").addEventListener("click", function (e) { e.stopPropagation(); });
  $("dirName").addEventListener("keydown", function (e) { if (e.key === "Enter") $("dirOk").click(); });
  $("dirOk").onclick = function () {
    if (dirPick.mode === "dir") { S.wsSub = dirPick.rel; closeDirModal(); loadTree(); return; }
    var name = ($("dirName").value || "").trim() || (dirPick.rel ? dirPick.rel.split("/").pop() : "新空间");
    var list = spaces();
    if (list.find(function (x) { return x.name === name; })) { toast("同名空间已存在", true); return; }
    list.unshift({ name: name, root: dirPick.rel, sessionKey: null });
    saveSpaces(list);
    closeDirModal();
    renderSpaces();
    toast("空间已创建: " + name + (dirPick.rel ? " (" + dirPick.rel + ")" : " (皮皮虾根目录)"));
  };

  /* ================= 侧栏: 会话 ================= */
  $("btnSessRefresh").onclick = loadSessions;
  $("btnSessSearch").onclick = function () {
    var q = prompt("搜索会话:");
    if (q == null) return;
    q = q.trim().toLowerCase();
    var items = $("sessList").querySelectorAll(".sess");
    var hit = 0;
    items.forEach(function (it) {
      var t = it.querySelector(".t");
      var txt = t ? t.textContent.toLowerCase() : "";
      var show = !q || txt.indexOf(q) !== -1;
      it.style.display = show ? "" : "none";
      if (show) hit++;
    });
    if (q) toast("匹配 " + hit + " 个会话" + (hit ? "" : " · 清空搜索框可恢复全部"));
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
    var html = '<div class="bubble">' + esc(text) + "</div>";
    // 图片预览: 抽出消息里的图片路径 (uploads/xx.png 或任意 .png 路径) → 内联缩略图
    var imgs = [];
    String(text).replace(/[^\s"'`，。；;：:,，()（）]+\.(?:png|jpe?g|gif|webp|bmp)/gi, function (m) { imgs.push(m); return m; });
    if (imgs.length) {
      html += '<div class="msg-imgs">' + imgs.map(function (p) {
        var src = encodeURI("/" + p.replace(/^\//, ""));
        return '<a href="' + esc(src) + '" target="_blank" rel="noopener"><img loading="lazy" src="' + esc(src) + '" alt="图片"></a>';
      }).join("") + "</div>";
    }
    d.innerHTML = html;
    toBottom(true);
    return d;
  }
  function evAgent() {
    var d = addEv("ev-agent");
    d.innerHTML = '<div class="who"><span class="mark">' + ico("mark", 12) + '</span>皮皮虾 <span class="t">' + fmtTs(Date.now()) + "</span>"
      + '<span class="flex1"></span><button type="button" class="msgcopy" data-copy="msg" title="复制整条回复">' + ico("copy", 12) + "</button></div>"
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
      + '<span class="tname">' + esc(ev.tool) + '</span><span class="tsum">' + esc(sum) + "</span>" + chip
      + '<span class="chev">' + ico("chev-d", 14) + "</span></div>"
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
    b.disabled = on ? false : (!$("inp").value.trim() && !S.pendingFiles.length);
    $("footNote").textContent = on ? "生成中… Esc 停止" : "Enter 发送 · Shift+Enter 换行 · / 唤起命令面板";
  }

  function send() {
    var t = $("inp").value.trim();
    if (!t && !S.pendingFiles.length) return;
    if (S.streaming) { toast("生成中, 已请求停止"); stopGen(); return; }
    // 已上传图片: 把相对路径拼进消息 (visionUserContent 会自动抽路径注入多模态)
    if (S.pendingFiles.length) t = S.pendingFiles.join(" ") + (t ? "\n" + t : "");
    S.pendingFiles = [];
    renderAttChips();
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
      if (m && m[1] === "model") { openModels(); return; }
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
    var t = S.lastTokens;
    var txt = t.total != null ? t.total : ((t.input != null || t.output != null) ? ((t.input || 0) + "/" + (t.output || 0)) : "—");
    $("tokPill").hidden = false;
    $("tokTxt").textContent = typeof txt === "number" ? txt + " tok" : txt;
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
  function hidePalette() {
    // 无障碍: 关闭弹层后把焦点归还给触发它的输入框, 避免键盘用户"焦点丢失"
    var wasOpen = !$("palette").hidden;
    $("palette").hidden = true;
    if (wasOpen) { try { $("inp").focus(); } catch (e) {} }
  }
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
    syncDrawerMask();
    localStorage.setItem("ppx_drawer", on ? "1" : "0");
    if (on) loadTab(S.drawerTab);
  }
  function syncDrawerMask() {
    var narrow = matchMedia("(max-width: 980px)").matches;
    $("drawerMask").hidden = !(S.drawer && narrow);
  }
  matchMedia("(max-width: 980px)").addEventListener("change", syncDrawerMask);
  $("drawerMask").onclick = function () { setDrawer(false); };
  $("btnDrawer").onclick = function () { setDrawer(!S.drawer); };
  $("btnDrawerClose").onclick = function () { setDrawer(false); };
  document.querySelectorAll(".tab").forEach(function (t) {
    t.onclick = function () {
      document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("on"); });
      t.classList.add("on");
      S.drawerTab = t.getAttribute("data-tab");
      document.querySelectorAll(".dpane").forEach(function (p) { p.classList.remove("on"); });
      $("pane-" + S.drawerTab).classList.add("on");
      // 模型面板字段多, 抽屉放宽一档
      $("drawer").classList.toggle("wide", S.drawerTab === "models");
      loadTab(S.drawerTab);
    };
  });
  function loadTab(tab) {
    if (tab === "files") loadTree();
    else if (tab === "models") loadModels();
    else if (tab === "goal") loadGoal();
    else if (tab === "review") loadReview();
    else if (tab === "settings") loadSettings();
  }

  /* --- 文件树 --- */
  // 2026-10-11 修复: 后端返回的 tree 是【根节点对象】{name,path,type,children},
  //   旧代码把它当数组 forEach → TypeError 被 catch 吞成"工作区不可用"(实测截图复现)。
  //   另支持子目录浏览 (?root=相对路径), 越界由后端 resolveInside 拦截。
  function loadTree() {
    var url = "/api/workspace/tree?maxDepth=3" + (S.wsSub ? "&root=" + encodeURIComponent(S.wsSub) : "");
    get(url).then(function (j) {
      var root = (j && j.root) || S.wsRoot || "";
      S.wsRoot = root;
      var t = j && j.tree;
      var nodes = Array.isArray(t) ? t : ((t && t.children) || (j && j.items) || []);
      $("wsRoot").textContent = (root ? root.split(/[\\/]/).pop() : "工作区") + (S.wsSub ? " / " + S.wsSub : "");
      $("wsRoot").title = root + (S.wsSub ? " / " + S.wsSub : "");
      $("wsTree").innerHTML = "";
      if (!nodes.length) { $("wsTree").innerHTML = '<div class="empty">目录为空</div>'; return; }
      renderTree($("wsTree"), nodes, 0);
    }).catch(function (e) {
      $("wsTree").innerHTML = '<div class="empty">工作区不可用: ' + esc(e && e.message || "加载失败") + "</div>";
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
  // 切换工作区子目录: 复用目录选择弹层 (替代原生 prompt)
  $("btnWsRoot").onclick = function () { openDirModal("dir", S.wsSub || ""); };

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

  /* ================= 模型配置模块 (v3.3) ================= */
  // 后端契约 (src/channels/http.js):
  //   GET    /api/providers            → { providers:[{id,model,base_url,api_key_set,api_key_env,...}], default_id }
  //   GET    /api/providers/presets    → { presets:[{id,label,base_url,models,api_key_env,key_url,...}] }
  //   POST   /api/providers            { provider:{...} }        新增 (写盘 + 热重载)
  //   PUT    /api/providers            { id, patch:{...} }       更新
  //   DELETE /api/providers            { id }                    删除
  //   POST   /api/providers/reorder    { order:[id...] }         重排 (第 0 个 = 默认)
  //   POST   /api/providers/test       { id }                    → { healthy, detail }
  // 安全: api_key 明文永不回传, 只回 api_key_set 布尔; 写盘走原子写 + .bak 备份

  function providerLabel(p) {
    if (!p) return "—";
    return p.model ? p.model : "未指定模型";
  }
  function presetOf(id) {
    var s = null;
    S.providerPresets.forEach(function (x) { if (x.id === id) s = x; });
    return s;
  }
  function updModelBadge() {
    var def = S.providers.length ? S.providers[0] : null;
    $("modelTxt").textContent = def ? providerLabel(def) : "未配置模型";
    $("modelPill").classList.toggle("warn", !def);
    $("modelHead").textContent = "模型服务 · " + S.providers.length;
  }
  function openModels() {
    setDrawer(true);
    switchTab("models");
  }
  $("modelPill").onclick = openModels;
  $("capModels").onclick = openModels;
  $("btnModelRefresh").onclick = function () { loadModels(true); };

  function loadPresets() {
    if (S.providerPresets.length) return Promise.resolve(S.providerPresets);
    return get("/api/providers/presets").then(function (j) {
      S.providerPresets = (j && j.presets) || [];
      return S.providerPresets;
    }).catch(function () { return []; });
  }

  function loadModels(loud) {
    if (!S.providers.length) $("modelList").innerHTML = '<div class="empty">加载中…</div>';
    return Promise.all([get("/api/providers").catch(function () { return null; }), loadPresets()])
      .then(function (r) {
        var j = r[0];
        if (!j) {
          $("modelList").innerHTML = '<div class="empty">模型服务不可用<br>请确认内核已启动且 REST /api/* 未退役</div>';
          return;
        }
        renderModels(j);
        if (loud) toast("模型服务已刷新");
      }).catch(function (e) {
        $("modelList").innerHTML = '<div class="empty">加载失败: ' + esc(e.message) + "</div>";
      });
  }
  function renderModels(j) {
    S.providers = (j && j.providers) || [];
    var el = $("modelList");
    el.innerHTML = "";
    updModelBadge();
    // 预设库是 v3.3 新增端点: 老进程未重启时取不到 → 明确告知, 不让用户对着空下拉发呆
    if (!S.providerPresets.length) {
      var n = document.createElement("div");
      n.className = "notice";
      n.innerHTML = ico("info", 13) + "<span>厂商预设库未加载 —— 内核需重启一次才会提供该端点 (界面本身已生效)。当前仍可手填 base_url 与模型名。</span>";
      el.appendChild(n);
    }
    if (!S.providers.length) {
      var e = document.createElement("div");
      e.className = "empty";
      e.innerHTML = "尚未配置模型服务<br>点右上角「新增」或在输入框发送 <b>/model</b>";
      el.appendChild(e);
      return;
    }
    S.providers.forEach(function (p, i) {
      el.appendChild(modelCard(p, i === 0));
    });
  }
  function modelCard(p, isDefault) {
    var wrap = document.createElement("div");
    wrap.className = "mcard" + (isDefault ? " def" : "");
    wrap.setAttribute("data-pid", p.id);
    var preset = presetOf(p.id);
    var keyState = p.api_key_set
      ? '<span class="ktag ok">' + ico("key", 11) + "Key 已存</span>"
      : (p.api_key_env
        ? '<span class="ktag warn" title="未内联保存, 运行时从环境变量读取">' + ico("key", 11) + esc(p.api_key_env) + "</span>"
        : '<span class="ktag warn">' + ico("key", 11) + "免 Key</span>");
    wrap.innerHTML =
      '<div class="mhead"><span class="mid">' + esc(p.id) + "</span>"
      + (isDefault ? '<span class="mdef">' + ico("star", 10) + "默认</span>" : "")
      + '<span class="flex1"></span>' + keyState + "</div>"
      + '<div class="mmodel" title="模型名">' + esc(providerLabel(p)) + "</div>"
      + '<div class="mmeta"><span title="接口地址">' + esc(p.base_url || "-") + "</span>"
      + (p.context_window ? '<span class="mctx">' + (Math.round(p.context_window / 1024)) + "K ctx</span>" : "")
      + (p.vision ? '<span class="mctx">视觉</span>' : "")
      + (preset && preset.cloud === false ? '<span class="mctx">本地</span>' : "")
      + "</div>"
      + '<div class="macts">'
      + '<button class="btn xs" data-act="test">' + ico("activity", 12) + "测试</button>"
      + '<button class="btn xs" data-act="edit">' + ico("edit", 12) + "编辑</button>"
      + (isDefault ? "" : '<button class="btn xs" data-act="default">' + ico("star", 12) + "设为默认</button>")
      + '<span class="flex1"></span>'
      + '<button class="btn xs danger" data-act="del" title="删除">' + ico("trash", 12) + "</button>"
      + "</div>"
      + '<div class="mresult" hidden></div>';
    wrap.querySelectorAll("[data-act]").forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var act = b.getAttribute("data-act");
        if (act === "test") testModel(p, wrap);
        else if (act === "edit") openModelForm(p);
        else if (act === "default") setDefaultModel(p.id);
        else if (act === "del") delModel(p);
      };
    });
    return wrap;
  }
  function mresult(wrap, text, kind) {
    var el = wrap.querySelector(".mresult");
    if (!el) return;
    el.className = "mresult" + (kind ? " " + kind : "");
    el.textContent = text;
    el.hidden = false;
  }
  function testModel(p, wrap) {
    mresult(wrap, "探测中…", "");
    post("/api/providers/test", { id: p.id }).then(function (j) {
      mresult(wrap, (j && j.healthy ? "✓ " : "✗ ") + ((j && j.detail) || ""), j && j.healthy ? "ok" : "bad");
    }).catch(function (e) {
      mresult(wrap, "✗ " + e.message, "bad");
    });
  }
  function setDefaultModel(id) {
    var order = S.providers.map(function (p) { return p.id; }).filter(function (x) { return x !== id; });
    order.unshift(id);
    post("/api/providers/reorder", { order: order }).then(function () {
      toast("已设为默认模型");
      loadModels();
    }).catch(function (e) { toast(e.message, true); });
  }
  function delModel(p) {
    if (!confirm("删除模型服务「" + p.id + "」?\n配置文件会先留一份 .bak 备份。")) return;
    req("/api/providers", { method: "DELETE", body: JSON.stringify({ id: p.id }) }).then(function () {
      toast("已删除 " + p.id);
      if (S.editingId === p.id) closeModelForm();
      loadModels();
    }).catch(function (e) { toast(e.message, true); });
  }

  /* --- 表单 --- */
  function fillPresetOptions() {
    var sel = $("mfPreset");
    var html = '<option value="">自定义 (手动填写)</option>';
    S.providerPresets.forEach(function (p) {
      html += '<option value="' + esc(p.id) + '">' + esc(p.label || p.id) + (p.cloud === false ? " · 本地" : "") + "</option>";
    });
    sel.innerHTML = html;
  }
  function applyPreset(id) {
    var p = presetOf(id);
    var dl = $("mfModelList");
    if (!p) { dl.innerHTML = ""; $("mfKeyHint").textContent = ""; return; }
    if (!$("mfId").value.trim() || S.editingId == null) $("mfId").value = p.id;
    $("mfBase").value = p.base_url || "";
    dl.innerHTML = (p.models || []).map(function (m) { return '<option value="' + esc(m) + '"></option>'; }).join("");
    if (p.models && p.models[0] && !$("mfModel").value.trim()) $("mfModel").value = p.models[0];
    $("mfModel").placeholder = p.model_hint || (p.models && p.models[0]) || "模型名";
    $("mfCtx").value = p.context_window || "";
    var hint = [];
    if (p.api_key_env) hint.push("环境变量 " + p.api_key_env);
    if (p.cloud === false) hint.push("本地推理, Key 可留空 (随便填 lm-studio 即可)");
    if (p.key_url) hint.push('申请: <a href="' + esc(p.key_url) + '" target="_blank" rel="noopener">' + esc(p.key_url) + "</a>");
    setKeyHint(hint.join(" · "));
  }
  // 编辑态才追加"已存 Key / 清除"后缀; 新增态保持纯提示
  function keyHintSuffix() {
    if (S.editingId == null) return "";
    return S.clearKey
      ? ' · <b class="warn">保存后清除已存 Key</b> <button type="button" class="linkbtn" id="mfClearKey">撤销</button>'
      : ' · 留空则不修改已存 Key <button type="button" class="linkbtn" id="mfClearKey">清除</button>';
  }
  function setKeyHint(base) {
    S.keyHintBase = base || "";
    $("mfKeyHint").innerHTML = S.keyHintBase + keyHintSuffix();
    bindClearKey();
  }
  function bindClearKey() {
    var b = $("mfClearKey");
    if (!b) return;
    b.onclick = function () {
      S.clearKey = !S.clearKey;
      $("mfKeyHint").innerHTML = S.keyHintBase + keyHintSuffix();
      bindClearKey();
    };
  }
  function openModelForm(p) {
    S.editingId = p ? p.id : null;
    S.clearKey = false;
    $("mfTitle").textContent = p ? "编辑 " + p.id : "新增模型服务";
    $("mfId").value = p ? p.id : "";
    $("mfId").readOnly = !!p;
    $("mfId").classList.toggle("ro", !!p);
    $("mfBase").value = p ? (p.base_url || "") : "";
    $("mfModel").value = p ? (p.model || "") : "";
    $("mfKey").value = "";
    $("mfCtx").value = p && p.context_window ? p.context_window : "";
    $("mfTimeout").value = p && p.timeout_ms ? p.timeout_ms : "";
    $("mfVision").checked = !!(p && p.vision);
    $("mfPreset").value = (p && presetOf(p.id)) ? p.id : "";
    showMsg("", "");
    var dl = $("mfModelList");
    dl.innerHTML = "";
    if (p) {
      setKeyHint(p.api_key_set ? "已保存 Key (不回显明文)" : (p.api_key_env ? "环境变量 " + esc(p.api_key_env) : "免 Key"));
    } else {
      setKeyHint("Key 写入本机 config/ppx.json (写盘前自动备份 .bak), 不会回传到浏览器");
    }
    $("modelForm").hidden = false;
    $("mfId").focus();
  }
  function closeModelForm() {
    S.editingId = null;
    S.clearKey = false;
    $("modelForm").hidden = true;
  }
  function showMsg(text, kind) {
    var el = $("mfMsg");
    el.textContent = text || "";
    el.className = "fmsg" + (kind ? " " + kind : "");
    el.hidden = !text;
  }
  $("btnModelAdd").onclick = function () {
    if (!$("modelForm").hidden && S.editingId == null) { closeModelForm(); return; }
    openModelForm(null);
  };
  $("mfCancel").onclick = function (e) { e.preventDefault(); closeModelForm(); };
  $("mfPreset").onchange = function () { applyPreset($("mfPreset").value); if (S.editingId != null) bindClearKey(); };
  $("modelForm").onsubmit = function (e) {
    e.preventDefault();
    var id = $("mfId").value.trim();
    var base = $("mfBase").value.trim();
    if (!id) { showMsg("请填标识 id", "bad"); return; }
    if (!base) { showMsg("请填接口地址 base_url", "bad"); return; }
    var payload = {
      id: id,
      backend: "http",
      base_url: base,
      model: $("mfModel").value.trim(),
      vision: $("mfVision").checked,
    };
    var key = $("mfKey").value.trim();
    var preset = presetOf(id);
    if (key) payload.api_key = key;
    else if (preset && preset.api_key_env) payload.api_key_env = preset.api_key_env;
    var ctx = Number($("mfCtx").value);
    if (ctx) payload.context_window = ctx;
    var to = Number($("mfTimeout").value);
    if (to) payload.timeout_ms = to;

    $("mfSave").disabled = true;
    var task;
    if (S.editingId == null) {
      task = post("/api/providers", { provider: payload });
    } else {
      var patch = Object.assign({}, payload);
      delete patch.id;
      if (!key && S.clearKey) patch.api_key = "";
      else if (!key) delete patch.api_key;
      task = req("/api/providers", { method: "PUT", body: JSON.stringify({ id: S.editingId, patch: patch }) });
    }
    task.then(function () {
      toast(S.editingId == null ? "已新增 " + id : "已保存 " + id);
      closeModelForm();
      loadModels();
    }).catch(function (err) {
      showMsg(err.message, "bad");
    }).finally(function () { $("mfSave").disabled = false; });
  };

  /* --- 设置 --- */
  // 设置面板 (2026-10-09 修): 此前读 /api/bootstrap 的 j.agent / j.root / j.tools,
  // 但 bootstrap 里 agent 是【字符串】(agent 名), 且没有 root/llm 字段 →
  // ag.approval_mode / ag.sandbox / ag.llm 全为 undefined, 下拉框恒空、信息栏显示 "-"。
  // 正确来源: 审批模式与沙箱 = GET /api/permissions; 其余配置 = GET /api/settings。
  function loadSettings() {
    get("/api/bootstrap").then(function (b) {
      if (!b) return;
      $("setInfo").textContent = "版本 " + (b.version || "-") + " · 模型 " + (S.providers[0] ? providerLabel(S.providers[0]) : (b.agent || "-")) + " · 工作区 " + (b.port ? (b.host || "127.0.0.1") + ":" + b.port : "-");
    }).catch(function () {
      $("setInfo").textContent = "引导信息不可用";
    });
    get("/api/permissions").then(function (p) {
      if (!p) return;
      if (p.approvalMode) { $("setApproval").value = p.approvalMode; S.perm = p.approvalMode; $("modeTxt").textContent = p.approvalMode; }
      if (p.sandbox) $("setSandbox").value = p.sandbox;
    }).catch(function () { /* 权限引擎未装配时保持默认显示 */ });
    get("/api/settings").then(function (j) {
      var s = (j && j.settings) || {};
      var ag = s.agent || {};
      var pc = s.agent && s.agent.proactive;
      var bits = [];
      if (ag.name) bits.push("Agent " + ag.name);
      if (ag.mode) bits.push("模式 " + ag.mode);
      if (pc && pc.enabled != null) bits.push("主动提醒 " + (pc.enabled ? "开" : "关"));
      if (s.user && s.user.name) bits.push("用户 " + s.user.name);
      if (bits.length) $("setInfo").textContent += " · " + bits.join(" · ");
    }).catch(function () { /* 设置读取失败不影响主流程 */ });
  }
  $("setApproval").onchange = function () {
    S.perm = $("setApproval").value;
    $("modeTxt").textContent = S.perm;
    post("/api/permissions", { approvalMode: S.perm }).then(function () { toast("审批模式已生效"); })
      .catch(function () { toast("已切换本地显示 (服务端模式未变)", false); });
  };
  $("setSandbox").onchange = function () {
    post("/api/permissions", { sandbox: $("setSandbox").value }).then(function () { toast("沙箱已生效"); }).catch(function () {});
  };
  $("setTheme").onchange = function () {
    localStorage.setItem("ppx_theme_pref", $("setTheme").value);
    try { localStorage.removeItem("ppx_theme"); } catch (e) {}
    applyTheme();
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

  /* ================= 生命周期角标 + hero 状态条 ================= */
  function loadLifecycle() {
    get("/api/lifecycle").then(function (j) {
      var st = j && (j.stage || j.status) || null;
      if (!st) return;
      S.life = st;
      $("lifeDot").className = "dot on";
      $("lifeTxt").textContent = "生命周期 " + st + (j.dialog_count != null ? " · 对话 " + j.dialog_count : "");
      updHeroStats();
    }).catch(function () {});
  }
  function updHeroStats() {
    var bits = [];
    var v = $("brandTag").textContent.replace(/^v/, "");
    if (v && v !== "3") bits.push("版本 v" + v);
    bits.push(S.providers.length ? "模型 " + providerLabel(S.providers[0]) : "模型未配置");
    if (S.life) bits.push("生命周期 " + S.life);
    bits.push("会话 " + S.sessions.length);
    $("heroStats").innerHTML = bits.map(function (b, i) {
      return (i ? '<span class="hs-sep"></span>' : "") + "<span>" + esc(b) + "</span>";
    }).join("");
    $("heroStats").hidden = false;
  }

  /* ================= 输入框 ================= */
  function autosize() {
    var i = $("inp");
    i.style.height = "auto";
    i.style.height = Math.min(i.scrollHeight, 180) + "px";
  }
  $("inp").addEventListener("input", function () {
    autosize();
    updSendState();
    var v = $("inp").value;
    if (v.charAt(0) === "/" && !S.streaming) showPalette(v.slice(1).split(/\s/)[0]);
    else hidePalette();
  });
  function updSendState() {
    $("btnSend").disabled = !S.streaming && !$("inp").value.trim() && !S.pendingFiles.length;
  }

  /* ================= 附件上传 (任意文件; 图片额外走多模态注入) ================= */
  var IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
  function fmtSize(n) {
    if (!n && n !== 0) return "";
    if (n < 1024) return n + "B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + "KB";
    return (n / 1024 / 1024).toFixed(1) + "MB";
  }
  function renderAttChips() {
    var el = $("attChips");
    el.innerHTML = S.pendingFiles.map(function (p, i) {
      var name = p.split("/").pop();
      var isImg = IMG_RE.test(name);
      var head = isImg
        ? '<img src="/' + esc(encodeURI(p)) + '" alt="">'
        : '<span class="fico">' + ico("file", 13) + "</span>";
      return '<span class="attchip' + (isImg ? "" : " file") + '">' + head +
        '<i title="' + esc(p) + '">' + esc(name) + "</i>" +
        '<button type="button" data-i="' + i + '" title="移除">' + ico("close", 11) + "</button></span>";
    }).join("");
    el.hidden = !S.pendingFiles.length;
    el.querySelectorAll("button").forEach(function (b) {
      b.onclick = function () { S.pendingFiles.splice(Number(b.getAttribute("data-i")), 1); renderAttChips(); updSendState(); };
    });
    updSendState();
  }
  function uploadFile(file) {
    var isImg = IMG_RE.test(file.name) || (file.type || "").indexOf("image/") === 0;
    var limit = isImg ? 8 * 1024 * 1024 : 20 * 1024 * 1024;
    if (file.size > limit) { toast((isImg ? "图片" : "文件") + "超过 " + (isImg ? 8 : 20) + "MB", true); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var b64 = String(reader.result).split(",")[1] || "";
      post("/api/upload", { name: file.name, data: b64 }).then(function (j) {
        if (j && j.path) {
          S.pendingFiles.push(j.path);
          renderAttChips();
          toast((j.kind === "image" ? "图片" : "文件") + "已就绪: " + j.path.split("/").pop() + " (" + fmtSize(j.bytes) + ")");
        }
      }).catch(function (e) { toast("上传失败: " + e.message, true); });
    };
    reader.readAsDataURL(file);
  }
  $("btnAttach").onclick = function () { $("fileInput").click(); };
  $("fileInput").onchange = function () {
    Array.prototype.forEach.call($("fileInput").files, uploadFile);
    $("fileInput").value = "";
  };
  // 粘贴: 截图直接上传 (微信/QQ 截图党的核心路径)
  $("inp").addEventListener("paste", function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf("image/") === 0) {
        e.preventDefault();
        var f = items[i].getAsFile();
        if (f) uploadFile(new File([f], "paste-" + Date.now() + ".png", { type: f.type }));
      }
    }
  });
  // 拖拽任意文件到输入区 (图片/文档/代码/压缩包)
  var composerEl = $("composer");
  composerEl.addEventListener("dragover", function (e) { e.preventDefault(); composerEl.classList.add("drag"); });
  composerEl.addEventListener("dragleave", function () { composerEl.classList.remove("drag"); });
  composerEl.addEventListener("drop", function (e) {
    e.preventDefault();
    composerEl.classList.remove("drag");
    Array.prototype.forEach.call((e.dataTransfer && e.dataTransfer.files) || [], uploadFile);
  });

  /* ================= 模型切换 + 思考强度 (对接 /api/llm) ================= */
  var REASON_LABELS = { auto: "自动", off: "关闭", low: "低", medium: "中", high: "High", max: "极高" };
  function llmPillRender() {
    var cur = S.llm && S.llm.current;
    $("pillModelTxt").textContent = cur ? (cur.model || cur.id) : "未配置模型";
    $("pillModel").title = cur ? ("当前: " + cur.model + " (" + cur.id + ") · 点击切换") : "点击配置模型";
    $("pillReasonTxt").textContent = REASON_LABELS[S.llm && S.llm.reasoning] || "自动";
  }
  function loadLlm() {
    return get("/api/llm").then(function (j) {
      if (j && j.ok) { S.llm = j; llmPillRender(); }
      return j;
    }).catch(function () { /* 端点不可用: 胶囊保持默认文案 */ });
  }
  function closePop() {
    ["popModel", "popReason"].forEach(function (id) { if ($(id)) $(id).hidden = true; });
    var a = document.querySelectorAll(".tpill"); a.forEach(function (b) { b.setAttribute("aria-expanded", "false"); });
  }
  function renderPopModel() {
    var j = S.llm || {};
    var provs = j.providers || [];
    var html = '<div class="pop-title">选择模型服务</div>';
    if (!provs.length) html += '<div class="empty">未配置任何 provider · 到右栏「模型」页新增</div>';
    html += provs.map(function (p) {
      return '<button class="pop-item' + (p.current ? " on" : "") + '" data-id="' + esc(p.id) + '"' + (p.usable ? "" : " disabled") + ">" +
        '<span class="pmain"><b>' + esc(p.model || "(未设模型)") + "</b><i>" + esc(p.id) + (p.vision ? " · 视觉" : "") + "</i></span>" +
        (p.usable ? (p.current ? '<span class="pbadge on">使用中</span>' : '<span class="pbadge">可用</span>') : '<span class="pbadge off">未配置 Key</span>') +
        "</button>";
    }).join("");
    $("popModel").innerHTML = html;
    $("popModel").querySelectorAll(".pop-item").forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute("data-id");
        post("/api/llm", { provider: id }).then(function (r) {
          S.llm = r; llmPillRender(); closePop();
          var c = r && r.current;
          toast("已切换到 " + (c ? c.model + " (" + c.id + ")" : id));
        }).catch(function (e) { toast("切换失败: " + e.message, true); });
      };
    });
  }
  function renderPopReason() {
    var levels = (S.llm && S.llm.reasoning_levels) || ["auto", "off", "low", "medium", "high", "max"];
    var cur = (S.llm && S.llm.reasoning) || "auto";
    var idx = Math.max(0, levels.indexOf(cur));
    var pct = (idx / (levels.length - 1)) * 100;
    $("popReason").innerHTML =
      '<div class="pop-title">思考强度<span class="rval" id="rvalTxt">' + esc(REASON_LABELS[cur] || cur) + "</span></div>" +
      '<div class="rwrap"><div class="rtrack"><div class="rdots">' +
      levels.map(function () { return "<i></i>"; }).join("") +
      '</div><div class="rthumb" id="rthumb" style="left:calc(' + pct + '% - ' + (pct * 0.24).toFixed(1) + 'px)"></div></div>' +
      '<input type="range" id="rrange" min="0" max="' + (levels.length - 1) + '" step="1" value="' + idx + '"></div>' +
      '<div class="pop-hint">按厂商能力注入: 智谱/方舟 thinking、通义 enable_thinking、OpenAI reasoning_effort; 未支持的模型自动忽略。</div>';
    var r = $("rrange");
    var onMove = function () {
      var v = Number(r.value), lv = levels[v], p2 = (v / (levels.length - 1)) * 100;
      $("rthumb").style.left = "calc(" + p2 + "% - " + (p2 * 0.24).toFixed(1) + "px)";
      $("rvalTxt").textContent = REASON_LABELS[lv] || lv;
    };
    r.oninput = onMove;
    r.onchange = function () {
      var lv = levels[Number(r.value)];
      post("/api/llm", { reasoning: lv }).then(function (res) {
        S.llm = res; llmPillRender();
        toast("思考强度: " + (REASON_LABELS[lv] || lv) + (lv === "auto" ? " (跟随模型默认)" : ""));
      }).catch(function (e) { toast("设置失败: " + e.message, true); });
    };
  }
  $("pillModel").onclick = function (e) {
    e.stopPropagation();
    var open = $("popModel").hidden;
    closePop();
    if (open) {
      loadLlm().then(function () { renderPopModel(); $("popModel").hidden = false; $("pillModel").setAttribute("aria-expanded", "true"); });
    }
  };
  $("pillReason").onclick = function (e) {
    e.stopPropagation();
    var open = $("popReason").hidden;
    closePop();
    if (open) {
      loadLlm().then(function () { renderPopReason(); $("popReason").hidden = false; $("pillReason").setAttribute("aria-expanded", "true"); });
    }
  };
  document.addEventListener("click", function (e) {
    if (!e.target.closest || !e.target.closest(".tpillwrap")) closePop();
  });

  /* ================= 语音输入 (媒体录音 → /api/voice/transcribe; 无配置时回退浏览器识别) ================= */
  var rec = { active: false, media: null, chunks: [], stream: null, t0: 0, timer: 0, sr: null };
  function micBusy(on, label) {
    var b = $("btnMic");
    b.classList.toggle("rec", !!on);
    b.title = label || (on ? "正在聆听… 点击结束" : "语音输入 (轻点开始/结束)");
  }
  // 录音 → 16kHz 单声道 WAV (云端 whisper 类接口通用, 避免 webm 兼容坑)
  function encodeWav(float32, rate) {
    var len = float32.length, buf = new ArrayBuffer(44 + len * 2), v = new DataView(buf);
    var ws = function (o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); ws(8, "WAVE");
    ws(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, "data"); v.setUint32(40, len * 2, true);
    for (var i = 0; i < len; i++) { var s = Math.max(-1, Math.min(1, float32[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return new Blob([buf], { type: "audio/wav" });
  }
  function blobToWav16k(blob) {
    return blob.arrayBuffer().then(function (ab) {
      var AC = window.AudioContext || window.webkitAudioContext;
      var ctx = new AC();
      return ctx.decodeAudioData(ab).then(function (audio) {
        var sr = 16000, len = Math.max(1, Math.round(audio.duration * sr));
        var off = new OfflineAudioContext(1, len, sr);
        var src = off.createBufferSource(); src.buffer = audio; src.connect(off.destination); src.start();
        return off.startRendering();
      }).then(function (rendered) {
        return encodeWav(rendered.getChannelData(0), 16000);
      }).finally(function () { try { ctx.close(); } catch (e) {} });
    });
  }
  function blobToB64(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(",")[1] || ""); };
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }
  function insertToInput(text) {
    var t = $("inp");
    t.value = (t.value ? t.value.replace(/\s*$/, " ") : "") + text;
    autosize(); updSendState(); t.focus();
  }
  function browserSR() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    var r = new SR();
    r.lang = "zh-CN"; r.interimResults = false; r.maxAlternatives = 1;
    return r;
  }
  function startMic() {
    // 优先: 已配 ASR → 服务端转写; 未配 → 浏览器识别; 都没有 → 指路
    var status = (S.llm && S.llm.voice) || {};
    if (status.asr) {
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        rec.stream = stream; rec.chunks = []; rec.t0 = Date.now();
        var mr = new MediaRecorder(stream);
        mr.ondataavailable = function (e) { if (e.data && e.data.size) rec.chunks.push(e.data); };
        mr.onstop = function () {
          var blob = new Blob(rec.chunks, { type: mr.mimeType || "audio/webm" });
          rec.stream.getTracks().forEach(function (t) { t.stop(); });
          micBusy(false);
          if (Date.now() - rec.t0 < 400) { toast("录音太短"); return; }
          toast("转写中…");
          blobToWav16k(blob).catch(function () { return blob; }).then(function (wav) {
            return blobToB64(wav).then(function (b64) {
              return post("/api/voice/transcribe", { name: "voice.wav", data: b64, language: "zh" });
            });
          }).then(function (r) {
            if (r && r.text) { insertToInput(r.text); toast("已转写"); }
            else toast("没有识别到内容", true);
          }).catch(function (e) { toast("转写失败: " + e.message, true); });
        };
        rec.media = mr; mr.start(); rec.active = true;
        micBusy(true); toast("开始录音 · 再点一下结束");
      }).catch(function (e) { toast("麦克风不可用: " + (e && e.message || e), true); });
      return;
    }
    var sr = browserSR();
    if (sr) {
      rec.sr = sr; rec.active = true; micBusy(true);
      sr.onresult = function (ev) {
        var txt = ev.results && ev.results[0] && ev.results[0][0] && ev.results[0][0].transcript;
        if (txt) { insertToInput(txt); toast("已转写"); }
      };
      sr.onerror = function (ev) {
        toast("浏览器识别失败: " + ((ev && ev.error) || "未知") + " (可在 config.voice.asr 配云端 ASR)", true);
      };
      sr.onend = function () { rec.active = false; micBusy(false); };
      try { sr.start(); toast("正在聆听… (浏览器识别)"); } catch (e) { toast("无法启动识别: " + e.message, true); micBusy(false); rec.active = false; }
      return;
    }
    toast("语音未配置: 浏览器不支持识别, 且 config.voice.asr 未设云端 ASR (base_url + api_key)", true);
  }
  function stopMic() {
    if (rec.media && rec.media.state !== "inactive") rec.media.stop();
    if (rec.sr) { try { rec.sr.stop(); } catch (e) {} }
    if (rec.stream) { try { rec.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} }
    rec.active = false; micBusy(false);
  }
  $("btnMic").onclick = function () { if (rec.active) stopMic(); else startMic(); };
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
      if (!$("drawer").hidden && matchMedia("(max-width: 980px)").matches && !$("modelForm").hidden) { closeModelForm(); return; }
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

    // 模型服务预取: 顶栏指示 + 设置面板信息都要用
    loadPresets().then(function () {
      fillPresetOptions();
      loadModels();
    });

    var saved = localStorage.getItem("ppx_session");
    loadSessions().then(function () {
      var found = S.sessions.find(function (s) { return s.key === saved; });
      if (found) switchSession(found.key, found.title || found.name);
      else newSession();
    });

    loadCommands();
    loadLifecycle();
    loadTasks();
    renderSpaces();
    loadLlm();
    pollApprovals();
    S.lifeTimer = setInterval(loadLifecycle, 30000);
    S.apprTimer = setInterval(function () { pollApprovals(); loadTasks(); }, 8000);
    $("inp").focus();
  }
  init();
})();
