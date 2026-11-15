<!-- webapp/src/modals/Onboarding.vue - 使用向导三步 (首次自动出现, 侧栏「使用向导」可重看)
     v5.1 改动: 第 2 步不再是一个"去设置里配"的跳转按钮, 而是就地两栏 —— 模型名称 + API Key。
       理由: 跳走之后没人回来。这一步必须当场做完, 或者当场决定跳过。
     本地模型 (LM Studio / Ollama) 不在引导里推, 留给用户自己去「设置 → 模型」加;
       不配模型也能进主界面, 只是顶部会挂一条提示 (ReadyBanner)。 -->
<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { ui } from "../stores/ui.js";
import { showToast } from "../stores/toast.js";
import { chat } from "../stores/chat.js";
import { attachByModelName, guessPreset } from "../stores/model-preset.js";
import { loadModelPanel } from "../stores/settings.js";
import { T } from "../i18n/lexicon.js";

const KEY = "ppx_onboarded_v1";
const TOTAL = 3;
const idx = ref(0);
const open = computed(() => ui.onboarding);

/* 第 2 步: 模型名称 + API Key */
const modelName = ref("");
const apiKey = ref("");
const baseUrl = ref("");
const advOpen = ref(false);
const busy = ref(false);
const result = ref(null); // { ok, healthy, detail, error }

const guessed = computed(() => guessPreset(modelName.value));
const endpointHint = computed(() => {
  if (baseUrl.value.trim()) return baseUrl.value.trim();
  if (guessed.value) return guessed.value.base_url + " · 按模型名识别为 " + guessed.value.name;
  return modelName.value.trim() ? "认不出这个名字，展开下面填接口地址" : "填了模型名后自动识别接口地址";
});

async function connect() {
  if (busy.value) return;
  busy.value = true;
  result.value = null;
  const r = await attachByModelName({ model: modelName.value, apiKey: apiKey.value, baseUrl: baseUrl.value });
  busy.value = false;
  result.value = r;
  if (r.ok) {
    loadModelPanel();
    // 探测通过 (或本来就存在) → 停一下让用户看见回执, 再进下一步
    if (r.healthy !== false) setTimeout(() => { if (idx.value === 1) idx.value = 2; }, 800);
  }
}

function skipModel() {
  idx.value = 2;
}

const STARTERS = [
  { label: "读懂这个项目", q: "先列出工作区结构，再挑 3 个最关键的文件，说明它们各自的作用和相互关系。" },
  { label: "做个小改动", q: "在工作区里找一个可以改进的小问题，先写一条能复现它的测试并跑出失败，再修好、跑绿并说明改动。" },
  { label: "自审代码结构", q: "用 self_audit 自审代码结构，挑一个最值得改的点，说明理由、影响面和验证方式。" },
];

function hide(markDone) {
  ui.onboarding = false;
  if (markDone) {
    try { localStorage.setItem(KEY, String(Date.now())); } catch { /* 隐私模式忽略 */ }
  }
}
function next() {
  if (idx.value < TOTAL - 1) { idx.value += 1; return; }
  hide(true);
}
function prev() { if (idx.value > 0) idx.value -= 1; }
function useStarter(s) {
  hide(true);
  chat.input = s.q;
  showToast("已填入输入框 · 按 Enter 发送");
}
function openModels() {
  hide(true);
  ui.settingsModal = "models";
}

watch(open, (v) => {
  if (!v) return;
  idx.value = 0;
  result.value = null;
});

onMounted(() => {
  let done = false;
  try { done = Boolean(localStorage.getItem(KEY)); } catch { done = false; }
  if (!done) setTimeout(() => { ui.onboarding = true; }, 600);
});
</script>

