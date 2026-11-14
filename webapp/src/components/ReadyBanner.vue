<!-- webapp/src/components/ReadyBanner.vue - 首启就绪提示条
     以前「配没配模型」只记在 localStorage (ppx_onboarded_v1), 换机器/清缓存/改配置都不会自愈。
     现在由后端 /api/readiness 判定: 没可用模型才出现, 配好自动消失, 也可以手动"知道了"。
     刻意做成一行, 不弹窗、不挡路 —— 没配模型也能先看界面, 这是设计不是错误。 -->
<script setup>
import { onMounted, ref, watch } from "vue";
import Icon from "../common/Icon.vue";
import { ui } from "../stores/ui.js";
import { readinessApi } from "../api/endpoints.js";

const DISMISS_KEY = "ppx_ready_dismiss_v1";

const loaded = ref(false);
const ready = ref(true);
const model = ref(null);
const dismissed = ref(false);

function readDismiss() {
  try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
}

async function refresh() {
  try {
    const j = await readinessApi();
    if (!j) return;
    ready.value = !!j.ready;
    model.value = j.model || null;
    loaded.value = true;
  } catch {
    // 取不到就不打扰 (服务刚起时可能还没就绪) —— 宁可少提示, 不要误报
    loaded.value = true;
  }
}

function openModels() { ui.settingsModal = "models"; }

function dismiss() {
  dismissed.value = true;
  try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* 隐私模式忽略 */ }
}

// 关掉设置弹窗后重新判定一次: 用户刚配完模型, 这条应该自己消失
watch(() => ui.settingsModal, (v) => { if (!v) refresh(); });

onMounted(() => {
  dismissed.value = readDismiss();
  refresh();
});
</script>

<template>
  <div v-if="loaded && !ready && !dismissed" class="rb" role="status">
    <Icon name="info" :size="14" />
    <span class="rbt">
      还没接模型 —— 现在能看界面，但还不能干活。
      <span class="rbs">{{ (model && model.reason) || "缺一个可用的模型配置" }}</span>
    </span>
    <button class="rbact" @click="openModels">填入模型</button>
    <button class="rbclose" title="知道了，不再提示" aria-label="知道了" @click="dismiss">
      <Icon name="close" :size="13" />
    </button>
  </div>
</template>

<style scoped>
.rb {
  flex: none;
  display: flex; align-items: center; gap: 9px;
  padding: 7px 14px;
  background: var(--warn-soft);
  border-bottom: 1px solid var(--warn);
  color: var(--warn);
  font-size: 12.5px;
}
.rbt { flex: 1; min-width: 0; }
.rbs { color: var(--text-3); margin-left: 6px; }
.rbact {
  flex: none; border: 1px solid currentColor; background: none;
  color: inherit; border-radius: var(--r-sm); padding: 2px 10px;
  font-size: 12px; cursor: pointer; font-weight: 600;
}
.rbact:hover { background: var(--warn); color: var(--on-accent); }
.rbclose {
  flex: none; border: none; background: none; color: inherit;
  cursor: pointer; display: inline-flex; padding: 2px; opacity: 0.7;
}
.rbclose:hover { opacity: 1; }
</style>
