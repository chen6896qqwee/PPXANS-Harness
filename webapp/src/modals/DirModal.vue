<!-- webapp/src/modals/DirModal.vue - 空间 / 工作区目录选择弹层 -->
<script setup>
import { ref, watch } from "vue";
import Icon from "../common/Icon.vue";
import { ui } from "../stores/ui.js";
import { addSpace, listDirs, rootName } from "../stores/rail.js";
import { rail } from "../stores/rail.js";
import { loadTree } from "../stores/panels.js";
import { showToast } from "../stores/toast.js";

const name = ref("");
const rel = ref("");
const crumbs = ref([]);
const dirs = ref([]);
const loading = ref(false);

watch(() => ui.dirModal, async (m) => {
  if (!m) return;
  name.value = "";
  rel.value = String(m.rel || "");
  await refresh();
});

async function refresh() {
  const parts = rel.value ? rel.value.split("/").filter(Boolean) : [];
  const cs = [{ acc: "", label: rootName() }];
  let acc = "";
  for (const p of parts) {
    acc = acc ? acc + "/" + p : p;
    cs.push({ acc, label: p });
  }
  crumbs.value = cs;
  loading.value = true;
  try {
    dirs.value = await listDirs(rel.value);
  } catch (e) {
    dirs.value = [];
    showToast("目录读取失败: " + ((e && e.message) || "未知错误"), true);
  } finally {
    loading.value = false;
  }
}

function pick(p) {
  rel.value = p;
  refresh();
}

function ok() {
  const m = ui.dirModal;
  if (!m) return;
  if (m.mode === "dir") {
    rail.wsSub = rel.value;
    ui.dirModal = null;
    loadTree();
    return;
  }
  const nm = (name.value || "").trim() || (rel.value ? rel.value.split("/").pop() : "新项目");
  if (addSpace(nm, rel.value)) ui.dirModal = null;
}
</script>

<template>
  <template v-if="ui.dirModal">
    <div class="mmask" @click="ui.dirModal = null" />
    <div class="mdlg" role="dialog" aria-modal="true">
      <div class="mhead">
        <span>{{ ui.dirModal.mode === "space" ? "新建项目" : "选择工作区目录" }}</span>
        <span class="flex1" />
        <button class="icobtn sm" aria-label="关闭" @click="ui.dirModal = null"><Icon name="close" :size="14" /></button>
      </div>
      <label v-if="ui.dirModal.mode === 'space'" class="mrow">
        名称
        <input v-model="name" type="text" placeholder="如 PPX-Harness" spellcheck="false" autocomplete="off" @keydown.enter="ok">
      </label>
      <div class="mrow col">
        <div class="mlab">目录 <em>{{ rel ? rootName() + " / " + rel : rootName() + " (根目录)" }}</em></div>
        <div class="mcrumb">
          <button v-for="c in crumbs" :key="c.acc" @click="pick(c.acc)">{{ c.label }}</button>
        </div>
        <div class="mdirs">
          <div v-if="loading" class="empty loading">加载中</div>
          <div v-else-if="!dirs.length" class="empty">{{ rel ? "该目录下没有子文件夹" : "根目录下没有子文件夹" }}</div>
          <button v-for="d in dirs" :key="d.path || d.name" class="mdir" @click="pick(d.path || (rel ? rel + '/' + d.name : d.name))">
            <Icon name="folder" :size="13" /><span class="nm">{{ d.name }}</span><Icon name="chev-r" :size="12" />
          </button>
        </div>
        <div class="mhint">目录限定在皮皮虾工作区内（相对路径）。默认 = 皮皮虾根目录；选子目录会让「工作区」面板聚焦到该文件夹。</div>
      </div>
      <div class="mfoot">
        <button class="btn" @click="ui.dirModal = null">取消</button>
        <button class="btn primary" @click="ok">{{ ui.dirModal.mode === "space" ? "创建" : "确定" }}</button>
      </div>
    </div>
  </template>
</template>

<style scoped>
.mdirs { min-height: 120px; }
.flex1 { flex: 1; }
</style>
