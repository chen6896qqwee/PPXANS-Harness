<!-- webapp/src/modals/AskModal.vue - 站内确认/输入弹窗 (Promise 服务, 全站唯一入口) -->
<script setup>
import { nextTick, ref, watch } from "vue";
import { ask, settleAsk } from "../stores/ui.js";
import Icon from "../common/Icon.vue";

const inputEl = ref(null);
const okEl = ref(null);

watch(() => ask.open, async (open) => {
  if (!open) return;
  await nextTick();
  if (ask.kind === "prompt" && inputEl.value) {
    inputEl.value.focus();
    inputEl.value.select();
  } else if (okEl.value) okEl.value.focus();
});

function submit() {
  if (ask.kind === "prompt") {
    const v = (ask.value || "").trim();
    settleAsk(v ? v : null);
  } else {
    settleAsk(true);
  }
}
function cancel() {
  settleAsk(ask.kind === "prompt" ? null : false);
}
function onInputKey(e) {
  if (e.key === "Enter") { e.preventDefault(); submit(); }
}
</script>

<template>
  <template v-if="ask.open">
    <div class="mmask" @click="cancel" />
    <div class="mdlg" :class="{ danger: ask.danger }" role="dialog" aria-modal="true">
      <div class="mhead">
        <span>{{ ask.title }}</span>
        <span class="flex1" />
        <button class="icobtn sm" aria-label="关闭" @click="cancel"><Icon name="close" :size="14" /></button>
      </div>
      <div class="mrow col"><div class="mlab pre">{{ ask.message }}</div></div>
      <label v-if="ask.kind === 'prompt'" class="mrow">
        <span>输入</span>
        <input ref="inputEl" v-model="ask.value" type="text" :placeholder="ask.placeholder" autocomplete="off" spellcheck="false" @keydown="onInputKey">
      </label>
      <div class="mfoot">
        <button class="btn" @click="cancel">{{ ask.cancelText }}</button>
        <button ref="okEl" class="btn primary" @click="submit">{{ ask.okText }}</button>
      </div>
    </div>
  </template>
</template>

<style scoped>
.pre { white-space: pre-wrap; }
.flex1 { flex: 1; }
</style>
