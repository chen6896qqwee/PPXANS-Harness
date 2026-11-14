<!-- webapp/src/views/TasksView.vue - 任务页: 长活的步骤/状态/结果 (内部叫「工单」) -->
<script setup>
import { computed, onMounted } from "vue";
import Icon from "../common/Icon.vue";
import { showView, setDrawerTab } from "../stores/ui.js";
import { rail, loadTasks, TASK_LABEL } from "../stores/rail.js";
import { panels, loadTickets, TICKET_LABEL } from "../stores/panels.js";
import { addAgentMarkdown } from "../stores/chat.js";
import { T } from "../i18n/lexicon.js";

const list = computed(() => rail.tasks || []);
const running = computed(() => list.value.filter((t) => t.status === "running").length);
const tickets = computed(() => panels.tickets || []);

onMounted(() => { loadTasks(); loadTickets(); });

function openTickets() {
  setDrawerTab("tickets");
}

// 点开任务 = 把详情写进当前对话 (与侧栏旧行为一致, 不新开页面)
function open(t) {
  const lines = ["## " + T.task + " · " + (t.title || t.id), "状态: **" + (TASK_LABEL[t.status] || t.status) + "**"];
  if (t.description) lines.push(t.description);
  (t.steps || []).forEach((s, i) => {
    lines.push((s.status === "done" ? "- [x] " : "- [ ] ") + (s.title || ("步骤 " + (i + 1))));
  });
  if (t.result) lines.push("结果: " + t.result);
  addAgentMarkdown(lines.join("\n"));
  showView("chat");
}
</script>

<template>
  <section id="view-tasks" class="view">
    <header class="botbar">
      <button class="icobtn" title="返回对话" aria-label="返回对话" @click="showView('chat')"><Icon name="back" :size="16" /></button>
      <div class="bmeta">
        <div class="bname2">{{ T.tasks }}</div>
        <div class="bsub">{{ list.length }} 个 · {{ running }} 个进行中 · 每个任务都有步骤和结果，中断了能接着跑</div>
      </div>
      <span class="flex1" />
      <button class="icobtn" title="刷新" aria-label="刷新" @click="loadTasks()"><Icon name="refresh" :size="16" /></button>
    </header>

    <div class="swrap">
      <div v-if="!list.length && !tickets.length" class="pcard">
        <div class="pcard-b">还没有任务。让 {{ T.brand }} 做一件多步骤的事（比如"跑一遍测试并把失败的修掉"），就会在这里留下记录。</div>
      </div>

      <div v-if="list.length" class="shint">可续跑任务 · {{ list.length }} 个</div>
      <div v-for="t in list" :key="t.id" class="pcard">
        <div class="pcard-h">
          <span class="pnm">{{ t.title || t.id }}</span>
          <span class="ptag" :class="'ts-' + (t.status || 'todo')">{{ TASK_LABEL[t.status] || t.status || "待办" }}</span>
        </div>
        <div v-if="t.description" class="pcard-b">{{ t.description }}</div>
        <div v-if="t.steps && t.steps.length" class="pcard-id">
          步骤 {{ t.steps.filter((s) => s.status === "done").length }} / {{ t.steps.length }}
        </div>
        <div class="pacts"><button class="wbtn" @click="open(t)">看详情</button></div>
      </div>

      <div v-if="tickets.length" class="shint">
        执行记录 · {{ tickets.length }} 条
        <button class="wbtn" @click="openTickets">在抽屉里查看</button>
      </div>
      <div v-for="t in tickets" :key="t.id" class="pcard">
        <div class="pcard-h">
          <span class="pnm">{{ t.title || t.id }}</span>
          <span class="ptag" :class="'ts-' + (t.status || 'todo')">{{ TICKET_LABEL[t.status] || t.status }}</span>
        </div>
        <div class="pcard-id">{{ (t.source || "-") + "/" + (t.from || "-") }} · {{ t.createdAt || "" }}</div>
        <div class="pacts"><button class="wbtn" @click="openTickets">看记录</button></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
@import "./manage.css";
.view { display: flex; flex-direction: column; min-height: 0; }
.ptag.ts-running { background: var(--warn-soft); color: var(--warn); }
.ptag.ts-done { background: var(--ok-soft); color: var(--ok); }
.ptag.ts-failed { background: var(--err-soft); color: var(--err); }
</style>
