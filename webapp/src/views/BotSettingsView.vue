<!-- webapp/src/views/BotSettingsView.vue - 本体设置页 (17 个 bot.manage 动作统一入口) -->
<script setup>
import { computed, onMounted, ref, watch } from "vue";
import Icon from "../common/Icon.vue";
import PixelAvatar from "../common/PixelAvatar.vue";
import { bot, loadState, manage, settingsPatch, openMem, closeMem } from "../stores/bot.js";
import { showView } from "../stores/ui.js";
import { showToast } from "../stores/toast.js";
import { shortAgo, fmtBytes } from "../stores/fmt.js";
import { settingsApi, settingsPutApi, personaPreviewApi } from "../api/endpoints.js";

const s = computed(() => bot.s);
const live = computed(() => (s.value && s.value.live) || {});
const st = computed(() => (s.value && s.value.settings) || {});
const rules = computed(() => (st.value.rules || {}));
const worker = computed(() => (st.value.worker || {}));
const limits = computed(() => (st.value.limits || {}));
const auto = computed(() => (st.value.autonomy || {}));
const brief = computed(() => (st.value.briefing || {}));

/* 表单本地态 (保存时提交) */
const setName = ref("");
const setWs = ref("");
const briefTime = ref("08:30");
const agText = ref("");
const agAt = ref("");
const memEdit = ref("");
const limitForm = ref({});
const permForm = ref({ approvalMode: "on-request", sandbox: "workspace-write" });

watch(s, (st2) => {
  if (!st2) return;
  if (!setName.value) setName.value = st2.bot.name || "";
  if (!setWs.value) setWs.value = st2.bot.workspace || "";
  briefTime.value = ((st2.settings || {}).briefing || {}).time || briefTime.value;
  const lim = ((st2.settings || {}).limits) || {};
  for (const k of Object.keys(lim)) {
    if (limitForm.value[k] === undefined) limitForm.value[k] = lim[k];
  }
  permForm.value.approvalMode = (st2.live || {}).approvalMode || permForm.value.approvalMode;
  permForm.value.sandbox = (st2.live || {}).sandbox || permForm.value.sandbox;
}, { immediate: true });

/* 记忆编辑框跟随 store (异步读取完成后回填) */
watch(() => bot.memText, (t) => { memEdit.value = t || ""; });

function segApply(name2, val) {
  if (name2 === "paused") manage("pause", { paused: val === "paused" }, val === "paused" ? "已暂停" : "继续运行").catch(() => {});
  else if (name2 === "type") manage("type", { typeId: val }, "类型已切换").catch(() => {});
  else if (name2 === "rules.background" || name2 === "rules.outbound") {
    const key = name2.split(".")[1];
    settingsPatch({ rules: { [key]: val } }, "规则已更新").catch(() => {});
  } else if (name2.startsWith("worker.")) {
    const wk = name2.split(".")[1];
    if (wk === "enabled") settingsPatch({ worker: { enabled: val === "1" } }, "已更新").catch(() => {});
  } else if (name2 === "briefing.enabled") settingsPatch({ briefing: { enabled: val === "1" } }, "已更新").catch(() => {});
  else if (name2 === "autonomy.enabled") settingsPatch({ autonomy: { enabled: val === "1" } }, "已更新").catch(() => {});
  else if (name2 === "autonomy.mode") settingsPatch({ autonomy: { mode: val } }, "模式已切换").catch(() => {});
}

