# 桌面端打包与开源发布指南 (Windows / macOS / Linux)

> 面向普通用户只发布**全量桌面安装包**（内置 Electron 运行时，免装 Node）：
> Windows NSIS `.exe`、macOS `.dmg/.zip`、Linux `.AppImage/.deb`。
> 独立便携包（内置 Node 运行时）保留为可选分发方式，默认不随 Release 上传。
>
> 构建机：Node ≥ 20；Windows 10 1803+ 自带 PowerShell/tar；macOS 包必须在 macOS 上构建；
> Linux 包建议在 Linux 上构建（CI 已覆盖三平台）。

## 开源发布标准 (GitHub Releases)

每个 `v<semver>` 版本附以下资产：

| 资产 | 必需 | 说明 |
|---|---|---|
| `PPXANS-Harness-Setup-<版本>-x64.exe` | ✅ | Windows 全量安装包，向导式、按用户安装、带卸载器 |
| `PPXANS-Harness-<版本>-mac-<arch>.dmg/.zip` | ✅ | macOS 安装包（x64 / arm64），由 CI 在 macOS runner 构建 |
| `PPXANS-Harness-<版本>-linux-x64.AppImage/.deb` | ✅ | Linux 安装包，由 CI 在 Ubuntu runner 构建 |
| `SHA256SUMS.txt` | ✅ | 安装包校验和，`certutil -hashfile <exe> SHA256` 对照 |
| `SIGNATURE-STATUS.txt` | ✅ | 该版本 Authenticode 签名状态（未签名也会如实标注） |
| `LICENSE` / `NOTICE` / `THIRD-PARTY-NOTICES.md` | ✅ | Apache-2.0 与再分发声明 |
| `CODE_SIGNING_POLICY.md` | ✅ | 签名范围、团队角色与隐私说明（SignPath 申请材料） |
| Source code (zip/tar.gz) | ✅ | GitHub 根据 tag 自动生成 |
| `*-portable-win64.zip` / `.msi` / SBOM | 可选 | 绿色版、企业 MSI、软件物料清单 |

约定：

- 版本号遵循 SemVer，tag 必须与 `package.json` 的 `version` 完全一致（发布工作流会校验）。
- 安装包命名固定为 `PPXANS-Harness-Setup-<semver>-<arch>.exe`，不要手工改名。
- 代码签名可选：配置仓库 secrets `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD` 即自动签名；
  未配置时产物未签名，首次运行会有 SmartScreen“未知发布者”提示，属于预期行为。
  仓库变量 `REQUIRE_SIGNED_RELEASE=true` 可把“必须签名”变成发布硬门禁。
  三条签名路线（SignPath Foundation 免费 OSS / OV 证书 / Azure Artifact Signing）、
  申请材料与故障排查见 [SIGNING.md](SIGNING.md)。
- 发布入口：`git tag v4.0.0 && git push origin v4.0.0`，由
  `.github/workflows/release.yml` 跑发布门禁、构建、生成校验和与签名状态并创建 Release。

## 桌面安装包（默认发布物）

```bash
npm ci
npm run desktop:pack
```

产物：

- `dist-desktop/PPXANS-Harness-Setup-<版本>-x64.exe`（约 119MB）
- `dist-desktop/SHA256SUMS.txt`（打包脚本自动生成）
- `dist-desktop/SIGNATURE-STATUS.txt`（打包脚本自动检查 Authenticode 并生成）
- `dist-desktop/win-unpacked/`（调试用，不发布）

安装行为：`perMachine: false`，默认装到 `%LOCALAPPDATA%\Programs\PPXANS-Harness`，
不写系统级注册表、不需要管理员权限；创建桌面/开始菜单快捷方式与卸载器。
用户数据在 `%LOCALAPPDATA%\PPXANS-Harness-Desktop`，卸载默认保留。

本地校验签名状态（未签名退出码 0；`--require` 时未签名退出码 1）：

```bash
npm run signature:check
npm run signature:check:strict
```

