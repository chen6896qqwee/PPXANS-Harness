# 桌面客户端 (Electron)

> 2026-10-30 新增，2026-11-02 收口为**唯一用户入口**：双击即用，没有浏览器、没有地址栏、不需要记端口或手动起服务。
> **运行时依赖仍然是零** —— Electron 只装在 `devDependencies`，打包后是独立的 `.exe`；内核本体仍是纯 Node。

## 形态

```
┌────────────────────────────┐
│ Electron 桌面客户端        │
│  · 窗口 / 菜单 / 权限      │
│  · 单实例 / 端口选择       │
└──────────┬─────────────────┘
           │ 子进程 (内部实现, 用户不可见)
┌──────────▼─────────────────┐
│ ppx web 内核               │
│  仅监听 127.0.0.1 本机回环 │
└────────────────────────────┘
```

- 用户只面对桌面窗口；内核服务由应用自己拉起、自己回收，端口与地址不对外暴露。
- 内核在独立子进程里跑，界面卡死/重载不影响内核；内核退出会弹窗提示并可重启。
- 端口策略（内部细节）：先试配置端口（`config/ppx.json` → `channels.http.port`，默认 8899）；若已有本应用服务则直接接入；被别的程序占用则自动向后找空闲端口。

## 本地开发运行

```bash
npm install                     # 会装 electron / electron-builder (devDependency)
npm start                       # = node scripts/desktop-start.mjs → electron/main.js（也可 npm run desktop）
npm run desktop:dev             # 同上, 保留开发者工具
```

Windows 也可以双击仓库根目录的 `启动皮皮虾.bat`：首次运行缺 Electron 时会提示并自动执行 `npm install`，之后直接开窗口。
macOS / Linux 直接 `npm start`。

首次启动会：

