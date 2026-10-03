# PC 端打包指南 (Windows)

> 2026-10-01 新增。零依赖打包: 构建机只需 Node + zip/python3; 目标机 Windows 10/11 开箱即用
> (安装器仅使用系统内置 PowerShell / Expand-Archive, **不写注册表**, 绿色卸载)。

## 产物

| 产物 | 文件 | 说明 |
|---|---|---|
| 便携版 | `dist/PPXANS-Harness-v{X.Y.Z}-portable-win64.zip` (~31MB) | 解压到任意目录, 双击 `启动皮皮虾.bat` 即用, 内置 Node 运行时 |
| 安装包 | `dist/PPXANS-Harness-v{X.Y.Z}-Setup-win64.cmd` (~41MB) | 单文件自解压安装向导 |

## 构建

```bash
node scripts/package.js              # 便携版 + 安装器
node scripts/package.js portable     # 仅便携版
node scripts/package.js installer    # 仅安装器
node scripts/package.js --node v22.14.0   # 指定内置 Node 版本
```

npm 快捷命令: `npm run package` / `package:portable` / `package:installer`。

内置 Node 运行时从 nodejs.org 官方分发下载并做 **SHA-256 校验** (缓存于 `dist/.cache/`, 重复构建不重下);
安装器写入时做 **自校验** (重新读回 base64 解码比对 payload SHA-256), 不一致即拒绝发布。

## 安装包行为 (Setup-win64.cmd)

1. 从文件尾部 base64 区解出 payload zip (标记串 `<<<PPX-PAYLOAD-DO-NOT-EDIT>>>`, 脚本内已拆串保证唯一)
2. 解压到 `%LOCALAPPDATA%\PPXANS-Harness`
3. 创建桌面快捷方式 + 开始菜单项 (指向内置运行时启动器 `ppx-web.cmd`)
4. 写入卸载器 `uninstall.cmd` (删快捷方式 + 删安装目录, 同样不动注册表)

双击即装, 无需管理员权限 (写入用户目录)。

## 运行时解析约定 (2026-10-01 重构)

所有启动器 (`启动皮皮虾.bat` / `停止皮皮虾.bat` 等) 统一遵循: **内置运行时优先, 系统兜底** —
`runtime\node.exe` 存在则用之, 否则回退系统 `node`。源码仓库内无 `runtime/`, 行为与旧版一致。

## 相关脚本

- `scripts/package.js` — 本文档主角 (便携版 + 安装器)
- `scripts/release.js` — npm 包发布打包 (web/ 子项目缺失时优雅跳过, 2026-10-01 修复)
