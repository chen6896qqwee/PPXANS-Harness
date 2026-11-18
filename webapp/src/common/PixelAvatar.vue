<!-- webapp/src/common/PixelAvatar.vue - 名字生成的像素头像 (2026-11-16) -->
<script setup>
import { computed } from "vue";
import { pixelAvatar } from "../stores/pixel-avatar.js";

const props = defineProps({
  name: { type: String, default: "皮皮虾" },
  size: { type: Number, default: 32 },
  state: { type: String, default: "idle" }, // idle | working
  title: { type: String, default: "" },
});

const avatar = computed(() => pixelAvatar(props.name));
const label = computed(() => `${props.name || "皮皮虾"} 的像素头像`);
</script>

<template>
  <span
    class="pxav" :class="{ working: state === 'working' }"
    :style="{ width: size + 'px', height: size + 'px' }"
    :title="title || (name || '皮皮虾') + ' · 像素头像'"
    role="img" :aria-label="label" v-html="avatar.svg"
  />
</template>

<style scoped>
.pxav {
  display: inline-flex; align-items: center; justify-content: center;
  flex: none; overflow: hidden; border-radius: 9px;
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--border-soft);
}
.pxav :deep(svg) { width: 100%; height: 100%; display: block; }
.pxav.working { animation: px-working 1.6s ease-in-out infinite; }
@keyframes px-working {
  0%, 100% { box-shadow: inset 0 0 0 1px var(--border-soft); }
  50% { box-shadow: inset 0 0 0 2px var(--accent); }
}
</style>