1. 在用户数据目录建工作副本 — Windows `%LOCALAPPDATA%\PPXANS-Harness-Desktop\`，
   macOS `~/Library/Application Support/PPXANS-Harness-Desktop/`，
   Linux `~/.config/PPXANS-Harness-Desktop/`；
2. 开发模式下工作副本就是仓库根目录，不做任何复制。

## 打包发布

```bash
npm run desktop:pack            # 唯一全量 NSIS 安装包 + SHA256SUMS.txt, 产物在 dist-desktop/
npm run desktop:pack:dir        # 只出未压缩目录, 调试用
```

产物：

| 文件 | 说明 |
|---|---|
| `dist-desktop/PPXANS-Harness-Setup-<版本>-x64.exe` | 全量 NSIS 安装包（可选安装目录、创建桌面+开始菜单快捷方式、无需管理员） |
| `dist-desktop/SHA256SUMS.txt` | 发布校验和，随安装包一起上传 Release |
| `dist-desktop/SIGNATURE-STATUS.txt` | Authenticode 签名状态（打包/发布生成；未签名也如实标注） |

发布标准见 [PACKAGING.md](PACKAGING.md)，签名路线见 [SIGNING.md](SIGNING.md)；`v*` tag 会触发 `.github/workflows/release.yml` 自动构建并创建 GitHub Release。

构建默认走国内镜像（`ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`，见 `scripts/desktop-pack.js`）。网络能直连 GitHub 时可以覆盖这两个环境变量。

> 图标由 `electron/icon.png` 生成：改图后执行 `electron scripts/make-icon.mjs` 重新生成 `electron/icon.ico`，再打包。

## 打包版的数据目录（工作副本）

打包后程序文件在安装目录（只读语义），真正运行的是**工作副本**：

```
%LOCALAPPDATA%\PPXANS-Harness-Desktop\
├── workspace\              # 工作副本 = 内核代码 + 数据
│   ├── bin\ src\ skills\ ...   # 从安装包首次播种
│   ├── data\               # 记忆 / 审计链 / 会话
│   ├── uploads\            # 上传附件
│   ├── config\ppx.json     # 模型配置（首次需在界面里配置）
│   └── .desktop-seed.json  # 播种版本记录
├── logs\server-YYYY-MM-DD.log
└── window-state.json
```

**为什么要复制一份**：皮皮虾有「自改代码闭环」，会在 `root` 内改自己的源码。安装目录不适合写，所以打包版第一次启动把内置代码播种到可写目录。升级安装包时**不再整包覆盖**：同一版本启动不做任何落盘；检测到新版本时先把代码目录与配置备份成 `workspace.backup-<旧版本>-<时间>`，再叠加新代码（用户改过的 `config/ppx.json`、`identity.md`、`PPX.md` 与 `data/ uploads/ .ppx/` 一律保留）。安装包版本号变化时触发一次可回退的升级，避免把 agent 自己的改动直接冲掉。

需要回到内置版本时：菜单 **应用 → 重置工作副本…**，会把当前副本整体备份成 `workspace.backup-<时间>`，重新播种，并保留 `data/ uploads/ .ppx/ config/ppx.json PPX.md`。

清空全部数据（含记忆与配置）：关闭应用后直接删除 `%LOCALAPPDATA%\PPXANS-Harness-Desktop\workspace`。卸载器默认不删这些数据（`deleteAppDataOnUninstall: false`）。

## 桌面行为约定

- **单实例**：重复启动只聚焦已有窗口。
- **常驻与托盘**：默认关闭窗口 = 隐藏到托盘，内核继续运行；托盘菜单可显示/新建对话/检查更新/打开日志/退出。可在「应用」菜单关闭该行为，改回关闭即退出。
- **开机自启**：默认关闭；「应用 → 开机自启」可切换（Windows/macOS 走系统登录项，Linux 写 `~/.config/autostart/ppxans-harness.desktop`）。
- **全局快捷键**：默认 `CommandOrControl+Shift+Space` 显示/隐藏窗口；被占用时只记日志，不阻塞启动。可在「应用」菜单停用。
- **完成通知**：窗口在后台且单轮超过 5 秒时，回合结束发系统通知；前台不打扰。
- **麦克风**：只对本地面板放行 `media`（且拒绝摄像头）；其他权限默认拒绝。
- **外链**：`target=_blank` / 外部链接交给系统浏览器，不在应用内开新窗口。
- **退出**：托盘「退出」或「应用 → 退出」会回收本次拉起的子进程；接入的是已有服务时不动它。
  正常退出先请求内核 `POST /desktop/shutdown`（仅回环 + `PPX_DESKTOP_SECRET`），
  走与 Ctrl+C 相同的优雅收口（记忆落盘 / 军团回收 / 投递队列）；2.8 秒未退出才强制结束进程树。
- **菜单**：默认隐藏（Alt 唤出）；提供显示/新建对话、开机自启、关闭到托盘、全局快捷键、检查更新、导出诊断包、打开工作副本、打开日志、重置工作副本、重载、缩放、全屏。
- **日志**：内核 stdout/stderr 落 `logs/server-*.log`，单文件超过 5MB 启动时截断。

## 更新与诊断

- **检查更新**：「应用 → 检查更新…」或启动时通知。流程是 **下载 → SHA-256 校验 → 用户确认 → 启动安装器**；
  没有 `SHA256SUMS.txt` 或校验不通过时不会自动安装。安装包未签名，启动安装器时系统仍可能提示“未知发布者”。
- **下载位置**：`<userData>/updates/`；重复检查时若同名文件哈希一致，直接复用不重下。
- **诊断包**：「应用 → 导出诊断包…」收集版本/环境、health 快照、脱敏后的 `config/ppx.json`、最近 5 个日志；
  API Key / token / 密码类字段与日志中的密钥形态会替换为 `***`。**不包含**对话正文、记忆、审计链数据与 uploads。
- **偏好文件**：`<userData>/desktop-prefs.json`（损坏自动回退默认，不阻止启动）。

## 前端构建依赖 (Vue 3 + Vite)

界面源码在 `webapp/src` (Vue SFC), 构建产物在 `webapp/dist` (入库, `npm ci` 后直接可跑):

```bash
npm run web:build   # vite build --config webapp/vite.config.mjs
npm run web:dev     # 开发服务器 (热更新)
npm run web:check   # 静态自检: CSP / 图标引用 / 结构锚点 id / 关键 CSS
```

Markdown / 代码高亮 / 数学公式由 `markdown-it`、`dompurify`、`katex`、`highlight.js`
提供 —— 它们是 **devDependencies**(构建期依赖), 由 Vite 打进 `webapp/dist`, 不进入主包运行时,
也不走 CDN。任意一个库没加载成功, `renderMd` 自动退回纯文本渲染: 少排版, 但不留不安全的 HTML 通道。
许可证与落点见 `THIRD-PARTY-NOTICES.md` 的 “Bundled in the Web UI” 一节。

## 数据目录补充

```
%LOCALAPPDATA%\PPXANS-Harness-Desktop\
├── desktop-prefs.json      # 托盘/自启/热键偏好
├── updates\                # 下载的安装包 (SHA-256 校验后保留)
├── workspace\              # 工作副本 = 内核代码 + 数据
└── logs\server-YYYY-MM-DD.log
```

## GUI 冒烟（真实窗口自动化）

```bash
npm run desktop:smoke
```

`scripts/desktop-gui-smoke.mjs` 负责隔离环境：检测 Electron 是否安装（未安装 → SKIP 退出 0）、
选空闲端口、建临时 `userData` / `data` 目录，并清掉父进程可能残留的 `PPX_DESKTOP_SECRET`，
**不会碰生产实例或真实数据**。Electron 以 `PPX_DESKTOP_SMOKE=1` 启动（不显示窗口），
`electron/main.js` 在渲染进程里断言：

- `#view-chat / #hero / #typeCards / #composer / #inp / #btnSend / #side` 存在
  （2026-11-03 起本体首页并入对话空态，类型卡在 hero 里，冒烟断言以 `#typeCards` 替代原 `#view-home`）；
