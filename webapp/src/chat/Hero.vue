<!-- webapp/src/chat/Hero.vue - 空态首屏: 当前项目 + 三个真实起点 + 工作模式(折叠) + 状态脚注
     v5.1 重排 (2026-11-08): 原来这里同时堆了 5 个卖点 chips、5 个命令 chips、4 张姿态卡和
       一行生命体征 —— 首屏在回答"我很强", 却没回答"我该点哪个"。现在按顺序给三件事:
         1) 在哪个项目里干活 (第一个可点的东西)
         2) 三个一句话就能跑完的起点 (点了就把话填好)
         3) 工作模式 (收成一行, 想换再展开)
       卖点与命令提示删掉: 卖点属于 README, 命令属于 "/" 面板。 -->
<script setup>
import { computed, ref } from "vue";
import Icon from "../common/Icon.vue";
import { chat, newSession, providerLabel } from "../stores/chat.js";
import { bot, manage, loadState } from "../stores/bot.js";
import { ui, showView } from "../stores/ui.js";
import { rail, rootName, loadSpaces } from "../stores/rail.js";
import { showToast } from "../stores/toast.js";
import { fmtTok } from "../stores/fmt.js";
import { T } from "../i18n/lexicon.js";

const TYPE_ICONS = { companion: "bot", assistant: "zap", researcher: "scan", scribe: "book" };
const TYPE_CLS = { companion: "c-comp", assistant: "c-asst", researcher: "c-rsch", scribe: "c-scrb" };

const s = computed(() => bot.s);
const types = computed(() => (s.value && s.value.types) || []);
const botState = computed(() => (s.value && s.value.bot) || null);
const typesOpen = ref(false);

/* 当前项目 = 选中的空间, 没选就是工作区根目录 */
const projectName = computed(() => rail.activeSpace || rootName());
const projectHint = computed(() => {
  const sp = (rail.spaces || []).find((x) => x.name === rail.activeSpace);
  if (!sp) return rootName() + " · 根目录";
  return sp.root ? rootName() + " / " + sp.root : rootName() + " (根目录)";
});

