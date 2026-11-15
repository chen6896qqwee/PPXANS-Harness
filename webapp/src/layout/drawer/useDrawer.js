// webapp/src/layout/drawer/useDrawer.js - 抽屉页签逻辑: 文件过滤 / 打开文件 / 任务详情 / 轮询调度
// 2026-11-13 从 Drawer.vue 抽出。不变量: 任务详情展开时暂停轮询, 收起后恢复 ——
//   否则后台刷新会打断正在看的内容 (原实现的行为, 保持)。

import { computed, onMounted, reactive, watch } from "vue";
import { ui, openFileView } from "../../stores/ui.js";
import {
  panels, loadTree, readFile, loadGoal, loadReview, loadTickets, loadTicketDetail,
  scheduleTicketPoll, stopTicketPoll,
} from "../../stores/panels.js";
import { rail } from "../../stores/rail.js";

export const TABS = [
  ["files", "文件", "folder"],
  ["goal", "目标", "target"],
  ["review", "审查", "scan"],
  ["tickets", "任务记录", "list"],
];

export function useDrawer() {
  const wsLabel = computed(() => {
    const root = panels.wsRoot ? panels.wsRoot.split(/[\\/]/).pop() : "工作区";
    return root + (rail.wsSub ? " / " + rail.wsSub : "");
  });
  const ticketHead = computed(() => {
    if (panels.ticketsDisabled) return "任务记录 (未启用)";
    if (panels.ticketHeadExtra) return "任务记录" + panels.ticketHeadExtra;
    const c = panels.ticketStats || {};
    return "任务 " + panels.ticketTotal + " · 执行 " + (c.working || 0) + " · 排队 " + (c.admitted || 0) + " · 失败 " + (c.failed || 0);
  });
  const filteredFiles = computed(() => filterTree(panels.tree, panels.treeFilter.toLowerCase()));
  function filterTree(nodes, q) {
    if (!q) return nodes;
    return nodes.map((n) => {
      if (n.type === "dir" || n.dir) {
        const kids = filterTree(n.children || n.items || [], q);
        return (kids.length || String(n.name || "").toLowerCase().includes(q)) ? Object.assign({}, n, { children: kids, _open: true }) : null;
      }
      return String(n.name || n.path || "").toLowerCase().includes(q) ? n : null;
    }).filter(Boolean);
  }

  const detailCache = reactive(new Map());
  const openDetails = reactive(new Set());

  function onTab(tab) {
    ui.drawerTab = tab;
    if (tab === "files") loadTree();
    else if (tab === "goal") loadGoal();
    else if (tab === "review") loadReview();
    else if (tab === "tickets") loadTickets();
  }

  async function openFile(path) {
    try {
      const text = await readFile(path);
      openFileView(path, text);
    } catch (e) {
      const { showToast } = await import("../../stores/toast.js");
      showToast(e.message, true);
    }
  }

  async function toggleDetail(id) {
    if (openDetails.has(id)) { openDetails.delete(id); return; }
    openDetails.add(id);
    if (!detailCache.has(id)) {
      try {
        const j = await loadTicketDetail(id);
        const t = j.ticket || {};
        const lines = [];
        if (t.text) lines.push("输入: " + String(t.text).slice(0, 600));
        if (t.resultPreview) lines.push("结果: " + t.resultPreview);
        if (t.error) lines.push("错误: " + t.error + (t.failureKind ? " (" + t.failureKind + ")" : ""));
        if (t.tools && t.tools.length) lines.push("工具: " + t.tools.join(", "));
        if (t.artifacts && t.artifacts.length) lines.push("交付物: " + t.artifacts.map((a) => a.path || a).join(", "));
        const asg = j.assignments || [];
        if (asg.length) {
          lines.push("指派: " + asg.map((a) =>
            (a.worker || "-") + "[" + (a.status || "") + "]" + (a.rounds ? " 轮次" + a.rounds : "") + (a.error ? " · " + a.error : "")
          ).join("; "));
        }
        detailCache.set(id, lines.join("\n") || "无详情");
      } catch (e) {
        detailCache.set(id, (e && e.message) || "读取失败");
      }
    }
  }

  function when(ts) {
    if (!ts) return "-";
    const d = new Date(ts);
    const p = (n) => (n < 10 ? "0" + n : "" + n);
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  watch(() => ui.drawer && ui.drawerTab === "tickets" && !openDetails.size, (active) => {
    if (active) scheduleTicketPoll(true);
    else stopTicketPoll();
  });
  watch(() => openDetails.size, () => {
    if (openDetails.size) stopTicketPoll();
    else if (ui.drawer && ui.drawerTab === "tickets") scheduleTicketPoll(true);
  });

  onMounted(() => {
    onTab(ui.drawerTab);
  });

  return { wsLabel, ticketHead, filteredFiles, detailCache, openDetails, onTab, openFile, toggleDetail, when };
}