- `#botList` 已加载（不再是"加载中"）；
- bootstrap 数据与 authToken 存在；
- `document.readyState === "complete"`；
- `/health` 返回 `app === "ppxans-harness"`；
- 没有 `console-message` level ≥3 或 `did-fail-load`。

然后截图并写 `result.json`。产物归档在 `.ppxtest/desktop-smoke/latest/`
（`result.json` / `smoke.png` / `child.log`），全程 120s 超时；断言失败退出 1。

> 只截图不能证明界面可用——白屏也能截出一张纯色图。冒烟同时检查 DOM 与 API，两者都过才 PASS。
> 相关环境变量：`PPX_DESKTOP_SMOKE`、`PPX_DESKTOP_SMOKE_OUT`、`PPX_DESKTOP_SMOKE_RESULT`、
> `PPX_DESKTOP_USER_DATA`、`PPX_DESKTOP_SMOKE_TIMEOUT_MS`。

## 排障

| 现象 | 处理 |
|---|---|
| 双击 bat 没窗口，终端里像 node 一样退出 | 环境里残留 `ELECTRON_RUN_AS_NODE=1`。bat 已清除；`npm start` 与 `npm run desktop:smoke` 的包装器也会自动清除（2026-11-09）；只有手动直接调 `electron.exe` 时需要先 `set ELECTRON_RUN_AS_NODE=` |
| `npm install` 后 `node_modules\electron\dist` 为空 | 安装脚本被拦。手动执行：`set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后 `node node_modules/electron/install.js` |
| 提示「内核服务启动失败」 | 看 `logs/server-*.log`；常见是 `config/ppx.json` 损坏或端口被占满 |
| 窗口白屏 | 菜单 视图 → 强制重新加载；仍不行看日志里的内核异常 |
| 打包时卡在下载 | 确认 `scripts/desktop-pack.js` 的镜像生效，或设 `ELECTRON_BUILDER_BINARIES_MIRROR` 指向可达镜像 |
| 想改端口 | 改 `config/ppx.json` 的 `channels.http.port`，或 `PPX_PORT=9000 npm run desktop` |

## 与其它形态的关系

| 形态 | 入口 | 说明 |
|---|---|---|
| 桌面客户端（本文，唯一用户入口） | `npm start` / `启动皮皮虾.bat` / 安装包 | 原生窗口，无需浏览器、无需记端口 |
| 纯 CLI（开发者） | `npm run chat` | 终端内对话 |
| 内核调试（开发者） | `ppx web --no-open` | 仅本机回环，供接口 / MCP 调试，不是用户入口 |