function act(a) {
  switch (a) {
    case "refresh": loadState(); showToast("已刷新"); break;
    case "modelsManage": import("../stores/ui.js").then((u) => { u.ui.settingsModal = "models"; }); break;
    case "rename": {
      const v = (setName.value || "").trim();
      if (!v) { showToast("名字不能为空", true); return; }
      manage("rename", { name: v }, "改好了").catch(() => {});
      break;
    }
    case "avatarPick": pickAvatar(); break;
    case "avatarClear": manage("avatar", { id: s.value.bot.id }, "头像已移除").catch(() => {}); break;
    case "workspace": {
      const ws = (setWs.value || "").trim();
      if (!ws) { showToast("路径不能为空", true); return; }
      manage("workspace", { workspace: ws }, "档案已更新（重启后按新目录跑）").catch(() => {});
      break;
    }
    case "briefTime": settingsPatch({ briefing: { time: briefTime.value || "08:30" } }, "时间已保存").catch(() => {}); break;
    case "briefNow": manage("briefingNow", {}, "已生成, 简报会走启用的通道发出").catch(() => {}); break;
    case "agAdd": {
      const text = (agText.value || "").trim();
      if (!text) { showToast("写点什么", true); return; }
      manage("agendaAdd", { text, at: agAt.value || null }, "已加入日程").then(() => { agText.value = ""; }).catch(() => {});
      break;
    }
    case "saveLimits": {
      const lim = {};
      for (const [k, v] of Object.entries(limitForm.value)) lim[k] = Number(v) || 0;
      settingsPatch({ limits: lim }, "限额已保存").catch(() => {});
      break;
    }
    case "proactive": {
      manage("proactive", {}, "扫描完成").then((j) => {
        if (j && j.message) showToast(String(j.message).slice(0, 90));
        else if (j && j.items && j.items.length) showToast("扫到 " + j.items.length + " 件可推进的事");
        else showToast("没有需要主动做的事");
      }).catch(() => {});
      break;
    }
    case "permission": {
      manage("permission", { approvalMode: permForm.value.approvalMode, sandbox: permForm.value.sandbox }, "权限已更新").catch(() => {});
      break;
    }
    case "memSave": {
      if (bot.memPath == null) return;
      manage("memoryWrite", { path: bot.memPath, text: memEdit.value }, "已写入").catch(() => {});
      break;
    }
    case "memClose": closeMem(); break;
    default: break;
  }
}

function pickAvatar() {
  const clone = document.createElement("input");
  clone.type = "file";
  clone.accept = "image/png,image/jpeg,image/webp,image/gif";
  clone.onchange = () => {
    const file = clone.files && clone.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { showToast("头像不能超过 4MB", true); return; }
    const fr = new FileReader();
    fr.onload = () => manage("avatar", { id: s.value.bot.id, dataUrl: String(fr.result) }, "头像已更新").catch(() => {});
    fr.readAsDataURL(file);
  };
  clone.click();
}

function memClick(p) {
  openMem(p);
}

/* ---------- 个性化 (WorkBuddy 式面板): 称呼/回复风格/指令 → config; 人设 → identity.md/ishiki.md ---------- */
const pUserName = ref("");
const pTone = ref("");
const pDirectives = ref("");
const pIdentity = ref("");
const pIshiki = ref("");
const pPreview = ref(null);
const pPreviewOpen = ref(false);

async function loadPersona() {
  try {
    const j = await settingsApi();
    const st = (j && j.settings) || {};
    pUserName.value = (st.user && st.user.name) || "";
    pTone.value = (st.agent && st.agent.reply_style) || "";
    pDirectives.value = (st.agent && st.agent.system_extra) || "";
  } catch { /* 读取失败: 表单留空, 保存时报错 */ }
  try {
    const j = await manage("personaRead", {});
    pIdentity.value = (j && j.identity) || "";
    pIshiki.value = (j && j.ishiki) || "";
  } catch { /* 同上 */ }
}

async function saveUserName() {
  try {
    await settingsPutApi({ patch: { user: { name: pUserName.value.trim() } } });
    showToast("称呼已保存, 下一轮对话生效");
  } catch (e) {
    showToast("保存失败: " + ((e && e.message) || "未知错误"), true);
  }
}
async function saveTone() {
  try {
    await settingsPutApi({ patch: { agent: { reply_style: pTone.value } } });
    showToast("回复风格已保存, 下一轮对话生效");
  } catch (e) {
    showToast("保存失败: " + ((e && e.message) || "未知错误"), true);
  }
}
async function saveDirectives() {
  try {
    await settingsPutApi({ patch: { agent: { system_extra: pDirectives.value } } });
    showToast("指令已保存, 下一轮对话生效");
  } catch (e) {
    showToast("保存失败: " + ((e && e.message) || "未知错误"), true);
  }
}
function savePersonaFiles() {
  manage("personaWrite", { identity: pIdentity.value, ishiki: pIshiki.value }, "人设已保存, 下一轮对话生效").catch(() => {});
}
async function togglePreview() {
  pPreviewOpen.value = !pPreviewOpen.value;
  if (!pPreviewOpen.value) return;
  pPreview.value = null;
  try {
    const j = await personaPreviewApi();
    pPreview.value = j && j.ok ? j : { ok: false, error: (j && j.error) || "未知错误" };
  } catch (e) {
    pPreview.value = { ok: false, error: (e && e.message) || "请求失败" };
  }
}

