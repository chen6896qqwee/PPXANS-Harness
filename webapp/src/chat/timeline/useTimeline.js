// webapp/src/chat/timeline/useTimeline.js - 时间线的行为层: 滚动跟随 / 复制 / 编辑重发 / 卡片文案
// 2026-11-13 从 Timeline.vue 抽出, 组件只剩模板与样式。
// 不变量: 这些函数只读写既有 chat.items 记录, 不新建状态机; 展开/折叠仍写 item 上的字段,
//   与拆出前完全一致 (轮询重绘靠 reactive 重新渲染, 不依赖 DOM)。

import { computed, nextTick, onMounted, ref, watch } from "vue";
import { chat, agentColor, toolKindOf, resolveApproval, rewindAndSend } from "../../stores/chat.js";
import { showToast } from "../../stores/toast.js";
import { renderMd } from "../../markdown/index.js";

export function useTimeline() {
  const el = ref(null);

  const lastUser = computed(() => {
    for (let i = chat.items.length - 1; i >= 0; i--) {
      if (chat.items[i].kind === "user") return chat.items[i].id;
    }
    return null;
  });
  const lastAgent = computed(() => {
    for (let i = chat.items.length - 1; i >= 0; i--) {
      if (chat.items[i].kind === "agent") return chat.items[i].id;
    }
    return null;
  });

  /* 滚动: 近底部跟随, 离底部浮「新内容」跳转按钮 (旧版 unseen 语义) */
  const nearBottom = ref(true);
  const showJump = ref(false);
  function onScroll() {
    const e = el.value;
    if (!e) return;
    nearBottom.value = e.scrollHeight - e.scrollTop - e.clientHeight < 140;
    if (nearBottom.value) showJump.value = false;
  }
  function toBottom(force) {
    const e = el.value;
    if (!e) return;
    if (nearBottom.value || force) {
      e.scrollTop = e.scrollHeight;
      showJump.value = false;
    } else {
      showJump.value = true;
    }
  }
  function jump() {
    const e = el.value;
    if (e) e.scrollTop = e.scrollHeight;
    showJump.value = false;
  }
  watch(() => chat.items.length, () => nextTick(() => toBottom(true)));
  watch(() => chat.items.map((x) => (x.text || "").length).reduce((a, b) => a + b, 0), () => nextTick(() => toBottom(false)));
  onMounted(() => { toBottom(true); });

  /* 复制 (代码块 / 整条消息) */
  function copyText(text) {
    const done = () => showToast("已复制");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => legacyCopy(text, done));
    } else legacyCopy(text, done);
  }
  function legacyCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch { showToast("复制失败, 请手动选择", true); }
    ta.remove();
  }
  function onCopyClick(e, item) {
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    if (btn.getAttribute("data-copy") === "code") {
      const wrap = btn.closest(".codewrap");
      const code = wrap && wrap.querySelector("code");
      if (code) copyText(code.textContent);
    } else {
      copyText(item.text || "");
    }
  }

  /* 用户消息图片路径抽取 → 内联缩略图 */
  function imgsOf(text) {
    const out = [];
    String(text).replace(/[^\s"'`，。；;：:,，()（）]+\.(?:png|jpe?g|gif|webp|bmp)/gi, (m) => { out.push(m); return m; });
    return out;
  }

  /* 编辑重发 */
  const editing = ref(null);
  const editText = ref("");
  function beginEdit(item) {
    if (chat.streaming) { showToast("生成中, 请先停止", true); return; }
    editing.value = item.id;
    editText.value = item.text;
  }
  function cancelEdit() { editing.value = null; }
  function sendEdit(item) {
    const text = editText.value.trim();
    if (!text) { showToast("消息不能为空", true); return; }
    editing.value = null;
    rewindAndSend(text);
  }

  function md(text) { return renderMd(text || ""); }
  function fmtTs(ts) {
    const d = new Date(ts || Date.now());
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function dur(ms) {
    return (ms / 1000).toFixed(ms < 1000 ? 2 : 1) + "s";
  }
  function toolSummary(item) { return item.tsum; }

  // 工具名 → 人话。图上是"查找文件 · memory/**/*.md"这种读法, 不是"glob: pattern=..."。
  // 认不出来的工具直接显示原名 (100+ 内置工具不值得逐个翻译, 原名也是有效信息)。
  const TOOL_LABEL = {
    run_command: "运行命令", run_command_bg: "后台运行",
    read_file: "读取", write_file: "写入", edit_file: "编辑", apply_patch: "编辑",
    list_dir: "列出目录", glob: "查找文件", grep: "搜索内容", search_files: "搜索内容",
    memory_add: "写入记忆", memory_search: "检索记忆", memory_recall: "检索记忆",
    web_fetch: "联网", browse: "联网", ask_user: "提问",
    spawn_agent: "派活", self_audit: "自审", create_skill: "写技能",
    tool_schema: "查工具", update_plan: "改计划", goal_board: "目标看板",
  };
  function toolLabel(name) { return TOOL_LABEL[name] || name; }

  // 思考行摘要: 取首段压成一行, 太长截断 —— 展开才看全文
  function thinkBrief(item) {
    const t = String(item.text || "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    return t.length > 108 ? t.slice(0, 108) + "…" : t;
  }

  /* 工具结果的展示形态按工具名分流 (shell 看末尾, 其余看开头) */
  function toolFold(item) {
    const text = String(item.result == null ? "" : item.result).replace(/\s+$/, "");
    const lines = (text || "（无输出）").split("\n");
    const kind = toolKindOf(item.tool);
    const folded = kind === "shell" && lines.length > 3 ? lines.slice(-3) : lines.slice(0, 3);
    return { lines, folded, rest: Math.max(0, lines.length - folded.length) };
  }
  function toolLines(item) { return item.resultOpen ? toolFold(item).lines : toolFold(item).folded; }
  function toolRest(item) { return toolFold(item).rest; }

  function toggleTool(item) { item.argsOpen = !item.argsOpen; }
  function onApprovalKey(item, act) { resolveApproval(item.aId, act); }
  function qAnswer(item, qi, label, checked) {
    const a = item.answers[qi];
    if (!a) return;
    if (checked) {
      if (!item.qs[qi] || !item.qs[qi].multiSelect) a.selected = [label];
      else if (!a.selected.includes(label)) a.selected.push(label);
    } else {
      a.selected = a.selected.filter((x) => x !== label);
    }
  }
  function qLabelOf(o) { return typeof o === "string" ? o : ((o && o.label) || ""); }
  function qDescOf(o) { return o && typeof o === "object" ? (o.description || "") : ""; }

  return {
    el, lastUser, lastAgent, showJump,
    onScroll, jump, copyText, onCopyClick, imgsOf,
    editing, editText, beginEdit, cancelEdit, sendEdit,
    md, fmtTs, dur, toolSummary, toolLabel, thinkBrief,
    toolLines, toolRest, toggleTool, onApprovalKey,
    qAnswer, qLabelOf, qDescOf, agentColor,
  };
}
