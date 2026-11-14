<!-- webapp/src/layout/Drawer.vue - 工作区抽屉: 文件树 / 目标看板 / 审查报告 / 工单账本
     2026-11-13: 页签逻辑 (文件过滤 / 打开文件 / 任务详情 / 轮询调度) 抽到 drawer/useDrawer.js,
     递归文件树抽到 drawer/TreeNodes.js; 本组件只剩外壳与目标/审查面板的派生。 -->
<script setup>
import { computed } from "vue";
import Icon from "../common/Icon.vue";
import { ui, setDrawer, closeFileView } from "../stores/ui.js";
import {
  panels, loadTree, loadGoal, loadReview, loadTickets, ticketAct,
  TICKET_LABEL, TICKET_TONE, TICKET_FINAL,
} from "../stores/panels.js";
import { rail } from "../stores/rail.js";
import { chat } from "../stores/chat.js";
import { renderMd } from "../markdown/index.js";
import { TABS, useDrawer } from "./drawer/useDrawer.js";
import { TreeNodes } from "./drawer/TreeNodes.js";

const { wsLabel, ticketHead, filteredFiles, detailCache, openDetails, onTab, openFile, toggleDetail, when } = useDrawer();

const reviewHtml = computed(() => (panels.review && panels.review.report ? renderMd(panels.review.report) : ""));

const evolveSum = computed(() => {
  const j = panels.evolve;
  if (!j) return "";
  const ev = j.evolve, pb = j.playbook, vd = j.verified;
  const bits = [];
  if (ev) bits.push("进化引擎 " + (ev.enabled ? "启用 · 每 " + ev.everyCalls + " 次提炼" : "关闭") + " · 累计 " + ev.calls + " 次");
  if (vd) bits.push("已验证写回 " + (vd.total || 0) + " 条");
  if (pb) bits.push("Playbook " + (pb.total || 0) + " 条");
  return bits.join(" · ");
});
</script>

