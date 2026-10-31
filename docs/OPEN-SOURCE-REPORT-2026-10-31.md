# PPXANS-Harness 开源发布报告（最终轮）

> 审计对象：`PPXANS-Harness` v4.0.0（工作树，含未提交变更）
> 审计日期：2026-10-31
> 结论口径：只记录**能复现、能定位到文件行**的事实；未验证项单列。

---

## 0. 结论摘要

| 维度 | 结论 | 证据 |
|---|---|---|
| 模块代码与测试 | ✅ 通过 | `verify` 14/14；1887 项测试 0 失败（4 项网络用例按设计跳过）；lint 0 error |
| 模型 API 密钥去除 | ✅ 通过 | 源码 / 测试 / Git 历史中未发现真实模型 API Key；密钥全部走环境变量或占位符；测试离线可跑 |
| 许可证（本项目） | ✅ 合规 | Apache-2.0 + `LICENSE` + `NOTICE` |
| 第三方运行时许可 | ✅ 合规 | Electron / Chromium / Node 许可文件随安装包分发并有 `THIRD-PARTY-NOTICES.md` |
| 内置第三方技能许可 | ✅ 已消除 | 4 个 office 技能已重写为仓库内自研实现（Apache-2.0），仓库中不再保留 Anthropic 专有许可文件 |
| 第三方技能署名 | ✅ 已修复 | `THIRD-PARTY-NOTICES.md` 已覆盖 24 个导入技能 + 4 个自研 office 技能 + 字体 |
| 文档一致性 | ✅ 已修复 | `SECURITY.md`、`README.md`、`SIGNING.md`、`THIRD-PARTY-SOURCES.md` 及 3 篇历史报告中的本机路径已修订 |
| 发布链路 | ✅ 可用（未签名） | Release 工作流 + SHA256SUMS + 签名校验脚本；当前安装包未签名，README 已声明 |

**总判定：源码与随包内容已无已知许可阻断项，可以按 Apache-2.0 公开。仍未签名，属发布说明层面的事实披露。**

---

## 1. 核查方法与命令

| 项 | 命令 / 方法 |
|---|---|
| 依赖与架构 | `npm run verify`（14 道门禁） |
| 全量测试 | `npm test`（`node --test test/*.test.js`） |
| 静态检查 | `npm run lint` |
| 密钥扫描（工作树） | `git ls-files -z \| xargs -0 grep -nE "<key 正则>"` |
| 密钥扫描（历史） | `git log --all -p -- . ':(exclude)CHANGELOG.md' \| grep -nE "^\+.*<key 正则>"` |
| 敏感文件追踪 | `git log --all -- config/ppx.json data/ .ppx/ .env` |
| 第三方许可 | 逐个检查 `skills/**/LICENSE*`、`NOTICE`、`THIRD-PARTY-NOTICES.md`、`skills/upstream-sources.json` |

扫描正则覆盖：`sk-[A-Za-z0-9]{10,}`、`ghp_*`、`github_pat_*`、`AKIA*`、`xox[baprs]-*`、`AIza*`、JWT、PEM 私钥、`Authorization: Bearer <literal>`、私网地址。

**方法边界**：这是正则 + 人工复核，不是全量熵值扫描；结论对"常见密钥形态"有效，对非常规编码的凭据不保证。

---

## 2. 模块代码与测试健康度

| 指标 | 结果 |
|---|---|
| `npm run verify` | **14/14 通过**（依赖完整性、架构守卫、README 数字同步、宣称闸门、Web 静态检查、审计链、自愈基准、技能格式、缓存前缀、上下文预算、本地评测、离线任务基准、记忆召回、静默 catch 守卫） |
| `npm test` | **1887 项 / 1883 通过 / 0 失败 / 4 跳过**，`duration 38.8s` |
| 跳过项 | 全部为网络用例，受 `PPX_NET_TEST=1` 门控（`test/advanced.tools.test.js`、`test/fetch-page.test.js`、`test/health.test.js`） |
| `npm run lint` | **0 error / 53 warning**（均为既有未使用变量类告警） |
| 运行时依赖 | **0**（`package.json` 无 `dependencies`；devDependencies 仅 electron / electron-builder / eslint / globals） |
| 规模 | 追踪文件 846；`src/` 184 个 JS ≈ 3.8 万行；`test/` 233 文件 ≈ 3.1 万行；`public/` ≈ 6.2k 行；技能文档 130 篇 |

