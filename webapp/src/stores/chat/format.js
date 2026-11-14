// webapp/src/stores/chat/format.js - 对话域纯格式化 (无状态; fmtTok 与 stores/fmt.js 同一实现)
export const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

export function isImagePath(p) { return IMG_RE.test(String(p || "")); }
export function fmtSize(n) {
  if (!n && n !== 0) return "";
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + "KB";
  return (n / 1024 / 1024).toFixed(1) + "MB";
}
export { fmtTok } from "../fmt.js";
