// webapp/src/markdown/index.js - Markdown 渲染栈
// 自 public/app.js (2026-11-03 换栈版) 移植, 行为保持:
//   · markdown-it 解析 —— html:false, 原文里的 HTML 一律当文本 (不引入注入口)
//   · 代码块按语言高亮, 未标语言时自动判型 (>20KB 不猜), 顶栏带复制按钮 (#i-copy)
//   · $行内$ / $$块级$$ 走 KaTeX; 公式写错只退回原文
//   · 输出过一遍 DOMPurify (use/href 白名单放行复制按钮的 sprite 引用)
// window.PPXMarkdown.render 是 Electron 冒烟的公开契约; window.markdownit/DOMPurify/
// katex/hljs 四个全局也由这里显式回填 (冒烟断言依赖)。

import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import katex from "katex";
import hljs from "highlight.js/lib/common";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";

// 冒烟契约: 渲染库全局可见 (真实 Chromium 里逐项断言)
window.markdownit = window.markdownit || MarkdownIt;
window.DOMPurify = window.DOMPurify || DOMPurify;
window.katex = window.katex || katex;
window.hljs = window.hljs || hljs;

const LANG_ALIAS = { js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", sh: "shell", zsh: "shell", yml: "yaml", md: "markdown", rs: "rust", kt: "kotlin" };

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function ico(name, size) {
  return '<svg width="' + (size || 15) + '" height="' + (size || 15) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><use href="#i-' + name + '"/></svg>';
}

function codeBlockHtml(lang, codeHtml) {
  const l = String(lang || "").trim();
  return '<div class="codewrap"><div class="codebar"><span class="clang">' + esc(l || "text") + "</span>"
    + '<button type="button" class="cbtn" data-copy="code">' + ico("copy", 12) + "复制</button></div>"
    + '<pre><code class="hljs">' + codeHtml + "</code></pre></div>";
}

function katexHtml(tex, display) {
  try {
    return katex.renderToString(tex, {
      displayMode: !!display,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: "html",
    });
  } catch {
    return '<code class="math-raw">' + esc(tex) + "</code>";
  }
}

// 公式插件: 行内 $...$ 与块级 $$...$$ (块级优先, 避免 $$ 被行内规则吃掉)
function mathPlugin(m) {
  function inline(state, silent) {
    const src = state.src, start = state.pos, max = state.posMax;
    if (src.charCodeAt(start) !== 0x24) return false;              // $
    if (start + 1 >= max || src.charCodeAt(start + 1) === 0x24) return false; // $$ 交给块级
    let pos = start + 1;
    while (pos < max) {
      const ch = src.charCodeAt(pos);
      if (ch === 0x5c) { pos += 2; continue; }                     // 跳过转义字符
      if (ch === 0x24) break;
      if (ch === 0x0a && src.charCodeAt(pos + 1) === 0x0a) return false;
      pos++;
    }
    if (pos >= max || pos === start + 1) return false;
    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = src.slice(start + 1, pos);
      token.markup = "$";
    }
    state.pos = pos + 1;
    return true;
  }
  function block(state, startLine, endLine, silent) {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const first = state.src.slice(start, state.eMarks[startLine]);
    if (first.slice(0, 2) !== "$$") return false;
    if (silent) return true;
    const rest = first.slice(2);
    const single = rest.match(/^([\s\S]+?)\$\$\s*$/);
    let content = "";
    let nextLine = startLine + 1;
    if (single) {
      content = single[1];
    } else {
      content = rest;
      let closed = false;
      for (; nextLine < endLine; nextLine++) {
        const line = state.src.slice(state.bMarks[nextLine] + state.tShift[nextLine], state.eMarks[nextLine]);
        const idx = line.indexOf("$$");
        if (idx >= 0) { content += "\n" + line.slice(0, idx); closed = true; nextLine++; break; }
        content += "\n" + line;
      }
      if (!closed) return false;
    }
    if (!content.trim()) return false;
    const token = state.push("math_block", "math_block", 0);
    token.block = true;
    token.content = content.trim();
    token.markup = "$$";
    token.map = [startLine, nextLine];
    state.line = nextLine;
    return true;
  }
  m.inline.ruler.before("escape", "math_inline", inline);
  m.block.ruler.before("fence", "math_block", block, { alt: ["paragraph", "reference", "blockquote", "list"] });
  m.renderer.rules.math_inline = (tokens, idx) => katexHtml(tokens[idx].content, false);
  m.renderer.rules.math_block = (tokens, idx) => '<p class="math-block">' + katexHtml(tokens[idx].content, true) + "</p>";
}

function highlightCode(code, lang) {
  const raw = esc(code);
  const l = LANG_ALIAS[String(lang || "").toLowerCase()] || String(lang || "").toLowerCase();
  try {
    if (l && hljs.getLanguage(l)) return hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
    if (!l && code.length <= 20000 && code.split("\n").length >= 3) {
      const auto = hljs.highlightAuto(code);
      // 相关性太低就别猜: 猜错了的配色比没有更难读
      if (auto && auto.relevance >= 6) return auto.value;
    }
  } catch { /* 高亮失败退回纯文本 */ }
  return raw;
}

const MD = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
MD.enable(["table", "strikethrough"]);
MD.use(mathPlugin);
MD.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const info = String(token.info || "").trim().split(/\s+/)[0];
  return codeBlockHtml(info, highlightCode(token.content, info));
};
MD.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const href = tokens[idx].attrGet("href") || "";
  if (/^https?:/i.test(href)) {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noopener noreferrer");
  }
  return self.renderToken(tokens, idx, options);
};

function sanitizeHtml(html) {
  return DOMPurify.sanitize(html, {
    // href/xlink:href + use: 代码块的复制按钮是 <use href="#i-copy"> 引用文档内 sprite,
    //   DOMPurify 默认既不给 use 上链接、也会把 use 本身摘掉, 不补这两个就是"按钮在、图标没"
    ADD_ATTR: ["target", "data-copy", "href", "xlink:href"],
    ADD_TAGS: ["use"],
    FORBID_TAGS: ["style", "form", "input", "textarea", "select", "option"],
    FORBID_ATTR: ["srcset"],
  });
}

export function renderMd(t) {
  const src = String(t == null ? "" : t);
  return sanitizeHtml(MD.render(src));
}

// 冒烟测试与调试用: 渲染管线是纯函数, 暴露出来才能在真实渲染进程里断言 (含 XSS 用例)
window.PPXMarkdown = { render: renderMd };
