<!-- webapp/src/layout/SideRail.vue - 左栏: 一级导航 + 最近对话 (v5.1 收拢)
     改动要点: 原来 6 个分组 + 8 个能力入口 + 3 个脚注 = 17 个位置并列, 新人不知道先点哪个。
     现在只留 4 个一级导航, 其余全部收进「能力」页; 任务/项目各自成页, 侧栏只保留最常用的会话列表。
     功能没有删: 会话的置顶/重命名/归档/删除/搜索、归档分组、同步状态、运行阶段都在原处。 -->
<script setup>
import { computed, ref } from "vue";
import Icon from "../common/Icon.vue";
import { ui, showView, setSide, setDrawerTab, promptAsk, MAIN_ROUTES } from "../stores/ui.js";
import { rail, loadSessions, togglePin, renameSession, archiveSession, removeSession, searchSessions } from "../stores/rail.js";
import { fmtTs } from "../stores/fmt.js";
import { chat, newSession, switchSession, onThrottleRecovered } from "../stores/chat.js";
import { bot, loadState } from "../stores/bot.js";
import { showToast } from "../stores/toast.js";
import { onStatus } from "../api/client.js";
import { T } from "../i18n/lexicon.js";

const sync = ref({ throttled: false, retryInSec: 0, wasThrottled: false, okFlash: false });

onStatus((st) => {
  const s = sync.value;
  if (st.throttled) {
    s.throttled = true;
    s.wasThrottled = true;
    s.retryInSec = st.retryInSec;
    return;
  }
  if (s.wasThrottled) {
    s.wasThrottled = false;
    s.throttled = false;
    s.okFlash = true;
    setTimeout(() => { s.okFlash = false; }, 3000);
    onThrottleRecovered(() => {
      if (ui.drawer && ui.drawerTab === "tickets") setDrawerTab("tickets");
    });
  } else {
    s.throttled = false;
  }
});

const activeSessions = computed(() => rail.sessions.filter((s) => !s.archived));
const archivedSessions = computed(() => rail.sessions.filter((s) => s.archived));

function openSession(s) {
  switchSession(s.key, s.title || s.name);
  showView("chat");
}
async function onSessionAction(e, s, archived) {
  if (e.act === "pin") { togglePin(s.key, !s.pinned); return; }
  if (e.act === "ren") { renameSession(s.key, s.title || s.name || s.key); return; }
  if (e.act === "arch") { archiveSession(s.key, !archived); return; }
  if (e.act === "del") {
    const ok = await removeSession(s.key);
    if (ok && chat.sessionKey === s.key) newSession();
    loadSessions();
  }
}
async function doSearch() {
  const q = await promptAsk("在全部会话的消息正文里搜索 (清空 = 恢复全部)。", { title: "搜索会话", placeholder: "关键词" });
  if (q == null) return;
  const trimmed = String(q).trim();
  if (!trimmed) return;
  try {
    const hits = await searchSessions(trimmed);
    rail.searchHits = hits;
    rail.searchQuery = trimmed;
  } catch (e) {
    showToast("搜索失败: " + ((e && e.message) || "未知错误"), true);
  }
}
function clearSearch() { rail.searchHits = null; rail.searchQuery = ""; }
</script>

