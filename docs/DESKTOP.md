# 桌面端 (Electron)

> 2026-10-30 新增。把 Web 形态的皮皮虾包成真正的桌面应用：独立窗口、任务栏图标、桌面/开始菜单快捷方式。
> **运行时依赖仍然是零** —— Electron 只装在 `devDependencies`，打包后是独立的 `.exe`，内核本体还是那套纯 Node 服务。

## 形态

```
┌────────────────────────────┐
│ Electron 外壳 (electron/)  │
│  · 窗口 / 菜单 / 权限      │
│  · 单实例 / 端口选择       │
└──────────┬─────────────────┘
           │ 子进程 (ELECTRON_RUN_AS_NODE)
┌──────────▼─────────────────┐
│ bin/ppx-web.js 内核服务    │
│  同源单端口: 界面 + /mcp   │
└────────────────────────────┘
```

- 界面仍是 `public/` 那套 Web UI，只是装进了无地址栏的原生窗口。
- 内核在独立子进程里跑，界面卡死/重载不影响内核；内核退出会弹窗提示并可重启。
- 端口策略：先试配置端口（`config/ppx.json` → `channels.http.port`，默认 8899）；若已有本应用服务则直接接入；被别的程序占用则自动向后找空闲端口。

## 本地开发运行

```bash
npm install                     # 会装 electron / electron-builder (devDependency)
npm run desktop                 # = electron electron/main.js
npm run desktop:dev             # 同上, 保留开发者工具
```

Windows 也可以双击仓库根目录的 `启动桌面版.bat`；macOS / Linux 直接 `npm run desktop`。

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
- **麦克风**：只对本地面板放行 `media`（且拒绝摄像头）；其他权限默认拒绝。
- **外链**：`target=_blank` / 外部链接交给系统浏览器，不在应用内开新窗口。
- **关闭窗口 = 退出**：同时回收本次拉起的子进程；接入的是已有服务时不动它。
- **菜单**：默认隐藏（Alt 唤出）；提供打开工作副本、打开日志、复制面板地址、重置工作副本、重载、缩放、全屏。
- **日志**：内核 stdout/stderr 落 `logs/server-*.log`，单文件超过 5MB 启动时截断。

## 排障

| 现象 | 处理 |
|---|---|
| 双击 bat 没窗口，终端里像 node 一样退出 | 环境里残留 `ELECTRON_RUN_AS_NODE=1`。bat 已清除；手动启动时先 `set ELECTRON_RUN_AS_NODE=` |
| `npm install` 后 `node_modules\electron\dist` 为空 | 安装脚本被拦。手动执行：`set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后 `node node_modules/electron/install.js` |
| 提示「内核服务启动失败」 | 看 `logs/server-*.log`；常见是 `config/ppx.json` 损坏或端口被占满 |
| 窗口白屏 | 菜单 视图 → 强制重新加载；仍不行看日志里的内核异常 |
| 打包时卡在下载 | 确认 `scripts/desktop-pack.js` 的镜像生效，或设 `ELECTRON_BUILDER_BINARIES_MIRROR` 指向可达镜像 |
| 想改端口 | 改 `config/ppx.json` 的 `channels.http.port`，或 `PPX_PORT=9000 npm run desktop` |

## 与其它形态的关系

| 形态 | 入口 | 说明 |
|---|---|---|
| 桌面端（本文） | `npm run desktop` / 安装包 | 原生窗口，推荐给日常使用 |
| Web 应用 | `npm start` / `启动皮皮虾.bat` | 浏览器打开，适合服务器/远程 |
| Edge App 外壳 | `npm run desktop:edge` | 零 Electron 的轻量方案（`bin/ppx-desktop.js`），作为无 npm 环境的兜底 |
| 纯 CLI | `npm run chat` | 终端内对话 |
