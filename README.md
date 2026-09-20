# 🦐 PPXANS-Harness (皮皮虾)

> **皮皮虾神经系 (ANS) + Harness 一体化智能体内核**，纯 Node.js，**零运行时依赖**。
>
> **69 内置工具** · L0–L4 五层记忆 · SHA-256 审计哈希链 · MCP 服务端+客户端 · 多模型路由 · 自愈 7/7 · **918 测试全绿** · Web UI (codex 风格)。

**一个会自我修复、自我学习、可审计的超级 Agent。** 标准 MCP 服务器（`POST /mcp`）让 Claude Desktop / Cursor / 任何 MCP 客户端开箱即用。支持各大模型 API + 本地模型。

> 🛡️ **自愈基准** `node scripts/selfheal-bench.js` → **7/7 100%**（发布前门禁，`PPX_MIN_SELFHEAL` 设阈值）
> 🔗 **审计哈希链** `npm run audit:verify`（append-only + SHA-256 链式防篡改，篡改定位到行）
>
> 👉 新手上路：5 分钟跑起来、写第一个工具/插件，见 [docs/QUICKSTART.md](docs/QUICKSTART.md)。v3.0 架构设计见 [docs/ARCHITECTURE-V3.md](docs/ARCHITECTURE-V3.md)。

---

## ✨ v3.0 新能力（codex 对齐 + 七项目特性吸收）

v3.0 引入 codex 的 **SQ/EQ 双队列 + Turn 模型** 作为交互主轴，把权限、钩子、编辑、审查、证据能力**分层独立成可替换模块**，并重制零依赖 Web UI：

| 模块 | 出处 | 能力 |
|------|------|------|
| `protocol/` | codex | **SQ·EQ 双队列事件流**：SubmissionQueue 入队 + EventQueue(WAL) 结构化事件，通道层与内核解耦总线 |
| `permissions/` | codex + opencode + CASDK | **三合一权限引擎**：AskForApproval 四档 + SandboxPolicy 三档 + 通配符规则链(last-match-wins) + canUseTool 回调 + Bash/Edit/Plan 审批模板 |
| `hooks/` | claude-code | **六事件钩子链**：PreToolUse(可否决/改参) / PostToolUse / PreCompact / SessionStart/Stop / SubagentStop，超时熔断，纯 JS |
| `edit/` | aider | **SEARCH/REPLACE 编辑块**（多候选/空白容错/失败回灌修复）+ 编辑前快照逐文件回滚 |
| `repomap/` | aider | **仓库地图**：def/ref 提取 → 引用图 → PageRank → token 预算内渲染，缓存 30s |
| `review/` | OCR | **分级审查流水线**：plan→group→review→relocate→filter，输出 P0/P1/P2 静态规则报告 |
| `evidence/` | oh-my-hermes | **证据边界**：prepared/observed 双层标记 + handoff manifest(哈希) + 目标看板 |
| `commands/` | claude-code | **斜杠命令统一模型**：内置 /init /plan /review /compact /new /resume /model /status /memory /skills /goal，用户命令从 `.ppx/commands/*.md` 加载 |

> **集成现状**：上述 9 模块中 8 个已装配进运行时（`plugin/v3.js` + `tools/v3.js`，MCP 实测可调）。`session/`（Turn/Rollout/Parts）为 standalone 模块随包保留、有完整单测，但尚未接入主链路，待 v3.1 集成——详见 [docs/ARCHITECTURE-V3.md](docs/ARCHITECTURE-V3.md) 集成现状节。

**Web UI（codex 风格, public/ 零依赖重制）**：三栏事件时间线（用户/agent/工具卡/审批卡/计划卡/diff卡）+ 斜杠命令面板 + 审批卡三类模板 + 工作区 Tab（文件树/目标看板/审查报告/设置）+ 子 agent 彩色徽标 + `@` 引用文件 + Esc 中断 + 亮暗主题。

---

## 🧰 核心特性

