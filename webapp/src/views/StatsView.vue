<!-- webapp/src/views/StatsView.vue - 使用统计 (KPI / 活动热力 / 每日趋势 / 模型用量环形 / 会话明细)
     2026-11-13: 窗口/序列/折线/环形/热力/KPI 的纯派生抽到 views/stats/derive.js, 组件只做 ref 与 computed 包装。 -->
<script setup>
import { computed, onMounted, ref } from "vue";
import Icon from "../common/Icon.vue";
import { usageStatsApi } from "../api/endpoints.js";
import { showView } from "../stores/ui.js";
import { fmtTokCn, fmtDur, fmtPct } from "../stores/fmt.js";
import {
  PALETTE, buildWindow, buildSeries, buildTrend, buildDonut, buildHeat, buildKpis, buildUnpricedNote,
} from "./stats/derive.js";

const data = ref(null);
const range = ref(30);
const heat = ref("day");
const sub = ref("正在读取用量账本…");
const err = ref(null);

const win = computed(() => buildWindow(data.value, range.value));
const series = computed(() => buildSeries(win.value));
const trend = computed(() => buildTrend(win.value, series.value));
const donut = computed(() => buildDonut(data.value));
const heatData = computed(() => buildHeat(data.value, heat.value));
const kpis = computed(() => buildKpis(data.value));
const unpricedNote = computed(() => buildUnpricedNote(data.value));

async function load() {
  try {
    const j = await usageStatsApi();
    if (!j || !j.ok) throw new Error((j && j.error) || "读不到用量账本");
    data.value = j;
    err.value = null;
    sub.value = [
      (j.totals && j.totals.calls ? fmtTokCn(j.totals.tokens) + " tokens · " + j.totals.calls + " 次调用" : "还没有模型调用"),
      j.chat && j.chat.sessions ? j.chat.sessions + " 个会话" : null,
      j.streak && j.streak.current ? "连续 " + j.streak.current + " 天" : null,
    ].filter(Boolean).join(" · ");
  } catch (e) {
    err.value = (e && e.message) || "读取失败";
    sub.value = "用量账本不可用";
  }
}
onMounted(() => load());
</script>

