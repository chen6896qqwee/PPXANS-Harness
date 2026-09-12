# 🦐 皮皮虾 (PPX Agent) 测试版

> 🛡️ **自愈基准**：故意注入破坏 -> 自愈引擎修复 -> 输出修复率。
> 跑 `node scripts/selfheal-bench.js` -> **7/7 100%**（发布前门禁，`PPX_MIN_SELFHEAL` 可设阈值）。

**一个会自我修复、自我学习的超级 Agent。** 零运行时依赖，纯 Node 原生，支持各大模型 API + 本地模型。

> 架构参考 openhanako/HanaAgent 与 TencentDB-Agent-Memory，扒其记忆分层、自愈内核、工具系统的精华，用干净自包含实现重搭。

> 👉 **新手上路**：5 分钟跑起来、写第一个工具/插件、替换默认模块，见 [docs/QUICKSTART.md](docs/QUICKSTART.md)。

## ✨ 特性

| 能力 | 说明 |
|------|------|
| 🧠 **腾讯式四层记忆** | L0原始对话 → L1原子记忆(高斯衰减) → L2场景 → L3核心画像 |
| 🔧 **33个内置工具** | 文件/命令/搜索/HTTP/定时/记忆检索/读图(多模态)/文档加载/文档入库/OCR/code_act(可选)/refine(失败→经验)/refine_skill(成功→技能) |
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
| ✅ 可观测 | 工具调用轨迹JSONL + 失败率/慢工具统计 |
| ✅ LLM真摘要 | 长对话自动LLM语义摘要, 非堆叠 |
| ✅ 场景系统 | 灵魂文件式场景(手动设定/历史提炼), 命中自动切换行为 |
| ✅ Next.js产品壳 | web/ 前端代理8899内核, 聊天+会话管理+场景+记忆+轨迹+统计+工具卡片 |
| ✅ **多轮对话历史** | 会话内上下文连续, 信息量感知裁剪控 token |
| ✅ **ANS 状态化** | 生命周期落盘(重启不归零) + 主动提醒去重/完成跟踪 + 过期待办跳过 (v1.0.7) |
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
- **DeepSeek Harness 底座（已内嵌源码）**：`deepseek-harness` 全部架构与源码已吸收到 `.deps/deepseek-harness`，且 `dsh` 已加入 `providers` 首位（default_id=dsh）；`dsh` 后端会自动定位该目录，无需再设 `PPX_DSH_ROOT`。未安装 dsh 依赖时健康检查会把它判为不可用并自动回退 http/cloud；安装后即作为底座生效。
- 可选引擎：`openclaw` / `dsh` 后端代码保留（`backend: "openclaw"` / `"deepseek"`），需自行在 config 加 provider 或用环境变量 `PPX_OPENCLAW_MJS` / `PPX_DSH_ROOT` 指定引擎位置
- 保留：皮皮虾四层记忆 / 自愈 / 方法Skill / 工具 / web 壳 全部保留

### DeepSeek Harness 内嵌底座（dsh）

```bash
# 首次安装/构建内嵌 dsh（需要网络安装依赖）
npm run dsh:install
npm run dsh:build

# 直接运行 dsh CLI（等同 deepseek-harness 仓库的 pnpm dsh）
npm run dsh -- web
```

- 源码位置：`.deps/deepseek-harness/`（完整保留 deepseek-harness 的 packages/apps/docs/scripts/vendor 等）
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
npm i -g ppx-agent

ppx           # 启动对话 CLI
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

## 🧠 记忆架构 (L0 → L3)

```
对话 → L0 原始对话(session 事件日志) → L1 原子记忆(高斯衰减) → L2 场景(关键词聚类) → L3 画像(persona)
```

- **L0**: 对话原文由会话事件日志 `data/sessions/*.jsonl` 全量承载; 每日滚动压缩视图由 MemoryTicker 产出到 `data/memory/daily/` + `longterm.md`, 过滤噪音
- **L1**: `facts.json`, score = score × exp(-λt²), 命中加分
- **L2**: `scenes.json`, 相关记忆聚类成场景
- **L3**: `user.persona.md` + `agent.persona.md`, 从记忆提炼画像

## 🩺 自我修复

- 启动体检: 补建缺失目录 / 修复损坏JSON(备份后重建)
- 崩溃恢复: 检测异常退出, 清理残留临时文件
- 数据一致性: integrity 标记, 干净退出/异常退出可感知

## 📂 目录结构

```
ppx-agent/
├── config/         配置 (ppx.json + identity/ishiki 人格)
├── src/
│   ├── agent/      Agent 引擎 (编排 + 工具循环 + 多模型回退)
│   ├── memory/     L0-L3 四层记忆 + 经验库
│   ├── selfheal/   自愈引擎
│   ├── tools/      工具系统 (32个 + MCP 动态注册)
│   ├── channels/   通道 (http/feishu/wechat)
│   ├── orchestrator/ 军团编排器 (多进程)
│   ├── llm/        LLM 客户端
│   └── utils/      基础设施
├── data/           运行时数据 (不进 git)
├── test/           测试 (452 项 448 过 0 失败 4 网络跳过)
└── docs/           文档
```

## 📄 License

Apache License 2.0

## 🙏 架构来源

- [openhanako (HanaAgent)](https://github.com/liliMozi/openhanako) — 记忆分层、自愈内核、人格系统
- [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) — L0-L3 四层记忆架构
- [OpenClaw](https://openclaw.ai) — agent 运行时组织