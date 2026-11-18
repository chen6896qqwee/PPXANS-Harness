<!-- webapp/src/modals/settings/AppearancePanel.vue - 外观: 主题/配色/壁纸/材质 (2026-11-16) -->
<script setup>
import { computed } from "vue";
import Icon from "../../common/Icon.vue";
import { theme, setTheme } from "../../stores/theme.js";
import { appearance, setAppearance, resetAppearance } from "../../stores/appearance.js";
import { PALETTES, WALLPAPERS, MATERIALS, paletteById } from "../../stores/appearance-data.js";

const themeOptions = [
  { id: "system", label: "跟随系统", icon: "monitor" },
  { id: "light", label: "亮色", icon: "sun" },
  { id: "dark", label: "深色", icon: "moon" },
];
const current = computed(() => paletteById(appearance.palette));
const wpActive = computed(() => appearance.wallpaper !== "none");

function pickPalette(id) { setAppearance({ palette: id }); }
function pickWallpaper(id) { setAppearance({ wallpaper: id }); }
function pickMaterial(id) { setAppearance({ material: id }); }
function setOpacity(e) {
  setAppearance({ wallpaperOpacity: Number(e.target.value) / 100 });
}
</script>

<template>
  <div class="ap">
    <div class="ap-head">外观</div>
    <div class="ap-sub">主题、配色、壁纸与面板材质。只保存在这台设备，不影响其他端。</div>

    <section class="ap-sec">
      <div class="ap-title">主题</div>
      <div class="ap-seg" role="radiogroup" aria-label="主题">
        <button
          v-for="t in themeOptions" :key="t.id" class="ap-segbtn"
          :class="{ on: theme.pref === t.id }" :aria-pressed="theme.pref === t.id"
          @click="setTheme(t.id)"
        >
          <Icon :name="t.icon" :size="13" />{{ t.label }}
        </button>
      </div>
      <div class="ap-hint">当前解析为 {{ theme.resolved === "light" ? "亮色" : "深色" }}。跟随系统时随系统外观自动切换。</div>
    </section>

    <section class="ap-sec">
      <div class="ap-title">配色</div>
      <div class="ap-grid" role="radiogroup" aria-label="配色">
        <button
          v-for="p in PALETTES" :key="p.id" class="ap-card ap-palette"
          :class="{ on: appearance.palette === p.id }" :aria-pressed="appearance.palette === p.id"
          @click="pickPalette(p.id)"
        >
          <span class="ap-dot" :style="{ background: 'linear-gradient(135deg, ' + p.light + ' 0 50%, ' + p.dark + ' 50% 100%)' }" />
          <span class="ap-name">{{ p.label }}</span>
          <span class="ap-note">{{ p.hint }}</span>
        </button>
      </div>
    </section>

    <section class="ap-sec">
      <div class="ap-title">壁纸</div>
      <div class="ap-grid ap-wp-grid" role="radiogroup" aria-label="壁纸">
        <button
          v-for="w in WALLPAPERS" :key="w.id" class="ap-card ap-wpcard"
          :class="{ on: appearance.wallpaper === w.id }" :aria-pressed="appearance.wallpaper === w.id"
          @click="pickWallpaper(w.id)"
        >
          <span class="ap-wp" :class="'ap-wp-' + w.id" />
          <span class="ap-name">{{ w.label }}</span>
        </button>
      </div>
      <div class="ap-row">
        <span class="ap-rowlabel">壁纸浓度</span>
        <input
          class="ap-range" type="range" min="15" max="90" step="5"
          :value="Math.round(appearance.wallpaperOpacity * 100)"
          :disabled="!wpActive" aria-label="壁纸浓度" @input="setOpacity"
        >
        <span class="ap-val">{{ Math.round(appearance.wallpaperOpacity * 100) }}%</span>
      </div>
      <div class="ap-hint">{{ wpActive ? "壁纸会透过画布与通透面板；浓度越高越明显。" : "选择一张壁纸后生效。" }}</div>
    </section>

    <section class="ap-sec">
      <div class="ap-title">面板材质</div>
      <div class="ap-seg" role="radiogroup" aria-label="面板材质">
        <button
          v-for="m in MATERIALS" :key="m.id" class="ap-segbtn"
          :class="{ on: appearance.material === m.id }" :aria-pressed="appearance.material === m.id"
          @click="pickMaterial(m.id)"
        >
          {{ m.label }}
        </button>
      </div>
      <div class="ap-hint">{{ MATERIALS.find((m) => m.id === appearance.material).hint }}。</div>
    </section>

    <div class="ap-foot">
      <span class="ap-current">当前：{{ current.label }} · {{ WALLPAPERS.find((w) => w.id === appearance.wallpaper).label }} · {{ appearance.material === "translucent" ? "通透" : "实色" }}</span>
      <button class="ap-reset" @click="resetAppearance"><Icon name="refresh" :size="12" />恢复默认</button>
    </div>
  </div>
