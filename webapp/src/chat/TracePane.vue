<!-- webapp/src/chat/TracePane.vue - 轨迹页签: 工具调用 + 事件流按天回翻 -->
<script setup>
import { computed, onMounted } from "vue";
import Icon from "../common/Icon.vue";
import { bot, loadTraces } from "../stores/bot.js";
import { fmtMs } from "../stores/fmt.js";

const statsText = computed(() => {
  const all = bot.traces;
  const st = bot.traceStats || {};
  if (!all.length) return bot.traceDay ? bot.traceDay + " 没有记录" : "今天还没有记录";
  return [
    (st.count || all.length) + " 条",
    "工具 " + (st.tools || 0),
    "事件 " + (st.notes || 0),
    st.failed ? "失败 " + st.failed : null,
    st.totalMs ? "耗时 " + fmtMs(st.totalMs) : null,
  ].filter(Boolean).join(" · ");
});
onMounted(() => loadTraces());

const filtered = computed(() => {
  const q = String(bot.traceFilter || "").trim().toLowerCase();
  const all = bot.traces.slice();
  if (!q) return all;
  return all.filter((t) =>
    (String(t.name || "") + " " + String(t.detail || "") + " " + String(t.error || "")).toLowerCase().includes(q));
});
</script>

<template>
  <div id="pane-trace" class="trace-pane">
    <div class="ttools">
      <span class="tstat">{{ statsText }}</span>
      <select :value="bot.traceDay" title="执行过程按天归档, 可翻以前的日子" @change="loadTraces($event.target.value || '')">
        <option value="">今天</option>
        <option v-for="d in bot.traceDays" :key="d" :value="d">{{ d }}</option>
      </select>
      <span class="flex1" />
      <input v-model="bot.traceFilter" placeholder="过滤工具 / 错误…" spellcheck="false">
      <button class="icobtn sm" title="刷新执行过程" aria-label="刷新执行过程" @click="loadTraces()"><Icon name="refresh" :size="14" /></button>
    </div>
    <div class="tlist">
      <div v-if="!filtered.length" class="empty">
        {{ bot.traceFilter ? "没有匹配的记录" : (bot.traceDay ? "这一天没有记录" : "今天还没有记录") }}
      </div>
      <div v-for="(t, i) in filtered" :key="i" class="titem" :class="{ bad: t.ok === false }">
        <span class="tname" :style="t.kind === 'note' ? 'color:var(--text-3)' : ''">{{ t.name || "?" }}</span>
        <span class="targ" :title="t.ok === false ? (t.error || '失败') : (t.detail || '')">{{ t.ok === false ? (t.error || "失败") : (t.detail || "") }}</span>
        <span class="tms">{{ t.ms ? fmtMs(t.ms) : "" }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trace-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 8px 16px 12px; }
.ttools { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.tstat { font-size: 11.5px; color: var(--text-3); white-space: nowrap; }
.ttools input { font-size: 12px; width: 200px; }
.ttools select { font-size: 12px; }
.tlist { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.titem {
  display: flex; align-items: center; gap: 10px;
  padding: 4px 10px; border-radius: var(--r-sm); font-size: 12px;
}
.titem:nth-child(odd) { background: var(--surface-2); }
.titem.bad .tname, .titem.bad .targ { color: var(--err); }
.tname { font-family: ui-monospace, Consolas, monospace; color: var(--text-2); flex: none; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.targ { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-3); }
.tms { font-size: 10.5px; color: var(--text-4); flex: none; }
.flex1 { flex: 1; }
</style>
