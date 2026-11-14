<!-- webapp/src/views/CapabilitiesView.vue - 能力页: 第二层功能的唯一入口 -->
<script setup>
import Icon from "../common/Icon.vue";
import { ui, showView, setDrawerTab, MORE_ROUTES } from "../stores/ui.js";
import { chat, showMemoryDigest } from "../stores/chat.js";
import { T } from "../i18n/lexicon.js";

// 分组: 新手只需要前三项, 其余按键值对收在后面 —— 侧栏不再平铺 8 个入口。
// domId 保留旧侧栏的 id (capSkills / capMcp …): 这些 id 是跨端契约测试和冒烟脚本的锚点,
// 入口从侧栏搬到本页, id 跟着搬, 断言语义不变。
const WORK = [
  { id: "skills", domId: "capSkills", icon: "book", name: "技能包", desc: "预置的做事方法，说一句话就能触发" },
  { id: "plugins", domId: "capPlugins", icon: "plug", name: "插件", desc: "给皮皮虾加新工具（没装也不影响使用）" },
  { id: "mcp", domId: "capMcp", icon: "cube", name: "外部工具 (MCP)", desc: "接入第三方服务，新手可以忽略" },
];

const OBSERVE = [
  { act: () => setDrawerTab("tickets"), icon: "list", name: T.taskRecord, desc: "每一次任务的受理、执行、结果" },
  { act: () => { ui.chatPane = "trace"; showView("chat"); }, icon: "activity", name: T.trace, desc: "工具调用的完整流水，可回查" },
  { act: () => setDrawerTab("review"), icon: "scan", name: "审查报告", desc: "对改动的自审结论与风险点" },
  { act: () => setDrawerTab("goal"), icon: "target", name: "目标看板", desc: "当前在推进的目标与进度" },
  { act: () => showView("stats"), icon: "bars", name: "使用统计", desc: "Token 消耗与费用估算" },
  { act: () => showView("body"), icon: "pulse", name: T.runState, desc: "服务、模型、记忆、安全四项状态" },
];

const SYSTEM = [
  { act: () => { ui.settingsModal = "general"; }, icon: "settings", name: T.settings, desc: "模型、权限、外观、快捷键" },
  { act: () => showMemoryDigest(), icon: "brain", name: "长期记忆", desc: "它记住的关于你和这个项目的事实" },
  { act: () => setDrawerTab("files"), icon: "folder", name: T.workspace, desc: "浏览与预览当前项目里的文件" },
  { act: () => { ui.onboarding = true; }, icon: "spark", name: T.guide, desc: "四步跑通第一次使用" },
];

function go(route) { showView(route.id); }
</script>

<template>
  <section id="view-caps" class="view">
    <header class="botbar">
      <button class="icobtn" title="返回对话" aria-label="返回对话" @click="showView('chat')"><Icon name="back" :size="16" /></button>
      <div class="bmeta">
        <div class="bname2">{{ T.capabilities }}</div>
        <div class="bsub">平时用不到的配置都收在这里。刚开始只需要「技能」和「设置」两项。</div>
      </div>
      <span class="flex1" />
    </header>

    <div class="swrap">
      <div class="ssec">
        <div class="ssec-head">{{ T.capWork }}</div>
        <button v-for="w in WORK" :key="w.id" :id="w.domId" class="crow" @click="go({ id: w.id })">
          <span class="cico"><Icon :name="w.icon" :size="15" /></span>
          <span class="cmeta"><b>{{ w.name }}</b><span>{{ w.desc }}</span></span>
          <Icon name="chev-r" :size="14" class="cchev" />
        </button>
      </div>

      <div class="ssec">
        <div class="ssec-head">{{ T.capObserve }}</div>
        <button v-for="w in OBSERVE" :key="w.name" class="crow" @click="w.act()">
          <span class="cico"><Icon :name="w.icon" :size="15" /></span>
          <span class="cmeta"><b>{{ w.name }}</b><span>{{ w.desc }}</span></span>
          <Icon name="chev-r" :size="14" class="cchev" />
        </button>
      </div>

      <div class="ssec">
        <div class="ssec-head">{{ T.capSystem }}</div>
        <button v-for="w in SYSTEM" :key="w.name" class="crow" @click="w.act()">
          <span class="cico"><Icon :name="w.icon" :size="15" /></span>
          <span class="cmeta"><b>{{ w.name }}</b><span>{{ w.desc }}</span></span>
          <Icon name="chev-r" :size="14" class="cchev" />
        </button>
      </div>

      <div class="shint">
        还有 {{ MORE_ROUTES.length }} 个底层页面可以从这里进：{{
          MORE_ROUTES.map((r) => r.label).join(" · ")
        }}。
      </div>
    </div>
  </section>
</template>

<style scoped>
@import "./manage.css";
.view { display: flex; flex-direction: column; min-height: 0; }
.crow {
  display: flex; align-items: center; gap: 11px; width: 100%; text-align: left;
  padding: 9px 12px; margin-bottom: 6px;
  border: 1px solid var(--border-soft); border-radius: var(--r-md);
  background: var(--surface); cursor: pointer;
  transition: border-color var(--t-fast), background var(--t-fast);
}
.crow:hover { border-color: var(--accent-border); background: var(--surface-2); }
.cico {
  width: 28px; height: 28px; border-radius: 8px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--surface-3); color: var(--text-3);
}
.crow:hover .cico { background: var(--accent-soft); color: var(--accent); }
.cmeta { flex: 1; min-width: 0; }
.cmeta b { display: block; font-size: 13px; font-weight: 600; }
.cmeta span { display: block; font-size: 11.5px; color: var(--text-3); }
.cchev { color: var(--text-4); flex: none; }
</style>