### 工作树状态备注

- 当前有 **96 个文件修改 + 54 个未追踪 + 67 个删除**，全部未提交；本轮验证即基于该工作树。
- 删除的 5 个 `index.js`（`src/{edit,evolve,llm,selfheal,session}/index.js`）是 barrel 出口。已在 `src/ bin/ scripts/ test/ electron/ skills/` 全量搜索，**没有任何 import 引用它们**，删除后测试与 verify 全绿。
- 新增的 54 个未追踪文件中，4 个是 `skills/office/*/scripts/*_tool.py`（本轮自研实现）；其余为此前轮次遗留的新模块、测试与发布文件。
- `docs/完整评估修复报告-2026-10-09.md:57` 记录过 `src/edit/index.js` 曾因 re-export 不存在的符号而崩溃 —— 删除与既有记录一致，不构成回归。
- **发布前必须先提交**：否则 GitHub Release 的 tag 与工作树内容不一致。

---

## 3. 模型 API 密钥去除核查（本轮重点）

### 3.1 源码 `src/`

| 检查点 | 结果 | 证据 |
|---|---|---|
| 硬编码 `api_key` 字面量 | 无 | 唯一命中是 `src/tools/advanced.js:23` 的 `process.env.TAVILY_API_KEY`，只把 key 放进请求体，未落库 |
| 认证头 | 全部从运行期配置取值 | `src/llm/client.js:197,277`、`src/channels/feishu.js:193`、`src/cli-doctor.js:74` 均为 `Bearer ${this.apiKey}` / `${token}` / `${key}` |
| 提供方预设 | 只有公开 `base_url` + 环境变量名 | `src/llm/presets.js:16-62`，本地 LM Studio / Ollama 条目 `api_key_env: null` |
| 配置默认值 | 不内置任何密钥 | `src/config/index.js` 的 `DEFAULT_CONFIG.providers = []` |

### 3.2 配置文件

| 文件 | 状态 |
|---|---|
| `config/ppx.json`（本机真实配置） | **未入库**：`.gitignore:2` 明确排除；当前内容使用 `api_key_env: "ZHIPU_API_KEY"`，无明文 key |
| `config/ppx.json.example` | 云端提供方全部 `api_key_env: "XXX_API_KEY"`；LM Studio 用约定俗成的假 key `"lm-studio"`（`config/ppx.json.example:78,109`） |
| `data/`、`.ppx/`、`uploads/`、`.env` | 均被 `.gitignore` 排除 |
| `package.json.files` | 只打包 `config/ppx.json.example`；`.npmignore` 为第二道防线；另有 `scripts/package-scan.js` 阻断密钥/配置进入安装包 |

### 3.3 测试

| 检查点 | 结果 |
|---|---|
| 是否需要真实模型 key | **不需要**。`npm test` 无任何环境变量即可全绿 |
| 测试里的 key 字面量 | 全部是显式假值：`sk-main-test-123`、`sk-cheap-test-123`、`sk-1234567890abcdef`、`sk-test`、`lm-studio` 等 |
| 真实端点引用 | 仅 `test/health.test.js:9,15` 写了 `https://api.openai.com/v1`，但用例受 `PPX_NET_TEST=1` 门控，默认跳过、不发请求 |
| 网络用例 | 4 项，全部按环境变量门控跳过 |

### 3.4 Git 历史

| 检查点 | 结果 |
|---|---|
| `config/ppx.json` 是否被提交过 | **是**（`79e7a22`、`51ba4e2`），但历史内容只有 `"lm-studio"` 假 key 与空 `appSecret/token/encodingAESKey/corpSecret`；`a839f9a` 已删除该文件 |
| `data/`、`.ppx/`、`.env` | **从未提交** |
| 历史新增行中的真实密钥形态 | 未发现；命中的全是 PII 脱敏测试用的假 key |

### 3.5 残余项（非密钥，仅记录）