const heroStats = computed(() => {
  const bits = [];
  const st = s.value;
  bits.push("版本 " + chat.versionTag);
  if (!chat.providersLoaded) bits.push("模型状态读取中");
  else bits.push(chat.providers.length ? "模型 " + providerLabel(chat.providers[0]) : "模型未配置");
  if (chat.life) bits.push(T.stage + " " + chat.life);
  if (st && st.live && st.live.traces) bits.push("调用 " + (st.live.traces.count || 0));
  return bits.filter(Boolean);
});
const showCta = computed(() => chat.providersLoaded && !hasUsableModel());
function hasUsableModel() {
  return (chat.providers || []).some((p) => {
    if (!p || p.enabled === false) return false;
    if (p.api_key_set || p.api_key_env) return true;
    return /(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(String(p.base_url || ""));
  });
}

/* 三个起点: 点了就把话填进输入框, 不自动发送 (用户还能改) */
const STARTERS = [
  {
    icon: "search", title: "读懂这个项目",
    desc: "先看结构，再讲清每个模块",
    q: "先列出工作区结构，再挑 3 个最关键的文件，说明它们各自的作用和相互关系。",
  },
  {
    icon: "edit", title: "修一个小问题",
    desc: "先写失败测试，修好再跑绿",
    q: "在工作区里找一个可以改进的小问题：先写一条能复现它的测试并跑出失败，再修好、跑绿并说明改动。",
  },
  {
    icon: "list", title: "拆一份计划",
    desc: "只出方案，你确认后再动手",
    q: "帮我把这件事拆成可执行的计划，先别动代码。",
  },
];
function useStarter(x) {
  chat.input = x.q;
  showToast("已填入输入框 · 按 Enter 发送");
}
function openProjects() {
  loadSpaces();
  showView("projects");
}

const formOpen = ref(false);
const typeName = ref("");
const typeBlurb = ref("");

function pickType(t) {
  const sameType = botState.value && botState.value.type === t.id;
  manage("type", { typeId: t.id }, "已切到「" + t.name + "」").catch(() => {});
  newSession(); // 切换类型 = 换一种干活的姿态, 开一局新的
  if (sameType) showToast("类型没变, 开了个新会话");
}
async function removeType(t) {
  await manage("typeRemove", { typeId: t.id }, "类型已删除").catch(() => {});
}
async function saveType() {
  const name = typeName.value.trim();
  if (!name) { showToast("类型名不能为空", true); return; }
  try {
    await manage("typeAdd", { name, blurb: typeBlurb.value.trim() }, "类型已保存");
    typeName.value = "";
    typeBlurb.value = "";
    formOpen.value = false;
  } catch { /* toast 已弹 */ }
}

</script>

<template>
  <section id="hero" class="hero">
    <div class="hero-mark"><Icon name="mark" :size="40" /></div>
    <h1>要在哪个项目里<em>动手</em>？</h1>
    <p class="hero-sub">选好项目直接说要做的事 —— 它会自己决定读哪个文件、跑哪条命令。</p>

    <!-- 1) 当前项目: 首屏第一个可点的东西 -->
    <div class="hero-block">
      <button class="project" @click="openProjects">
        <span class="pico"><Icon name="folder" :size="16" /></span>
        <span class="pmeta">
          <b>{{ projectName }}</b>
          <span>{{ projectHint }}</span>
        </span>
        <span class="pact">切换</span>
      </button>
    </div>

    <!-- 2) 三个起点: 一句话就能跑完 -->
    <div class="hero-block">
      <div class="fhead">从这里开始<span class="fsub">· 点一下就把话填好</span></div>
      <div class="cards">
        <button v-for="x in STARTERS" :key="x.title" class="card" @click="useStarter(x)">
          <span class="cico"><Icon :name="x.icon" :size="15" /></span>
          <b>{{ x.title }}</b>
          <span class="cdesc">{{ x.desc }}</span>
        </button>
      </div>
    </div>

    <!-- 3) 工作模式: 收成一行, 想换再展开 -->
    <div class="hero-block">
      <button class="modebar" @click="typesOpen = !typesOpen">
        <Icon name="sliders" :size="13" />
        <span>{{ T.mode }}</span>
        <b>{{ (botState && botState.typeName) || "未设置" }}</b>
        <span class="flex1" />
        <span class="modehint">{{ typesOpen ? "收起" : "更换" }}</span>
        <Icon :name="typesOpen ? 'chev-d' : 'chev-r'" :size="13" />
      </button>

      <div v-show="typesOpen" class="modepanel">
        <div v-if="!s && bot.pollErr" class="empty">工作模式暂时读不到<br><button class="btn xs" @click="loadState()">重试</button></div>
        <div v-else-if="!types.length" class="empty loading">正在读取类型…</div>
        <!-- id 保留: Electron 菜单与桌面冒烟按 #typeCards 定位这块 (结构挪进折叠面板, id 不动) -->
        <div id="typeCards" class="bcards">
          <button
            v-for="t in types" :key="t.id" class="bcard"
            :style="botState && t.id === botState.type ? { borderColor: 'var(--accent)' } : null"
            @click="pickType(t)"
          >
            <span class="bcard-ico" :class="TYPE_CLS[t.id] || 'c-custom'"><Icon :name="TYPE_ICONS[t.id] || 'spark'" :size="15" /></span>
            <b>{{ t.name }}{{ botState && t.id === botState.type ? " · 现在这个" : "" }}</b>
            <span class="blurb">{{ t.blurb || "—" }}</span>
            <span v-if="!t.builtin" class="del" title="删除类型" @click.stop="removeType(t)"><Icon name="close" :size="12" /></span>
          </button>
        </div>
        <div class="shint">一个工作区只跑一个助手 —— 换工作模式 = 换一种干活的方式，并开一个新对话。</div>
        <button class="bdashed" @click="formOpen = !formOpen">＋ 新建类型</button>
        <div v-if="formOpen" class="bform">
          <input v-model="typeName" placeholder="类型名，如 校对员" spellcheck="false" maxlength="20">
          <input v-model="typeBlurb" placeholder="一句话说明它怎么干活" spellcheck="false" maxlength="80">
          <div class="facts">
            <button type="button" class="btn" @click="formOpen = false">取消</button>
            <button type="button" class="btn primary" @click="saveType">保存类型</button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="showCta" class="hero-cta">
      <button class="btn primary" @click="ui.settingsModal = 'models'"><Icon name="zap" :size="14" />配置模型 · 约 1 分钟</button>
      <span class="hcta-hint">只填模型名称和 API Key，地址按名字自动识别</span>
    </div>

    <div v-if="heroStats.length" class="hero-stats">
      <template v-for="(b, i) in heroStats" :key="i">
        <span v-if="i" class="hs-sep" />
        <span>{{ b }}</span>
      </template>
    </div>
  </section>
</template>

<style scoped>
.hero {
  flex: 1; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; align-items: center;
  padding: 26px 20px 18px; text-align: center;
}
.hero-mark { color: var(--accent); margin-bottom: 8px; }
h1 { font-size: 23px; margin: 0 0 6px; letter-spacing: 0.2px; font-weight: 700; }
h1 em { font-style: normal; color: var(--accent); }
.hero-sub { color: var(--text-3); margin: 0 0 18px; font-size: 13px; max-width: 46ch; }

.hero-block { width: min(660px, 100%); text-align: left; margin-bottom: 16px; }
.fhead { font-size: 11.5px; color: var(--text-3); letter-spacing: 1.2px; margin-bottom: 8px; display: flex; align-items: baseline; gap: 7px; }
.fsub { color: var(--text-4); letter-spacing: 0; font-size: 11px; }

