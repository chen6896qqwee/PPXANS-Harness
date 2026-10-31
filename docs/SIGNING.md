# Windows 代码签名指南

> 适用：PPXANS-Harness 桌面安装包（NSIS，Windows x64）
> 构建链：electron-builder 26.18 + GitHub Actions
> 最后核对：2026-10-31

## 0. 当前状态与结论

**4.0.0 的安装包是未签名的。** 在没有“经过身份核验的证书/云签名服务”之前，
无法生成一个 Windows 公开信任的签名；自签证书只能用于本机测试，不能消除
SmartScreen 的“未知发布者”提示。这不是代码问题，而是 CA/身份体系的问题。

针对“现在什么都没有”的情况，按优先级：

| 优先级 | 路线 | 费用 | 适合谁 | 主要门槛 |
|---|---|---|---|---|
| 1 | **SignPath Foundation**（免费 OSS 签名） | 0 | 公开仓库、OSI 许可证、有一定知名度的开源项目 | 需要申请与人工审核；证书签发给 SignPath Foundation；每个版本人工批准 |
| 2 | **OV 代码签名证书**（Certum/Sectigo/GlobalSign 等） | 约 ¥1,000–2,500/年，以报价为准 | 有个人/企业身份材料、需要稳定发布渠道 | 身份/组织核验；私钥在 UKey 或云 HSM |
| 3 | **Azure Artifact Signing**（原 Trusted Signing） | 约 US$9.99/月起 | 美国、加拿大、欧盟、英国等地区的组织；美/加个人 | 公共信任目前**不覆盖中国大陆**；需要 Azure 订阅与身份验证 |
| 4 | **自签证书** | 0 | 本机开发、内网分发 | Windows 默认不信任；**不可用于公开分发** |

如果短期内拿不到 1–3，正确做法是：**继续发布未签名安装包，但同时提供
`SHA256SUMS.txt`、源码和可复现的 GitHub Actions 构建**。这不能消除 SmartScreen
提示，但能让用户验证“下载到的文件确实来自这个仓库的这次构建”。

## 1. 为什么不能“随便签一下”

Windows 的 Authenticode 校验的是完整信任链：

1. 文件哈希与签名匹配；
2. 签名证书由 Windows 信任的根 CA 签发；
3. 证书用途包含代码签名，且未过期/未吊销；
4. 有时间戳时，即使证书过期，旧签名仍然有效。

自签证书不在 Windows 受信任根里，用户机器上会显示“未知发布者”，
SmartScreen 仍可能拦截。把它装进“受信任的根证书颁发机构”只对那台机器有效，
不能要求下载用户这么做。

另外两个现实预期：

- **新证书也要攒信誉。** 换用 OV、Azure 或 SignPath 后，前几个版本仍可能触发
  SmartScreen；持续用同一发布者身份签名，信誉会逐步建立。
- **EV 不再保证“秒过”。** 微软已调整 SmartScreen 信誉逻辑，单纯为跳过提示
  去买更贵的 EV 并不划算；EV 的价值主要在更严格的身份核验和部分企业采购要求。

## 2. 仓库里已经准备好的部分

| 能力 | 位置 | 说明 |
|---|---|---|
| PFX 证书签名 | `.github/workflows/release.yml` | 配置 `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD` 后自动签名 |
| 签名结果检查 | `scripts/verify-signature.js` | 读取 `Get-AuthenticodeSignature`，输出状态/签名者/时间戳 |
| 发布时签名报告 | `.github/workflows/release.yml` | 生成 `SIGNATURE-STATUS.txt`，写入 Job Summary 并随 Release 上传 |
| 强制签名门禁 | 仓库变量 `REQUIRE_SIGNED_RELEASE=true` | 未签名或签名无效时让发布失败 |
| 签名策略 | `CODE_SIGNING_POLICY.md` | SignPath Foundation 申请所需的公开策略 |
| SignPath 工作流样例 | `docs/signpath-release.yml` | 获批后复制到 `.github/workflows/` 使用 |

本地检查当前安装包：

```powershell
npm run signature:check
# 或要求必须签名（当前会失败，因为 4.0.0 未签名）
npm run signature:check:strict
```

输出示例：

```text
Authenticode 签名检查

  ...\PPXANS-Harness-Setup-4.0.0-x64.exe
    状态   : 未签名 (NotSigned)

共 1 个文件: 有效 0, 未签名 1, 不受信任 0, 无效/无法读取 0
```

## 3. 路线 A：SignPath Foundation（开源首选）

SignPath Foundation 用自己的名义申请代码签名证书，替符合条件的开源项目签名。
它不核验你的个人身份，而是核验“这个二进制确实由公开仓库的 CI 构建”。
因此：