发版前门禁：`npm run gate:release`（verify + lint + README 数字含全量测试）。

## macOS / Linux 安装包

```bash
npm ci
npm run desktop:pack:mac      # 必须在 macOS 上执行 → dist-desktop/*.dmg + *.zip (x64 + arm64)
npm run desktop:pack:linux    # 在 Linux 上执行 (CI 覆盖) → dist-desktop/*.AppImage + *.deb
```

说明：

- macOS 包未签名/未公证时，用户首次打开会看到 Gatekeeper 提示，需右键 → 打开；
  配置 `CSC_LINK` / `CSC_KEY_PASSWORD` 后可签名，公证还需 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`。
- Linux AppImage 直接 `chmod +x` 后运行；`.deb` 用 `sudo dpkg -i` 安装。
- 本地在 Windows 上 *不能* 构建 macOS 包；日常发版交给 `.github/workflows/release.yml`
  （`windows-latest` / `macos-latest` / `ubuntu-latest` 三平台矩阵，最后汇总一份 `SHA256SUMS.txt`）。

## 独立安装包（可选）

```bash
node scripts/package.js              # 便携版 zip + 单文件 Setup.cmd
node scripts/package.js portable     # 仅便携版
node scripts/package.js installer    # 仅 Setup.cmd
node scripts/package.js --node v22.14.0
```

产物在 `dist/`：

| 产物 | 文件 | 说明 |
|---|---|---|
| 便携版 | `PPXANS-Harness-v<版本>-portable-win64.zip` (~32MB) | 解压即用，内置 Node 运行时 |
| 安装器 | `PPXANS-Harness-v<版本>-Setup-win64.cmd` (~43MB) | 单文件自解压，不写注册表 |

补充规则：

- zip 写入使用 `C:\Windows\System32\tar.exe`（bsdtar，正斜杠条目），`node.exe` 与
  `LICENSE.node.txt` 由 PowerShell `.NET ZipFile` 从官方 zip 抽取；不再依赖 `zip`/`python3`。
- 内置 Node 运行时从 nodejs.org 下载并做 **SHA-256 校验**（缓存于 `dist/.cache/`）。
- 安装器自校验：重新读回 base64 解码，比对 payload SHA-256，不一致拒绝发布。
- 独立产物如对外分发，需自行生成校验和：
  `node scripts/checksums.js dist --pattern "PPXANS-Harness-v.*\.(zip|cmd)$"`。
- 再分发必须保留 `runtime/LICENSE.node.txt`、`LICENSE`、`NOTICE`、`THIRD-PARTY-NOTICES.md`。

## 安装包行为 (Setup-win64.cmd)

1. 从文件尾部 base64 区解出 payload zip（标记串 `<<<PPX-PAYLOAD-DO-NOT-EDIT>>>`，脚本内拆串保证唯一）
2. 解压到 `%LOCALAPPDATA%\PPXANS-Harness`
3. 创建桌面快捷方式 + 开始菜单项（指向内置运行时启动器 `ppx-web.cmd`）
4. 写入卸载器 `uninstall.cmd`（删快捷方式 + 删安装目录，不动注册表）

双击即装，无需管理员权限（写入用户目录）。

## 运行时解析约定

所有启动器统一遵循：**内置运行时优先，系统兜底** —— `runtime\node.exe` 存在则用之，
否则回退系统 `node`。源码仓库内无 `runtime/`，行为与旧版一致。

## 相关脚本

- `scripts/desktop-pack.js` — 桌面安装包（electron-builder，默认发布物）
- `scripts/checksums.js` — 生成 SHA256SUMS.txt
- `scripts/verify-signature.js` — 检查 Authenticode 签名（发布流与本地共用）
- `docs/signpath-release.yml` — SignPath Foundation 签名发布样例（获批后启用）
- `scripts/package.js` — 独立便携包 / Setup.cmd（可选）
- `scripts/package-scan.js` — 阻断用户配置/备份/密钥进入产物
- `scripts/release.js` — npm 包发布打包
