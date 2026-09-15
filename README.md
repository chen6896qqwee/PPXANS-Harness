# 🦐 PPXANS-Harness

> **PPXANS-Harness = 皮皮虾神经系 (ANS) + Harness 一体化智能体内核**，纯 Node.js 编写，**零运行时依赖**。
> 43 内置工具 · L0–L4 五层记忆 · SHA-256 审计哈希链 · MCP 客户端 · 多模型路由 · 自愈 7/7 · 597 测试。
>
> 由 `ppx-agent v1.6.0`（合并基座）+ `ppx-v2 v0.4.0`（能力吸收）合并而成。合并范围与取舍见 [MERGE-REPORT.md](MERGE-REPORT.md)、第三方来源见 [references/THIRD-PARTY-SOURCES.md](references/THIRD-PARTY-SOURCES.md)。

> 🛡️ **自愈基准**：故意注入破坏 -> 自愈引擎修复 -> 输出修复率。
> 跑 `node scripts/selfheal-bench.js` -> **7/7 100%**（发布前门禁，`PPX_MIN_SELFHEAL` 可设阈值）。
>
> 🔗 **审计哈希链**：工具调用落 append-only + SHA-256 链式账本，篡改可定位到具体行。
> 跑 `npm run audit:verify` 校验，`npm run audit:verify -- --fix` 隔离损坏段并重建。

**一个会自我修复、自我学习、可审计的超级 Agent。** 零运行时依赖，纯 Node 原生，支持各大模型 API + 本地模型。

> 架构参考 openhanako/HanaAgent 与 TencentDB-Agent-Memory，扒其记忆分层、自愈内核、工具系统的精华，用干净自包含实现重搭。
>
> 👉 **新手上路**：5 分钟跑起来、写第一个工具/插件、替换默认模块，见 [docs/QUICKSTART.md](docs/QUICKSTART.md)。

## ✨ 特性