/* 当前项目 */
.project {
  display: flex; align-items: center; gap: 11px; width: 100%;
  padding: 11px 13px; border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--surface); cursor: pointer; text-align: left;
  transition: border-color var(--t-fast), box-shadow var(--t-fast);
}
.project:hover { border-color: var(--accent-border); box-shadow: var(--shadow-1); }
.pico {
  width: 32px; height: 32px; border-radius: 9px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--accent-soft); color: var(--accent);
}
.pmeta { flex: 1; min-width: 0; }
.pmeta b { display: block; font-size: 13.5px; font-weight: 600; }
.pmeta span { display: block; font-size: 11.5px; color: var(--text-4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pact { font-size: 12px; color: var(--text-3); border: 1px solid var(--border); border-radius: var(--r-sm); padding: 2px 9px; flex: none; }

/* 起点卡 */
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.card {
  display: flex; flex-direction: column; align-items: flex-start; gap: 5px;
  padding: 12px; border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--surface); cursor: pointer; text-align: left;
  transition: border-color var(--t-fast), transform var(--t-fast), box-shadow var(--t-fast);
}
.card:hover { border-color: var(--accent-border); transform: translateY(-1px); box-shadow: var(--shadow-1); }
.cico {
  width: 28px; height: 28px; border-radius: 8px; display: inline-flex;
  align-items: center; justify-content: center;
  background: var(--surface-3); color: var(--text-3); margin-bottom: 2px;
}
.card:hover .cico { background: var(--accent-soft); color: var(--accent); }
.card b { font-size: 12.8px; }
.cdesc { font-size: 11.5px; color: var(--text-3); line-height: 1.5; }

/* 工作模式一行条 */
.modebar {
  display: flex; align-items: center; gap: 7px; width: 100%;
  padding: 8px 12px; border: 1px solid var(--border-soft); border-radius: var(--r-md);
  background: var(--surface-2); color: var(--text-3); font-size: 12px; cursor: pointer;
  transition: border-color var(--t-fast), color var(--t-fast);
}
.modebar:hover { border-color: var(--border); color: var(--text-2); }
.modebar b { color: var(--text); font-weight: 600; }
.modehint { font-size: 11.5px; color: var(--text-4); }
.flex1 { flex: 1; }
.modepanel { margin-top: 8px; }

.bcards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.bcard {
  position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
  border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface);
  padding: 10px 12px; cursor: pointer; text-align: left;
  transition: border-color var(--t-fast), transform var(--t-fast), box-shadow var(--t-fast);
}
.bcard:hover { border-color: var(--accent-border); transform: translateY(-1px); box-shadow: var(--shadow-1); }
.bcard b { font-size: 12.8px; }
.bcard .blurb { font-size: 11.5px; color: var(--text-3); line-height: 1.45; }
.bcard .del { position: absolute; right: 7px; top: 7px; color: var(--text-4); display: flex; opacity: 0; transition: opacity var(--t-fast); }
.bcard:hover .del { opacity: 1; }
.bcard .del:hover { color: var(--err); }
.bcard-ico {
  width: 26px; height: 26px; border-radius: 8px; display: inline-flex;
  align-items: center; justify-content: center; margin-bottom: 3px;
}
.c-comp { background: var(--info-soft); color: var(--info); }
.c-asst { background: var(--accent-soft); color: var(--accent); }
.c-rsch { background: var(--ok-soft); color: var(--ok); }
.c-scrb { background: var(--warn-soft); color: var(--warn); }
.c-custom { background: var(--surface-3); color: var(--text-3); }
.shint { font-size: 11.5px; color: var(--text-4); margin: 8px 0; }
.bdashed {
  width: 100%; border: 1px dashed var(--border); border-radius: var(--r-md);
  background: none; color: var(--text-3); padding: 8px; cursor: pointer; font-size: 12.5px;
}
.bdashed:hover { color: var(--accent); border-color: var(--accent-border); }
.bform {
  display: flex; flex-direction: column; gap: 8px;
  border: 1px solid var(--border); border-radius: var(--r-md);
  padding: 12px; margin-top: 8px; background: var(--surface-2);
}
.bform .facts { display: flex; justify-content: flex-end; gap: 8px; }

.hero-cta { margin-top: 4px; display: flex; flex-direction: column; gap: 6px; align-items: center; }
.hcta-hint { font-size: 11.5px; color: var(--text-4); }
.hero-stats {
  margin-top: 16px; display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
  gap: 4px 10px; color: var(--text-4); font-size: 11.5px;
}
.hs-sep { width: 3px; height: 3px; border-radius: 50%; background: var(--text-4); display: inline-block; }
.empty { font-size: 12px; color: var(--text-3); padding: 8px 0; }
.empty button { margin-left: 6px; }
</style>