1. `scripts/eval.js:110`、`scripts/e2e-response-smoke.js:20-21`、`scripts/memory-benchmark.js:68`、`scripts/toolcall-smoke.js:13` 把本地 LM Studio 地址 `http://127.0.0.1:1234/v1` 和假 key `"lm-studio"` 写死在兜底分支。**不是秘密**，但建议改成读环境变量，避免用户误以为项目绑定了某个本地端口。
2. `test/health.test.js` 使用真实厂商域名但默认不联网；保留无风险，若担心误解可改成 `https://example.invalid/v1`。

**本节结论：模型 API 已按开源要求去除干净 —— 代码、配置模板、测试、Git 历史四个层面都没有可用的真实密钥；运行期密钥只从环境变量/本机配置读取。**

---

## 4. 许可证与第三方合规

### 4.1 本项目

- `LICENSE`：Apache-2.0，全文完整。
- `NOTICE`：版权人 `chen6896qqwee`，声明 Electron / Chromium / Node 再分发要求。
- `package.json` 的 `license`、`author`、`repository`、`homepage`、`bugs` 字段齐全。

### 4.2 随安装包分发的运行时

| 组件 | 许可 | 文件 | 状态 |
|---|---|---|---|
| Electron 45.x | MIT | 安装目录 `LICENSE.electron.txt` | ✅ |
| Chromium + 内置组件 | BSD 系等 | 安装目录 `LICENSES.chromium.html` | ✅ |
| Node.js 22.14.0（便携包） | MIT | `runtime/LICENSE.node.txt` | ✅ |

`docs/PACKAGING.md:17,85` 已把"再分发必须保留许可文件"写成发布约束。

### 4.3 内置技能许可

`skills/upstream-sources.json` 登记了 24 个从上游导入的技能；另有 4 个 office 技能为仓库内自研。

| 分组 | 数量 | 许可文件 | 结论 |
|---|---|---|---|
| Anthropic 技能（Apache 版） | 13 | `LICENSE.txt` = Apache-2.0（`md5 0ee6429f`，另 `frontend-design` 为 `2ee41112` 同为 Apache） | ✅ 可再分发，需保留许可与署名 |
| **office 技能**（`skills/office/{docx,pdf,pptx,xlsx}`） | **4** | 仓库内自研，无上游 `LICENSE.txt` | ✅ 按本项目 Apache-2.0 分发 |
| Anthropic `doc-coauthoring` | 1 | 未随技能复制 | ⚠️ 已在 NOTICE 标注，需核对上游 |
| addyosmani / superpowers 技能 | 10 | **无 LICENSE 文件** | ✅ 已在 `THIRD-PARTY-NOTICES.md` 统一署名并附 MIT 全文 |

**P0 根因与处置**：原 `skills/office/{docx,pdf,pptx,xlsx}/LICENSE.txt`（`md5 f8515c36`）为 Anthropic 专有条款（`ADDITIONAL RESTRICTIONS`：不得复制、不得创作衍生作品、不得向第三方分发），与本仓库的 Apache-2.0 分发直接冲突。本轮已把 4 个技能**从头改写为自研实现**并删除全部上游文件：

- `SKILL.md` 为中文新写，`scripts/*.py` 仅依赖 Python 标准库；
- 技能 id 与目录名保持不变（`office/docx` 等），技能总数仍为 67，不影响 README 机读锚点；
- 4 个技能均通过 `src/skills/lint.js` 格式门禁（`upstream: false`、无 warning）。

登记口径同步：`skills/upstream-sources.json` 中 `anthropics` 的 `license` 改为 `Apache-2.0 (13 skills) / missing (doc-coauthoring)`、`imported` 由 18 降为 14，`known_skills` 移除 `docx/pdf/pptx/xlsx`。

**重写验证**：

| 技能 | 冒烟路径 | 结果 |
|---|---|---|
| docx | `create`（Markdown→docx）→ `read` → `replace`（run 内 + 跨 run 折叠）→ `validate` | 正文/标题/列表/表格/粗斜体正确回读；替换命中；`ok: true` |
| xlsx | CSV（公式/前导零/中文/引号逗号）→ `read` / `--formulas` / `--json` → `validate` | 单元格类型与公式正确；openpyxl 可加载；`ok: true` |
| pptx | 5 页大纲 → `create` → `read --labels` → `validate` | python-pptx 可加载（5 页 / 17 形状 / 16:9）；`ok: true` |
| pdf | 文本型 / CJK / 加密 / 扫描件四类样例 → `info` / `text` / `validate` | 加密与扫描件识别正确；CJK 无 ToUnicode 时给出乱码提示；`ok: true` |