| 能力 | 说明 |
|------|------|
| 🧠 **五层记忆 L0–L4** | L0原始对话 → L1原子记忆(高斯衰减) → L2场景 → L3核心画像 → **L4程序性记忆**(技能/流程, 衰减仅为 L1 的 1/4) |
| 🗂️ **记忆治理** | **软删可回滚**(forget/restore) + 版本链(update 留痕) + TTL 自动归档 + 按层清理 + 导出/导入迁移; 遗忘不再不可逆 |
| 🔐 **审计哈希链** | 工具调用 append-only 账本 + SHA-256 链式防篡改, 篡改/删行可定位到具体行, 支持隔离损坏段重建 |
| 🔧 **43个内置工具** | 文件/命令/搜索/HTTP/定时/记忆检索/读图/文档加载/文档入库/OCR/code_act/refine/refine_skill + **10个治理运维工具**(memory_forget/restore/export/import/clear_layer/list_deleted、audit_verify、persona_build/read、selfheal_run) |
| 🩺 **自我修复** | 启动体检、损坏JSON自动修复、崩溃恢复、残留清理 |
| 📚 **自我学习** | 经验库 + 自动提炼用户画像/agent人格 + refine 失败轨迹闭环 + refineSkill 成功轨迹沉淀技能 |
| 🤖 **多 Agent 军团** | 多进程并行 + DAG 编排 + legion 模式 (broadcast/dispatch/runDag) + spawn_agent 自主协作 (并行/差异化视角/仲裁聚合/SDD 审查循环) |
| 🔌 **多渠道接入** | HTTP(可用) + 飞书(已实现) + 微信(加解密+主动推送+加密回包, 已实现) |
| 🖼️ **多模态读图** | 消息含图片路径自动读图注入 image_url 块 + 视觉路由到 vision provider (qwen-vl/gpt-4o/glm-4v 等) |
| 📄 **文档加载 + RAG** | read_document 读 txt/md/pdf/html (零依赖 PDF 提取) + ingest_document 分块入库 + 可选 embedding 向量检索 |
| 🔍 **OCR 文字识别** | ocr_image 识别图片/扫描件文字 + 扫描件 PDF 自动 OCR (本地 tesseract 零 key, 云 OCR 回退) |
| 🛡️ **防注入安全边界** | 不泄露系统提示词/人格, 忽略「忽略指令/扮演新角色」注入 |
| ⌨️ **CLI 交互** | readline 历史(↑↓) + /stop 中断 + /reset 清会话 + Ctrl+C 单次中断 |
| ✅ 上下文压缩 | 长对话自动滚动摘要, 防 token 失控 |
| ✅ 错误自愈 | 工具错误统一语义, 自动重试修正 |
| ✅ 方法型Skill | humanize去AI味 / write_article分阶段写作 / clarify需求澄清 / brainstorm审批门禁 / plan精确计划 / verify验证优先 / debug五步调试 |
| 🔌 **MCP 客户端** | 零依赖 MCP 客户端 (stdio + HTTP Streamable), 接入 9600+ MCP 工具服务器 |
| ✅ 可观测 | 工具调用轨迹JSONL + 失败率/慢工具统计 + **结构化事件流**(traceId 经 AsyncLocalStorage 贯穿) |
| ✅ LLM真摘要 | 长对话自动LLM语义摘要, 非堆叠 |
| ✅ 场景系统 | 灵魂文件式场景(手动设定/历史提炼), 命中自动切换行为 |
| ✅ Next.js产品壳 | web/ 前端代理8899内核, 聊天+会话管理+场景+记忆+轨迹+统计+工具卡片 |
| ✅ **多轮对话历史** | 会话内上下文连续, 信息量感知裁剪控 token |
| ✅ **ANS 状态化** | 生命周期落盘(重启不归零) + 主动提醒去重/完成跟踪 + 过期待办跳过 |
| ✅ **流式输出** | SSE 逐字流式, Web UI 实时渲染 (P1) |
| ✅ **命令安全** | 命令守卫三层防线: 用户 deny 规则 + 硬黑名单(rm -rf /、fork bomb、curl\|sh 等, allow_all 也拦) + 高危黑名单/前缀白名单, 反混淆检测防引号绕过 (P0) |
| ✅ **SSRF 防护** | http_request 拦截内网/保留地址 (P1) |
| ✅ **会话持久化** | 会话 JSONL 落盘, 重启不丢 (P1) |
| ✅ **测试隔离** | 所有测试用临时目录, 不污染生产数据 (P0) |
| 🔐 **HTTP 认证** | Bearer Token, 未配置自动生成随机token (P0) |
| ✅ **Markdown 渲染** | Web UI marked.js 渲染代码块/列表 (P1) |
| ✅ **OpenClaw / DeepSeek Harness 底座** | LLM 引擎通过 `openclaw agent` CLI 驱动 OpenClaw，或通过 `dsh` 后端驱动内嵌 DeepSeek Harness（`.deps/deepseek-harness`）；围栏协议代理工具，保留多 provider 回退 |
| ✅ **多模型 API 优先** | OpenAI/DeepSeek/火山/通义 + 本地模型兜底 |

## 独立底座

皮皮虾是**独立自包含的 agent**：默认用 `src/llm/router.js` 在本地/HTTP、内嵌 dsh 引擎、云端 OpenAI 兼容 API 之间自动回退（OpenAI/DeepSeek/火山/通义/本地），多 provider 自动回退 + 瞬态错误重试。

- 默认：本地/HTTP 直连优先（router 按 local → dsh 引擎 → cloud 顺序回退，配 API key 即可跑）
- **DeepSeek Harness 底座（可选，需手动安装）**：`.deps/deepseek-harness` 为**可选底座，不随仓库分发**（见 .gitignore），需先 `npm run dsh:install` + `npm run dsh:build` 才可用；`dsh` 已加入 `providers` 首位（default_id=dsh）。未安装时健康检查自动判不可用并回退 http/cloud，不受影响。
- 可选引擎：`openclaw` / `dsh` 后端代码保留（`backend: "openclaw"` / `"deepseek"`），需自行在 config 加 provider 或用环境变量 `PPX_OPENCLAW_MJS` / `PPX_DSH_ROOT` 指定引擎位置
- 保留：皮皮虾四层记忆 / 自愈 / 方法Skill / 工具 / web 壳 全部保留