<template>
  <div v-if="open" class="onb-mask">
    <section class="onb" role="dialog" aria-modal="true">
      <button class="onb-skip" aria-label="跳过" @click="hide(true)">跳过</button>
      <div class="onb-top">
        <span class="onb-badge">{{ idx + 1 }} / {{ TOTAL }}</span>
        <span class="onb-kicker">{{ T.guide }}</span>
      </div>

      <!-- 第 1 步: 它是谁 -->
      <template v-if="idx === 0">
        <h2>你好，我是{{ T.brand }}</h2>
        <p class="onb-body">一个跑在本机的智能体：能读代码、跑命令、查资料、改自己，并把每一步留下证据。</p>
        <div class="onb-points">
          <div class="onb-point">直接说话就行 —— 我会自己决定读哪个文件、跑哪条命令。</div>
          <div class="onb-point">输入 <b>/</b> 打开命令面板；不确定能做什么就发 <b>/help</b>。</div>
          <div class="onb-point">左侧只有四项：对话、项目、任务、能力。想配置什么都收在「能力」里。</div>
        </div>
      </template>

      <!-- 第 2 步: 就地填模型名称 + Key, 可跳过 -->
      <template v-else-if="idx === 1">
        <h2>接上一个模型</h2>
        <p class="onb-body">只填两样：模型名称和 API Key。本地模型留给你自己去「设置 → 模型」里配，这一步也可以直接跳过。</p>

        <div class="onb-field">
          <label>模型名称</label>
          <input v-model="modelName" placeholder="deepseek-chat / gpt-4o / qwen-plus" spellcheck="false" @keyup.enter="connect">
          <span class="onb-tip">{{ endpointHint }}</span>
        </div>

        <div class="onb-field">
          <label>API Key</label>
          <input v-model="apiKey" type="password" placeholder="粘贴 Key，只保存在这台机器上" spellcheck="false" @keyup.enter="connect">
        </div>

        <button class="onb-adv" @click="advOpen = !advOpen">{{ advOpen ? "－" : "＋" }} 接口地址（可留空，按模型名自动识别）</button>
        <div v-if="advOpen" class="onb-field">
          <input v-model="baseUrl" placeholder="https://.../v1" spellcheck="false">
        </div>

        <div v-if="result" class="onb-result" :class="result.ok ? (result.healthy === false ? 'warn' : 'ok') : 'err'">
          <template v-if="!result.ok">✕ {{ result.error }}</template>
          <template v-else-if="result.healthy === false">已保存，但探测没通过：{{ result.detail }}。可以先继续，之后在设置里改。</template>
          <template v-else>✓ 已连接 · {{ result.detail }}</template>
        </div>

        <div class="onb-actions2">
          <button class="btn" @click="skipModel">先跳过</button>
          <span class="flex1" />
          <button class="btn primary" :disabled="busy" @click="connect">{{ busy ? "正在连接…" : "验证并连接" }}</button>
        </div>
        <div class="onb-foot">
          不配也能用：可以先看界面、看能力，随时回来补。<button class="onb-link" @click="openModels">打开完整设置</button>
        </div>
      </template>

      <!-- 第 3 步: 跑通第一条 -->
      <template v-else>
        <h2>跑通第一条，就算上手了</h2>
        <p class="onb-body">不用想提示词。挑一个直接发出去，看着它一步步做完 —— 比读十页文档快。</p>
        <div class="onb-starters">
          <button v-for="(s, i) in STARTERS" :key="i" class="onb-starter" @click="useStarter(s)">{{ s.label }}</button>
        </div>
        <div class="onb-points">
          <div class="onb-point">每次只推进一个可验证的小步，工具报错会自己读错误再改。</div>
          <div class="onb-point">改完会读回文件或跑测试；没验证的部分会明确标注。</div>
        </div>
      </template>

      <div v-if="idx !== 1" class="onb-actions">
        <button v-show="idx > 0" class="btn" @click="prev">上一步</button>
        <span class="flex1" />
        <button class="btn primary" @click="next">{{ idx === TOTAL - 1 ? "开始使用" : "下一步" }}</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.onb-mask { position: fixed; inset: 0; z-index: 95; background: rgba(8, 8, 12, 0.55); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; }
.onb {
  position: relative; width: min(480px, calc(100vw - 40px));
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg);
  box-shadow: var(--shadow-3); padding: 20px 22px;
  max-height: calc(100vh - 48px); overflow-y: auto;
}
.onb-skip { position: absolute; right: 14px; top: 12px; border: none; background: none; color: var(--text-4); cursor: pointer; font-size: 12px; }
.onb-skip:hover { color: var(--text); }
.onb-top { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.onb-badge { font-size: 10.5px; border: 1px solid var(--border); border-radius: 99px; padding: 1px 8px; color: var(--text-3); }
.onb-kicker { font-size: 11px; color: var(--accent); letter-spacing: 2px; }
h2 { margin: 0 0 8px; font-size: 18px; }
.onb-body { font-size: 13px; color: var(--text-2); margin: 0 0 12px; }
.onb-points { display: flex; flex-direction: column; gap: 6px; }
.onb-point { font-size: 12.5px; color: var(--text-2); padding-left: 14px; position: relative; }
.onb-point::before { content: ""; position: absolute; left: 0; top: 7px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); opacity: 0.7; }
.onb-point b { color: var(--accent); }
/* 模型表单 */
.onb-field { margin-bottom: 10px; }
.onb-field label { display: block; font-size: 11.5px; color: var(--text-3); margin-bottom: 4px; }
.onb-field input {
  width: 100%; padding: 8px 11px; border: 1px solid var(--border); border-radius: var(--r-sm);
  background: var(--surface-2); color: var(--text); font-size: 13px; outline: none;
}
.onb-field input:focus { border-color: var(--accent-border); box-shadow: 0 0 0 3px var(--accent-soft); }
.onb-tip { display: block; font-size: 11px; color: var(--text-4); margin-top: 3px; word-break: break-all; }
.onb-adv { border: none; background: none; color: var(--text-3); font-size: 11.5px; cursor: pointer; padding: 0 0 8px; }
.onb-adv:hover { color: var(--text); }
.onb-result { font-size: 12px; border-radius: var(--r-sm); padding: 7px 10px; margin-bottom: 10px; }
.onb-result.ok { color: var(--ok); background: var(--ok-soft); }
.onb-result.warn { color: var(--warn); background: var(--warn-soft); }
.onb-result.err { color: var(--err); background: var(--err-soft); }
.onb-actions { display: flex; align-items: center; gap: 8px; margin-top: 18px; }
.onb-actions2 { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.onb-foot { font-size: 11.5px; color: var(--text-4); margin-top: 10px; }
.onb-link { border: none; background: none; color: var(--accent); cursor: pointer; font-size: 11.5px; text-decoration: underline; text-underline-offset: 2px; padding: 0 4px; }
.onb-starters { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 12px; }
.onb-starter {
  border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2);
  border-radius: 99px; padding: 5px 14px; font-size: 12.5px; cursor: pointer;
}
.onb-starter:hover { border-color: var(--accent); color: var(--accent); }
.flex1 { flex: 1; }
</style>
