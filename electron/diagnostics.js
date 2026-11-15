// electron/diagnostics.js — 诊断包导出 (收集 → 归档 → 落到用户下载目录)
// 拆自 main.js (2026-11-03): 与更新流程同级的独立菜单动作域。收集/归档本体在
//   src/services/desktop/diagnostics.js, 这里只负责窗口对话框与装配参数 (经 ctx 借读)。
import { app, dialog, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_NAME } from "./app-meta.js";
import { log } from "./app-log.js";
import { probe } from "./server-proc.js";

export function createDiagnostics(ctx) {
  async function exportDiagnostics() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const ext = process.platform === "win32" ? "zip" : "tar.gz";
    let base = os.homedir();
    try { base = app.getPath("downloads") || base; } catch { /* 无下载目录 */ }
    const r = await dialog.showSaveDialog(ctx.getWin() ?? undefined, {
      title: "导出诊断包",
      defaultPath: path.join(base, `ppx-diagnostics-${stamp}.${ext}`),
      filters: ext === "zip" ? [{ name: "Zip", extensions: ["zip"] }] : [{ name: "压缩包", extensions: ["tar.gz", "tgz"] }],
    });
    if (r.canceled || !r.filePath) return;

    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-diag-"));
    try {
      const { collectDiagnostics, archiveDirectory } = await import("../src/services/desktop/diagnostics.js");
      const health = await probe(ctx.getServerPort(), 1200).catch(() => null);
      collectDiagnostics({
        root: ctx.getRoot(),
        userData: app.getPath("userData"),
        outDir: staging,
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron || "",
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.versions.node,
        health,
      });
      const arch = archiveDirectory(staging, r.filePath);
      if (!arch.ok) {
        shell.openPath(staging);
        dialog.showMessageBox(ctx.getWin() ?? undefined, {
          type: "warning", title: APP_NAME, message: "诊断材料已生成，但压缩失败",
          detail: `材料目录: ${staging}\n${arch.error}`,
          buttons: ["打开目录", "关闭"], defaultId: 0, cancelId: 1,
        });
        return;
      }
      fs.rmSync(staging, { recursive: true, force: true });
      const done = await dialog.showMessageBox(ctx.getWin() ?? undefined, {
        type: "info", title: APP_NAME, message: "诊断包已导出",
        detail: `${r.filePath}\n\n已脱敏: API Key / token / 密码类字段。未包含对话正文与记忆数据。`,
        buttons: ["打开所在文件夹", "关闭"], defaultId: 0, cancelId: 1,
      });
      if (done.response === 0) shell.showItemInFolder(r.filePath);
    } catch (e) {
      log(`诊断导出失败: ${e?.message || e}`); // swallowed-ok(2026-11-03): 已 log 并弹窗告知
      const rr = await dialog.showMessageBox(ctx.getWin() ?? undefined, {
        type: "error", title: APP_NAME, message: "诊断导出失败",
        detail: `${String(e?.message || e).slice(0, 500)}\n材料目录: ${staging}`,
        buttons: ["打开材料目录", "关闭"], defaultId: 0, cancelId: 1,
      });
      if (rr.response === 0) shell.openPath(staging);
    }
  }

  return { exportDiagnostics };
}
