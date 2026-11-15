// src/selfcode/source-text.js - 源码静态扫描共用的文本清洗
// 为什么收敛: selfcode/graph.js (依赖图) 与 selfcode/catch-scan.js (静默吞错)
//   都要一份"去注释但保留字符串"的源码视图 —— 注释里的示例 import 不是依赖,
//   字符串里的 // 也不是注释。此前 graph 用字符扫描、catch-scan 用正则,
//   两边口径会漂 (正则版会把字符串里的 // 当注释切掉)。这里只保留一份实现。
//
// 边界: 不解析正则字面量 (源码里的 /\\/\\// 仍可能被当成注释开头);
//   仓库静态扫描的输入是自己维护的 JS, 该边界已知且可接受。
export function stripComments(src) {
  src = String(src == null ? "" : src);
  let out = "";
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") { out += n || ""; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    out += c;
    i++;
  }
  return out;
}