</template>

<style scoped>
.ap { display: flex; flex-direction: column; gap: 0; }
.ap-head { font-weight: 700; font-size: 15px; }
.ap-sub { font-size: 11.5px; color: var(--text-3); margin: 2px 0 4px; }
.ap-sec { border-top: 1px solid var(--border-soft); padding: 13px 0 3px; }
.ap-title { font-weight: 650; font-size: 12.5px; margin-bottom: 8px; }
.ap-seg { display: inline-flex; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm); padding: 2px; gap: 2px; }
.ap-segbtn {
  display: inline-flex; align-items: center; gap: 5px;
  border: none; background: transparent; color: var(--text-3);
  padding: 4px 12px; border-radius: 5px; cursor: pointer; font-size: 12px;
}
.ap-segbtn:hover { color: var(--text); }
.ap-segbtn.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow-1); }
.ap-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 8px; }
.ap-wp-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.ap-card {
  display: flex; flex-direction: column; align-items: flex-start; gap: 5px;
  padding: 8px 9px; border: 1px solid var(--border-soft); border-radius: var(--r-md);
  background: var(--surface-2); color: var(--text-2); cursor: pointer; text-align: left;
  transition: border-color var(--t-fast), box-shadow var(--t-fast), background var(--t-fast);
}
.ap-card:hover { border-color: var(--text-4); background: var(--surface-3); }
.ap-card.on { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.ap-dot { width: 22px; height: 22px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18); }
.ap-name { font-size: 12px; color: var(--text); font-weight: 600; }
.ap-note { font-size: 10.5px; color: var(--text-4); }
.ap-wp { display: block; width: 100%; height: 54px; border-radius: 5px; border: 1px solid var(--border-soft); background-size: cover; background-position: center; }
.ap-wpcard { padding: 6px; }
.ap-wp-none { background: repeating-linear-gradient(135deg, var(--surface-3) 0 8px, var(--surface-2) 8px 16px); }
.ap-wp-aurora { background: var(--wp-aurora); }
.ap-wp-mist { background: var(--wp-mist); }
.ap-wp-grid { background: var(--wp-grid); }
.ap-wp-dusk { background: var(--wp-dusk); }
.ap-row { display: flex; align-items: center; gap: 9px; margin-top: 10px; }
.ap-rowlabel { font-size: 11.5px; color: var(--text-3); flex: none; }
.ap-range { flex: 1; accent-color: var(--accent); }
.ap-val { font-size: 11px; color: var(--text-3); width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
.ap-hint { font-size: 11px; color: var(--text-4); margin: 6px 0 2px; }
.ap-foot { display: flex; align-items: center; gap: 10px; border-top: 1px solid var(--border-soft); margin-top: 14px; padding-top: 10px; }
.ap-current { font-size: 11px; color: var(--text-3); flex: 1; }
.ap-reset {
  display: inline-flex; align-items: center; gap: 4px;
  border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2);
  padding: 4px 10px; border-radius: var(--r-sm); cursor: pointer; font-size: 11.5px;
}
.ap-reset:hover { border-color: var(--accent); color: var(--accent); }
</style>
