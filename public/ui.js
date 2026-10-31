/* public/ui.js - 轻量确认/输入弹窗 (替代原生 confirm/prompt, 2026-10-30)
 *
 * 为什么不用原生对话框:
 *   1) 原生 confirm/prompt 是浏览器级模态, 会冻结页面脚本、样式不可控、与皮皮虾的
 *      主题/深色模式完全脱节 (Windows 上尤其突兀);
 *   2) 无法做焦点圈定与键盘操作 —— 原生 prompt 只支持单行, Esc 语义由浏览器决定;
 *   3) 部分桌面壳/内嵌浏览器会禁用或改写原生对话框, 行为不可预期。
 *
 * 接口 (Promise, 不阻塞主线程):
 *   PPXUI.confirm(message, { title, okText, cancelText, danger }) -> Promise<boolean>
 *   PPXUI.prompt(message, { title, value, placeholder, okText, cancelText }) -> Promise<string|null>
 *
 * 可访问性: role=dialog + aria-modal + aria-labelledby/describedby; 打开时记录并迁移焦点,
 *   关闭时归还; Tab/Shift+Tab 在弹窗内循环; Esc / 点遮罩 = 取消; Enter 提交 (输入框内)。
 * 无依赖、不写 localStorage; 同一时刻只允许一个弹窗 (新弹窗会把旧的按取消收口)。
 */
(function () {
  "use strict";

  var state = { resolve: null, prevFocus: null, nodes: null };

  function node(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function build() {
    if (state.nodes) return state.nodes;
    var mask = node("div", "mmask");
    var dlg = node("div", "mdlg ppx-ask");
    dlg.setAttribute("role", "dialog");
    dlg.setAttribute("aria-modal", "true");
    dlg.setAttribute("aria-labelledby", "ppxAskTitle");
    dlg.setAttribute("aria-describedby", "ppxAskMsg");
    dlg.hidden = true;

    var head = node("div", "mhead");
    var title = node("span", null, "确认");
    title.id = "ppxAskTitle";
    var x = node("button", "icobtn sm");
    x.type = "button";
    x.setAttribute("aria-label", "关闭");
    x.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><use href="#i-close"/></svg>';
    head.appendChild(title);
    head.appendChild(x);

    var msgWrap = node("div", "mrow col ppx-ask-msg");
    var msg = node("div", "mlab");
    msg.id = "ppxAskMsg";
    msgWrap.appendChild(msg);

    var inputRow = node("label", "mrow");
    inputRow.hidden = true;
    inputRow.appendChild(node("span", null, "输入"));
    var input = node("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    inputRow.appendChild(input);

    var foot = node("div", "mfoot");
    var cancel = node("button", "btn", "取消");
    cancel.type = "button";
    var ok = node("button", "btn primary", "确定");
    ok.type = "button";
    foot.appendChild(cancel);
    foot.appendChild(ok);

    dlg.appendChild(head);
    dlg.appendChild(msgWrap);
    dlg.appendChild(inputRow);
    dlg.appendChild(foot);
    document.body.appendChild(mask);
    document.body.appendChild(dlg);
    state.nodes = { mask: mask, dlg: dlg, title: title, msg: msg, inputRow: inputRow, input: input, cancel: cancel, ok: ok, x: x };
    return state.nodes;
  }

  function focusables(n) {
    return [n.inputRow.hidden ? null : n.input, n.cancel, n.ok, n.x].filter(Boolean);
  }

  function finish(value) {
    var r = state.resolve;
    state.resolve = null;
    if (!state.nodes) return;
    var n = state.nodes;
    n.mask.hidden = true;
    n.dlg.hidden = true;
    n.dlg.classList.remove("danger");
    n.ok.classList.remove("danger");
    if (state.prevFocus && typeof state.prevFocus.focus === "function") {
      try { state.prevFocus.focus(); } catch (e) { /* 元素可能已被重绘移除 */ }
    }
    state.prevFocus = null;
    if (r) r(value);
  }

  function open(kind, message, opts) {
    opts = opts || {};
    // 旧弹窗未收口: 先按取消关闭, 避免两个遮罩叠在一起 (Promise 不会悬挂)
    if (state.resolve) finish(kind === "prompt" ? null : false);
    var n = build();
    state.prevFocus = document.activeElement;
    n.title.textContent = opts.title || (kind === "prompt" ? "输入" : "确认");
    n.msg.textContent = String(message == null ? "" : message);
    n.inputRow.hidden = kind !== "prompt";
    n.input.value = opts.value == null ? "" : String(opts.value);
    n.input.placeholder = opts.placeholder || "";
    n.cancel.textContent = opts.cancelText || "取消";
    n.ok.textContent = opts.okText || "确定";
    var danger = !!opts.danger;
    n.dlg.classList.toggle("danger", danger);
    n.ok.classList.toggle("danger", danger);

    n.mask.hidden = false;
    n.dlg.hidden = false;

    function onKey(e) {
      if (state.nodes !== n) return;
      if (e.key === "Escape") {
        e.preventDefault();
        // 弹窗打开时 Esc 只关闭弹窗: 不再冒泡给 app.js 的全局 Esc (否则会顺手停止生成/收起面板)
        if (e.stopImmediatePropagation) e.stopImmediatePropagation(); else e.stopPropagation();
        finish(kind === "prompt" ? null : false);
        return;
      }
      if (e.key === "Tab") {
        var list = focusables(n);
        if (!list.length) return;
        var i = list.indexOf(document.activeElement);
        if (i === -1) { e.preventDefault(); list[0].focus(); return; }
        if (e.shiftKey && i === 0) { e.preventDefault(); list[list.length - 1].focus(); }
        else if (!e.shiftKey && i === list.length - 1) { e.preventDefault(); list[0].focus(); }
        return;
      }
      if (e.key === "Enter" && kind === "prompt") { e.preventDefault(); submit(); }
    }
    function submit() {
      var v = n.input.value;
      finish(kind === "prompt" ? (v.trim() ? v.trim() : null) : true);
    }
    function cleanup() {
      document.removeEventListener("keydown", onKey, true);
      n.ok.onclick = n.cancel.onclick = n.x.onclick = n.mask.onclick = n.input.onkeydown = null;
    }

    n.ok.onclick = function () { if (kind === "prompt") submit(); else finish(true); };
    n.cancel.onclick = function () { finish(kind === "prompt" ? null : false); };
    n.x.onclick = n.cancel.onclick;
    n.mask.onclick = n.cancel.onclick;
    n.input.onkeydown = function (e) {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    };
    // 捕获阶段监听: 即使焦点意外落到弹窗外, Esc/Tab 也由弹窗接管
    document.addEventListener("keydown", onKey, true);
    setTimeout(function () {
      if (state.nodes !== n) return;
      if (kind === "prompt") { n.input.focus(); n.input.select(); } else n.ok.focus();
    }, 20);

    return new Promise(function (resolve) {
      state.resolve = function (v) { cleanup(); resolve(v); };
    });
  }

  window.PPXUI = {
    confirm: function (message, opts) { return open("confirm", message, opts); },
    prompt: function (message, opts) { return open("prompt", message, opts); },
  };
})();
