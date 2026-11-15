// webapp/src/stores/fmt.js - 中性格式化工具 (无 store 依赖, 各 store 共用)

export function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + "B";
  if (n < 1048576) return Math.round(n / 1024) + "KB";
  return (n / 1048576).toFixed(1) + "MB";
}

export function fmtMs(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return n + "ms";
  return (n / 1000).toFixed(n < 10000 ? 2 : 1) + "s";
}

export function pct(v) { return (v == null || !isFinite(v)) ? "—" : Math.round(v * 100) + "%"; }

export function shortAgo(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const d = Date.now() - t;
  if (d < 45000) return "刚刚";
  if (d < 3600000) return Math.round(d / 60000) + " 分";
  if (d < 86400000) return Math.round(d / 3600000) + " 时";
  return Math.round(d / 86400000) + " 天";
}

export function fmtTs(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

export function fmtTok(n) {
  if (n == null) return "—";
  if (n >= 1048576) return (n / 1048576).toFixed(2) + "M";
  if (n >= 1024) return Math.round(n / 1024) + "K";
  return String(n);
}

// 中文计数: 亿 / 万 (使用统计)
export function fmtCn(n) {
  n = Number(n) || 0;
  const trim = (s) => s.replace(/\.?0+$/, "");
  if (n >= 1e8) return trim((n / 1e8).toFixed(n >= 1e9 ? 1 : 2)) + " 亿";
  if (n >= 1e4) return trim((n / 1e4).toFixed(1)) + " 万";
  return String(Math.round(n));
}

export function fmtTokCn(n) {
  n = Number(n) || 0;
  const trim = (s) => s.replace(/\.?0+$/, "");
  if (n >= 1e8) return trim((n / 1e8).toFixed(2)) + "亿";
  if (n >= 1e4) return trim((n / 1e4).toFixed(1)) + "万";
  return String(Math.round(n));
}

export function fmtDur(ms) {
  ms = Number(ms) || 0;
  if (ms < 1000) return ms > 0 ? "不足 1 分" : "—";
  const min = Math.round(ms / 60000);
  if (min < 60) return min + " 分钟";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? h + " 小时 " + m + " 分" : h + " 小时";
  return Math.floor(h / 24) + " 天 " + (h % 24) + " 小时";
}

export function fmtPct(v, digits) {
  if (v == null || !isFinite(v)) return "—";
  return (v * 100).toFixed(digits == null ? 0 : digits) + "%";
}
