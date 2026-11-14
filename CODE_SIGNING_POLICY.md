# Code signing policy

## 状态

本仓库已为免费开源签名（SignPath Foundation）准备好构建、校验与发布流程。
**在申请获批并正式启用签名之前，GitHub Release 中的安装包是未签名的**；
未签名状态会在 `SIGNATURE-STATUS.txt` 中如实标注，用户可用 `SHA256SUMS.txt`
与源码构建结果核对。

获批后：

> Free code signing provided by SignPath.io, certificate by SignPath Foundation.

签名由 SignPath.io 的托管流水线执行，证书由 SignPath Foundation 持有；
发布者显示为 SignPath Foundation，而不是项目维护者个人。

## 签名范围

只有同时满足以下条件的文件会被签名：

1. 由 GitHub Actions 从本仓库的 tag 构建；
2. tag 与 `package.json` 的 `version` 一致；
3. 构建前通过 `npm run gate:release`；
4. 产物为 `PPXANS-Harness-Setup-<版本>-x64.exe`；
5. 由项目 Approver 在 SignPath 中人工批准该次签名请求。

不会签名：本地开发构建、未打 tag 的临时产物、第三方二进制、用户自行修改后的副本。

## 团队角色

本项目目前由单一维护者维护：

- Authors / Committers：[@chen6896qqwee](https://github.com/chen6896qqwee)
- Reviewers：[@chen6896qqwee](https://github.com/chen6896qqwee)
- Approvers：[@chen6896qqwee](https://github.com/chen6896qqwee)

维护者承诺：

- GitHub 与 SignPath 账号启用双因素认证；
- 每次签名请求在合并/发布前人工确认；
- 代码变更与构建脚本变更受到同等审查；
- 不在本地或第三方渠道用同一身份签署非本仓库构建的二进制。

## 构建可验证性

- 构建在 GitHub 托管的 Windows runner 上进行，日志公开；
- 依赖通过 `npm ci` 从 `package-lock.json` 安装；
- Electron 运行时由 electron-builder 下载并校验；
- 发布资产包含 `SHA256SUMS.txt` 与 `SIGNATURE-STATUS.txt`；
- 源码、构建脚本、CI 配置全部在公开仓库中。

## 隐私

> This program will not transfer any information to other networked systems
> unless specifically requested by the user or the person installing or operating it.

具体说明：

- 程序默认在本机运行，不包含遥测、统计或广告 SDK；
- 只有当用户配置了模型服务后，程序才会把对话内容发送到用户指定的
  OpenAI 兼容端点；
- 只有用户主动配置并启用飞书/微信等渠道时，程序才会连接对应服务；
- 会话、记忆、审计日志默认保存在用户本机
  `%LOCALAPPDATA%\PPXANS-Harness-Desktop`，不会自动上传；
- 第三方模型服务的数据处理遵循其各自的隐私政策。

## 卸载

Windows 安装包提供标准卸载器：设置 → 应用 → “皮皮虾 (PPXANS-Harness)”，
或开始菜单中的 Uninstall。卸载默认保留用户数据，删除数据需用户手动操作。

## 安全与合规

- 项目不包含恶意软件、广告软件或漏洞利用工具；
- 项目不会在未提示的情况下修改系统配置；
- 安全漏洞请通过 GitHub Security Advisory 私下报告，不要公开提交利用细节。

## 联系方式

- 仓库：<https://github.com/chen6896qqwee/PPXANS-Harness>
- 安全问题：<https://github.com/chen6896qqwee/PPXANS-Harness/security/advisories/new>
- 一般问题：GitHub Issues
