<!-- webapp/src/views/ProjectsView.vue - 项目页: 一个项目 = 一个文件夹 (内部叫「空间」) -->
<script setup>
import { computed, onMounted } from "vue";
import Icon from "../common/Icon.vue";
import { ui, showView } from "../stores/ui.js";
import { rail, loadSpaces, removeSpace, relOfRoot, rootName } from "../stores/rail.js";
import { chat, newSession, switchSession } from "../stores/chat.js";
import { T } from "../i18n/lexicon.js";

const list = computed(() => rail.spaces || []);

onMounted(() => loadSpaces());

function dirText(sp) {
  const rel = relOfRoot(sp.root);
  return rel ? rootName() + " / " + rel : rootName() + " (根目录)";
}

// 进入项目 = 切工作区 + 复用绑定会话 (没有就开一局新的)
function enter(sp) {
  rail.activeSpace = sp.name;
  rail.wsSub = relOfRoot(sp.root);
  const bound = sp.sessionKey && rail.sessions.find((s) => s.key === sp.sessionKey);
  if (bound) switchSession(bound.key, bound.title || bound.name);
  else newSession();
  showView("chat");
}

function create() {
  ui.dirModal = { mode: "space", rel: "" };
}
</script>

<template>
  <section id="view-projects" class="view">
    <header class="botbar">
      <button class="icobtn" title="返回对话" aria-label="返回对话" @click="showView('chat')"><Icon name="back" :size="16" /></button>
      <div class="bmeta">
        <div class="bname2">{{ T.projects }}</div>
        <div class="bsub">一个项目就是一个文件夹。{{ T.brand }} 只能在你给的项目里读写文件。</div>
      </div>
      <span class="flex1" />
      <button class="wbtn primary" @click="create">＋ 添加文件夹</button>
    </header>

    <div class="swrap">
      <div class="pcard">
        <div class="pcard-h">
          <span class="pnm"><Icon name="folder" :size="14" />{{ rootName() }}</span>
          <span class="ptag">当前工作区</span>
        </div>
        <div class="pcard-id">对话默认就在这个文件夹里读写；它是唯一无需添加即可使用的项目。</div>
        <div class="pacts"><button class="wbtn" @click="showView('chat')">回到对话</button></div>
      </div>

      <div v-if="!list.length" class="shint">还没有添加其他文件夹。点右上角「添加文件夹」，让 {{ T.brand }} 在更多项目里工作。</div>
      <div v-else class="shint">其他项目 · {{ list.length }} 个</div>

      <div v-for="sp in list" :key="sp.name" class="pcard">
        <div class="pcard-h">
          <span class="pnm"><Icon name="folder" :size="14" />{{ sp.name }}</span>
          <span v-if="rail.activeSpace === sp.name" class="ptag">当前</span>
        </div>
        <div class="pcard-id">{{ dirText(sp) }}</div>
        <div class="pacts">
          <button class="wbtn primary" @click="enter(sp)">进入</button>
          <button class="wbtn danger" @click="removeSpace(sp.name)">移除</button>
        </div>
      </div>

      <div class="shint">
        移除只影响这份列表，文件夹和会话都不会被删除。工作区根目录：{{ rootName() }}。
      </div>
    </div>
  </section>
</template>

<style scoped>
@import "./manage.css";
.view { display: flex; flex-direction: column; min-height: 0; }
</style>
