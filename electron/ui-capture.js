// electron/ui-capture.js — UI 截图回合驱动 (PPX_UI_CAPTURE=1)
//
// 与 smoke 的分工: smoke 断言"功能在不在" (DOM/API 契约); 这里产出"长什么样"的
// 像素证据。2026-11-16 起验证过的截图回环: 真实可见窗口 (x/y≈40, skipTaskbar) +
// 每步 executeJavaScript 注入状态后 capturePage, 截图写 PPX_UI_CAPTURE_DIR,
// 完成后优雅退出。截图标注为离线合成 (注入的时间线数据), 不冒充真实生产回合。
//
// 步骤清单按回合改写。当前 (2026-11-18, WorkBuddy 对话体验吸收):
//   欢迎语首屏 / 思考链路收拢态 / 链路展开态 / 对话设置面板 / 个性化面板 / 提示词预览
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { log } from "./app-log.js";
import { requestGracefulShutdown } from "./server-proc.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 合成一轮对话: 思考×2 + 工具×2 + diff + 回答。链路收拢/展开、diff 折叠、排队条都由它驱动。
// 每步先关 onboarding 弹窗 (fresh userData 首启会弹, 挡住被截图的主体)。
// 只关弹窗, 不切视图 —— 各步骤自己决定 view (聊天/设置)。
const OPEN_PANE = `(() => { window.__ppx.ui.onboarding = false; })()`;

const SYNTH_TURN = `(() => {
  ${OPEN_PANE};
  const { chat, dialog } = window.__ppx;
  chat.items.length = 0;
  chat.items.push(
    { id: "u1", kind: "user", text: "把启动脚本修一下, 顺便看看日志为什么没落盘" },
    { id: "c1", kind: "think", text: "先看启动脚本和最近日志目录的状态, 再决定改哪里。", ended: true, secs: 14, open: false, began: 0 },
    { id: "c2", kind: "tool", tool: "read_file", tsum: "启动皮皮虾.bat", status: "ok", durationMs: 820, result: "14 行脚本, 环境变量读取正常", ok: true, args: { path: "启动皮皮虾.bat" }, argsOpen: false, resultOpen: false },
    { id: "c3", kind: "think", text: "日志没落盘是 dataDir 解析顺序问题; 先修 config 读取顺序, 再补一条回归测试。", ended: true, secs: 9, open: false, began: 0 },
    { id: "c4", kind: "tool", tool: "edit_file", tsum: "src/config/index.js", status: "ok", durationMs: 1240, result: "+3 -1 已写入", ok: true, args: { path: "src/config/index.js" }, argsOpen: false, resultOpen: false },
    { id: "d1", kind: "diff", lines: [ {cls:"hunk", text:"@@ -12,6 +12,9 @@"}, {cls:"del", text:"-  const cfg = readConfig()"}, {cls:"add", text:"+  const cfg = readConfig({ dataDir: resolveDataDir(root) })"}, {cls:"add", text:"+  if (!fs.existsSync(cfg.dataDir)) fs.mkdirSync(cfg.dataDir, { recursive: true })"} ] },
    { id: "a1", kind: "agent", text: "**已修复。** 启动脚本读取顺序修正, 日志目录不存在时自动创建, 并补了回归测试。", streaming: false, interrupted: false },
  );
  dialog.processDisplay = "concise";
  dialog.showFileChanges = false;
  chat.queue.push({ text: "再把 README 的启动说明同步一下", label: "再把 README 的启动说明同步一下", files: [] });
  return true;
})()`;

const STEPS = [
  { name: "hero-welcome", wait: 500, js: `(() => {
    ${OPEN_PANE};
    const { chat, dialog } = window.__ppx;
    chat.items.length = 0; chat.queue.length = 0;
    dialog.processDisplay = "concise"; dialog.showFileChanges = true;
    dialog.welcome.enabled = true; dialog.welcome.text = "";
    return true;
  })()` },
  { name: "chain-collapsed", wait: 400, js: SYNTH_TURN },
  { name: "chain-expanded", wait: 400, js: `(() => {
    ${OPEN_PANE};
    const { chat } = window.__ppx;
    const first = chat.items.find((x) => x.id === "c1");
    if (first) first.chainOpen = true;
    const diff = chat.items.find((x) => x.id === "d1");
    if (diff) diff.diffOpen = true;
    return true;
  })()` },
  { name: "settings-dialog-panel", wait: 500, js: `(() => { ${OPEN_PANE}; window.__ppx.ui.settingsModal = "dialog"; return true; })()` },
  { name: "persona-panel", wait: 900, js: `(() => {
    ${OPEN_PANE};
    window.__ppx.ui.settingsModal = null;
    window.__ppx.ui.view = "settings";
    setTimeout(() => {
      const head = [...document.querySelectorAll(".ssec-head")].find((h) => h.textContent.includes("个性化"));
      if (head) head.closest(".ssec").scrollIntoView();
    }, 400);
    return true;
  })()` },
  { name: "persona-preview", wait: 1500, js: `(() => {
    ${OPEN_PANE};
    const btn = [...document.querySelectorAll(".wbtn")].find((b) => b.textContent.includes("预览系统提示词"));
    if (!btn) return "no-preview-btn";
    btn.click();
    setTimeout(() => {
      const head = [...document.querySelectorAll(".ssec-head")].find((h) => h.textContent.includes("个性化"));
      if (head) head.closest(".ssec").scrollIntoView();
    }, 500);
    return true;
  })()` },
];

export function createUiCapture(ctx) {
  async function run() {
    const dir = process.env.PPX_UI_CAPTURE_DIR || path.join(app.getPath("userData"), "ui-capture");
    fs.mkdirSync(dir, { recursive: true });
    const errors = [];
    const shots = [];
    const wc = ctx.getWin().webContents;
    try {
      for (const [i, step] of STEPS.entries()) {
        try {
          const r = await wc.executeJavaScript(step.js, true);
          if (r !== true) errors.push({ step: step.name, message: "注入返回 " + String(r) });
        } catch (e) {
          errors.push({ step: step.name, message: String(e?.message || e) });
        }
        await wait(step.wait);
        const img = await wc.capturePage();
        const file = path.join(dir, `${String(i + 1).padStart(2, "0")}-${step.name}.png`);
        fs.writeFileSync(file, img.toPNG());
        shots.push({ step: step.name, file });
      }
    } catch (e) {
      errors.push({ step: "runner", message: String(e?.message || e) });
    }
    try {
      fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({
        at: new Date().toISOString(), url: ctx.getAppUrl(), port: ctx.getServerPort(), shots, errors,
      }, null, 2));
    } catch (e) {
      log(`ui-capture: result.json 写入失败 — ${e?.message || e}`); // swallowed-ok(2026-11-18): 截图已落盘, 结果 JSON 只影响驱动脚本汇总
    }
    // 优雅退出 (与 smoke 同款 teardown)
    ctx.setQuitting(true);
    try { await requestGracefulShutdown(ctx.getServerPort(), 3000); } catch { /* 已退出 */ }
    ctx.killServer();
    setTimeout(() => app.exit(errors.length ? 1 : 0), 300);
    return { shots, errors };
  }
  return { runUiCapture: run };
}
