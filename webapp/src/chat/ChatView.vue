<!-- webapp/src/chat/ChatView.vue - 对话页: 头部 + 对话/轨迹双页签 -->
<script setup>
import { computed } from "vue";
import Icon from "../common/Icon.vue";
import Hero from "./Hero.vue";
import Timeline from "./Timeline.vue";
import Composer from "./Composer.vue";
import TracePane from "./TracePane.vue";
import ReadyBanner from "../components/ReadyBanner.vue";
import { chat, newSession, rewindAndSend } from "../stores/chat.js";
import { showToast } from "../stores/toast.js";
import { bot } from "../stores/bot.js";
import { ui, showView } from "../stores/ui.js";
import { theme, cycleTheme, LABEL as THEME_LABEL } from "../stores/theme.js";
import { providerLabel, fmtTok } from "../stores/chat.js";

const botState = computed(() => (bot.s && bot.s.bot) || null);
const live = computed(() => (bot.s && bot.s.live) || {});
const subBits = computed(() => {
  const b = botState.value;
  const l = live.value;
  const bits = [];
  if (b) bits.push(b.typeName || "");
  bits.push(((l.traces && l.traces.count) || 0) + " 次工具调用");
  if (l.pendingApprovals) bits.push(l.pendingApprovals + " 个待批准");
  if (l.stage) bits.push("阶段 " + l.stage);
  if (b && b.paused) bits.push("已暂停");
  return bits.filter(Boolean).join(" · ");
});
const avatarUrl = computed(() => (botState.value && botState.value.avatarUrl) || "");
const botName = computed(() => (botState.value && botState.value.name) || "皮皮虾");
const hasHistory = computed(() => chat.items.length > 0);

const modelText = computed(() => {
  if (chat.llm && chat.llm.current) return chat.llm.current.model || chat.llm.current.id;
  if (chat.providersLoaded) return chat.providers.length ? providerLabel(chat.providers[0]) : "未配置模型";
  return "—";
});
const tokText = computed(() => {
  const t = chat.lastTokens;
  if (!t) return "";
  const txt = t.total != null ? t.total : ((t.input != null || t.output != null) ? ((t.input || 0) + "/" + (t.output || 0)) : null);
  if (txt == null) return "";
  return (typeof txt === "number" ? fmtTok(txt) + " tok" : String(txt));
});
const themeIcon = computed(() => (theme.pref === "system" ? "monitor" : (theme.resolved === "light" ? "moon" : "sun")));
const themeLabel = computed(() => THEME_LABEL[theme.pref]);

function rewind() {
  if (chat.streaming) { showToast("生成中, 请先停止", true); return; }
  // /rewind 走后端命令: 直接作为消息发送 (与旧实现一致), 完成后刷新侧栏
  sendRewind();
}
async function sendRewind() {
  const { send } = await import("../stores/chat.js");
  send("/rewind");
  setTimeout(() => import("../stores/rail.js").then((r) => r.loadSessions()), 1200);
}
function cycleThemeClick() {
  const next = cycleTheme();
  showToast("主题: " + THEME_LABEL[next]);
}
</script>

<template>
  <section id="view-chat" class="view chatview">
    <header class="botbar">
      <div class="avavt">
        <img v-if="avatarUrl" :src="avatarUrl" alt="">
        <template v-else>{{ String(botName).slice(0, 1) }}</template>
      </div>
      <div class="bmeta">
        <div class="bname2">{{ botName }}</div>
        <div class="bsub">{{ bot.s ? subBits : (bot.pollErr ? "正在重连本地服务…" : "正在连接服务…") }}</div>
      </div>
      <span class="flex1" />
      <button class="icobtn" title="新会话" aria-label="新会话" @click="newSession()"><Icon name="plus" :size="16" /></button>
      <button class="icobtn" title="助手设置" aria-label="助手设置" @click="showView('settings')"><Icon name="settings" :size="16" /></button>
    </header>

    <ReadyBanner />

    <div class="panes">
      <button class="ptab" :class="{ on: ui.chatPane !== 'trace' }" @click="ui.chatPane = 'talk'">对话</button>
      <button class="ptab" :class="{ on: ui.chatPane === 'trace' }" @click="ui.chatPane = 'trace'">执行过程</button>
      <span class="sess-title">{{ chat.sessionTitle }}</span>
      <span class="flex1" />
      <span class="pill" title="审批模式">
        <Icon name="shield" :size="12" /><em>{{ chat.perm }}</em>
      </span>
      <button class="pill clickable" title="当前模型 · 点击配置" @click="ui.settingsModal = 'models'">
        <Icon name="cube" :size="12" /><em>{{ modelText }}</em>
      </button>
      <span v-if="tokText" class="pill"><Icon name="bars" :size="12" /><em>{{ tokText }}</em></span>
      <button class="icobtn" title="回退上一轮对话 (/rewind)" aria-label="回退上一轮对话" @click="rewind">
        <Icon name="refresh" :size="16" />
      </button>
      <button class="icobtn" :title="'主题: ' + themeLabel + ' (点击切换)'" aria-label="切换主题" @click="cycleThemeClick">
        <Icon :name="themeIcon" :size="16" />
      </button>
      <button class="icobtn" title="工作区面板" aria-label="工作区面板" @click="ui.drawer = !ui.drawer">
        <Icon name="panel" :size="16" />
      </button>
    </div>

    <div v-show="ui.chatPane !== 'trace'" class="pane">
      <Hero v-if="!hasHistory" />
      <Timeline v-show="hasHistory" />
      <Composer />
    </div>
    <TracePane v-if="ui.chatPane === 'trace'" />
  </section>
</template>

<style scoped>
.chatview { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.botbar {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 14px; border-bottom: 1px solid var(--border-soft); flex: none;
  background: var(--bg);
}
.avavt {
  width: 32px; height: 32px; border-radius: 10px; flex: none;
  background: var(--accent-soft); color: var(--accent);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 15px; font-weight: 700; overflow: hidden;
}
.avavt img { width: 100%; height: 100%; object-fit: cover; }
.bmeta { min-width: 0; }
.bname2 { font-weight: 700; font-size: 13.5px; line-height: 1.3; }
.bsub { font-size: 11.5px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panes {
  display: flex; align-items: center; gap: 4px;
  padding: 5px 14px; border-bottom: 1px solid var(--border-soft); flex: none;
}
.ptab {
  border: none; background: none; color: var(--text-3); cursor: pointer;
  padding: 3px 12px; border-radius: 99px; font-size: 12.5px;
}
.ptab:hover { color: var(--text); }
.ptab.on { background: var(--surface-3); color: var(--text); }
.sess-title {
  font-size: 12px; color: var(--text-4); margin-left: 10px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px;
}
.pill {
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--border); border-radius: 99px;
  padding: 2px 10px; font-size: 11.5px; color: var(--text-3); background: var(--surface);
}
.pill em { font-style: normal; }
.pill.clickable { cursor: pointer; }
.pill.clickable:hover { color: var(--text); border-color: var(--text-4); }
.pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.flex1 { flex: 1; }
</style>
