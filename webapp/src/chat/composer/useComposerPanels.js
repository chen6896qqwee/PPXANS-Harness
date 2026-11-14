// webapp/src/chat/composer/useComposerPanels.js - 输入框的两个联想面板
//
// 从 Composer.vue 抽出来的一块自包含逻辑 (2026-11-08):
//   · 命令面板: 输入 `/` 时列出可用斜杠命令, 上下键选择
//   · @ 引用: 输入 `@` 时列工作区文件, 选中后插入文本并挂到 refFiles
// 两块的共同点: 都只依赖「输入框 DOM ref + chat.input + 光标位置」, 与发送/附件/座椅无关。
// 抽出来以后 Composer 只剩编排 (键盘优先级 / 发送 / 附件), 改联想规则不用碰主组件。
//
// 保持不变的行为:
//   · 生成中不弹联想 (chat.streaming 时不响应 @; `/` 面板同样被 streaming 挡住)
//   · 斜杠开头时不弹 @ 面板 (避免 `/cmd @x` 抢焦点)
//   · 文件列表按「文件名前缀 > 文件名包含 > 路径包含」打分, 同分短的优先, 最多 12 条
//   · 选中后光标落在插入串之后
import { computed, nextTick, watch } from "vue";
import { chat } from "../../stores/chat.js";
import { rail } from "../../stores/rail.js";
import { workspaceTreeApi } from "../../api/endpoints.js";

/**
 * @param {import("vue").Ref<HTMLTextAreaElement|null>} inp 输入框 ref (用于读写光标)
 */
export function useComposerPanels(inp) {
  /* ---------- 命令面板 (/) ---------- */
  const paletteList = computed(() => {
    const q = (chat.input || "").slice(1).split(/\s/)[0].toLowerCase();
    return chat.commands
      .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.description || "").toLowerCase().includes(q))
      .slice(0, 20);
  });
  watch(() => chat.input, (v) => {
    if (v && v.charAt(0) === "/" && !chat.streaming && paletteList.value.length && !v.includes("\n")) {
      chat.paletteOpen = true;
      chat.paletteSel = 0;
    } else if (chat.paletteOpen) {
      chat.paletteOpen = false;
    }
  });
  function pickCommand(c) {
    chat.input = "/" + c.name + " ";
    chat.paletteOpen = false;
    inp.value && inp.value.focus();
  }
  function movePalette(dir) {
    const n = paletteList.value.length;
    if (!n) return;
    chat.paletteSel = (chat.paletteSel + dir + n) % n;
  }

  /* ---------- @ 文件引用 ---------- */
  const atToken = computed(() => {
    const i = inp.value;
    if (!i) return null;
    const pos = i.selectionStart || 0;
    const before = (chat.input || "").slice(0, pos);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!m) return null;
    return { q: m[2], start: pos - m[2].length - 1, end: pos };
  });
  watch(() => chat.input, async () => {
    await nextTick();
    const tok = chat.streaming ? null : atToken.value;
    if (tok && !(chat.input || "").charAt(0).startsWith("/")) {
      await loadAtFiles();
      const needle = String(tok.q || "").toLowerCase();
      const files = chat.atFiles || [];
      const scored = files.map((p) => {
        const base = p.split("/").pop().toLowerCase();
        const s = !needle
          ? (p.split("/").length <= 2 ? 2 : 1)
          : (base.indexOf(needle) === 0 ? 3 : base.indexOf(needle) !== -1 ? 2 : p.toLowerCase().indexOf(needle) !== -1 ? 1 : 0);
        return { p, s };
      }).filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.p.length - b.p.length)
        .slice(0, 12);
      chat.atMatches = scored.map((x) => x.p);
      if (chat.atMatches.length) { chat.atPaletteOpen = true; chat.atSel = 0; }
      else chat.atPaletteOpen = false;
    } else if (chat.atPaletteOpen) {
      chat.atPaletteOpen = false;
    }
  }, { deep: false });

  async function loadAtFiles() {
    const key = rail.wsSub || "";
    if (chat.atFiles && chat.atFilesKey === key) return;
    try {
      const j = await workspaceTreeApi(4, key);
      chat.atFiles = flattenFiles(j && j.tree, []);
      chat.atFilesKey = key;
    } catch {
      chat.atFiles = [];
      chat.atFilesKey = key;
    }
  }
  function flattenFiles(node, out) {
    if (!node) return out;
    if (node.type === "file") out.push(node.path);
    (node.children || []).forEach((c) => flattenFiles(c, out));
    return out;
  }
  function pickAt(p) {
    const tok = atToken.value;
    const i = inp.value;
    if (!tok || !i) { chat.atPaletteOpen = false; return; }
    const v = chat.input || "";
    const before = v.slice(0, tok.start);
    const after = v.slice(tok.end);
    const insert = "@" + p + " ";
    chat.input = before + insert + after;
    const caret = (before + insert).length;
    nextTick(() => { try { i.setSelectionRange(caret, caret); } catch { /* 忽略 */ } });
    if (!chat.refFiles.includes(p)) chat.refFiles.push(p);
    chat.atPaletteOpen = false;
    i.focus();
  }
  function moveAt(dir) {
    const n = chat.atMatches.length;
    if (!n) return;
    chat.atSel = (chat.atSel + dir + n) % n;
  }
  function atName(p) { return p.split("/").pop(); }
  function atDir(p) { return p.slice(0, Math.max(0, p.length - atName(p).length - 1)); }

  return { paletteList, pickCommand, movePalette, pickAt, moveAt, atName, atDir };
}
