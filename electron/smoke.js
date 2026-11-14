// electron/smoke.js — 桌面端冒烟: 真实窗口内的 DOM/API 断言 (2026-11-02)
// 拆自 main.js (2026-11-03): SMOKE 专属逻辑独立成域。smokeErrors 是共享数组引用,
//   由 main 的 createWindow 监听器填充; 窗口/端口/退出状态经 ctx 借读。
// 只截图无法证明"界面真的起来了" (白屏也能截出一张纯色图)。这里在渲染进程里检查
// 关键节点、bootstrap token、/health, 收集 console error / did-fail-load, 最后截图并
// 写结果 JSON。脚本 scripts/desktop-gui-smoke.mjs 负责隔离目录、选空闲端口与退出码。
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { log } from "./app-log.js";
import { requestGracefulShutdown } from "./server-proc.js";

export const smokeErrors = []; // SMOKE: 渲染进程 error/warning + 加载失败 (写进结果 JSON)

export function createSmoke(ctx) {
  async function runSmoke() {
    const t0 = Date.now();
    const out = process.env.PPX_DESKTOP_SMOKE_OUT || path.join(app.getPath("userData"), "smoke.png");
    const resultPath = process.env.PPX_DESKTOP_SMOKE_RESULT || out.replace(/\.png$/i, "") + ".result.json";
    let checks = {};
    let pass = false;
    let error = null;
    try {
      checks = await ctx.getWin().webContents.executeJavaScript(`(async () => {
        const $ = (s) => document.querySelector(s);
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const deadline = Date.now() + 8000;
        // 2026-11-08: 侧栏的「本体列表」并入一级导航, 就绪信号改为"导航渲染完成"。
        //   仍然验证后端真的通了: 下面用 bootstrap token 打一次 /api/readiness。
        let navReady = false;
        while (Date.now() < deadline) {
          if (document.querySelectorAll('#side .navi').length >= 4) { navReady = true; break; }
          await sleep(150);
        }
        const boot = window.__PPX_BOOTSTRAP__ || null;
        const health = await fetch('/health', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
        const authTok = boot && (boot.authToken || boot.token);
        const ready = await fetch('/api/readiness', {
          cache: 'no-store',
          headers: authTok ? { Authorization: 'Bearer ' + authTok } : {},
        }).then((r) => r.json()).catch(() => null);
        // 渲染栈冒烟: 在真实 Chromium 里跑一遍 markdown-it/DOMPurify/KaTeX/highlight.js 的合成用例。
        // 反引号在模板字符串里不可用, 代码围栏用 String.fromCharCode 拼。
        const fence = String.fromCharCode(96, 96, 96);
        const LF = String.fromCharCode(10);
        const mdR = (window.PPXMarkdown && window.PPXMarkdown.render) || (() => '');
        // 注入用例: 原始 HTML 与 javascript: 链接都不得变成可执行节点 (只查文本会误判 ——
        // 转义后的 &lt;img onerror=...&gt; 里同样有 "onerror=" 字样, 但它是文本不是节点)
        const xssDoc = new DOMParser().parseFromString(
          mdR('<img src=x onerror=alert(1)><script>alert(1)</script>[x](javascript:alert(1))<iframe src="https://e.com"></iframe>'),
          'text/html'
        );
        const md = {
          libs: !!(window.markdownit && window.DOMPurify && window.katex && window.hljs),
          table: mdR(['| a | b |', '|---|---|', '| 1 | 2 |'].join(LF)).indexOf('<table>') >= 0,
          heading: mdR('## 标题').indexOf('<h2>标题</h2>') >= 0,
          code: mdR(fence + 'js' + LF + 'const a = 1;' + LF + fence).indexOf('hljs-keyword') >= 0,
          copyIcon: mdR(fence + 'js' + LF + 'x = 1;' + LF + fence).indexOf('#i-copy') >= 0,
          math: mdR('质能方程 $E=mc^2$').indexOf('katex') >= 0,
          mathBlock: mdR('$$' + LF + 'a+b' + LF + '$$').indexOf('katex-display') >= 0,
          xss: !xssDoc.querySelector('script, iframe, img') && !xssDoc.querySelector('a[href^="javascript:"]'),
          link: mdR('[示例](https://example.com/a)').indexOf('rel="noopener noreferrer"') >= 0,
        };
        return {
          title: document.title,
          href: location.href,
          readyState: document.readyState,
          typeCards: !!$('#typeCards'),
          viewChat: !!$('#view-chat'),
          hero: !!$('#hero'),
          composer: !!$('#composer'),
          input: !!$('#inp'),
          sendButton: !!$('#btnSend'),
          sidebar: !!$('#side'),
          navReady,
          navCount: document.querySelectorAll('#side .navi').length,
          readinessOk: !!(ready && ready.ok === true && ready.model && typeof ready.model.ready === "boolean"),
          readinessModel: (ready && ready.model && ready.model.ready) || false,
          bootstrap: !!boot,
          token: !!(boot && (boot.authToken || boot.token)),
          healthApp: (health && health.app) || null,
          healthOk: !!(health && (health.ok === true || health.status === 'ok' || health.app)),
          visibility: document.visibilityState,
          md,
        };
      })()`);
    } catch (e) {
      error = String(e?.message || e);
    }

    // 截图失败不掩盖断言结果: 两者都写进 JSON, 由退出码决定成败
    let shot = null;
    try {
      const img = await ctx.getWin().webContents.capturePage();
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, img.toPNG());
      shot = out;
    } catch (e) {
      error = error || `截图失败: ${String(e?.message || e)}`; // swallowed-ok(2026-11-03): 已并入 error 汇总
    }

    const fatal = smokeErrors.filter((e) => e.level >= 3);
    const required = ["typeCards", "viewChat", "hero", "composer", "input", "sendButton", "sidebar", "navReady", "readinessOk", "bootstrap", "token"];
    const missing = required.filter((k) => !checks[k]);
    // 渲染栈: 每个用例都要过 —— 库没加载/净化失效/公式报错都算失败
    const mdBad = Object.entries(checks.md || {}).filter(([, v]) => v !== true).map(([k]) => k);
    pass = !error && !fatal.length && missing.length === 0 && mdBad.length === 0
      && checks.readyState === "complete"
      && checks.healthApp === "ppxans-harness" && checks.healthOk === true;

    const result = {
      ok: pass,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      port: ctx.getServerPort(),
      url: ctx.getAppUrl(),
      screenshot: shot,
      missing,
      mdBad,
      healthApp: checks.healthApp || null,
      checks,
      consoleErrors: smokeErrors,
      error,
    };
    try {
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
      log(`smoke 结果: ${resultPath} (${pass ? "PASS" : "FAIL"})`);
    } catch (e) {
      log(`smoke 结果写入失败: ${e.message}`); // swallowed-ok(2026-11-03): 已 log 记录
    }
    if (shot) log(`smoke 截图: ${shot}`);
    ctx.setQuitting(true);
    try { await requestGracefulShutdown(ctx.getServerPort(), 3000); } catch { /* 已退出 */ }
    ctx.killServer();
    app.exit(pass ? 0 : 1);
  }

  return { runSmoke };
}
