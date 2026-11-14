<!-- webapp/src/views/BodyView.vue - 身体页: 四体征卡 + 躯干呼吸图 (没量过 = 不动, 不编数) -->
<script setup>
import { computed, onMounted } from "vue";
import Icon from "../common/Icon.vue";
import { bot, loadBody, BODY_LABEL, OVERALL_LABEL } from "../stores/bot.js";
import { showView } from "../stores/ui.js";
import { showToast } from "../stores/toast.js";
import { pct, fmtMs, shortAgo } from "../stores/fmt.js";

const s = computed(() => bot.body);
function stateOf(organ) {
  const st = s.value;
  if (!st) return "unknown";
  const m = { pain: st.pain, memory: st.memory, load: st.load, work: st.work }[organ] || {};
  return m.state || "unknown";
}
function sparkPath(vals, tone) {
  if (!vals || vals.length < 2) return { pts: "", last: null };
  const w = 96, h = 20, pad = 3;
  const min = Math.min(...vals), max = Math.max(...vals);
  let span = max - min;
  if (!(span > 0.001)) span = 0.001;
  const pts = vals.map((v, i) => {
    const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return x.toFixed(1) + "," + y.toFixed(1);
  });
  return { pts: pts.join(" "), last: pts[pts.length - 1].split(",") };
}
const pain = computed(() => (s.value && s.value.pain) || {});
const mem = computed(() => (s.value && s.value.memory) || {});
const work = computed(() => (s.value && s.value.work) || {});
const load = computed(() => (s.value && s.value.load) || {});
const hist = computed(() => (s.value && s.value.history) || {});
const workItems = computed(() => ((work.value.items || []).filter((x) => x.status !== "done")).slice(0, 5));

function blink(card) {
  card.classList.add("blink");
  setTimeout(() => card.classList.remove("blink"), 1200);
}
function organClick(organ, ev) {
  const card = ev.target.closest(".bodygrid")?.querySelector("#card" + organ.charAt(0).toUpperCase() + organ.slice(1));
  if (card) blink(card);
}
onMounted(() => loadBody());
</script>