onMounted(() => { loadState(); loadPersona(); });
</script>

<template>
  <section id="view-settings" class="view">
    <header class="botbar">
      <button class="icobtn" title="返回" aria-label="返回" @click="showView('chat')"><Icon name="back" :size="16" /></button>
      <PixelAvatar v-if="s && !s.bot.avatarUrl" :name="s.bot.name" :size="28" />
      <div class="bmeta">
        <div class="bname2" id="setTitle">设置{{ s ? " · " + s.bot.name : "" }}</div>
        <div class="bsub" id="setSub">{{ s ? (s.bot.typeName + " · " + s.workspace) : "正在读取助手状态…" }}</div>
      </div>
      <span class="flex1" />
      <button class="icobtn" title="刷新" aria-label="刷新" @click="act('refresh')"><Icon name="refresh" :size="16" /></button>
    </header>

    <div id="botSettings" class="swrap">
      <div v-if="!s" class="empty">
        还没读到助手状态<br>
        <button class="btn xs" @click="loadState()">重试</button>
      </div>
      <template v-else>
        <!-- 运行状态 -->
        <div class="ssec">
          <div class="ssec-head">运行状态<span class="flex1" /><button class="wbtn" @click="act('refresh')">刷新</button></div>
          <div class="srow"><span class="slab">运行</span>
            <span class="seg">
              <button :class="{ on: !s.bot.paused }" @click="segApply('paused', 'running')">运行中</button>
              <button :class="{ on: s.bot.paused }" @click="segApply('paused', 'paused')">已暂停</button>
            </span>
          </div>
          <div v-if="s.bot.paused" class="shint">暂停只是让助手不再主动行动, 你发消息它照常回。</div>
          <div class="srow"><span class="slab">运行阶段</span><span class="svd">{{ (live.stage ? "阶段 " + live.stage : "阶段 —") + " · " + (live.chats != null ? live.chats + " 次对话" : "对话数未知") + (live.evolved != null ? " · 进化 " + live.evolved + " 次" : "") }}</span></div>
          <div class="srow"><span class="slab">心跳</span><span class="svd">{{ shortAgo(live.heartbeatAt) }} · 进程已跑 {{ Math.round((live.uptimeMs || 0) / 60000) }} 分钟</span></div>
          <div class="srow"><span class="slab">今天</span><span class="svd">{{ (live.traces.count || 0) + " 次工具调用 · 失败 " + (live.traces.failed || 0) + " · 失败率 " + (live.traces.failRate || "0%") }}</span></div>
        </div>

        <!-- 模型配置 -->
        <div class="ssec">
          <div class="ssec-head">模型配置<span class="flex1" />
            <button class="wbtn" @click="act('modelsManage')">管理模型</button>
          </div>
          <div class="srow"><span class="slab">当前模型</span><span class="svd">{{ live.model || "未配置" }}</span></div>
          <template v-if="(live.providers || []).length">
            <div v-for="(p, i) in live.providers" :key="i" class="svc" :data-state="p.configured ? 'ok' : 'unknown'">
              <span class="sdot" /><span class="svn">{{ p.id || "未命名" }}</span>
              <span class="svd">{{ (p.model || "未设模型") + " · " + (p.configured ? "已配置凭据" : "未配置 Key") }}</span>
            </div>
          </template>
          <div v-else class="shint">还没有配置任何模型提供商。</div>
          <div class="shint">换模型、填 Key、拉取模型列表在「管理模型」里完成。</div>
        </div>

        <!-- 身份 -->
        <div class="ssec">
          <div class="ssec-head">身份</div>
          <div class="idcard">
            <PixelAvatar v-if="!s.bot.avatarUrl" :name="s.bot.name" :size="54" />
            <img v-else class="idimg" :src="s.bot.avatarUrl" alt="">
            <div class="idmeta">
              <div class="idname">{{ s.bot.name }}</div>
              <div class="idtype">{{ s.bot.typeName || "助手" }}<span v-if="s.bot.blurb"> · {{ s.bot.blurb }}</span></div>
              <div class="idhint">{{ s.bot.avatarUrl ? "使用上传的头像" : "像素头像由名字生成 · 改名会换一张" }}</div>
            </div>
          </div>
          <div class="srow"><span class="slab">名字</span>
            <input v-model="setName" type="text" class="grow" maxlength="40">
            <button class="wbtn primary" @click="act('rename')">保存</button>
          </div>
          <div class="srow"><span class="slab">类型</span>
            <span class="seg">
              <button v-for="x in (s.types || [])" :key="x.id" :class="{ on: s.bot.type === x.id }" @click="segApply('type', x.id)">{{ x.name }}</button>
            </span>
            <span v-if="s.bot.blurb" class="svd">{{ s.bot.blurb }}</span>
          </div>
          <div class="srow"><span class="slab">头像</span>
            <button class="wbtn" @click="act('avatarPick')">上传图片</button>
            <button class="wbtn danger" @click="act('avatarClear')">移除</button>
          </div>
          <div class="shint">PNG / JPEG / WebP / GIF，≤4MB。按内容类型校验, 不看扩展名。</div>
        </div>

        <!-- 个性化 -->
        <div class="ssec">
          <div class="ssec-head">个性化<span class="flex1" />
            <button class="wbtn" @click="togglePreview">{{ pPreviewOpen ? "收起预览" : "预览系统提示词" }}</button>
          </div>
          <div class="srow"><span class="slab">对你的称呼</span>
            <input v-model="pUserName" type="text" class="grow" maxlength="24" placeholder="兄弟">
            <button class="wbtn primary" @click="saveUserName">保存</button>
          </div>
          <div class="shint">助手平时怎么叫你。写进每轮系统提示词, 下一轮对话生效。</div>
          <div class="srow"><span class="slab">回复风格</span><span class="flex1" />
            <button class="wbtn primary" @click="saveTone">保存</button>
          </div>
          <textarea v-model="pTone" class="mempane thin" rows="3" spellcheck="false"
            placeholder="例如: 简洁直接, 少客套, 先给结论再给证据; 涉及代码时给 文件:行。留空 = 不注入。"></textarea>
          <div class="srow"><span class="slab">给助手的指令</span><span class="flex1" />
            <button class="wbtn primary" @click="saveDirectives">保存</button>
          </div>
          <textarea v-model="pDirectives" class="mempane thin" rows="4" spellcheck="false"
            placeholder="工作流约定, 支持 Markdown。例如: 默认先出计划, 我确认后再动手; 高危命令必须先问我。留空 = 不注入。"></textarea>
          <div class="srow"><span class="slab">人设设定</span><span class="svd">身份 (config/identity.md) · 性格表达 (config/ishiki.md)</span></div>
          <textarea v-model="pIdentity" class="mempane thin" rows="3" spellcheck="false"
            placeholder="身份: 我是谁 —— 长期不变的自我描述"></textarea>
          <textarea v-model="pIshiki" class="mempane thin" rows="3" spellcheck="false"
            placeholder="性格与表达: 例如 直接、务实"></textarea>
          <div class="srow"><span class="flex1" />
            <button class="wbtn primary" @click="savePersonaFiles">保存人设</button>
          </div>
          <div v-if="pPreviewOpen && pPreview && pPreview.ok" class="promptpreview">{{ pPreview.preview }}</div>
          <div v-else-if="pPreviewOpen && pPreview" class="shint">预览失败: {{ pPreview.error }}</div>
          <div v-else-if="pPreviewOpen" class="shint">正在组装最终系统提示词…</div>
        </div>

        <!-- 工作区 -->
        <div class="ssec">
          <div class="ssec-head">工作区</div>
          <div class="srow"><span class="slab">路径</span>
            <input v-model="setWs" type="text" class="grow" spellcheck="false">
            <button class="wbtn" @click="act('workspace')">应用</button>
          </div>
          <div class="shint">改工作区只改档案记录。真正跑在哪由启动时的 root 决定 —— 换目录请用新工作区重启, 界面不假装已经切过去了。</div>
        </div>

        <!-- 规则 -->
        <div class="ssec">
          <div class="ssec-head">规则</div>
          <div class="srow"><span class="slab">后台干活</span>
            <span class="seg">
              <button v-for="[v, label] in [['auto','自己干'],['preapproved','预先批准的才干'],['ask','每次问'],['handoff','交给别人']]" :key="v" :class="{ on: rules.background === v }" @click="segApply('rules.background', v)">{{ label }}</button>
            </span>
          </div>
          <div class="srow"><span class="slab">对外发送</span>
            <span class="seg">
              <button v-for="[v, label] in [['auto','自己干'],['preapproved','预先批准的才干'],['ask','每次问'],['handoff','交给别人']]" :key="v" :class="{ on: rules.outbound === v }" @click="segApply('rules.outbound', v)">{{ label }}</button>
            </span>
          </div>
          <div class="shint">「对外发送」管的是发邮件/发消息这类一旦发出就收不回的动作。默认每次问。</div>
        </div>

        <!-- 后台执行 -->
        <div class="ssec">
          <div class="ssec-head">后台执行</div>
          <div class="srow"><span class="slab">启用</span>
            <span class="seg">
              <button :class="{ on: worker.enabled }" @click="segApply('worker.enabled', '1')">开</button>
              <button :class="{ on: !worker.enabled }" @click="segApply('worker.enabled', '0')">关</button>
            </span>
          </div>
          <div class="srow"><span class="slab">看队列间隔</span><input type="number" :value="worker.pollSeconds" min="5" max="3600" @change="settingsPatch({ worker: { pollSeconds: Number($event.target.value) } }, '已更新')"><span class="svd">秒</span></div>
          <div class="srow"><span class="slab">同时做几件</span><input type="number" :value="worker.concurrency" min="1" max="8" @change="settingsPatch({ worker: { concurrency: Number($event.target.value) } }, '已更新')"><span class="svd">件</span></div>
          <div class="srow"><span class="slab">今日次数</span><span class="svd">{{ String(worker.todayRuns || 0) }} 次</span></div>
        </div>

        <!-- 晨间简报 -->
        <div class="ssec">
          <div class="ssec-head">晨间简报</div>
          <div class="srow"><span class="slab">启用</span>
            <span class="seg">
              <button :class="{ on: brief.enabled }" @click="segApply('briefing.enabled', '1')">开</button>
              <button :class="{ on: !brief.enabled }" @click="segApply('briefing.enabled', '0')">关</button>
            </span>
          </div>
          <div class="srow"><span class="slab">时间</span>
            <input v-model="briefTime" type="time">
            <button class="wbtn" @click="act('briefTime')">保存</button>
          </div>
          <div class="srow"><span class="slab">现在发一条</span>
            <button class="wbtn" @click="act('briefNow')">立刻生成</button>
            <span class="svd">上次: {{ brief.lastAt ? shortAgo(brief.lastAt) : "从未" }}</span>
          </div>
        </div>

        <!-- 日程 -->
        <div class="ssec">
          <div class="ssec-head">日程<span class="flex1" /><span class="svd">{{ (s.agenda || []).length }} 条</span></div>
          <div class="srow">
            <span class="sctl-inline">
              <input v-model="agText" type="text" placeholder="要做的事…" maxlength="200">
              <input v-model="agAt" type="time">
              <button class="wbtn primary" @click="act('agAdd')">添加</button>
            </span>
          </div>
          <template v-if="(s.agenda || []).length">
            <div v-for="a in s.agenda" :key="a.id" class="ag" :class="{ done: a.done }">
              <button class="icobtn sm" :title="a.done ? '标记未完成' : '标记完成'" @click="manage('agendaDone', { agendaId: a.id, done: !a.done }).catch(() => {})">
                <Icon :name="a.done ? 'check' : 'stop-dot'" :size="13" />
              </button>
              <span class="agt">{{ a.text }}</span>
              <span v-if="a.at" class="agw">{{ a.at }}</span>
              <button class="icobtn sm" title="删除" @click="manage('agendaRemove', { agendaId: a.id }, '已删除').catch(() => {})"><Icon name="trash" :size="13" /></button>
            </div>
          </template>
          <div v-else class="shint">还没有日程。日程是给助手自己看的待办，不是日历 —— 到点它会主动提。</div>
        </div>

        <!-- 限额 -->
        <div class="ssec">
          <div class="ssec-head">限额<span class="flex1" /><button class="wbtn" @click="act('saveLimits')">保存</button></div>
          <div class="srow"><span class="slab">单任务最多跑</span><input v-model="limitForm.maxTaskMinutes" type="number" min="0" max="1440"><span class="svd">分钟</span></div>
          <div class="srow"><span class="slab">每天累计</span><input v-model="limitForm.dailyMinutes" type="number" min="0" max="1440"><span class="svd">分钟</span></div>
          <div class="srow"><span class="slab">单任务最多调工具</span><input v-model="limitForm.maxToolCalls" type="number" min="0" max="10000"><span class="svd">次</span></div>
          <div class="srow"><span class="slab">队列保留</span><input v-model="limitForm.queueKeep" type="number" min="0" max="10000"><span class="svd">条</span></div>
          <div class="srow"><span class="slab">回放保留</span><input v-model="limitForm.replayKeep" type="number" min="0" max="10000"><span class="svd">条</span></div>
          <div class="srow"><span class="slab">面板加载</span><input v-model="limitForm.panelLimit" type="number" min="0" max="1000"><span class="svd">条</span></div>
          <div class="shint">0 = 不限。这些是给自主行动装的刹车 —— 没人看着的时候, 它最多能花多少时间、调多少次工具。</div>
        </div>

        <!-- 自主时间 -->
        <div class="ssec">
          <div class="ssec-head">自主时间</div>
          <div class="srow"><span class="slab">启用</span>
            <span class="seg">
              <button :class="{ on: auto.enabled }" @click="segApply('autonomy.enabled', '1')">开</button>
              <button :class="{ on: !auto.enabled }" @click="segApply('autonomy.enabled', '0')">关</button>
            </span>
          </div>
          <div class="srow"><span class="slab">空闲多久动一次</span><input type="number" :value="auto.idleMinutes" min="1" max="1440" @change="settingsPatch({ autonomy: { idleMinutes: Number($event.target.value) } }, '已更新')"><span class="svd">分钟</span></div>
          <div class="srow"><span class="slab">每小时最多</span><input type="number" :value="auto.maxPerHour" min="1" max="120" @change="settingsPatch({ autonomy: { maxPerHour: Number($event.target.value) } }, '已更新')"><span class="svd">次</span></div>
          <div class="srow"><span class="slab">模式</span>
            <span class="seg">
              <button :class="{ on: auto.mode === 'read' }" @click="segApply('autonomy.mode', 'read')">只读</button>
              <button :class="{ on: auto.mode === 'review' }" @click="segApply('autonomy.mode', 'review')">可动手·每步审查</button>
              <button :class="{ on: auto.mode === 'full' }" @click="segApply('autonomy.mode', 'full')">完全权限</button>
            </span>
          </div>
          <div class="shint">只读 = 只看不动；可动手 = 能改但每步等你点头；完全权限 = 自己决定。默认只读。</div>
          <div class="srow"><span class="slab">现在就去看一眼</span><button class="wbtn" @click="act('proactive')">立刻扫描</button></div>
        </div>

        <!-- 权限 -->
        <div class="ssec">
          <div class="ssec-head">权限</div>
          <div class="srow"><span class="slab">审批模式</span>
            <select v-model="permForm.approvalMode">
              <option v-for="m in ['unless-trusted', 'on-request', 'on-failure', 'never']" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
          <div class="srow"><span class="slab">沙箱</span>
            <select v-model="permForm.sandbox">
              <option v-for="m in ['read-only', 'workspace-write', 'danger-full-access']" :key="m" :value="m">{{ m }}</option>
            </select>
            <button class="wbtn primary" @click="act('permission')">应用</button>
          </div>
        </div>

        <!-- 记忆 -->
        <div class="ssec">
          <div class="ssec-head">记忆<span class="flex1" /><span class="svd">事实 {{ s.memory.factCount }} · 场景 {{ s.memory.sceneCount }} · 文件 {{ (s.memory.files || []).length }}</span></div>
          <template v-if="(s.memory.files || []).length">
            <div v-for="f in s.memory.files" :key="f.path" class="memfile" @click="memClick(f.path)">
              <Icon name="file" :size="12" />{{ f.path }}
              <span class="msz">{{ fmtBytes(f.size) }} · {{ shortAgo(f.mtime) }}</span>
            </div>
          </template>
          <div v-else class="shint">data/memory 下没有可读文件。</div>
          <template v-if="bot.memPath">
            <div class="srow">
              <span class="sctl-inline">
                <span class="svd">{{ bot.memPath }}</span>
                <span class="flex1" />
                <button class="wbtn primary" @click="act('memSave')">保存</button>
                <button class="wbtn" @click="act('memClose')">关闭</button>
              </span>
            </div>
            <textarea v-model="memEdit" class="mempane" spellcheck="false"></textarea>
          </template>
        </div>

        <!-- 服务 -->
        <div class="ssec">
          <div class="ssec-head">服务</div>
          <template v-if="(s.services || []).length">
            <div v-for="(x, i) in s.services" :key="i" class="svc" :data-state="x.state">
              <span class="sdot" /><span class="svn">{{ x.name }}</span><span class="svd">{{ x.kind }} · {{ x.detail }}</span>
            </div>
          </template>
          <div v-else class="shint">没有可列的服务。</div>
          <div class="shint">灰点 = 没测过，不等于没问题。要测连通性请到「模型配置」页点测试。</div>
        </div>

        <!-- 关于 -->
        <div class="ssec">
          <div class="ssec-head">关于</div>
          <div class="srow"><span class="slab">版本</span><span class="svd">{{ s.version || "未知" }}</span></div>
          <div class="srow"><span class="slab">工作区</span><span class="svd">{{ s.workspace }}</span></div>
          <div class="srow"><span class="slab">工具</span><span class="svd">{{ ((live.tools || {}).total || 0) + " 个 · 启用 " + ((live.tools || {}).enabled || 0) }}</span></div>
          <div class="srow"><span class="slab">模型</span><span class="svd">{{ live.model || "未配置" }}</span></div>
          <div class="srow"><span class="slab">今天轮数</span><span class="svd">{{ live.turns == null ? "未知" : live.turns }}</span></div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
