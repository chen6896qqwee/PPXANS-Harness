// webapp/src/chat/composer/useStatusBar.js - 状态条: 轮次/速度/上下文/缓存/累计用量
//
// 从 Composer.vue 抽出来 (2026-11-13)。四个派生值各自独立, 任一有内容就切到状态条视图;
// 全空且不在生成中时退回一句键盘提示 (footHint 由调用方给)。
// 口径: 上下文占用 = 最近一次调用输入 token ÷ 模型上下文窗口; 金额不含无价格模型时
// 把"未定价 N 个模型"显式写出来, 不让用户误以为总价就是全部花费。
import { computed } from "vue";
import { chat, fmtTok } from "../../stores/chat.js";

export function useStatusBar() {
  const statRun = computed(() => {
    const r = chat.run;
    if (!r) return "";
    let txt = "";
    if (r.rounds) txt += r.rounds + " 轮 ";
    if (r.steps) txt += r.steps + " 步";
    txt = txt.trim();
    if (r.tokps >= 0.05) txt += (txt ? " · " : "") + (r.tokps >= 10 ? Math.round(r.tokps) : r.tokps.toFixed(1)) + " tok/s";
    return txt;
  });
  const statCtx = computed(() => {
    const t = chat.lastTokens;
    const win = (chat.llm && chat.llm.current && Number(chat.llm.current.context_window)) || chat.ctxWindow || 0;
    if (!t || !t.prompt || !win || win < 1024) return "";
    const pctv = (t.prompt / win) * 100;
    return (pctv < 1 ? "<1" : Math.round(pctv)) + "%";
  });
  const ctxBar = computed(() => {
    const t = chat.lastTokens;
    if (!t) return "";
    const bits = [];
    if (t.prompt != null) bits.push(fmtTok(t.prompt) + " tok");
    const pctv = (t.cacheHitPct != null) ? t.cacheHitPct
      : (t.cacheHit != null && t.prompt > 0 ? Math.round((t.cacheHit / t.prompt) * 100) : null);
    if (pctv != null) bits.push("缓存命中 " + pctv + "%");
    if (t.completion != null && !bits.length) bits.push("输出 " + fmtTok(t.completion));
    return bits.join(" · ");
  });
  const statSum = computed(() => {
    const t = chat.health && chat.health.usage;
    if (!t || !t.calls) return "";
    const bits = ["累计 " + t.calls + " 次"];
    if (t.tokens) bits.push(fmtTok(t.tokens) + " tok");
    if (t.cacheHitPct != null) bits.push("缓存 " + t.cacheHitPct + "%");
    // 金额不含无价格数据的模型 —— 状态条上要让这一点可见
    if (t.unpriced) bits.push("未定价 " + t.unpriced + " 个模型");
    return bits.join(" · ");
  });
  const hasStats = computed(() => !!(statRun.value || ctxBar.value || statCtx.value || statSum.value));

  return { statRun, statCtx, ctxBar, statSum, hasStats };
}
