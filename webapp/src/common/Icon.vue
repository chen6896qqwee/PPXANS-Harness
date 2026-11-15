// webapp/src/common/Icon.vue - 图标组件 (引用 index.html 内联 sprite)
<script setup>
const props = defineProps({
  name: { type: String, required: true },
  size: { type: Number, default: 15 },
});
</script>

<template>
  <svg
    :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
  >
    <use :href="'#i-' + name" />
  </svg>
</template>
