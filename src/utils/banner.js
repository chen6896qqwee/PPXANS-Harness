// src/utils/banner.js - 启动横幅统一模块 (CLI / ppx-web / agent 直跑共用)
// 2026-10-24 (UI 轮): 从三个入口各自手拼的分隔线横幅收敛为一份设计:
//   · box-drawing 面板 + codex 橙点睛 + 版本/状态行
//   · ANSI 256 色安全: NO_COLOR 环境变量或非 TTY 自动降级为纯文本 (CI/管道不花屏)
// 零依赖, 纯字符串拼接。

const C = {
  accent: (s) => `\x1b[38;2;217;119;87m${s}\x1b[0m`,   // codex 橙 #d97757
  accentBg: (s) => `\x1b[48;2;217;119;87m\x1b[97m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[38;2;78;167;92m${s}\x1b[0m`,
  warn: (s) => `\x1b[38;2;217;119;6m${s}\x1b[0m`,
};

function colorEnabled() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR === "1") return true;
  return Boolean(process.stdout && process.stdout.isTTY);
}

// 按能力上色: 无色环境原样返回
function paint(fn, s) {
  return colorEnabled() ? fn(s) : s;
}

// 可见宽度 (中文/全角按 2 列计), 供面板对齐
export function visibleWidth(s) {
  // 剥 ANSI 转义
  const bare = String(s).replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of bare) {
    const code = ch.codePointAt(0);
    w += (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6))) ? 2 : 1;
  }
  return w;
}

function padTo(s, width) {
  return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
}

// 圆角面板: rows = 字符串数组 (可含 ANSI); 自动按内容取宽
export function panel(rows, { width = 0, pad = 2, title = "" } = {}) {
  const inner = Math.max(
    width,
    ...rows.map((r) => visibleWidth(r)),
    title ? visibleWidth(title) + 2 : 0,
  ) + pad * 2;
  // 2026-10-24 修正: line() 原先把中段连接符 m 追加在 inner 段之后 (╭ + inner×─ + ─ + ╮),
  //   无标题时右边框比内容行宽 1 格。现在边框恒为 l + inner×─ + r, 长度严格一致。
  const line = (l, r) => `${l}${"─".repeat(inner)}${r}`;
  const out = [];
  out.push(line("╭", "╮"));
  if (title) {
    const t = ` ${paint(C.bold, title)} `;
    out.push(`│${padTo(t, inner)}│`);
    out.push(line("├", "┤"));
  }
  for (const r of rows) out.push(`│${" ".repeat(pad)}${padTo(r, inner - pad * 2)}${" ".repeat(pad)}│`);
  out.push(line("╰", "╯"));
  return out.join("\n");
}

// 一行键值 (键对齐): label 加粗暗色, 值原样
export function kv(label, value, { labelWidth = 13 } = {}) {
  return `${paint(C.dim, padTo(label, labelWidth))}${value}`;
}

export { C as colors, paint, colorEnabled };

// 品牌字 (两行紧凑版, 适配窄终端): 手绘感优于巨型 ASCII art
export function brandWord() {
  return [
    "┌─┐┌─┐╶─┐╷ ╷╶─┐",
    "│││├─┘┌─┤│ │┌─┤",
    "┘└┘┴  ┘ ┘┴─┘┘ ┘",
  ];
}

// CLI 交互横幅 (src/cli.js 用)
export function cliBanner({ version, memory, experience, modelReady, tools }) {
  const rows = [];
  const word = brandWord();
  rows.push(`${paint(C.accent, word[0])}   ${paint(C.bold, "皮皮虾 PPXANS-Harness")}  ${paint(C.dim, "v" + version)}`);
  rows.push(`${paint(C.accent, word[1])}   ${paint(C.dim, "自我修复 · 自我学习 · 可审计智能体内核")}`);
  rows.push(`${paint(C.accent, word[2])}`);
  rows.push("");
  rows.push(kv("记忆", `${memory} 条`, ));
  rows.push(kv("经验", `${experience} 条`, ));
  rows.push(kv("工具", `${tools} 个`, ));
  rows.push(kv("模型", modelReady ? paint(C.ok, "已配置") : paint(C.warn, "未配置 (离线记忆模式)"), ));
  rows.push("");
  rows.push(paint(C.dim, "输入 /help 看斜杠命令 · quit 退出 · Ctrl+C 中断任务"));
  return panel(rows, { pad: 2 });
}

// Web 启动横幅 (bin/ppx-web.js 用)
export function webBanner({ version, url, health, mcp, root }) {
  const rows = [];
  const word = brandWord();
  rows.push(`${paint(C.accent, word[0])}   ${paint(C.bold, "皮皮虾 PPXANS-Harness")}  ${paint(C.dim, "v" + version)}`);
  rows.push(`${paint(C.accent, word[1])}   ${paint(C.ok, "● Web 应用已就绪")}`);
  rows.push(`${paint(C.accent, word[2])}`);
  rows.push("");
  rows.push(kv("界面", paint(C.bold, url), ));
  if (health) rows.push(kv("健康", health, ));
  if (mcp) rows.push(kv("MCP", mcp, ));
  rows.push(kv("根目录", root, ));
  rows.push("");
  rows.push(paint(C.dim, "Ctrl+C 停止 (自动保存记忆)"));
  return panel(rows, { pad: 2 });
}
