// electron/update-flow.js — 桌面端自动更新 (检查/提示/下载/SHA-256 校验/启动安装)
// 拆自 main.js (2026-11-03): 三个函数 + 两个互斥忙碌位构成独立域, busy 位闭包在本模块;
//   窗口与退出状态经 ctx 借读 (main 仍是状态所有者)。收集/校验本体在 src/services/update.js。
import { app, dialog, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { APP_NAME } from "./app-meta.js";
import { log } from "./app-log.js";

export function createUpdateFlow(ctx) {
  let updateBusy = false;
  let downloadBusy = false;

  async function checkForUpdatesInteractive({ silent = false } = {}) {
    if (updateBusy) return;
    updateBusy = true;
    try {
      const { checkForUpdate, RELEASES_URL } = await import("../src/services/update.js");
      const check = await checkForUpdate({
        currentVersion: app.getVersion(),
        dataDir: app.getPath("userData"),
        channel: "github",
        force: true,
      });
      if (!check.ok) {
        if (!silent) {
          const r = await dialog.showMessageBox(ctx.getWin() ?? undefined, {
            type: "warning", title: APP_NAME, message: "检查更新失败",
            detail: `无法访问 GitHub Releases: ${check.reason || "网络不可用"}`,
            buttons: ["前往下载页", "关闭"], defaultId: 0, cancelId: 1,
          });
          if (r.response === 0) shell.openExternal(RELEASES_URL);
        }
        return;
      }
      if (!check.updateAvailable) {
        if (!silent) dialog.showMessageBox(ctx.getWin() ?? undefined, { type: "info", title: APP_NAME, message: "已是最新版本", detail: `当前 v${check.current}` });
        return;
      }
      await promptUpdate(check);
    } finally {
      updateBusy = false;
    }
  }

  async function promptUpdate(check) {
    const { RELEASES_URL } = await import("../src/services/update.js");
    const r = await dialog.showMessageBox(ctx.getWin() ?? undefined, {
      type: "info", title: APP_NAME,
      message: `发现新版本 v${check.latest}`,
      detail: `当前 v${check.current}。\n\n下载后会先用 SHA-256 校验安装包；安装包未签名，Windows 可能提示“未知发布者”。`,
      buttons: ["下载并校验", "前往下载页", "稍后"], defaultId: 0, cancelId: 2,
    });
    if (r.response === 0) await downloadAndInstallUpdate(check);
    else if (r.response === 1) shell.openExternal(RELEASES_URL);
  }

  async function downloadAndInstallUpdate(check) {
    if (downloadBusy) return;
    downloadBusy = true;
    try {
      const { fetchReleaseAssets, pickReleaseAsset, findChecksumsAsset, parseChecksums, checksumFor, downloadAsset, sha256File } = await import("../src/services/update.js");
      const { proxiedFetch } = await import("../src/security/http-proxy.js");
      const release = await fetchReleaseAssets({});
      const asset = pickReleaseAsset(release.assets, { platform: process.platform, arch: process.arch });
      if (!asset) {
        const r = await dialog.showMessageBox(ctx.getWin() ?? undefined, {
          type: "warning", title: APP_NAME, message: "没有找到适配当前平台的安装包",
          detail: `v${release.tag} 的资产里没有 ${process.platform}/${process.arch} 安装包。`,
          buttons: ["前往下载页", "关闭"], defaultId: 0, cancelId: 1,
        });
        if (r.response === 0) shell.openExternal("https://github.com/chen6896qqwee/PPXANS-Harness/releases/latest");
        return;
      }
      const sumsAsset = findChecksumsAsset(release.assets);
      if (!sumsAsset) {
        dialog.showMessageBox(ctx.getWin() ?? undefined, {
          type: "warning", title: APP_NAME, message: "该版本没有校验和，已停止自动下载",
          detail: "缺少 SHA256SUMS.txt 时无法验证安装包完整性。请前往 Release 页面手动下载。",
          buttons: ["前往下载页", "关闭"], defaultId: 0, cancelId: 1,
        }).then((r) => { if (r.response === 0) shell.openExternal("https://github.com/chen6896qqwee/PPXANS-Harness/releases/latest"); });
        return;
      }
      const sumsRes = await proxiedFetch(sumsAsset.url, {
        headers: { "User-Agent": "ppxans-harness-desktop", Accept: "text/plain" },
        timeoutMs: 15000,
      });
      if (!sumsRes || !sumsRes.ok) throw new Error(`校验和下载失败 HTTP ${sumsRes ? sumsRes.status : "?"}`);
      const expected = checksumFor(parseChecksums(await sumsRes.text()), asset.name);
      if (!expected) throw new Error("SHA256SUMS.txt 中没有该安装包的校验和");

      const dir = path.join(app.getPath("userData"), "updates");
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, path.basename(asset.name));
      let verified = false;
      if (fs.existsSync(dest)) {
        try { verified = sha256File(dest) === expected; } catch { verified = false; /* swallowed-ok(2026-11-03): 校验失败即走重新下载 */ }
      }
      if (!verified) {
        ctx.notify("正在下载更新", `v${release.tag} · ${asset.size ? Math.round(asset.size / 1024 / 1024) + " MB" : "准备中"}`);
        await downloadAsset({
          url: asset.url,
          dest,
          expectedSha256: expected,
          onProgress: ({ ratio }) => { try { ctx.getWin()?.setProgressBar(ratio); } catch { /* 窗口可能已关 */ } },
        });
      }
      try { ctx.getWin()?.setProgressBar(-1); } catch { /* 已销毁 */ }

      const r = await dialog.showMessageBox(ctx.getWin() ?? undefined, {
        type: "info", title: APP_NAME,
        message: verified ? "安装包已存在且校验通过" : "安装包已下载并通过 SHA-256 校验",
        detail: `${dest}\n\n启动安装程序会关闭当前应用。安装包未签名，系统可能提示“未知发布者”。`,
        buttons: ["启动安装程序", "打开所在文件夹", "稍后"], defaultId: 0, cancelId: 2,
      });
      if (r.response === 0) {
        if (/\.AppImage$/i.test(dest)) { try { fs.chmodSync(dest, 0o755); } catch { /* 权限失败交给系统 */ } }
        const err = await shell.openPath(dest);
        if (err) {
          dialog.showErrorBox(APP_NAME, `启动安装程序失败: ${err}`);
          return;
        }
        setTimeout(() => { ctx.setQuitting(true); app.quit(); }, 1200);
      } else if (r.response === 1) {
        shell.showItemInFolder(dest);
      }
    } catch (e) {
      try { ctx.getWin()?.setProgressBar(-1); } catch { /* 已销毁 */ }
      log(`更新下载失败: ${e?.message || e}`);
      const r = await dialog.showMessageBox(ctx.getWin() ?? undefined, {
        type: "error", title: APP_NAME, message: "更新下载失败",
        detail: String(e?.message || e).slice(0, 600),
        buttons: ["前往下载页", "关闭"], defaultId: 0, cancelId: 1,
      });
      if (r.response === 0) shell.openExternal("https://github.com/chen6896qqwee/PPXANS-Harness/releases/latest");
    } finally {
      downloadBusy = false;
      try { ctx.getWin()?.setProgressBar(-1); } catch { /* 已销毁 */ }
    }
  }

  return { checkForUpdatesInteractive, promptUpdate };
}