@import "./manage.css";
.view { display: flex; flex-direction: column; min-height: 0; }
.sctl-inline { display: flex; align-items: center; gap: 8px; flex: 1; flex-wrap: wrap; }
.sctl-inline input[type="text"] { flex: 1; min-width: 160px; }
.srow input[type="number"] { width: 90px; }
.idcard {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 12px; margin: 2px 0 10px;
  background: var(--surface-2); border: 1px solid var(--border-soft); border-radius: var(--r-md);
}
.idimg { width: 54px; height: 54px; border-radius: 12px; object-fit: cover; flex: none; }
.idmeta { min-width: 0; }
.idname { font-weight: 700; font-size: 14px; }
.idtype { font-size: 12px; color: var(--text-2); margin-top: 1px; }
.idhint { font-size: 11px; color: var(--text-4); margin-top: 2px; }
.mempane.thin { min-height: 0; margin-top: 2px; }
.promptpreview {
  margin-top: 8px; max-height: 320px; overflow: auto;
  font-family: ui-monospace, Consolas, monospace; font-size: 11px; line-height: 1.55;
  white-space: pre-wrap; word-break: break-word; color: var(--text-3);
  background: var(--bg-soft); border: 1px solid var(--border-soft);
  border-radius: var(--r-md); padding: 10px 12px;
}
</style>