<template>
  <section id="view-body" class="view bodyview">
    <header class="botbar">
      <button class="icobtn" title="返回" aria-label="返回" @click="showView('chat')"><Icon name="back" :size="16" /></button>
      <div class="bhead-t">
        <div class="bhead-n">运行状态</div>
        <div class="bhead-s">{{ s ? (OVERALL_LABEL[s.overall] || "—") : "—" }}</div>
      </div>
      <span class="flex1" />
      <button class="btn xs" @click="refresh">刷新</button>
    </header>
    <div class="bodywrap">
      <div v-if="!s" class="empty">
        {{ bot.bodyErr ? "拿不到体征 —— 不是「健康」, 是「不知道」。" : "正在摸脉…" }}
      </div>
      <template v-else>
        <div class="bodygrid">
          <!-- 躯干: 状态靠呼吸节奏传达; unknown 不动 = 没量过 -->
          <aside class="bfig">
            <svg viewBox="0 0 140 258" class="bsvg" aria-hidden="true">
              <g class="bline">
                <circle cx="70" cy="28" r="15" />
                <path d="M57 47 Q70 42 83 47 L86 112 Q70 122 54 112 Z" />
                <path d="M55 53 L42 88 L39 114" />
                <path d="M85 53 L98 88 L101 114" />
                <path d="M61 118 L59 170 L57 216" />
                <path d="M79 118 L81 170 L83 216" />
              </g>
              <g v-for="([organ, cx, cy, r]) in [['pain',70,26,11],['memory',70,70,11],['load',70,98,10],['work',101,112,10]]"
 :key="organ" class="borgan" :data-organ="organ" :data-state="stateOf(organ)" @click="organClick(organ, $event)">
                <circle class="bhalo" :cx="cx" :cy="cy" :r="r" />
                <circle class="bdot2" :cx="cx" :cy="cy" :r="r / 2" />
              </g>
            </svg>
            <p class="bfigcap">{{ s.verdict || "—" }}</p>
          </aside>

          <div class="bcards">
            <article id="cardPain" class="bcard" :data-state="pain.state || 'unknown'">
              <div class="bcard-h"><span class="bdot" :data-t="pain.state || 'unknown'" /><span class="bcard-t">痛觉 · 能不能干成事</span><span class="bval">{{ pain.total ? pct(pain.rate) : "—" }}</span></div>
              <p class="bfeel">{{ pain.feeling || "—" }}</p>
              <div class="bcard-b">
                <template v-if="pain.total">
                  <div class="brow"><b>{{ pain.passed }}/{{ pain.total }}</b> 个任务干成 · 耗时 {{ fmtMs(pain.ms) }}</div>
                  <div class="bsub">最近一次 {{ shortAgo(pain.at) }}前 · {{ BODY_LABEL[pain.state] || pain.state }}</div>
                  <svg v-if="sparkPath(hist.pain).pts" class="bspark" viewBox="0 0 96 20" width="96" height="20">
                    <polyline :points="sparkPath(hist.pain).pts" />
                    <circle :cx="sparkPath(hist.pain).last[0]" :cy="sparkPath(hist.pain).last[1]" r="2" />
                  </svg>
                </template>
                <div v-else class="bnote">{{ pain.hint || "还没跑过" }}</div>
              </div>
            </article>
            <article id="cardMemory" class="bcard" :data-state="mem.state || 'unknown'">
              <div class="bcard-h"><span class="bdot" :data-t="mem.state || 'unknown'" /><span class="bcard-t">记忆 · 认不认得你</span><span class="bval">{{ mem.recallK == null ? "—" : pct(mem.recallK) }}</span></div>
              <p class="bfeel">{{ mem.feeling || "—" }}</p>
              <div class="bcard-b">
                <div class="brow"><b>{{ mem.facts == null ? "?" : mem.facts }}</b> 条有效记忆</div>
                <template v-if="mem.recallK != null">
                  <div class="bsub">换个说法认得出来 <b>{{ pct(mem.recallK) }}</b> · 原话直接命中 {{ pct(mem.recall1) }}</div>
                  <div class="bsub">向量 {{ mem.embedder || "?" }} · 最近一次 {{ shortAgo(mem.at) }}前 · {{ BODY_LABEL[mem.state] || mem.state }}</div>
                  <svg v-if="sparkPath(hist.memory).pts" class="bspark" viewBox="0 0 96 20" width="96" height="20">
                    <polyline :points="sparkPath(hist.memory).pts" />
                    <circle :cx="sparkPath(hist.memory).last[0]" :cy="sparkPath(hist.memory).last[1]" r="2" />
                  </svg>
                </template>
                <div v-else class="bnote">{{ mem.hint || "还没跑过" }}</div>
              </div>
            </article>
            <article id="cardWork" class="bcard" :data-state="work.state || 'unknown'">
              <div class="bcard-h"><span class="bdot" :data-t="work.state || 'unknown'" /><span class="bcard-t">手头的事 · 记得住进度</span><span class="bval">{{ workItems.length ? workItems.length + " 件" : "空" }}</span></div>
              <p class="bfeel">{{ work.feeling || "—" }}</p>
              <div class="bcard-b">
                <template v-if="workItems.length">
                  <div v-for="(x, i) in workItems" :key="i" class="bitem">
                    {{ x.status === "blocked" ? "⏸" : "▶" }} {{ x.goal }}
                    <span v-if="(x.steps || []).some((st) => !st.done)" class="bsub">({{ x.steps.filter((st) => !st.done).length }} 步未完成)</span>
                  </div>
                </template>
                <div v-else class="bnote">手头没挂着的事。长任务开工前让皮皮虾 task_stack push 一条。</div>
              </div>
            </article>
            <article id="cardLoad" class="bcard" data-state="ok">
              <div class="bcard-h"><span class="bdot" data-t="ok" /><span class="bcard-t">负荷 · 身上挂着多少</span><span class="bval">{{ load.tools == null ? "—" : load.tools + " 工具" }}</span></div>
              <p class="bfeel">{{ load.feeling || "—" }}</p>
              <div class="bcard-b">
                <div class="brow">会话 <b>{{ load.sessions == null ? "?" : load.sessions }}</b> · 模型 provider <b>{{ load.providers == null ? "?" : load.providers }}</b></div>
                <div class="bsub">进程已跑 {{ fmtMs(load.uptimeMs) }} · {{ load.node || "" }}</div>
              </div>
            </article>
          </div>
        </div>
        <p class="bodyfoot">
          痛觉和记忆两项靠离线探针产出：<code>node scripts/taskbench-offline.js</code> ·
          <code>node scripts/memory-recall.js</code>。没跑过就是 unknown —— 器官不动，也不编数。
        </p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.bodyview { display: flex; flex-direction: column; min-height: 0; }
