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

// 交互步骤也走现有 required/missing 汇总: 任一步失败都会让桌面冒烟以非零退出。
const STEP_CHECKS = [
  "stepSkipOnboarding",
  "stepSendHello",
  "stepNewSession",
  "stepNavProjects",
  "stepNavTasks",
  "stepNavCaps",
  "stepNavChat",
  "stepShowTrace",
  "stepShowTalk",
  "stepCycleTheme",
];

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
        const $$ = (s) => Array.from(document.querySelectorAll(s));
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const assert = (cond, message) => { if (!cond) throw new Error(message); };
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
        };
        const waitFor = async (fn, timeoutMs = 5000) => {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const value = fn();
            if (value) return value;
            if (Date.now() >= deadline) return null;
            await sleep(100);
          }
        };
        const stored = (key) => { try { return localStorage.getItem(key); } catch { return null; /* swallowed-ok(2026-11-16): 渲染进程 localStorage 不可用时视作未存储, 冒烟步骤自身会判缺失 */ } };
        const tabByText = (label) => $$('#view-chat .panes button.ptab').find((b) => b.textContent.trim() === label) || null;

        // 2026-11-08: 侧栏的「本体列表」并入一级导航, 就绪信号改为"导航渲染完成"。
        // 仍然验证后端真的通了: 下面用 bootstrap token 打一次 /api/readiness。
        const navReady = !!(await waitFor(() => document.querySelectorAll('#side .navi').length >= 4, 8000));
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

        // 基础结构在操作前快照: 发送后 Hero 消失是正常产品行为, 不应让基础断言误判。
        const outcome = {
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

        // 每个交互独立落结果, 单步异常不吞掉后续步骤; 最终统一映射到 checks/required。
        const stepResults = [];
        async function step(name, fn) {
          const started = Date.now();
          const result = { name, ok: false, durationMs: 0, detail: null, error: null };
          try {
            result.detail = (await fn()) || null;
            result.ok = true;
          } catch (e) {
            result.error = String((e && e.message) || e);
          }
          result.durationMs = Date.now() - started;
          stepResults.push(result);
          outcome[name] = result.ok;
        }

        await step('stepSkipOnboarding', async () => {
          const mask = await waitFor(() => $('.onb-mask'), 4000);
          assert(mask, '首次使用向导未出现');
          const skip = mask.querySelector('button.onb-skip[aria-label="跳过"]');
          assert(skip, '向导缺少「跳过」按钮');
          skip.click();
          assert(await waitFor(() => !$('.onb-mask'), 4000), '点击跳过后向导仍未关闭');
          assert(!!stored('ppx_onboarded_v1'), '跳过向导后未记录完成状态');
          return { skipped: true, onboarded: true };
        });

        await step('stepSendHello', async () => {
          const inp = $('#inp');
          assert(inp, '找不到消息输入框 #inp');
          inp.focus();
          inp.value = '你好';
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          const sendButton = await waitFor(() => {
            const b = $('#btnSend');
            return b && !b.disabled ? b : null;
          }, 3000);
          assert(sendButton, '输入「你好」后发送按钮仍不可用');
          const errorsBefore = $$('#stream .ev-error').length;
          sendButton.click();
          assert(await waitFor(() => $$('#stream .ev-user .bubble').some((b) => b.textContent.trim() === '你好'), 4000),
            '时间线未出现用户消息「你好」');
          const agent = await waitFor(() => {
            const cards = $$('#stream .ev-agent');
            const last = cards[cards.length - 1];
            if (!last || last.querySelector('.typing, .caret')) return null;
            const body = last.querySelector('.mdhtml');
            const send = $('#btnSend');
            return body && body.textContent.trim() && send && !send.classList.contains('stop') ? last : null;
          }, 15000);
          assert(agent, '等待 agent 本地回答完成超时');
          const reply = agent.querySelector('.mdhtml').textContent.trim();
          // 「你好」命中内核内置 chitchat 规则, 应答必须来自本地规则而不是实际 LLM。
          assert(reply.indexOf('在的兄弟') >= 0, '回答不是预期的本地寒暄应答: ' + reply.slice(0, 120));
          assert($$('#stream .ev-error').length === errorsBefore, '本轮对话出现了错误卡片');
          assert(inp.value === '', '发送后输入框未清空');
          return { message: '你好', reply: reply.slice(0, 500), completed: true };
        });

        await step('stepNewSession', async () => {
          const beforeKey = stored('ppx_session');
          const button = $('#btnNewBot');
          assert(button, '找不到新对话按钮 #btnNewBot');
          button.click();
          const afterKey = await waitFor(() => {
            const key = stored('ppx_session');
            return key && key !== beforeKey ? key : null;
          }, 4000);
          assert(afterKey, '点击新对话后会话 key 未变化');
          assert(await waitFor(() => visible($('#hero')), 4000), '新对话未回到空态 Hero');
          assert($$('#stream .ev').length === 0, '新对话仍残留上一局时间线');
          assert(($('.sess-title') && $('.sess-title').textContent.trim()) === '新会话', '新对话标题未复位');
          return { beforeKey, afterKey, empty: true };
        });

        async function navStep(name, title, viewSelector) {
          await step(name, async () => {
            const button = $('#side .navi[title="' + title + '"]');
            assert(button, '找不到主导航「' + title + '」');
            button.click();
            assert(await waitFor(() => visible($(viewSelector)) && button.classList.contains('on'), 6000),
              '主导航「' + title + '」未切到 ' + viewSelector);
            const visibleViews = $$('.app .main > .view').filter(visible).map((el) => el.id);
            assert(visibleViews.length === 1 && visibleViews[0] === $(viewSelector).id,
              '主导航「' + title + '」激活后可见视图异常: ' + visibleViews.join(','));
            return { title, view: $(viewSelector).id };
          });
        }
        await navStep('stepNavProjects', '项目', '#view-projects');
        await navStep('stepNavTasks', '任务', '#view-tasks');
        await navStep('stepNavCaps', '能力', '#view-caps');
        await navStep('stepNavChat', '对话', '#view-chat');

        await step('stepShowTrace', async () => {
          const traceTab = tabByText('执行过程');
          assert(traceTab, '找不到「执行过程」页签');
          traceTab.click();
          assert(await waitFor(() => visible($('#pane-trace')) && traceTab.classList.contains('on'), 5000),
            '执行过程页签未显示 #pane-trace');
          return { pane: 'trace', visible: true };
        });

        await step('stepShowTalk', async () => {
          const talkTab = tabByText('对话');
          assert(talkTab, '找不到「对话」页签');
          talkTab.click();
          assert(await waitFor(() => {
            const pane = $('#view-chat .pane');
            return visible(pane) && talkTab.classList.contains('on') && !$('#pane-trace');
          }, 5000), '对话页签未恢复对话面板');
          return { pane: 'talk', visible: true };
        });

        await step('stepCycleTheme', async () => {
          const button = $('#view-chat .panes button[aria-label="切换主题"]');
          assert(button, '找不到主题切换按钮');
          const order = ['system', 'light', 'dark'];
          const savedBefore = stored('ppx_theme_pref');
          const beforePref = order.includes(savedBefore) ? savedBefore : (stored('ppx_theme') === 'light' ? 'light' : 'dark');
          const beforeResolved = document.documentElement.getAttribute('data-theme');
          const expectedPref = order[(order.indexOf(beforePref) + 1) % order.length];
          const expectedResolved = expectedPref === 'system'
            ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
            : expectedPref;
          button.click();
          assert(await waitFor(() => stored('ppx_theme_pref') === expectedPref
            && document.documentElement.getAttribute('data-theme') === expectedResolved, 4000),
          '主题未按三态顺序切换并应用');
          return {
            beforePref,
            afterPref: stored('ppx_theme_pref'),
            beforeResolved,
            afterResolved: document.documentElement.getAttribute('data-theme'),
          };
        });

        outcome.steps = stepResults;
        return outcome;
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
    const required = [
      "typeCards", "viewChat", "hero", "composer", "input", "sendButton", "sidebar", "navReady",
      "readinessOk", "bootstrap", "token", ...STEP_CHECKS,
    ];
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
      steps: checks.steps || [],
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