| 能力 | 说明 |
|------|------|
| 🧠 **五层记忆 L0–L4** | L0对话 → L1原子(高斯衰减) → L2场景 → L3画像 → L4程序性(技能/流程, 衰减仅 L1 1/4) |
| 🗂️ **记忆治理** | 软删可回滚 + 版本链 + TTL 归档 + 按层清理 + 导出/导入迁移 |
| 🔐 **审计哈希链** | 工具调用 append-only 账本 + SHA-256 链式防篡改，篡改/删行可定位到行，可隔离重建 |
| 🛡️ **权限安全** | AskForApproval 四档审批 + SandboxPolicy 沙箱 + 命令守卫三层防线 + SSRF 防护 + fail-open 钩子栅栏 |
| 🩺 **自我修复** | 启动体检、损坏JSON修复、崩溃恢复、残留清理 (自愈 7/7) |
| 📚 **自我学习** | 经验库 + 画像/人格提炼 + refine 失败轨迹闭环 + refineSkill 成功沉淀技能 |
| 🤖 **多 agent 军团** | 多进程并行 + DAG 编排 + legion 模式 + spawn_agent 自主协作 (并行/差异化视角/仲裁/SDD 审查循环) |
| 🔌 **多渠道接入** | HTTP + 飞书 + 微信（加解密+主动推送+加密回包） |
| 📄 **文档 + RAG + OCR** | read_document(txt/md/pdf/html) + ingest_document 分块入库 + ocr_image (本地 tesseract / 云回退) |
| ⌨️ **CLI 交互** | readline 历史 + /stop 中断 + /reset 清会话 + Ctrl+C 单次中断 |
| 🔌 **MCP 客户端 + 服务端** | 零依赖 MCP 客户端 (stdio + HTTP Streamable) 接入外部工具；`POST /mcp` 暴露 69 工具 + 记忆/轨迹/统计/会话资源 + 方法技能 prompts + ppx.* 管理工具 |
| 🎛️ **MCP 管理工具** | 会话/提供方/设置/任务面板全部经标准 MCP 暴露 (`ppx.sessions.*`/`ppx.providers.*`/`ppx.settings.*`/`ppx.task.*`) |
| ✅ **任务面板** | MCP 任务工具 + Web UI 模块：任务队列 + 步骤状态推进 + 结果回填，6 套技能模板 |
| ✅ **可观测** | 工具轨迹 JSONL + 结构化事件流 (traceId 贯穿) + tool call result 头 |
| ✅ **场景系统** | 灵魂文件式场景(手动设定/历史提炼)，命中自动切换行为 |
| ✅ **流式输出** | SSE 逐字流式 + Web UI 实时渲染 |
| 🔐 **HTTP 认证** | Bearer Token，未配置自动生成随机 token 持久化 |

**69 内置工具**（运行时实测）：
- **47 内置**：文件/命令/搜索/HTTP/定时/记忆(读图/检索/入库)/文档(加载/OCR/入库)/场景/技能(加载/创建/提炼)/重构 refine/子agent spawn + 治理运维(repo_map/apply_patch/review_code/goal_board/audit_verify/persona/selfheal_run 等)
- **22 ppx.\***：chat.send/stream、sessions.*、providers.(list/add/update/delete/test/reorder)、settings.get/update、task.(templates/create/list/update/step/delete/run)、session.reset

---

## 🚀 快速开始

**本地开发 · 一键起 Web 应用（推荐）**

```bash
# 1. 配置模型 (config/ppx.json): 设 OPENAI_API_KEY / DEEPSEEK_API_KEY 等环境变量,
#    或启动本地 LM Studio (默认 http://127.0.0.1:1234/v1) 走本地模型。

# 2. 一条命令起整个 Web 应用 (内核+界面同进程同端口, 自动开浏览器)
npm start                          # → http://127.0.0.1:8899
# 等价: node bin/ppx-web.js [--port 9000] [--host 0.0.0.0] [--no-open] [--root D:/ws]

# 3. 启动自愈体检
npm run selfheal
```

**Windows 双击即用**：

| 入口 | 作用 |
|---|---|
| `启动皮皮虾.vbs` | 静默启动（无控制台, 内核自动开浏览器）—— **推荐** |
| `启动皮皮虾.bat` | 带窗口启动（可见启动日志） |
| `停止皮皮虾.bat` | 按端口精准停服 |
| `高级菜单.bat` | CLI / 仅接口 / 体检 / 测试 / 高级菜单 |

启动器自动清理上一轮遗留监听进程 → 单进程起服务并轮询就绪 → 就绪后打开浏览器并退出。

**其他启动方式**

```bash
npm run chat          # 终端对话 CLI (ppx / ppxans)
npm run serve         # 仅 HTTP 接口 (无界面): http://127.0.0.1:8899
npm run web:check     # Web UI 静态自检 (图标/DOM id/语法解析/静态资源)
npm test              # 全量测试 (918 项)
```

### MCP 标准端点 (Streamable HTTP)

`POST http://127.0.0.1:8899/mcp`（同 Bearer token 鉴权）。任何 MCP 客户端 (Claude Desktop / Cursor / MCP Inspector 等) 可直接接入：

- `tools/list` + `tools/call` — 69 工具全量暴露
- resources: `memory://` `traces://` `stats://` `sessions://`
- prompts: `humanize` / `plan` / `debug` / `verify` / `write_article`（方法型技能）
- `ppx.chat.send` / `ppx.chat.stream`（对话工具，驱动完整工具循环）

配置: `config/ppx.json` → `channels.http { port, auth_token }`。

### 模型接入

任意 **OpenAI 兼容端点**，自动多 provider 回退：

```json
{
  "providers": [
    { "id": "openai",     "base_url": "https://api.openai.com/v1",           "api_key_env": "OPENAI_API_KEY",   "model": "gpt-4o-mini" },
    { "id": "deepseek",   "base_url": "https://api.deepseek.com/v1",          "api_key_env": "DEEPSEEK_API_KEY", "model": "deepseek-chat" },
    { "id": "dashscope",  "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "api_key_env": "DASHSCOPE_API_KEY", "model": "qwen-turbo" },
    { "id": "lmstudio",   "base_url": "http://127.0.0.1:1234/v1",             "api_key": "lm-studio",            "model": "<本地模型名>" }
  ]
}
```