- 证书上的发布者是 **SignPath Foundation**，不是你；
- 每个版本需要项目内 Approver 在 SignPath 里人工批准；
- 不保证申请通过，项目知名度和可验证信誉是硬门槛；
- 二进制必须能从公开源码可验证地构建。

官方说明与条款：
[signpath.org](https://signpath.org/) · [申请条件](https://signpath.org/terms.html) · [申请入口](https://signpath.org/apply)

### 3.1 申请前检查

- [ ] 仓库公开，`LICENSE` 为 OSI 认可许可证（本项目 Apache-2.0）
- [ ] 没有商业双许可、没有专有组件；Electron 等系统库可按条款随包分发
- [ ] 项目处于活跃维护状态
- [ ] 已经以“要签名的形式”发布过版本（本项目已有 GitHub Release，见 Releases 页）
- [ ] README/下载页能说明软件功能
- [ ] 首页有 **Code signing policy**（本仓库：`CODE_SIGNING_POLICY.md`）
- [ ] 维护者启用 GitHub 与 SignPath 的双因素认证
- [ ] 每个版本由 Approver 人工批准
- [ ] 软件提供卸载方式（NSIS 卸载器已具备）
- [ ] 不包含恶意软件、漏洞利用/绕过安全机制的功能

> 本项目是本地智能体运行框架，带有命令执行与自修改能力。申请时应如实说明：
> 它是用户本机运行的 agent harness，不是漏洞扫描/渗透工具。是否被接受由
> SignPath Foundation 判断。

### 3.2 申请步骤

1. 把仓库、许可证、README 下载区和 `CODE_SIGNING_POLICY.md` 准备好；
2. 打开 <https://signpath.org/apply>，填写项目地址、许可证、构建方式、
   发布流程、维护者信息；
3. 审核通过后，在 SignPath 中创建：
   - Project（对应本仓库）
   - Signing policy（例如 `release-signing`）
   - Artifact configuration（匹配 `PPXANS-Harness-Setup-*.exe`，并限制产品名/版本元数据）
4. 在 GitHub 仓库配置：
   - Secret：`SIGNPATH_API_TOKEN`
   - Variables：`SIGNPATH_ORGANIZATION_ID`、`SIGNPATH_PROJECT_SLUG`、
     `SIGNPATH_SIGNING_POLICY_SLUG`、`SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`
5. 把 `docs/signpath-release.yml` 复制为 `.github/workflows/release-signpath.yml`，
   按注释替换占位符；
6. 打 tag 发布，SignPath 里人工批准后，签名后的安装包会被下载回来并替换原文件；
7. 工作流会重新生成 `SHA256SUMS.txt`，并用 `--require` 验证签名。

### 3.3 注意

- SignPath 的 GitHub Action 会上传**未签名产物**作为 artifact，签名完成后再下载
  签名后的文件；因此 Release 资产必须是“签名后重新生成校验和”的版本。
- 只签外层 NSIS 安装包时，安装后的 `PPXANS-Harness.exe` 仍可能是未签名的。
  如果需要内外都签，PFX/Azure 路线更直接（electron-builder 会在打包阶段同时签
  应用 exe 与安装包）；SignPath 路线要额外做自定义签名钩子，复杂度更高。
- 申请被拒并不罕见。不要伪造“已签名”，继续用 SHA-256 + 源码发布即可。

## 4. 路线 B：OV 代码签名证书（最稳的付费路线）

适合有个人/企业身份材料、希望长期稳定发布的维护者。中国大陆可购买，
常见品牌：Certum、Sectigo、GlobalSign、DigiCert。

### 4.1 购买与验证

1. 选择 **OV Code Signing**（组织验证）或 EV（扩展验证）；
2. 提交身份/组织材料，CA 做人工核验（通常 1–3 个工作日，视材料而定）；
3. 私钥必须在符合要求的硬件中：UKey/HSM，或 CA 提供的云签名服务；
4. 证书最长有效期受 CA/B 论坛规则限制（2026 年起单张最长 459 天），
   到期需要续签；时间戳能让已发布的旧版本在证书过期后继续有效。

> 只做桌面软件、主要目的是消除“未知发布者”时，OV 通常足够；EV 更贵，
> 且不再保证 SmartScreen 立即放行。

### 4.2 用 PFX 在 CI 中签名

如果 CA 允许导出 PFX（部分云签名服务不导出，改用其签名工具）：

```powershell
# 1) 把 pfx 转成 base64（只在本机执行，不要把 pfx 提交到仓库）
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\certs\ppxans.pfx"))
$b64 | Set-Clipboard

# 2) 写入 GitHub Secrets
gh secret set WINDOWS_CSC_LINK --body $b64
gh secret set WINDOWS_CSC_KEY_PASSWORD
```

仓库的 `release.yml` 已经把这些 secret 映射为 electron-builder 认识的
`CSC_LINK` / `CSC_KEY_PASSWORD`。本地验证：

```powershell
$env:CSC_LINK = "C:\certs\ppxans.pfx"
$env:CSC_KEY_PASSWORD = "你的密码"
npm run desktop:pack
npm run signature:check:strict
```

签名成功后，`Get-AuthenticodeSignature` 应为 `Valid`，并且有时间戳。
electron-builder 默认使用 `http://timestamp.digicert.com`；如果 CA 要求其他
时间戳服务，可在 `package.json` 的 `build.win.signtoolOptions` 中设置
`rfc3161TimeStampServer`。

### 4.3 云 HSM / UKey

- 云签名服务通常提供自己的签名 CLI 或“自定义签名钩子”，需要把
  electron-builder 的 `win.signtoolOptions.sign` 指向对应命令；
- UKey 只能插在构建机上，不适合 GitHub 托管 runner；更推荐云 HSM；
- 无论哪种方式，都要保证**私钥不进入仓库、不进 artifact、不进日志**。

## 5. 路线 C：Azure Artifact Signing（原 Trusted Signing）

微软全托管签名服务，electron-builder 26.18 原生支持
`win.azureSignOptions`。费用约 US$9.99/月起（Basic，具体以 Azure 定价页为准），
不需要硬件令牌。

**地区限制（公共信任）**：截至 2026-10，公共信任面向美国、加拿大、欧盟、英国、
澳大利亚、新西兰、日本、韩国、新加坡、瑞士、挪威、以色列的组织；个人开发者
仅限美国/加拿大。**中国大陆的个人与组织目前不在公共信任范围内**，应改走 OV
证书。私有信任不受此限制，但私有信任只对受控设备有意义，不能用于公开下载。

### 5.1 开通

1. Azure 订阅中注册资源提供程序 `Microsoft.CodeSigning`；
2. 创建 Trusted Signing / Artifact Signing 账户（选择支持的区域）；
3. 完成 Identity Validation（个人或组织）；
4. 创建 Public Trust 证书配置文件；
5. 创建 Entra 应用，给构建流水线授予签名权限，配置
   `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`（或等价凭据）。

区域端点示例（以 Azure 门户显示为准）：

| 区域 | Endpoint |
|---|---|
| East US | `https://eus.codesigning.azure.net` |
| West US 2 | `https://wus2.codesigning.azure.net` |
| West Central US | `https://wcus.codesigning.azure.net` |
| North Europe | `https://neu.codesigning.azure.net` |
| West Europe | `https://weu.codesigning.azure.net` |

### 5.2 配置 electron-builder

在 `package.json` 的 `build.win` 中加入（不要同时配置 `signtoolOptions`）：

```json
"azureSignOptions": {
  "publisherName": "证书上验证过的法定名称",
  "endpoint": "https://wus2.codesigning.azure.net",
  "certificateProfileName": "ppxans-public",
  "codeSigningAccountName": "ppxans-signing"
}
```

在 `release.yml` 的构建步骤里加入三个 Azure 凭据 secret。electron-builder 会
自动安装 `TrustedSigning` PowerShell 模块并调用 `Invoke-TrustedSigning`。

### 5.3 签名后的行为

Azure 签名不会立即获得 SmartScreen 信任；使用同一发布者身份持续签名，
信誉会逐步累积。签名身份绑定的是“验证过的身份”，不是某一张证书，
续期后信誉可以延续。

## 6. 路线 D：自签证书（仅本机测试）

只用于验证“签名链路能跑通”，**不要发布自签名的安装包**。

```powershell
# 1) 生成自签代码签名证书
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=PPXANS Test Only" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -KeyUsage DigitalSignature `
  -KeyExportPolicy Exportable

# 2) 导出 pfx（密码仅用于本地测试）
$pwd = ConvertTo-SecureString "test-only" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath "$env:TEMP\ppxans-test.pfx" -Password $pwd

# 3) 用测试证书打包
$env:CSC_LINK = "$env:TEMP\ppxans-test.pfx"
$env:CSC_KEY_PASSWORD = "test-only"
npm run desktop:pack

# 4) 结果应为 NotTrusted（不是 Valid）
npm run signature:check
```

如果本机把该自签证书手动装进了“受信任的根证书颁发机构”，状态可能变成
`Valid`，但这只对这台机器成立，不能外推到用户。

## 7. 如何验证签名

### 7.1 仓库脚本

```powershell
node scripts/verify-signature.js dist-desktop/PPXANS-Harness-Setup-4.0.0-x64.exe
node scripts/verify-signature.js --require      # 未签名/无效 → 退出码 1
node scripts/verify-signature.js --json         # 机器可读
```

状态含义：

| Status | 含义 | 是否可发布 |
|---|---|---|
| `Valid` | 签名有效、证书受信任、哈希匹配 | 是 |
| `NotSigned` | 没有签名 | 可以，但用户会看到提示 |
| `NotTrusted` | 有签名，但证书链不受信任（常见于自签） | 不应公开发布 |
| `HashMismatch` | 文件在签名后被改动 | 绝对不可发布 |
| `UnknownError` / `NotSupported` | 无法验证（文件损坏/非 PE/系统限制） | 不应发布 |
| `Missing` | 文件不存在 | — |

### 7.2 系统工具

```powershell
Get-AuthenticodeSignature .\PPXANS-Harness-Setup-4.0.0-x64.exe |
  Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

资源管理器 → 右键安装包 → 属性 → 数字签名，也能看到签名者与时间戳。

如果安装了 Windows SDK，还可以：

```powershell
signtool verify /pa /v .\PPXANS-Harness-Setup-4.0.0-x64.exe
```

## 8. GitHub Secrets / Variables 一览

| 名称 | 类型 | 用途 |
|---|---|---|
| `WINDOWS_CSC_LINK` | Secret | PFX 文件路径/URL/base64；映射到 `CSC_LINK` |
| `WINDOWS_CSC_KEY_PASSWORD` | Secret | PFX 密码；映射到 `CSC_KEY_PASSWORD` |
| `AZURE_TENANT_ID` | Secret | Azure Artifact Signing 的 Entra 租户 |
| `AZURE_CLIENT_ID` | Secret | Entra 应用 ID |
| `AZURE_CLIENT_SECRET` | Secret | Entra 应用凭据 |
| `SIGNPATH_API_TOKEN` | Secret | SignPath REST API token |
| `SIGNPATH_ORGANIZATION_ID` | Variable | SignPath 组织 ID |
| `SIGNPATH_PROJECT_SLUG` | Variable | SignPath 项目 slug |
| `SIGNPATH_SIGNING_POLICY_SLUG` | Variable | SignPath 签名策略 slug |
| `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` | Variable | SignPath 产物配置 slug |
| `REQUIRE_SIGNED_RELEASE` | Variable | `true` 时未签名/无效签名会让发布失败 |

`SIGNATURE-STATUS.txt` 会随 Release 一起上传，用户可以直接看到该版本是否签名、
签名者是谁。

## 9. 证书到期与轮换

- 证书/服务到期前更新 secret，重新打 tag 发布即可；
- 已发布版本只要带可信时间戳，证书过期后签名仍然有效；
- 私钥泄露时立即吊销证书，并发布安全公告；不要尝试“重新签同一个文件”掩盖；
- 建议在日历里提前 30 天提醒续签；
- 不要在多个项目间共用同一个 PFX；SignPath/Azure 的身份绑定更容易管理。

## 10. 安全底线

- 绝不把 `.pfx`、密码、API token 提交到仓库或放进构建产物；
- 只在 CI 的 secret 中使用私钥，构建日志里不要打印；
- 限制谁可以触发 release workflow（tag 保护、环境审批）；
- 签名前先跑 `npm run gate:release`，避免把有问题的构建签出去；
- 签名只证明“这个二进制来自这个发布者/仓库”，不证明代码没有漏洞。

## 11. 常见问题

**Q：我现在一张证书都没有，最现实的做法是什么？**

A：先保持未签名发布，附 `SHA256SUMS.txt` 与源码；同时申请 SignPath Foundation。
如果项目知名度不够、申请不确定，且有预算/身份材料，直接买 OV 证书更可控。
不要用自签证书发布。

**Q：签名后 SmartScreen 还会提示吗？**

A：可能。新发布者需要积累信誉；持续用同一身份签名，后续版本会逐步好转。
EV 也不再保证立即放行。

**Q：为什么安装后的 `PPXANS-Harness.exe` 还是未签名？**

A：PFX/Azure 路线下 electron-builder 会同时签应用 exe 和安装包；如果只用
SignPath 对最终安装包做后签名，内层 exe 不会自动被签。需要内外都签时，
优先 PFX/Azure，或为 SignPath 增加自定义签名钩子。

**Q：可以买很便宜的“代码签名证书”吗？**

A：不建议。来路不明的证书可能被盗用、被吊销，甚至本身不受信任；私钥也可能
已经泄露。只从受信任 CA 或其授权渠道购买。

## 12. 参考

- [SignPath Foundation](https://signpath.org/)
- [SignPath Foundation 申请条件](https://signpath.org/terms.html)
- [SignPath GitHub Action](https://github.com/SignPath/github-action-submit-signing-request)
- [Microsoft：Windows 应用代码签名选项](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options)
- [Azure Artifact Signing 快速入门](https://learn.microsoft.com/azure/artifact-signing/quickstart)
- [electron-builder Code Signing](https://www.electron.build/code-signing)
