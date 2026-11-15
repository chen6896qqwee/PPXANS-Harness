<!-- webapp/src/views/SkillsView.vue - 技能管理页 (只做停用/启用, 不编辑 SKILL.md) -->
<script setup>
import { computed, onMounted } from "vue";
import Icon from "../common/Icon.vue";
import { admin, loadSkills, toggleSkill, sourceLabel } from "../stores/admin.js";
import { showView } from "../stores/ui.js";
import { shortAgo } from "../stores/fmt.js";

const d = computed(() => admin.skills || {});
const list = computed(() => d.value.skills || []);
const byDomain = computed(() => {
  const by = {};
  for (const s of list.value) {
    const dm = s.domain || "misc";
    (by[dm] = by[dm] || []).push(s);
  }
  return Object.keys(by).sort().map((dm) => ({ dm, items: by[dm] }));
});

onMounted(() => loadSkills());
</script>

<template>
  <section id="view-skills" class="view">
    <header class="botbar">
      <button class="icobtn" title="返回" aria-label="返回" @click="showView('chat')"><Icon name="back" :size="16" /></button>
      <div class="bmeta">
        <div class="bname2">技能</div>
        <div class="bsub">已安装 {{ list.length }} 个 · 启用 {{ d.enabled == null ? list.length : d.enabled }} 个 · 停用后不再注入提示, 也不能被 load_skill 读取</div>
      </div>
      <span class="flex1" />
      <button class="icobtn" title="刷新" aria-label="刷新" @click="loadSkills()"><Icon name="refresh" :size="16" /></button>
    </header>
    <div class="swrap">
      <div v-if="admin.skillsErr" class="empty">加载失败：{{ admin.skillsErr }} <button class="wbtn" @click="loadSkills()">重试</button></div>
      <div v-else-if="!list.length" class="empty">没找到技能。技能放在 skills/ 或 .ppx/skills/ 下, 每个技能一个目录 + SKILL.md。</div>
      <div v-for="g in byDomain" :key="g.dm" class="ssec">
        <div class="ssec-head">{{ g.dm }}<span class="flex1" /><span class="svd">{{ g.items.length }} 个</span></div>
        <div v-for="s in g.items" :key="s.id" class="skrow" :class="{ off: !s.enabled }">
          <div class="skt"><b>{{ s.name || s.id }}</b><span class="skid">{{ s.id }}</span></div>
          <div class="skd">{{ s.description || "" }}</div>
          <div v-if="s.source || s.version || s.uses" class="skmeta">
            {{ [s.source ? sourceLabel(s.source) : null, s.version ? "v" + s.version : null, s.uses ? "用过 " + s.uses + " 次" + (s.lastUsed ? " · " + shortAgo(s.lastUsed) + "前" : "") : null].filter(Boolean).join(" · ") }}
          </div>
          <div class="skact">
            <button class="wbtn" :class="s.enabled ? 'danger' : 'primary'" @click="toggleSkill(s.id, !s.enabled)">
              {{ s.enabled ? "停用" : "启用" }}
            </button>
          </div>
        </div>
      </div>
      <div class="ssec">
        <div class="shint">停用只影响本机的提示注入与 load_skill, 不删除任何文件; 想彻底移除请删对应目录。技能的创建与修改仍由 create_skill / refine_skill 或手动编辑 SKILL.md 完成。</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
@import "./manage.css";
.view { display: flex; flex-direction: column; min-height: 0; }
</style>