### DeepSeek Harness 可选底座（dsh，需手动安装）

> `.deps/` 在 .gitignore 中，clone 后目录为空。若要用 dsh 底座，需先按下面步骤安装：

```bash
# 首次安装/构建内嵌 dsh（需要网络安装依赖）
npm run dsh:install
npm run dsh:build

# 直接运行 dsh CLI（等同 deepseek-harness 仓库的 pnpm dsh）
npm run dsh -- web
```

- 源码位置（安装后）：`.deps/deepseek-harness/`（完整保留 deepseek-harness 的 packages/apps/docs/scripts/vendor 等）
- **构建形态优先（v1.5.1+）**：`dshRoot` 存在 `lib/bin.js`（已安装的 dsh npm 包，如 `npm i -g @deepseek-ai/dsh`）时直接零构建运行；否则回退源码形态（`apps/cli/src/bin.ts` + `node_modules/tsx`）
- 定位优先级：`PPX_DSH_ROOT` 环境变量 > provider 的 `dsh_root` 配置 > 内嵌 `.deps/deepseek-harness` 默认目录
- 未安装/构建 dsh 时，健康检查判不可用并自动回退 http/cloud，不受影响

## 🚀 快速开始

### ⚠️ 首次使用：本地模型优先，云端可选（极简配置）

皮皮虾**默认优先使用本地模型**（LM Studio 等本地推理，需先启动本地服务）。配了**至少一个**云端 API key 时自动云端优先；无任意可用模型（既无云端 key 也未运行本地服务）时对话不可用（见启动提示）。云端/本地自由接入，互不冲突。

按需选一个厂商，把 key 设为环境变量（Windows 用 `setx`，Linux/macOS 用 `export`）：

```bash
# OpenAI / 任意 OpenAI 兼容端点
setx OPENAI_API_KEY "sk-..."

# 深度求索 DeepSeek
setx DEEPSEEK_API_KEY "sk-..."

# 火山方舟（需同时把 config/ppx.json 的 volcengine.model 改成你的 endpoint 模型名）
setx VOLCENGINE_API_KEY "..."

# 通义千问 DashScope（含 qwen-turbo 文本 + qwen-vl-max 视觉）
setx DASHSCOPE_API_KEY "sk-..."
```

重开终端生效，然后直接 `ppx` 开聊。配了云端 key 就**云端优先**（按 providers 云段顺序），没配任何云端 key 就**回落本地推理**（需本地模型服务在运行）：
- 无云端 key + 本地 LM Studio 未启动 → 对话不可用（启动时会有明确提示）
- 双击 `双击启动皮皮虾-服务.bat` 会强制本地 lmstudio 模式。
路由逻辑见 docs/ARCHITECTURE-ORGANISM.md 模型接入节。

> 本地模型（LM Studio）离线/私有场景直接用，**前提是本地服务已启动**；要更高质量答案可再配云端 key 自动升级。云端/本地自由接入，互不冲突。
### 全局安装 (npm)

直接从 npm 安装，即可使用命令行工具：

```bash
npm i -g ppxans-harness

ppx           # 启动对话 CLI (别名 ppxans)
ppx-serve     # 启动 HTTP 服务
ppx-channels  # 通道 CLI
```

### 本地开发

```bash
# 1. 配置模型 (config/ppx.json)
#    设置环境变量: OPENAI_API_KEY / DEEPSEEK_API_KEY / VOLCENGINE_API_KEY ...

# 2. 启动自愈体检
# 3. 启动产品壳 (Next.js, 需先启动内核): cd web && npm run dev # http://localhost:3000
npm run selfheal

# 3. 启动对话 (CLI)
npm run chat

# 4. 启动 HTTP 服务
node src/server.js   # http://127.0.0.1:8899

# 5. 跑测试
npm run test
```