<template>
  <div class="drawer-inner">
    <div class="dhead">
      <div class="tabs">
        <button
          v-for="[id, label, icon] in TABS" :key="id" class="tab" :class="{ on: ui.drawerTab === id }"
          @click="onTab(id)"
        >
          <Icon :name="icon" :size="13" />{{ label }}
        </button>
      </div>
      <button class="icobtn sm" title="关闭" aria-label="关闭" @click="setDrawer(false)"><Icon name="close" :size="14" /></button>
    </div>

    <!-- 文件树 -->
    <div id="pane-files" v-show="ui.drawerTab === 'files'" class="dpane">
      <div class="pane-tools">
        <span class="wslab" :title="panels.wsRoot + (rail.wsSub ? ' / ' + rail.wsSub : '')">{{ wsLabel }}</span>
        <span class="flex1" />
        <button class="icobtn sm" title="切换工作区目录" aria-label="切换工作区目录" @click="ui.dirModal = { mode: 'dir', rel: rail.wsSub || '' }"><Icon name="folder-open" :size="14" /></button>
        <button class="icobtn sm" title="刷新" aria-label="刷新" @click="loadTree()"><Icon name="refresh" :size="14" /></button>
      </div>
      <input v-model="panels.treeFilter" class="tree-filter" placeholder="过滤文件…" spellcheck="false">
      <div class="tree">
        <div v-if="panels.treeErr" class="empty">
          {{ panels.treeErr }}<br>
          <button class="btn xs" @click="loadTree()">重试</button>
        </div>
        <div v-else-if="!panels.tree.length" class="empty">目录为空</div>
        <template v-else>
          <TreeNodes :nodes="filteredFiles" :depth="0" @open="openFile" />
        </template>
      </div>
      <!-- 文件预览 -->
      <div v-if="ui.fileView" class="fileview">
        <div class="fv-head">
          <span class="fv-path">{{ ui.fileView.path }}</span>
          <span class="flex1" />
          <button class="icobtn sm" title="关闭" aria-label="关闭" @click="closeFileView"><Icon name="close" :size="13" /></button>
        </div>
        <pre class="fv-body">{{ ui.fileView.text }}</pre>
      </div>
    </div>

    <!-- 目标看板 -->
    <div id="pane-goal" v-show="ui.drawerTab === 'goal'" class="dpane">
      <div class="pane-tools">
        <span class="wslab">目标看板</span>
        <span class="flex1" />
        <button class="icobtn sm" title="刷新" aria-label="刷新" @click="loadGoal()"><Icon name="refresh" :size="14" /></button>
      </div>
      <div class="board">
        <div v-if="!panels.goals.length" class="empty">暂无目标 · 发送 /goal 创建</div>
        <div v-for="g in panels.goals" :key="g.id" class="goal">
          <div class="gt">
            <span class="gid">{{ g.id || "" }}</span>
            <span v-if="g.priority" class="badge" :class="'p' + String(g.priority).replace(/^p/i, '')">{{ String(g.priority).toUpperCase() }}</span>
            <span class="gsts" :class="g.status || 'pending'">{{ g.status || "pending" }}</span>
          </div>
          <div class="gmeta">{{ g.title || "" }}</div>
        </div>
      </div>
    </div>

    <!-- 审查报告 -->
    <div id="pane-review" v-show="ui.drawerTab === 'review'" class="dpane">
      <div class="pane-tools">
        <span class="wslab">审查报告</span>
        <span class="flex1" />
        <button class="icobtn sm" title="触发审查" aria-label="触发审查" @click="chat.input = '/review';"><Icon name="spark" :size="14" /></button>
      </div>
      <div class="review">
        <div v-if="!panels.review || (!panels.review.issues.length && !panels.review.report)" class="empty">尚无报告 · 发送 /review 触发</div>
        <template v-else>
          <div v-for="(it, i) in (panels.review.issues || [])" :key="i" class="issue">
            <div class="ihead">
              <span class="badge" :class="it.severity === 'high' ? 'p0' : it.severity === 'medium' ? 'p1' : 'p2'">{{ (it.severity === 'high' ? 'P0' : it.severity === 'medium' ? 'P1' : 'P2') }}</span>
              <span class="ititle">{{ it.title || "" }}</span>
            </div>
            <div class="ifile">{{ (it.file || "") + (it.line ? ":" + it.line : "") }}</div>
            <div v-if="it.detail" class="idetail">{{ it.detail }}</div>
            <div v-if="it.suggestion" class="ifix">→ {{ it.suggestion }}</div>
          </div>
          <div v-if="panels.review.report" class="report-md md" v-html="reviewHtml" />
        </template>
        <div class="evol-head">验收记录</div>
        <div v-if="!panels.verify || (!(panels.verify.executions || []).length && !(panels.verify.verification || {}).total)" class="empty">暂无验收记录 (任务执行后自动积累)</div>
        <template v-else>
          <div class="vsum">已验证 {{ (panels.verify.verification || {}).total || 0 }} 条 · 最近执行 {{ (panels.verify.executions || []).length }} 次</div>
          <div v-for="(e, i) in (panels.verify.executions || []).slice(-15)" :key="i" class="vexec">
            <span class="vtool">{{ e.tool || "" }}</span>
            <span class="badge" :class="e.ok ? 'ok' : 'p0'">{{ e.ok ? "通过" : "失败" }}</span>
            <span class="vmeta">{{ e.durationMs ? e.durationMs + "ms" : "" }}</span>
            <div v-if="e.error" class="vdetail">{{ e.error }}</div>
            <div class="vargs">{{ e.args || "" }}</div>
          </div>
        </template>
        <div class="evol-head">自我进化</div>
        <div v-if="evolveSum" class="vsum">{{ evolveSum }}</div>
        <template v-if="panels.evolve && panels.evolve.playbook && (panels.evolve.playbook.bullets || []).length">
          <div v-for="(b, i) in panels.evolve.playbook.bullets" :key="i" class="bullet">
            <span class="bkind">{{ b.kind || "" }}</span>
            <span class="bcontent">{{ b.content || "" }}</span>
            <span class="bcount">{{ ((b.counters && b.counters.helpful) || 0) }}↑ / {{ ((b.counters && b.counters.harmful) || 0) }}↓</span>
          </div>
        </template>
        <div v-else-if="!evolveSum" class="empty">暂无进化记录 (用久后自动积累)</div>
      </div>
    </div>

    <!-- 工单账本 -->
    <div id="pane-tickets" v-show="ui.drawerTab === 'tickets'" class="dpane">
      <div class="pane-tools">
        <span class="wslab">{{ ticketHead }}</span>
        <span class="flex1" />
        <button class="icobtn sm" title="刷新" aria-label="刷新" @click="loadTickets()"><Icon name="refresh" :size="14" /></button>
      </div>
      <div class="board">
        <div v-if="panels.ticketsDisabled" class="empty">任务记录未启用 · agent.work_graph.enabled=false</div>
        <template v-else>
          <div class="tk-filter">
            <button
              v-for="[v, label] in [['', '全部'], ['admitted', '排队'], ['working', '执行中'], ['failed', '失败'], ['done', '完成']]"
              :key="v" class="tk-chip" :class="{ on: panels.ticketStatus === v }" @click="panels.ticketStatus = v; loadTickets()"
            >{{ label }}</button>
          </div>
          <div v-if="!panels.tickets.length" class="empty">
            {{ panels.ticketStatus ? "没有该状态的任务" : "暂无任务记录 · 通道收到消息或使用 /work 查看" }}
          </div>
          <div v-for="t in panels.tickets" :key="t.id" class="tk">
            <div class="tk-head">
              <span class="badge" :class="TICKET_TONE[t.status] || 'ts-todo'">{{ TICKET_LABEL[t.status] || t.status }}</span>
              <span class="tk-src">{{ (t.source || "-") + "/" + (t.from || "-") }}</span>
              <span class="flex1" />
              <span class="tk-time">{{ when(t.createdAt) }}</span>
            </div>
            <div class="tk-text" title="点击查看详情" @click="toggleDetail(t.id)">
              {{ String(t.textPreview || t.text || t.resultPreview || "(空)").slice(0, 160) }}
            </div>
            <div class="tk-meta">
              {{ t.id }} · {{ t.sessionKey || "-" }}
              <template v-if="t.attempts"> · 尝试 {{ t.attempts }}</template>
              <template v-if="t.worker"> · {{ t.worker }}</template>
            </div>
            <pre v-if="openDetails.has(t.id)" class="tk-pre">{{ detailCache.get(t.id) || "加载中…" }}</pre>
            <div v-if="!TICKET_FINAL[t.status] || t.status === 'failed' || t.status === 'cancelled'" class="tk-actions">
              <button v-if="!TICKET_FINAL[t.status]" class="tk-btn" @click="ticketAct('cancel', t.id)">取消</button>
              <button v-else class="tk-btn" title="重新执行这个任务 (结果回投原通道)" @click="ticketAct('requeue', t.id)">重跑</button>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.drawer-inner { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.dhead { display: flex; align-items: center; padding: 8px 10px 6px; border-bottom: 1px solid var(--border-soft); }
.tabs { display: flex; gap: 2px; flex: 1; }
.tab {
  display: inline-flex; align-items: center; gap: 5px;
  border: none; background: none; color: var(--text-3); cursor: pointer;
  padding: 4px 10px; border-radius: var(--r-sm); font-size: 12.5px;
}
.tab:hover { color: var(--text); background: var(--surface-2); }
.tab.on { color: var(--accent); background: var(--accent-soft); }
.dpane { flex: 1; display: flex; flex-direction: column; min-height: 0; padding: 8px 10px 10px; }
.pane-tools { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.wslab { font-size: 12px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-filter { margin-bottom: 6px; font-size: 12px; }
.tree { flex: 1; overflow: auto; min-height: 0; }
.tree :deep(.dir), .tree :deep(.f) {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 3px 6px; border: none; background: none; color: var(--text-2);
  cursor: pointer; font-size: 12.3px; border-radius: 4px; text-align: left;
}
.tree :deep(.dir:hover), .tree :deep(.f:hover) { background: var(--surface-2); color: var(--text); }
.tree :deep(.dir .chev) { transition: transform var(--t-fast); flex: none; }
.tree :deep(.dir.open .chev) { transform: rotate(90deg); }
.tree :deep(.kids) { padding-left: 16px; }
.tree :deep(.nm) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree :deep(.f.k-js), .tree :deep(.f.k-ts) { color: var(--chart-2); }
.tree :deep(.f.k-md) { color: var(--chart-3); }
.tree :deep(.f.k-style) { color: var(--chart-4); }
.tree :deep(.f.k-img) { color: var(--chart-5); }
.tree :deep(.f.on) { background: var(--accent-soft); color: var(--accent); }
.fileview { flex: none; max-height: 45%; display: flex; flex-direction: column; border-top: 1px solid var(--border); margin-top: 6px; padding-top: 6px; }
.fv-head { display: flex; align-items: center; gap: 6px; }
.fv-path { font-size: 11.5px; color: var(--text-3); font-family: ui-monospace, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fv-body { flex: 1; overflow: auto; margin: 6px 0 0; padding: 8px; background: var(--bg-soft); border-radius: var(--r-sm); font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; }
.board, .review { flex: 1; overflow: auto; min-height: 0; }
.goal { border: 1px solid var(--border-soft); border-radius: var(--r-sm); padding: 8px 10px; margin-bottom: 6px; background: var(--surface-2); }
.goal .gt { display: flex; align-items: center; gap: 6px; }
.goal .gid { font-size: 10.5px; color: var(--text-4); font-family: ui-monospace, Consolas, monospace; }
.goal .gsts { font-size: 11px; color: var(--text-3); margin-left: auto; }
.goal .gsts.done { color: var(--ok); }
.goal .gsts.active { color: var(--info); }
.goal .gmeta { font-size: 12.5px; margin-top: 3px; }
.issue { border: 1px solid var(--border-soft); border-radius: var(--r-sm); padding: 7px 10px; margin-bottom: 6px; background: var(--surface-2); }
.ihead { display: flex; align-items: center; gap: 7px; }
.ititle { font-size: 12.5px; font-weight: 600; }
.ifile { font-size: 11px; color: var(--text-4); font-family: ui-monospace, Consolas, monospace; margin-top: 2px; }
.idetail { font-size: 12px; color: var(--text-2); margin-top: 3px; }
.ifix { font-size: 12px; color: var(--ok); margin-top: 2px; }
.report-md { margin-top: 8px; font-size: 12.3px; }
.evol-head { font-size: 11.5px; color: var(--text-3); letter-spacing: 1px; margin: 14px 0 6px; border-top: 1px solid var(--border-soft); padding-top: 10px; }
.vsum { font-size: 11.5px; color: var(--text-3); margin-bottom: 6px; }
.vexec { border: 1px solid var(--border-soft); border-radius: var(--r-sm); padding: 5px 8px; margin-bottom: 4px; font-size: 11.5px; }
.vtool { color: var(--text-2); margin-right: 6px; }
.vmeta { color: var(--text-4); margin-left: 6px; }
.vdetail { color: var(--err); margin-top: 2px; }
.vargs { color: var(--text-4); font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; margin-top: 2px; word-break: break-all; }
.bullet { display: flex; gap: 6px; font-size: 11.5px; padding: 3px 0; align-items: baseline; }
.bkind { color: var(--accent); flex: none; font-size: 10.5px; }
.bcontent { color: var(--text-2); flex: 1; }
.bcount { color: var(--text-4); flex: none; }
/* 工单 */
.tk-filter { display: flex; gap: 4px; margin-bottom: 8px; flex-wrap: wrap; }
.tk-chip {
  border: 1px solid var(--border); background: none; color: var(--text-3);
  font-size: 11px; padding: 2px 9px; border-radius: 99px; cursor: pointer;
}
.tk-chip.on { background: var(--accent-soft); color: var(--accent); border-color: var(--accent-border); }
.tk { border: 1px solid var(--border-soft); border-radius: var(--r-sm); padding: 7px 9px; margin-bottom: 6px; background: var(--surface-2); }
.tk-head { display: flex; align-items: center; gap: 6px; }
.tk-src { font-size: 11px; color: var(--text-4); }
.tk-time { font-size: 10.5px; color: var(--text-4); }
.tk-text { font-size: 12px; margin: 4px 0; cursor: pointer; word-break: break-all; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.tk-text:hover { color: var(--accent); }
.tk-meta { font-size: 10.5px; color: var(--text-4); font-family: ui-monospace, Consolas, monospace; word-break: break-all; }
.tk-pre { margin: 6px 0 0; padding: 7px; background: var(--bg-soft); border-radius: var(--r-sm); font-size: 10.5px; white-space: pre-wrap; word-break: break-all; max-height: 180px; overflow: auto; }
.tk-actions { display: flex; gap: 6px; margin-top: 6px; }
.tk-btn {
  border: 1px solid var(--border); background: var(--surface); color: var(--text-2);
  font-size: 11px; padding: 2px 10px; border-radius: 4px; cursor: pointer;
}
.tk-btn:hover { color: var(--text); border-color: var(--text-4); }
.flex1 { flex: 1; }
</style>