**回退机制**：路由层选主模型，运行时负责失败切换——选中 provider 连不上自动切下一个直到成功。默认本地优先，配了云端 key 自动云端优先。

---

## 🧪 测试 / 评测 / CI

```bash
npm test                # 全量 918 项 (0 失败)
npm run eval            # 本地能力评测 (7 项, 无需 LLM)
npm run eval -- --llm   # LLM 端到端评测 (需 provider)
npm run bench           # 并发/长会话吞吐压测
npm run audit:verify    # 审计哈希链完整性校验
```

**GitHub Actions CI**：push/PR 自动跑全量测试 + Web 静态自检 + 本地评测。要启用 LLM 回归，在 Settings → Secrets 配置 `PPX_E2E_BASE_URL` / `PPX_E2E_API_KEY` / `PPX_E2E_MODEL`。

---

## 🧠 记忆架构（L0 → L4）

```
对话 → L0 原始对话(会话日志) → L1 原子记忆(高斯衰减) → L2 场景(关键词聚类) → L3 画像(persona)
                                                                          ↘ L4 程序性记忆(技能/流程, 慢衰减)
```

- **L0**: `data/sessions/*.jsonl` 全量承载 + MemoryTicker 滚动压缩
- **L1**: `facts.json`, score = score × exp(-λt²), 命中加分 (λ = `decay_per_day`)
- **L2**: `scenes.json` 相关记忆聚类
- **L3**: `user.persona.md` + `agent.persona.md`
- **L4**: 技能/流程程序性记忆, 衰减率 0.005 仅为 L1 的 1/4 —— 技能长期留存

**记忆治理（可回滚的遗忘）**：软删(`memory_forget`) + 回滚(`memory_restore`) + 复核(`memory_list_deleted`) + 版本链 + TTL 归档 + 按层清理 + 导出/导入迁移。容量保护仍是硬删（`_prune` 裁最弱项），治理管"想忘的"、`_prune` 管"装不下的"，两者分工不重叠。

---

## 📂 目录结构（v3.0）

```
PPXANS-Harness/
├── config/         配置 (ppx.json + 人格)
├── src/
│   ├── agent/      Agent 引擎 (工具循环 + 多模型回退 + v3 插件装配)
│   ├── protocol/   [v3] SQ·EQ 双队列事件流 (WAL)
│   ├── session/    [v3] Turn 状态机 + rollout + parts (standalone, 待 v3.1)
│   ├── permissions/[v3] 审批 + 沙箱 + 规则链 + canUseTool
│   ├── hooks/      [v3] 六事件钩子链
│   ├── edit/       [v3] SR 编辑块 + 快照回滚
│   ├── repomap/    [v3] 仓库地图 (PageRank)
│   ├── review/     [v3] 分级审查流水线
│   ├── evidence/   [v3] 证据边界 + 目标看板 + manifest
│   ├── commands/   [v3] 斜杠命令统一模型
│   ├── plugin/     v3.js 五插件装配 (permissions/hooks/commands/evidence/protocol)
│   ├── tools/      工具系统 (69 个 + v3 工具注册)
│   ├── core/  services/  memory/  audit/  ans/  selfheal/  channels/  orchestrator/  llm/  utils/
├── public/         零依赖 Web UI (index.html/app.js/app.css, codex 风格)
├── bin/            ppx / ppxans / ppx-web / ppx-serve / ppx-channels 入口
├── data/           运行时数据 (不进 git)
├── references/     第三方项目来源登记
├── test/           测试 (918 项, v3 新模块全覆盖)
└── docs/           文档 (ARCHITECTURE-V3 / QUICKSTART / web-launch 等)
```

---

## 📄 License

Apache License 2.0

## 🙏 架构来源

- [openhanako (HanaAgent)](https://github.com/liliMozi/openhanako) — 记忆分层、自愈内核、人格系统
- [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) — L0-L3 四层记忆架构
- **ppx-v2 (ppx Harness)** — 审计哈希链、记忆治理、L4 程序性记忆、治理工具
- [openai/codex](https://github.com/openai/codex) — v3.0 主骨架参照 (SQ/EQ 队列、权限、仓库地图)
- [openrowan / opencode](https://github.com/sst/opencode)、[claude-code](https://github.com/anthropics/claude-code)、[aider](https://aider.chat)、[OpenHands](https://github.com/All-Hands-AI/OpenHands)、[open-code-review](https://github.com/srikanth235/open-code-review)、[claude-agent-sdk-ts](https://github.com/anthropics/claude-agent-sdk-typescript)、[oh-my-hermes](https://github.com/wintermute-cell/oh-my-hermes) — v3.0 特性吸收来源，源码未直接纳入，见 [docs/ARCHITECTURE-V3.md](docs/ARCHITECTURE-V3.md) 与 [references/THIRD-PARTY-SOURCES.md](references/THIRD-PARTY-SOURCES.md)