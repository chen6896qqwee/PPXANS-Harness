<!-- webapp/src/App.vue - 外壳: 侧栏 + 主区 (七视图) + 抽屉 + 全局弹层 -->
<script setup>
import { defineAsyncComponent, onMounted, onBeforeUnmount } from "vue";
import { ui, ask, settleAsk, setSide, setDrawer } from "./stores/ui.js";
import { chat, pendingQuestionItem, pendingApprovalItem, resolveApproval, skipQuestion, stopGen, toggleAllTools } from "./stores/chat.js";
import SideRail from "./layout/SideRail.vue";
import Drawer from "./layout/Drawer.vue";
import ChatView from "./chat/ChatView.vue";
// 非对话视图按需加载: 首屏只带对话 + 外壳, 其余视图各自成 chunk (减小 1.7MB 主包)
const BotSettingsView = defineAsyncComponent(() => import("./views/BotSettingsView.vue"));
const BodyView = defineAsyncComponent(() => import("./views/BodyView.vue"));
const PluginsView = defineAsyncComponent(() => import("./views/PluginsView.vue"));
const SkillsView = defineAsyncComponent(() => import("./views/SkillsView.vue"));
const McpView = defineAsyncComponent(() => import("./views/McpView.vue"));
const StatsView = defineAsyncComponent(() => import("./views/StatsView.vue"));
const ProjectsView = defineAsyncComponent(() => import("./views/ProjectsView.vue"));
const TasksView = defineAsyncComponent(() => import("./views/TasksView.vue"));
const CapabilitiesView = defineAsyncComponent(() => import("./views/CapabilitiesView.vue"));
import AskModal from "./modals/AskModal.vue";
import DirModal from "./modals/DirModal.vue";
import SettingsModal from "./modals/SettingsModal.vue";
import Onboarding from "./modals/Onboarding.vue";

function isTypingTarget(e) {
  const tag = (e.target && e.target.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || (e.target && e.target.isContentEditable);
}

function onKeydown(e) {
  if (e.key !== "Escape") {
    // Ctrl+O: 展开/收起全部工具结果
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "o" || e.key === "O")) {
      e.preventDefault();
      toggleAllTools();
    }
    // 审批数字快捷键: 焦点不在输入控件内时 1=批准 2=拒绝
    if (!e.defaultPrevented && !e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "1" || e.key === "2")) {
      if (pendingQuestionItem.value) return;
      if (isTypingTarget(e)) return;
      const ap = pendingApprovalItem.value;
      if (!ap) return;
      e.preventDefault();
      resolveApproval(ap.aId, e.key === "1" ? "approve" : "deny");
    }
    return;
  }
  // Esc 语义链 (优先级从高到低): 站内弹窗 → 目录弹层 → 文件预览 → 文件引用 →
  // 命令面板 → 设置弹窗 → 模型/权限浮层 → 提问跳过 → 审批拒绝 → 停止生成
  if (ask.open) { e.preventDefault(); settleAsk(ask.kind === "prompt" ? null : false); return; }
  if (ui.dirModal) { e.preventDefault(); ui.dirModal = null; return; }
  if (ui.fileView) { e.preventDefault(); ui.fileView = null; return; }
  if (chat.atPaletteOpen) { e.preventDefault(); chat.atPaletteOpen = false; return; }
  if (chat.paletteOpen) { e.preventDefault(); chat.paletteOpen = false; return; }
  if (ui.settingsModal) { e.preventDefault(); ui.settingsModal = null; return; }
  if (chat.seatOpen) { e.preventDefault(); chat.seatOpen = false; return; }
  if (chat.permOpen) { e.preventDefault(); chat.permOpen = false; return; }
  const qc = pendingQuestionItem.value;
  if (qc) { e.preventDefault(); skipQuestion(qc); return; }
  const ap = pendingApprovalItem.value;
  if (ap) { e.preventDefault(); resolveApproval(ap.aId, "deny"); return; }
  if (chat.streaming) stopGen();
}

onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="app" :class="{ 'side-collapsed': ui.sideCollapsed }">
    <SideRail />

    <div v-if="ui.drawer" class="drawer-scrim" aria-hidden="true" @click="setDrawer(false)" />
    <aside class="drawer" :class="{ on: ui.drawer }" aria-label="工作区面板">
      <Drawer />
    </aside>

    <button v-show="ui.sideCollapsed" class="side-reveal" title="展开侧栏" aria-label="展开侧栏" @click="setSide(false)">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><use href="#i-panel" /></svg>
    </button>

    <main class="main">
      <!-- 对话页常驻 (时间线/流式状态必须活着, v-show 保活); 其余视图进出挂载, 数据随 onMounted 加载 -->
      <ChatView v-show="ui.view === 'chat'" />
      <ProjectsView v-if="ui.view === 'projects'" />
      <TasksView v-if="ui.view === 'tasks'" />
      <CapabilitiesView v-if="ui.view === 'caps'" />
      <BotSettingsView v-if="ui.view === 'settings'" />
      <BodyView v-if="ui.view === 'body'" />
      <PluginsView v-if="ui.view === 'plugins'" />
      <SkillsView v-if="ui.view === 'skills'" />
      <McpView v-if="ui.view === 'mcp'" />
      <StatsView v-if="ui.view === 'stats'" />
    </main>
  </div>

  <AskModal />
  <DirModal />
  <SettingsModal v-if="ui.settingsModal" />
  <Onboarding />
</template>

<style>
/* 外壳布局 (全局, 非 scoped —— 子组件布局互相咬合) */
.app {
  display: flex;
  height: 100vh;
  overflow: hidden;
  background: var(--bg);
  position: relative;
  z-index: 1; /* 壁纸层 body::before 是 z-index 0 */
}
.app .main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
/* 侧栏压在收起态抽屉之上 (抽屉负 margin 收起时其盒子仍与侧栏同域, 层叠错会盖住侧栏按钮) */
.app > aside.side { position: relative; z-index: 20; }
.app .main > .view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.app .drawer {
  width: var(--drawer-w);
  flex: none;
  border-right: 1px solid var(--border);
  background: var(--surface);
  margin-left: calc(-1 * var(--drawer-w));
  transition: margin-left var(--t-med);
  position: relative;
  z-index: 10;
}
.app .drawer.on { margin-left: 0; }
.drawer-scrim { display: none; }
@media (max-width: 980px) {
  .app .drawer { position: fixed; left: var(--side-w); top: 0; bottom: 0; z-index: 60; box-shadow: var(--shadow-3); margin-left: 0; transform: translateX(-110%); transition: transform var(--t-med); width: min(var(--drawer-w), calc(100vw - var(--side-w))); }
  .app .drawer.on { transform: none; }
  /* 侧栏收起时不再为它留 264px 空洞, 抽屉从视口左侧展开 */
  .app.side-collapsed .drawer { left: 0; width: min(var(--drawer-w), 88vw); }
  .drawer-scrim { display: block; position: fixed; inset: 0; z-index: 55; background: rgba(0, 0, 0, 0.38); }
}
.side-reveal {
  position: fixed; left: 8px; top: 10px; z-index: 40;
  width: 30px; height: 30px; border-radius: var(--r-sm);
  border: 1px solid var(--border); background: var(--surface);
  color: var(--text-2); cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.side-reveal:hover { color: var(--text); background: var(--surface-3); }
</style>
