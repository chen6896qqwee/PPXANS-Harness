// electron/window-state.js - 窗口几何记忆 + "这个 URL 还属于本应用吗"
//
// 2026-11-12 自 main.js 拆出: 两件事都只回答「窗口/页面还归不归本应用管」,
// 不碰托盘、菜单与服务生命周期, 因此不需要读写主进程的生命周期变量。
import fs from "node:fs";
import path from "node:path";
import { noteCatch } from "../src/utils/catch-log.js";

export function createWindowState({ app, screen }) {
  const file = () => path.join(app.getPath("userData"), "window-state.json");
  return {
    load() {
      try {
        const s = JSON.parse(fs.readFileSync(file(), "utf8"));
        if (Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
      } catch (e) { noteCatch(e); /* 首次启动 */ }
      return { width: 1280, height: 860 };
    },

    save(win) {
      if (!win || win.isDestroyed()) return;
      try {
        const b = win.getNormalBounds();
        fs.writeFileSync(file(), JSON.stringify({
          x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized(),
        }));
      } catch (e) { noteCatch(e); /* 状态记忆失败不致命 */ }
    },

    // 上次的坐标可能落在已拔掉的显示器上 —— 那种情况只恢复尺寸, 不恢复位置。
    withinDisplays(s) {
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) return false;
      return screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return s.x >= a.x - 40 && s.y >= a.y - 40 && s.x < a.x + a.width - 120 && s.y < a.y + a.height - 80;
      });
    },
  };
}

// 是否还是本应用的页面。只比较 origin: 路径/查询/尾斜杠不同都算同一应用,
//   也不用字符串前缀 —— "http://127.0.0.1:8899.evil.com" 会骗过 startsWith。
//   解析失败 (空串/非 URL) 一律 false: 调用方都在做放行判断, 不认识就当外部。
export function isAppUrl(url, appUrl) {
  if (!url || !appUrl) return false;
  try {
    return new URL(url).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}