<template>
  <aside id="side" class="side" :class="{ collapsed: ui.sideCollapsed }">
    <div class="brand">
      <span class="mark"><Icon name="mark" :size="19" /></span>
      <span class="bname">{{ T.brand }}</span>
      <span class="btag">{{ chat.versionTag }}</span>
      <span class="flex1" />
      <button class="icobtn" :title="T.runState" :aria-label="T.runState" @click="showView('body')">
        <Icon name="pulse" :size="16" />
        <span class="bdot" :data-t="(bot.s && bot.s.overall) || 'unknown'" />
      </button>
      <button class="icobtn" title="收起侧栏" aria-label="收起侧栏" @click="setSide(true)">
        <Icon name="collapse" :size="16" />
      </button>
    </div>

    <button id="btnNewBot" class="newchat" @click="newSession(); showView('chat')">
      <Icon name="plus" :size="15" />
      {{ T.newChat }}
    </button>

    <!-- 一级导航: 4 项, 由路由表驱动 (ui.js ROUTES) -->
    <nav class="nav">
      <button
        v-for="r in MAIN_ROUTES" :key="r.id"
        class="navi" :class="{ on: ui.view === r.id }"
        :title="r.label" @click="showView(r.id)"
      >
        <Icon :name="r.icon" :size="16" />
        <span>{{ r.label }}</span>
      </button>
    </nav>

    <div class="side-scroll">
      <div class="group">
        <div class="ghead">
          <span class="lab">{{ T.recentChats }}</span>
          <span class="gacts">
            <button class="icobtn sm" title="搜索会话" aria-label="搜索会话" @click="doSearch"><Icon name="search" :size="14" /></button>
            <button class="icobtn sm" title="刷新" aria-label="刷新" @click="loadSessions"><Icon name="refresh" :size="14" /></button>
            <button id="btnNew" class="icobtn sm" title="新会话" aria-label="新会话" @click="newSession(); showView('chat')"><Icon name="plus" :size="14" /></button>
          </span>
        </div>
        <div class="gbody">
          <!-- 搜索结果模式 -->
          <template v-if="rail.searchHits">
            <button class="sess-arch-head" title="清除搜索, 回到会话列表" @click="clearSearch">
              <Icon name="search" :size="12" /><span>{{ rail.searchQuery }} · {{ rail.searchHits.length }} 条</span><Icon name="close" :size="12" />
            </button>
            <div v-if="!rail.searchHits.length" class="empty">没有匹配的会话</div>
            <button
              v-for="h in rail.searchHits" :key="h.key" class="sess hit" :class="{ on: h.key === chat.sessionKey }"
              :title="(h.title || h.key) + (h.ts ? ' · ' + fmtTs(h.ts) : '')" @click="openSession(h); clearSearch()"
            >
              <Icon :name="h.role === 'user' ? 'edit' : 'bot'" :size="13" />
              <span class="hitbody">
                <span class="t">{{ h.title || h.key }}</span>
                <span class="snip">{{ h.snippet || "" }}</span>
              </span>
            </button>
          </template>
          <!-- 常规列表: 活跃在上, 归档分组可展开 -->
          <template v-else>
            <div v-if="!rail.sessions.length" class="empty">暂无会话</div>
            <button
              v-for="s in activeSessions" :key="s.key" class="sess"
              :class="{ on: s.key === chat.sessionKey, pinned: s.pinned, streaming: s.key === chat.sessionKey && chat.streaming }"
              :title="(s.title || s.name || s.key) + (s.ts ? ' · ' + fmtTs(s.ts) : '') + (s.pinned ? ' · 已置顶' : '')"
              @click="openSession(s)"
            >
              <Icon name="file" :size="13" />
              <span class="t">{{ s.title || s.name || s.key || "(未命名)" }}</span>
              <span class="del act" :title="s.pinned ? '取消置顶' : '置顶'" @click.stop="togglePin(s.key, !s.pinned)"><Icon name="pin" :size="13" /></span>
              <span class="del act" title="重命名" @click.stop="renameSession(s.key, s.title || s.name || s.key)"><Icon name="edit" :size="13" /></span>
              <span class="del act" title="归档 (不删除, 可恢复)" @click.stop="archiveSession(s.key, true)"><Icon name="folder-open" :size="13" /></span>
              <span class="del act" title="删除" @click.stop="onSessionAction({ act: 'del' }, s, false)"><Icon name="trash" :size="13" /></span>
            </button>
            <template v-if="archivedSessions.length">
              <button class="sess-arch-head" title="自动归档: 超过 7 天未活跃的会话 (数据保留, 可恢复)" @click="chat.showArchived = !chat.showArchived">
                <Icon name="folder" :size="12" />
                <span>已归档 ({{ archivedSessions.length }})</span>
                <Icon :name="chat.showArchived ? 'chev-d' : 'chev-r'" :size="12" />
              </button>
              <template v-if="chat.showArchived">
                <button
                  v-for="s in archivedSessions" :key="s.key" class="sess archived" :class="{ on: s.key === chat.sessionKey }"
                  :title="(s.title || s.name || s.key) + ' · 已归档'" @click="openSession(s)"
                >
                  <Icon name="file" :size="13" />
                  <span class="t">{{ s.title || s.name || s.key || "(未命名)" }}</span>
                  <span class="del act" title="恢复到活跃列表" @click.stop="archiveSession(s.key, false)"><Icon name="plus" :size="13" /></span>
                  <span class="del act" title="删除" @click.stop="onSessionAction({ act: 'del' }, s, true)"><Icon name="trash" :size="13" /></span>
                </button>
              </template>
            </template>
          </template>
        </div>
      </div>
    </div>

    <div class="sidefoot">
      <button
        v-if="sync.throttled || sync.okFlash" class="syncchip" :data-state="sync.throttled ? 'warn' : 'ok'"
        :title="sync.throttled ? '本地服务每分钟最多 60 次请求, 当前已用满 · 点击立即重试' : '请求节流已结束, 数据已补拉'"
        @click="chat._syncRetry && chat._syncRetry()"
      >
        <span class="syncdot" />{{ sync.throttled ? "同步暂停 · " + Math.max(1, sync.retryInSec) + "s 后自动恢复" : "连接已恢复" }}
      </button>
      <button class="cap guidebtn" :title="T.guide" :aria-label="T.guide" @click="ui.onboarding = true">
        <Icon name="spark" :size="14" />{{ T.guide }}
      </button>
      <button class="cap guidebtn" title="外观 · 主题 / 配色 / 壁纸" aria-label="外观" @click="ui.settingsModal = 'appearance'">
        <Icon name="sun" :size="14" />外观
      </button>
      <div class="agentline">
        <span class="dot" :class="{ on: chat.life }" />
        <span class="lifetxt">{{ T.stage }} {{ chat.life || "—" }}</span>
        <button class="linkbtn" title="重新读取状态" @click="loadState(true)"><Icon name="refresh" :size="11" /></button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.side {
  width: var(--side-w);
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-right: 1px solid var(--border);
  min-height: 0;
  transition: width var(--t-med), margin-left var(--t-med);
  overflow: hidden;
}
.side.collapsed { width: 0; border-right: none; }
.brand {
  display: flex; align-items: center; gap: 7px;
  padding: 12px 12px 8px; flex: none;
}
.brand .mark { color: var(--accent); display: flex; }
.bname { font-weight: 700; font-size: 14.5px; letter-spacing: 0.5px; }
.btag { font-size: 10.5px; color: var(--text-4); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; }
.bdot { width: 7px; height: 7px; border-radius: 50%; margin-left: 5px; display: inline-block; background: var(--text-4); }
.bdot[data-t="ok"] { background: var(--ok); }
.bdot[data-t="warn"] { background: var(--warn); }
.bdot[data-t="bad"] { background: var(--err); }
.newchat {
  margin: 2px 12px 10px; padding: 8px 12px; flex: none;
  display: flex; align-items: center; gap: 7px; justify-content: center;
  background: var(--accent-soft); color: var(--accent);
  border: 1px solid var(--accent-border); border-radius: var(--r-md);
  font-weight: 600; cursor: pointer; transition: background var(--t-fast);
}
.newchat:hover { background: var(--accent); color: var(--on-accent); }
/* 一级导航 */
.nav { display: flex; flex-direction: column; gap: 1px; padding: 0 8px 6px; flex: none; }
.navi {
  display: flex; align-items: center; gap: 9px; width: 100%;
  padding: 7px 9px; border-radius: var(--r-sm); border: none; background: none;
  color: var(--text-2); cursor: pointer; font-size: 13px; text-align: left;
  transition: background var(--t-fast), color var(--t-fast);
}
.navi:hover { background: var(--surface-2); color: var(--text); }
.navi.on { background: var(--surface-3); color: var(--text); font-weight: 600; }
.navi.on svg { color: var(--accent); }
.side-scroll { flex: 1; overflow-y: auto; min-height: 0; padding: 4px 8px 8px; }
.group { margin-bottom: 12px; }
.ghead {
  display: flex; align-items: center; padding: 4px 6px;
  color: var(--text-3); font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase;
}
.gacts { display: inline-flex; gap: 2px; align-items: center; margin-left: auto; }
.gbody { display: flex; flex-direction: column; gap: 1px; }
.sess {
  display: flex; align-items: center; gap: 7px; width: 100%;
  padding: 5px 8px; border-radius: var(--r-sm); border: none;
  background: none; color: var(--text-2); cursor: pointer; text-align: left;
  font-size: 12.8px; transition: background var(--t-fast), color var(--t-fast);
}
.sess:hover { background: var(--surface-2); color: var(--text); }
.sess:hover .del { opacity: 1; }
.sess.on { background: var(--surface-3); color: var(--text); }
.sess .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sess .del { opacity: 0; display: inline-flex; flex: none; transition: opacity var(--t-fast); }
.sess .del:hover { color: var(--err); }
.sess.streaming::after {
  content: ""; width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent); animation: pulse-dot 1.2s infinite; flex: none;
}
.sess .snip { display: block; font-size: 11px; color: var(--text-4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sess .hitbody { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.sess-arch-head {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 5px 8px; border: none; background: none; cursor: pointer;
  color: var(--text-3); font-size: 11.5px; border-radius: var(--r-sm);
}
.sess-arch-head:hover { background: var(--surface-2); color: var(--text-2); }
.cap {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 5px 8px; border-radius: var(--r-sm); border: none;
  background: none; color: var(--text-2); cursor: pointer; font-size: 12.8px;
  transition: background var(--t-fast), color var(--t-fast);
}
.cap:hover { background: var(--surface-2); color: var(--text); }
.guidebtn { color: var(--text-3); }
.sidefoot { flex: none; padding: 8px 10px 10px; border-top: 1px solid var(--border-soft); display: flex; flex-direction: column; gap: 6px; }
.syncchip {
  display: flex; align-items: center; gap: 7px; padding: 5px 10px;
  border-radius: var(--r-sm); border: 1px solid var(--border);
  background: var(--surface-2); color: var(--text-2); cursor: pointer; font-size: 11.5px;
}
.syncchip[data-state="warn"] { border-color: var(--warn); color: var(--warn); background: var(--warn-soft); }
.syncchip[data-state="ok"] { border-color: var(--ok); color: var(--ok); background: var(--ok-soft); }
.syncdot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; animation: pulse-dot 1s infinite; }
.agentline { display: flex; align-items: center; gap: 7px; color: var(--text-3); font-size: 11.5px; padding: 0 4px; }
.agentline .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-4); }
.agentline .dot.on { background: var(--ok); }
.linkbtn { border: none; background: none; color: var(--text-4); cursor: pointer; display: inline-flex; padding: 0 2px; }
.linkbtn:hover { color: var(--text); }
.flex1 { flex: 1; }
</style>