4 个技能均通过 `src/skills/lint.js`（`fail 0`、`upstream: false`），`npm run verify` 的"技能格式检查"通过。**本机无 LibreOffice / Microsoft Office，docx / pptx 未做渲染级视觉核对**——这是已知的验证边界，不是通过项。

`THIRD-PARTY-NOTICES.md` 原先只覆盖 Electron / Chromium / Node / 构建工具，且写着"第三方源码未随包分发"——与 `skills/` 实际内置 24 个上游技能的事实矛盾。**本轮已补 "Bundled third-party skills" 章节**：按来源列出技能、许可与目录位置，并附 10 个 MIT 技能的版权行与许可全文；同时声明 4 个 office 技能为仓库内自研、不来自上游。

### 4.4 其它第三方资产

- `skills/content/canvas-design/canvas-fonts/`：21 份 `*-OFL.txt` 齐全，OFL 要求满足。
- `skills/` 中导入技能共 24 个，`LICENSE.txt` 覆盖率 13/24（均为 Apache-2.0）；其余 10 个 MIT 技能已在 `THIRD-PARTY-NOTICES.md` 统一署名，`doc-coauthoring` 已标注待核对上游。4 个 office 技能为自研，不涉第三方许可。

---

## 5. 文档一致性问题（P1，已全部修复）

| 文件 | 问题 | 位置 | 状态 |
|---|---|---|---|
| `SECURITY.md` | 正文混入 `<u>` HTML 标签，渲染后下划线错位 | `SECURITY.md:15-18` | ✅ 已清除 |
| `SECURITY.md` | 支持版本表停在 `3.x`，当前已是 4.0.0 | `SECURITY.md:10` | ✅ 改为 4.x / 3.x 仅安全修复 |
| `README.md` | 粗体标记断在单词中间：`Wind**ows`、`Foundatio**n` | `README.md:38,40` | ✅ 已修正 |
| `references/THIRD-PARTY-SOURCES.md` | 仍描述 `backend: "deepseek"` / `dsh` 可选底座（v2.5.0 已移除，`src/llm/client.js:6` 有明确记录） | 第 2 节 | ✅ 改写为"未接入，仅吸收设计" |
| `references/THIRD-PARTY-SOURCES.md` | 含本机个人路径（`C:\Users\<用户名>\...`），公开仓库不应出现 | 第 3 行 | ✅ 已移除 |
| `docs/SIGNING.md` | 全文按 3.5.0 描述，未随 4.0.0 更新 | 多处 | ✅ 已更新到 4.0.0 |
| 其他历史报告 | `AUDIT-2026-09-17.md`、`EVALUATION-2026-10-07-DAWN-agent-report.md`、`完整评估修复报告-2026-10-09.md` 含本机绝对路径 | — | ✅ 已改为仓库相对描述 |
| Git 提交信息 | 中文提交信息为 GBK 乱码（`git log` 显示 `����`），公开仓库观感差 | 多个提交 | ⏳ 历史提交未改写（P2） |

---

## 6. 发布链路