.botbar { display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-bottom: 1px solid var(--border-soft); flex: none; }
.bhead-n { font-weight: 700; font-size: 13.5px; }
.bhead-s { font-size: 11.5px; color: var(--text-3); }
.bodywrap { flex: 1; min-height: 0; overflow-y: auto; padding: 18px; }
.bodygrid { display: flex; gap: 22px; max-width: 860px; margin: 0 auto; }
.bfig { flex: none; width: 150px; text-align: center; }
.bsvg { width: 130px; }
.bline { fill: none; stroke: var(--border); stroke-width: 2; }
.borgan { cursor: pointer; }
.bhalo { fill: none; stroke: var(--text-4); stroke-width: 1.4; opacity: 0.5; }
.bdot2 { fill: var(--text-4); }
.borgan[data-state="ok"] .bdot2 { fill: var(--ok); }
.borgan[data-state="ok"] .bhalo { stroke: var(--ok); animation: breathe 3.2s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
.borgan[data-state="warn"] .bdot2 { fill: var(--warn); }
.borgan[data-state="warn"] .bhalo { stroke: var(--warn); animation: breathe 1.6s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
.borgan[data-state="bad"] .bdot2 { fill: var(--err); }
.borgan[data-state="bad"] .bhalo { stroke: var(--err); animation: breathe 0.7s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
@keyframes breathe { 0%, 100% { transform: scale(1); opacity: 0.5; } 50% { transform: scale(1.18); opacity: 0.9; } }
.bfigcap { font-size: 12px; color: var(--text-3); margin-top: 8px; }
.bcards { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.bcard { border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); padding: 10px 14px; transition: border-color var(--t-fast); }
.bcard.blink { border-color: var(--accent); }
.bcard-h { display: flex; align-items: center; gap: 8px; }
.bdot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-4); flex: none; }
.bdot[data-t="ok"] { background: var(--ok); }
.bdot[data-t="warn"] { background: var(--warn); }
.bdot[data-t="bad"] { background: var(--err); }
.bcard-t { font-weight: 650; font-size: 13px; flex: 1; }
.bval { font-size: 13px; color: var(--text-2); }
.bfeel { font-size: 11.5px; color: var(--text-3); margin: 4px 0; }
.bcard-b { font-size: 12px; color: var(--text-2); }
.brow b { color: var(--text); }
.bsub { font-size: 11px; color: var(--text-4); margin-top: 2px; }
.bnote { color: var(--text-4); font-size: 11.5px; }
.bitem { padding: 2px 0; }
.bspark polyline { fill: none; stroke: var(--accent); stroke-width: 1.4; }
.bspark circle { fill: var(--accent); }
.bodyfoot { max-width: 860px; margin: 16px auto 0; font-size: 11.5px; color: var(--text-4); text-align: center; }
.bodyfoot code { background: var(--surface-3); border-radius: 4px; padding: 1px 5px; }
.flex1 { flex: 1; }
@media (max-width: 760px) { .bodygrid { flex-direction: column; align-items: center; } }
</style>
