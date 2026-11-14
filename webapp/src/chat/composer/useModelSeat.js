// webapp/src/chat/composer/useModelSeat.js - 模型座椅: 当前模型 + 思考强度滑杆
//
// 从 Composer.vue 抽出来的一块自包含逻辑 (2026-11-13):
//   · 滑杆几何 (轨道宽度/拇指位置/填充比例) 与指针拖拽、键盘调档
//   · 座椅两级面板 (root / model) 与打开时按需拉取模型状态
// 依赖只有 chat.llm + llmReason/loadLlm 两个动作 + 一个 DOM ref, 与发送/附件无关。
// 行为保持: 拖拽期间只更新预览位置, 松手才提交; 键盘支持 ←/→/↑/↓/Home/End。
import { computed, nextTick, ref } from "vue";
import { chat, llmReason, loadLlm } from "../../stores/chat.js";

export function useModelSeat() {
  const track = ref(null);
  const seatLevels = computed(() => (chat.llm && chat.llm.reasoning_levels) || ["auto", "off", "low", "medium", "high", "max"]);
  const curLevel = computed(() => (chat.llm && chat.llm.reasoning) || "auto");
  const curIdx = computed(() => Math.max(0, seatLevels.value.indexOf(curLevel.value)));
  const modelName = computed(() => {
    const c = chat.llm && chat.llm.current;
    return c ? (c.model || c.id) : (chat.llm ? "未配置模型" : "读取中…");
  });
  function reasonTone(idx) {
    const levels = seatLevels.value;
    if (idx <= 0 || levels[idx] === "off" || levels.length <= 1) return 0;
    const r = idx / (levels.length - 1);
    return r <= 0.5 ? 1 : r < 0.85 ? 2 : 3;
  }
  const fillPct = computed(() => {
    const levels = seatLevels.value;
    const idx = dragIdx.value >= 0 ? dragIdx.value : curIdx.value;
    const maxIdx = Math.max(1, levels.length - 1);
    if (idx <= 0 || levels[idx] === "off") return 0;
    return 27 + (idx / maxIdx) * Math.max(1, (track.value ? track.value.offsetWidth : 320) - 30);
  });
  const fillLevel = computed(() => reasonTone(dragIdx.value >= 0 ? dragIdx.value : curIdx.value));
  const curLevelTone = computed(() => reasonTone(curIdx.value));
  const thumbLeft = computed(() => {
    const idx = dragIdx.value >= 0 ? dragIdx.value : curIdx.value;
    const maxIdx = Math.max(1, seatLevels.value.length - 1);
    const usable = Math.max(1, trackWidth.value - 30);
    return 1 + (idx / maxIdx) * usable;
  });
  const trackWidth = ref(320);
  function measureTrack() {
    if (track.value && track.value.offsetWidth > 30) trackWidth.value = track.value.offsetWidth;
  }
  const dragging = ref(false);
  const dragIdx = ref(-1);
  function idxFromX(clientX) {
    const t = track.value;
    if (!t) return 0;
    const rect = t.getBoundingClientRect();
    const ratio = (clientX - rect.left - 1) / Math.max(1, rect.width - 30);
    const clamped = Math.max(0, Math.min(1, ratio));
    return Math.round(clamped * (seatLevels.value.length - 1));
  }
  function onTrackDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    try { track.value.setPointerCapture(e.pointerId); } catch { /* 可选 */ }
    dragging.value = true;
    dragIdx.value = idxFromX(e.clientX);
  }
  function onTrackMove(e) {
    if (!dragging.value) return;
    dragIdx.value = idxFromX(e.clientX);
  }
  function onTrackUp() {
    if (!dragging.value) return;
    dragging.value = false;
    const idx = dragIdx.value;
    dragIdx.value = -1;
    if (idx != null && idx >= 0) commitLevel(idx);
  }
  function onTrackKey(e) {
    const levels = seatLevels.value;
    let next = curIdx.value;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, curIdx.value - 1);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(levels.length - 1, curIdx.value + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = levels.length - 1;
    else return;
    e.preventDefault();
    commitLevel(next);
  }
  async function commitLevel(idx) {
    const lv = seatLevels.value[idx];
    if (lv === curLevel.value) return;
    await llmReason(lv);
  }
  const seatPane = ref("root"); // root | model
  const provs = computed(() => (chat.llm && chat.llm.providers) || []);

  async function openSeat() {
    chat.permOpen = false;
    chat.seatOpen = !chat.seatOpen;
    if (chat.seatOpen) {
      seatPane.value = "root";
      await loadLlm();
      await nextTick();
      measureTrack();
    }
  }

  return {
    track, seatLevels, curLevel, curIdx, modelName, fillPct, fillLevel, curLevelTone,
    thumbLeft, dragIdx, onTrackDown, onTrackMove, onTrackUp, onTrackKey,
    seatPane, provs, openSeat,
  };
}