| 能力 | 状态 | 证据 |
|---|---|---|
| 一键构建安装包 | ✅ | `npm run desktop:pack` → `dist-desktop/PPXANS-Harness-Setup-<版本>-x64.exe` + `SHA256SUMS.txt` |
| 打包内容白名单 | ✅ | `package.json.files` + `.npmignore` + `scripts/package-scan.js` |
| Release 工作流 | ✅ | `.github/workflows/release.yml`：tag 与版本号校验 → `gate:release` → 构建 → 校验和 → GitHub Release |
| CI | ✅ | `ci.yml` / `lint.yml` / `nightly.yml`；LLM E2E 仅在 `secrets.PPX_E2E_*` 存在时运行 |
| 签名 | ⚠️ 未签名 | `docs/SIGNING.md` 已说明原因；`scripts/verify-signature.js` 与 `SIGNATURE-STATUS.txt` 已就位 |
| 社区文件 | ✅ | `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、Issue 模板（含私密漏洞入口） |

---

## 7. 问题清单

### P0 — 发布前必须处理（已消除）

1. ✅ **4 个 Anthropic 专有许可技能**（`skills/office/{docx,pdf,pptx,xlsx}`）已重写为仓库内自研实现（Apache-2.0），上游 `LICENSE.txt` 与全部上游脚本已删除；技能 id、目录名与总数保持不变。仓库与安装包中不再包含 Anthropic 专有许可材料。

### P1 — 发布前建议处理（本轮已修复 2–8，9 待用户执行）

2. ✅ `THIRD-PARTY-NOTICES.md` 增补"Bundled third-party skills"章节（24 个导入技能 + 4 个自研 office 技能 + 字体）。
3. ✅ 10 个 MIT 技能统一在 NOTICE 署名，并附版权行与 MIT 全文（addyosmani / obra）。
4. ✅ 修正 `skills/upstream-sources.json` 的许可登记（按技能分组记录，移除 4 个已自研的技能）。
5. ✅ 修复 `SECURITY.md` 的 `<u>` 污染与版本表；修复 `README.md` 的粗体断裂。
6. ✅ 更新 `references/THIRD-PARTY-SOURCES.md`：dsh 改为"未接入，仅吸收设计"，删除本机路径。
7. ✅ 更新 `docs/SIGNING.md` 到 4.0.0。
8. ✅ 额外清理 3 篇历史报告中的本机绝对路径。
9. ⏳ 提交当前工作树后再打 tag —— 需用户执行。

### P2 — 可选

10. ✅ 已修：`scripts/e2e-response-smoke.js` / `eval.js` / `memory-benchmark.js` / `toolcall-smoke.js` 的本地兜底改为读 `PPX_LOCAL_BASE_URL` / `PPX_LOCAL_API_KEY`（默认值不变）。
11. 后续提交信息统一用 UTF-8，避免公开仓库乱码。
12. 安装包签名（需 CA 证书，当前不阻塞发布）。

### 审计后补修（同日）

- **FactStore 磁盘签名**（`src/memory/fact-store.js` + 技能副本）：`mtimeNs:size` 在 Windows 约 16ms 的时间戳粒度内会漏判外部/回溯写入（实测 2/10 误判，`fact-tombstone-purge` 随机失败）。现签名并入 inode（应用写入走 rename，必换 inode），原地手改由「戳未落定就重读」兜住；30 轮复现 0 失败。
- **记忆召回探针**（`scripts/memory-recall.js`）：语料中的个人绝对路径改为中性路径，holdout recall@3 仍 100%。
- **文档**：`ARCHITECTURE-CURRENT.md` 版本口径、`PROJECT-OVERVIEW.md` src 文件数（194→189）、`web-launch.md` 失效截图与时效说明；`docs/WIKI.md` 重新生成（并让 repomap 忽略 `.ppx` / `uploads` / `dist-desktop`，防止本地草稿进入生成文档）。

---

## 8. 发布前检查清单

- [x] 4 个 office 技能已重写为自研实现，Anthropic 专有许可文件已删除（P0 已消除）
- [x] `THIRD-PARTY-NOTICES.md` 覆盖内置技能与字体
- [x] `SECURITY.md` / `README.md` / `SIGNING.md` / `THIRD-PARTY-SOURCES.md` 修订
- [x] `npm run verify` 14/14
- [x] `npm test` 1887 项 / 1883 通过 / 0 失败 / 4 跳过
- [x] `npm run lint` 0 error（53 warning 为既有未使用变量）
- [x] `npm run gate:release` 通过
- [ ] 工作树已提交，tag 与 `package.json` 版本一致
- [ ] `dist-desktop/SHA256SUMS.txt` 与产物同批生成
- [ ] Release 说明中注明"未签名"与 SmartScreen 预期

---

## 9. 复现

```bash
cd PPXANS-Harness
npm run verify                 # 14/14
npm test                       # 1887 / 1883 / 0 / 4
npm run lint                   # 0 error
git ls-files -z | xargs -0 grep -nE "sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}"
git log --all --oneline -- config/ppx.json data/ .ppx/ .env
find skills -name "LICENSE*" -exec md5sum {} \;
```