## 🧪 评测与 CI

- **本地能力评测**: `npm run eval` — 零依赖跑问候/时间/记忆/生命周期等 7 项 (无需 LLM)
- **LLM 端到端评测**: `npm run eval -- --llm` — 加跑真实 LLM 问答/工具调用回归, provider 三选一:
  - `--provider <id>`: 用 config/ppx.json 里指定的 provider
  - `PPX_E2E_BASE_URL` + `PPX_E2E_API_KEY` + `PPX_E2E_MODEL` 环境变量
  - 默认探活本地 LM Studio (http://127.0.0.1:1234)
- **GitHub Actions CI**: push/PR 自动跑全量测试 + web 类型检查/构建 + 本地评测。要启用 LLM 回归, 在仓库 Settings → Secrets 配置三个变量 (均需配置才触发):
  - `PPX_E2E_BASE_URL` (OpenAI 兼容端点, 如 `https://api.deepseek.com/v1`)
  - `PPX_E2E_API_KEY`
  - `PPX_E2E_MODEL` (如 `deepseek-chat`)
- **压测**: `npm run bench` — 并发/长会话吞吐基线


## 🔌 模型接入 (云端 API 优先, 本地模型兜底)

皮皮虾支持任意 **OpenAI 兼容端点**, 自动多 provider 回退:

```json
{
  "providers": [
    { "id": "openai",     "base_url": "https://api.openai.com/v1",              "api_key_env": "OPENAI_API_KEY",     "model": "gpt-4o-mini" },
    { "id": "deepseek",   "base_url": "https://api.deepseek.com/v1",             "api_key_env": "DEEPSEEK_API_KEY",   "model": "deepseek-chat" },
    { "id": "volcengine", "base_url": "https://ark.cn-beijing.volces.com/api/v3", "api_key_env": "VOLCENGINE_API_KEY", "model": "<你的endpoint>" },
    { "id": "dashscope",  "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "api_key_env": "DASHSCOPE_API_KEY", "model": "qwen-turbo" }
  ]
}
```

**回退机制**: 路由层 (router.js) 负责选主模型, 运行时 (agent) 负责失败切换——选中 provider 连不上自动切下一个, 直到成功。本地 LM Studio 示例:

```json
{ "id": "lmstudio", "base_url": "http://127.0.0.1:1234/v1", "api_key": "lm-studio", "model": "gemma-4-e2b" }
```

## 🧠 记忆架构 (L0 → L4)

```
对话 → L0 原始对话(session 事件日志) → L1 原子记忆(高斯衰减) → L2 场景(关键词聚类) → L3 画像(persona)
                                                                                  ↘ L4 程序性记忆(技能/流程, 慢衰减)
```

- **L0**: 对话原文由会话事件日志 `data/sessions/*.jsonl` 全量承载; 每日滚动压缩视图由 MemoryTicker 产出到 `data/memory/daily/` + `longterm.md`, 过滤噪音
- **L1**: `facts.json`, score = score × exp(-λt²), 命中加分（λ = `decay_per_day`，默认 0.02）
- **L2**: `scenes.json`, 相关记忆聚类成场景
- **L3**: `user.persona.md` + `agent.persona.md`, 从记忆提炼画像
- **L4**: 程序性记忆（技能/流程/方法论），与 L1 同库以 `layer: 4` 标记；衰减率固定为 `0.005`，仅为 L1 的 1/4 —— 技能应当长期留存，不该像闲聊事实一样快速遗忘

### 记忆治理（可回滚的遗忘）

原版的遗忘是**不可逆硬删**。现在引入治理语义，误删不再无法挽回：

| 能力 | 工具 | 说明 |
|---|---|---|
| 软删 | `memory_forget` | 标记 `status='deleted'`，数据保留，检索立即可见性消失 |
| 回滚 | `memory_restore` | 恢复软删记忆，恢复即视作一次访问（避免恢复后被立刻衰减清空） |
| 复核 | `memory_list_deleted` | 列出已遗忘条目（含原因与时间），防误删无人发现 |
| 版本链 | `update()` | 更新保留旧版为 `archived` + `prevId` 链接，记忆演化可追溯 |
| TTL 归档 | `sweepExpired()` | 超 `memory_ttl_days`（默认 90 天）未访问则软归档，支持 `dryRun` 预演 |
| 按层清理 | `memory_clear_layer` | 清 L1 或 L4，默认软删，`hard=true` 才物理删除 |
| 迁移 | `memory_export` / `memory_import` | 导出含软删/归档条目；导入 `merge` 按内容去重、`replace` 整体替换 |

> 容量保护仍是硬删（`fact-store._prune` 超 `max_facts` 裁剪最弱项）——治理管"想忘的"，`_prune` 管"装不下的"，两者分工不重叠。

## 🔐 审计哈希链

工具调用落 `data/logs/audit.ndjson`，每条带 `prevHash` 串成 SHA-256 链：

- **append-only**：只追加，不改历史行
- **防篡改**：改动任意一行会导致后续所有行校验失败，`verify()` 精确报出首个断裂行号
- **参数脱敏**：落盘前掩码 `sk-*` / `Bearer` / `api_key` / URL query 凭证（`?token=` 等）/ 手机号
- **可隔离**：链损坏时 `quarantineBroken()` 备份损坏段、重建空链并记录隔离事件（自愈语义）

```bash
npm run audit:verify              # 校验链完整性
npm run audit:verify -- --fix     # 损坏则隔离并重建
npm run audit:verify -- --tail 20 # 附带最近 20 条
```

`config.audit.enabled: false` 可关闭（性能敏感场景）。未启用时工具调用路径零开销。

## 🩺 自我修复

- 启动体检: 补建缺失目录 / 修复损坏JSON(备份后重建)
- 崩溃恢复: 检测异常退出, 清理残留临时文件
- 数据一致性: integrity 标记, 干净退出/异常退出可感知

## 📂 目录结构

```
PPXANS-Harness/
├── config/         配置 (ppx.json + identity/ishiki 人格)
├── src/
│   ├── agent/      Agent 引擎 (编排 + 工具循环 + 多模型回退)
│   ├── core/       核心纯逻辑 (policy 工具循环策略 / trace 事件流 traceId 贯穿)
│   ├── services/   业务服务 (memory-service 记忆协调 / learning-service 自我学习)
│   ├── memory/     五层记忆 (L0-L4) + 会话事件日志 + 经验库 + 压缩层
│   ├── audit/      verifier 语义验证闸门 + audit-chain 防篡改哈希链
│   ├── ans/        ANS 神经系 (values/lifecycle/proactive/reward/eviction/guard)
│   ├── selfheal/   自愈引擎
│   ├── tools/      工具系统 (43个 + MCP 动态注册; governance.js 为治理工具)
│   ├── channels/   通道 (http/feishu/wechat)
│   ├── orchestrator/ 军团编排器 (多进程)
│   ├── llm/        LLM 客户端
│   └── utils/      基础设施
├── data/           运行时数据 (不进 git)
├── references/     第三方项目来源登记 (不含源码)
├── test/           测试 (597 项 591 过 0 失败 6 跳过)
└── docs/           文档
```

## 📄 License

Apache License 2.0

## 🙏 架构来源

- [openhanako (HanaAgent)](https://github.com/liliMozi/openhanako) — 记忆分层、自愈内核、人格系统
- [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) — L0-L3 四层记忆架构
- [OpenClaw](https://openclaw.ai) — agent 运行时组织
- **ppx-v2 (ppx Harness)** — 审计哈希链、记忆治理（软删/回滚/版本链/TTL）、L4 程序性记忆、10 个治理工具
- [openai/codex](https://github.com/openai/codex)、[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — 仅作架构参考，源码未纳入，见 [references/THIRD-PARTY-SOURCES.md](references/THIRD-PARTY-SOURCES.md)