<template>
  <section id="view-stats" class="view">
    <header class="botbar">
      <button class="icobtn" title="返回" aria-label="返回" @click="showView('chat')"><Icon name="back" :size="16" /></button>
      <div class="bmeta">
        <div class="bname2">使用统计</div>
        <div class="bsub">{{ sub }}</div>
      </div>
      <span class="flex1" />
      <span class="seg" role="group" aria-label="时间范围">
        <button :class="{ on: range === 7 }" @click="range = 7">近 7 日</button>
        <button :class="{ on: range === 30 }" @click="range = 30">近 30 日</button>
        <button :class="{ on: range === 0 }" @click="range = 0">全部</button>
      </span>
      <button class="icobtn" title="刷新" aria-label="刷新" @click="load()"><Icon name="refresh" :size="16" /></button>
    </header>

    <div id="statsWrap" class="st-wrap">
      <div v-if="err" class="empty">读取失败：{{ err }}</div>
      <div v-else-if="!data" class="empty loading">加载中</div>
      <div v-else class="st-col">
        <!-- KPI -->
        <div class="st-kpis">
          <div v-for="(k, i) in kpis" :key="i" class="st-kpi" :class="{ dim: k.dim }" :title="k.tip">
            <b>{{ k.val }}</b><span>{{ k.lab }}</span>
          </div>
        </div>

        <div v-if="unpricedNote" class="st-warn" role="status">{{ unpricedNote }}</div>

        <!-- 热力 -->
        <div class="st-card">
          <div class="st-card-h">
            <h3>Token 活动</h3>
            <span class="hint">{{ data.ledger && data.ledger.since ? "账本自 " + data.ledger.since : "暂无按天账本" }}</span>
            <span class="flex1" />
            <span class="seg">
              <button :class="{ on: heat === 'day' }" @click="heat = 'day'">每日</button>
              <button :class="{ on: heat === 'week' }" @click="heat = 'week'">每周</button>
              <button :class="{ on: heat === 'cum' }" @click="heat = 'cum'">累计</button>
            </span>
          </div>
          <div v-if="!heatData" class="empty">还没有按天记录 —— 分桶自本次升级起累积, 跑过一轮模型调用这里就有热力了</div>
          <template v-else>
            <div class="st-heat" role="img" aria-label="按天 token 活动热力图">
              <div v-for="(w, wi) in heatData.weeks" :key="wi" class="st-heat-col">
                <div class="st-heat-mo">{{ w.label ? ((w.month + 1) + "月") : "" }}</div>
                <div
 v-for="(c, ci) in w.vals" :key="ci" class="st-cell" :class="[c.level, { future: c.future }]"
                  :title="c.tip || ''"
                />
              </div>
            </div>
            <div class="st-heat-foot">
              <span>{{ heatData.firstKey }}</span><span class="flex1" /><span>少</span>
              <div class="st-cell" /><div class="st-cell l1" /><div class="st-cell l2" /><div class="st-cell l3" /><div class="st-cell l4" />
              <span>多</span><span>{{ data.today || "" }}</span>
            </div>
          </template>
        </div>

        <!-- 趋势折线 -->
        <div class="st-card">
          <div class="st-card-h"><h3>每日 Token 趋势图</h3><span class="hint">窗口合计 {{ fmtTokCn(trend.total) }} tokens</span></div>
          <div v-if="!series.length" class="empty">这段时间没有模型调用记录</div>
          <template v-else>
            <div class="st-chart">
              <svg :viewBox="'0 0 ' + trend.W + ' ' + trend.H" aria-label="每日 token 趋势折线图">
                <g v-for="(g, gi) in trend.grid" :key="'g' + gi">
                  <line class="st-grid" :x1="trend.PL" :y1="g.y" :x2="trend.W - trend.PR" :y2="g.y" />
                  <text class="st-axis" :x="trend.PL - 9" :y="Number(g.y) + 3.5" text-anchor="end">{{ g.label }}</text>
                </g>
                <text v-for="(t, ti) in trend.ticks" :key="'t' + ti" class="st-axis" :x="t.x" :y="trend.H - 9" text-anchor="middle">{{ t.label }}</text>
                <template v-for="(l, li) in trend.lines" :key="'l' + li">
                  <polyline :points="l.pts" fill="none" :stroke="l.color" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round" />
                  <circle :cx="l.last.cx" :cy="l.last.cy" r="3.4" :fill="l.color" />
                </template>
              </svg>
            </div>
            <div class="st-legend">
              <span v-for="(s2, si) in series" :key="si">
                <i :style="{ background: PALETTE[si % PALETTE.length] }" />{{ s2.name }}<em>{{ fmtTokCn(s2.tokens) }}</em>
              </span>
            </div>
          </template>
        </div>

        <!-- 模型用量环形 -->
        <div class="st-card">
          <div class="st-card-h">
            <h3>模型用量</h3>
            <span class="hint">{{ donut ? "累计 · 共 " + donut.models.length + " 个模型" : "累计" }}</span>
          </div>
          <div v-if="!donut" class="empty">还没有模型调用记录</div>
          <div v-else class="st-models">
            <svg class="st-donut" width="168" height="168" viewBox="0 0 168 168" role="img" aria-label="模型用量占比环形图">
              <g transform="translate(84,84) rotate(-90)">
                <circle
 v-for="(s2, si) in donut.segs" :key="si" :r="donut.R" fill="none"
                  :style="{ stroke: s2.color }" :stroke-width="donut.SW"
                  :stroke-dasharray="s2.len.toFixed(2) + ' ' + (donut.C - s2.len).toFixed(2)"
                  :stroke-dashoffset="s2.off.toFixed(2)"
                />
              </g>
              <text x="84" y="80" text-anchor="middle" font-size="19" font-weight="650">{{ fmtTokCn(donut.total) }}</text>
              <text class="dt-sub" x="84" y="99" text-anchor="middle">tokens</text>
            </svg>
            <div class="st-mlist">
              <div v-for="(m, mi) in donut.models" :key="mi" class="st-mrow">
                <span class="nm"><b>{{ m.model }}</b><i>{{ String(m.calls || 0) }} 次调用 · {{ m.costBasis === "estimated" ? "按现价估算 $" + (Number(m.estimatedCost) || 0).toFixed(4) : "折算 $" + (Number(m.cost) || 0).toFixed(4) }}</i></span>
                <span class="tk"><i :style="{ background: PALETTE[mi % PALETTE.length] }" />{{ fmtTokCn(m.tokens) }} tokens</span>
                <span class="pc">{{ fmtPct(m.tokens / donut.total, 1) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 会话明细 -->
        <div v-if="(data.chat || {}).recent && data.chat.recent.length" class="st-card">
          <div class="st-card-h"><h3>会话</h3><span class="hint">最近 {{ data.chat.recent.length }} 个 · 时长已扣掉 30 分钟以上的空档</span></div>
          <div class="st-srows">
            <div v-for="(s2, i) in data.chat.recent" :key="i" class="st-srow">
              <span class="d">{{ s2.day || "—" }}</span>
              <span class="t" :title="s2.title || s2.id">{{ s2.title || s2.id }}</span>
              <span class="m">{{ String(s2.messages || 0) }} 条 · {{ fmtDur(s2.activeMs) }}</span>
            </div>
          </div>
        </div>

        <p class="st-note">
          累计 <b>{{ fmtTokCn((data.totals || {}).tokens) }}</b> tokens · <b>{{ String((data.totals || {}).calls || 0) }}</b> 次调用 · <template v-if="(data.totals || {}).costIsEstimated">记录 $0 + 估算 <b>${{ (Number((data.totals || {}).estimatedCost) || 0).toFixed(4) }}</b>（含估算, 仅供量级参考）</template><template v-else>折算 <b>${{ (Number((data.totals || {}).cost) || 0).toFixed(4) }}</b></template> · 缓存命中 <b>{{ (data.totals || {}).cacheHitPct == null ? "未上报" : fmtPct((data.totals || {}).cacheHitPct, 1) }}</b><br>
          <template v-if="data.ledger && data.ledger.since">
            按天账本自 <b>{{ data.ledger.since }}</b> 起，共 <b>{{ String(data.ledger.days || 0) }}</b> 天有记录。
          </template>
          <template v-else>按天账本还没有记录 —— 分桶自本次升级起累积，跑过一轮模型调用后这里就有数了。</template>
          趋势与热力只读按天账本，不拿累计值补历史。
          <template v-if="data.pricing"> 价格按 {{ data.pricing.updated }} 快照估算（国内厂商已按 1 USD ≈ {{ data.pricing.cny_per_usd }} CNY 折算）。</template>
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
@import "./manage.css";
.view { display: flex; flex-direction: column; min-height: 0; }
.st-wrap { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 18px 24px; }
.st-col { max-width: 1000px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.st-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.st-kpi {
  border: 1px solid var(--border-soft); border-radius: var(--r-md); background: var(--surface);
  padding: 10px 14px; display: flex; flex-direction: column; gap: 2px;
}
.st-kpi b { font-size: 20px; font-weight: 700; }
.st-kpi span { font-size: 11px; color: var(--text-3); }
.st-kpi.dim b { color: var(--text-4); }
.st-warn {
  border: 1px solid color-mix(in srgb, var(--warn, #d68a1a) 45%, var(--border-soft));
  background: color-mix(in srgb, var(--warn, #d68a1a) 10%, var(--surface));
  border-radius: var(--r-md); padding: 9px 12px; font-size: 11.5px; line-height: 1.6; color: var(--text-2);
}
.st-card { border: 1px solid var(--border-soft); border-radius: var(--r-md); background: var(--surface); padding: 12px 16px; }
.st-card-h { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.st-card-h h3 { margin: 0; font-size: 13.5px; }
.hint { font-size: 11px; color: var(--text-4); }
.st-heat { display: flex; gap: 3px; overflow-x: auto; padding-bottom: 4px; }
.st-heat-col { display: flex; flex-direction: column; gap: 3px; }
.st-heat-mo { height: 14px; font-size: 9px; color: var(--text-4); }
.st-cell { width: 11px; height: 11px; border-radius: 2.5px; background: var(--surface-3); flex: none; }
.st-cell.future { background: transparent; }
.st-cell.l1 { background: color-mix(in srgb, var(--accent) 25%, var(--surface-3)); }
.st-cell.l2 { background: color-mix(in srgb, var(--accent) 45%, var(--surface-3)); }
.st-cell.l3 { background: color-mix(in srgb, var(--accent) 70%, var(--surface-3)); }
.st-cell.l4 { background: var(--accent); }
.st-heat-foot { display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--text-4); margin-top: 6px; }
.st-chart svg { width: 100%; height: auto; }
.st-grid { stroke: var(--border-soft); stroke-width: 1; }
.st-axis { fill: var(--text-4); font-size: 10px; }
.st-legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 8px; font-size: 11.5px; color: var(--text-2); }
.st-legend span { display: inline-flex; align-items: center; gap: 5px; }
.st-legend i { width: 9px; height: 9px; border-radius: 99px; display: inline-block; }
.st-legend em { font-style: normal; color: var(--text-4); margin-left: 3px; }
.st-models { display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
.st-donut text { fill: var(--text); }
.st-donut .dt-sub { fill: var(--text-4); font-size: 10px; }
.st-mlist { flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: 6px; }
.st-mrow { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.st-mrow .nm { flex: 1; display: flex; flex-direction: column; }
.st-mrow .nm i { font-style: normal; font-size: 10.5px; color: var(--text-4); }
.st-mrow .tk { display: inline-flex; align-items: center; gap: 5px; color: var(--text-2); }
.st-mrow .tk i { width: 9px; height: 9px; border-radius: 99px; display: inline-block; }
.st-mrow .pc { color: var(--text-3); width: 46px; text-align: right; }
.st-srow { display: flex; align-items: center; gap: 10px; font-size: 12px; padding: 3px 0; border-bottom: 1px solid var(--border-soft); }
.st-srow .d { color: var(--text-4); font-family: ui-monospace, Consolas, monospace; flex: none; }
.st-srow .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-srow .m { color: var(--text-3); flex: none; }
.st-note { font-size: 11.5px; color: var(--text-3); line-height: 1.7; }
.flex1 { flex: 1; }
</style>
