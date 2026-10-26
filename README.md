# 🦐 PPXANS-Harness

<!-- readme-sync: {"tools":93,"skills":67,"core_schema":93,"ctx_tokens":13993,"mcp_tools":115,"tests":1759} -->

**皮皮虾神经系（ANS）+ Harness 一体化智能体内核** —— 纯 Node.js、**零运行时依赖**的可审计自主智能体。

一个会自我修复、自我学习、自主迭代、可审计验证的超级 Agent：**92 个内置工具 · 能力边界护栏 · L0–L4 五层记忆 · SHA-256 审计哈希链 · 标准 MCP 服务端+客户端 · 多模型路由 · 自愈 7/7 · 可验证自改进闭环（self_improve） · 全量测试 **1759 项 (1755 通过 / 4 网络跳过)** · Web UI**。

> ⚠️ 本节数字为 **2026-10-25 实测**（`node --test test/*.test.js`），请勿手改臆测值 —— 改完请重跑并同步本行。
> 机读锚点由 `node scripts/readme-sync-check.js --fix` 维护，手改会被闸门拦下。
> 2026-10-25 评估修复轮后全量 0 失败（此前 1 项失败为测试断言过期，已随工具数 113→114 一并修正）；
> 主干链路（启动 / 对话 / 记忆 / 审计 / 权限 / HTTP / MCP）全量通过。

自带标准 MCP 服务（`POST /mcp`），Claude Desktop / Cursor / 任何 MCP 客户端**开箱即用**；支持各大模型 API + 本地模型，自由回退。

> 🛡️ **自愈基准**：`node scripts/selfheal-bench.js` → **7/7 100%**（发布前门禁，`PPX_MIN_SELFHEAL` 可设阈值）
> 🔗 **审计哈希链**：`npm run audit:verify` —— append-only + SHA-256 链式防篡改，篡改/删除可定位到行

---

## ✨ 核心特性

| 能力 | 说明 |
|------|------|
| 🧠 **五层记忆 L0–L4** | L0 对话 → L1 原子（高斯衰减）→ L2 场景 → L3 画像 → L4 程序性（技能/流程，衰减仅 L1 的 1/4）；语义检索开箱即用（内置零依赖哈希向量兜底 + 向量落盘缓存，配云端 embedding 自动切换） |
| 🧹 **记忆治理** | 软删可回滚 + 版本链 + TTL 归并 + 按层清理 + 导出/导入迁移 |
| 🔗 **审计哈希链** | 工具调用 append-only 账本 + SHA-256 链式防篡改 + HMAC 链外密钥锚点（防"整链重算"伪造，密钥不落数据目录），篡改/删除定位到行，可隔离重放 |
| 🛡️ **权限安全** | AskForApproval 四档审批 + SandboxPolicy 沙箱（工作区写含 realpath 符号链接复核）+ 命令守卫三层防线（shell 结构化解析：命令替换硬拦 / 逐段 argv0 白名单）+ SSRF 防护 + fail-open 钩子栅栏 |
| 🩺 **自我修复** | 启动体检、损坏 JSON 修复、崩溃恢复、残留清理（自愈 7/7） |
| 🔄 **自主迭代** | 可验证自改进闭环：失败测试 → LLM 诊断 → SEARCH/REPLACE 补丁 → 快照落盘 → 重跑验证 → 绿保留/红回滚（`self_improve` 工具 + `npm run selfiterate`，默认 propose 只出补丁，apply 需双重确认，全程审计链留痕） |
| 🧬 **持续进化循环** | 每日自主进化编排：弱点聚类定向学习（同类故障病历 ≥N 先治）→ 失败沉淀经验/成功沉淀技能 → 代码自改进 → 进化度量落账 journal（`evolution_loop` 配置 + `npm run evolve:loop` + `evolution_status` 工具随时查看能力快照/弱点/进化曲线，「变强」有账可查） |
| 📚 **自我学习** | 经验库 + 画像/人格提炼 + refine 失败轨迹闭环 + refineSkill 成功沉淀技能；经验自动沉淀语境 Playbook（进化闭环），失败自动写故障病历并反哺提炼 |
| 🤖 **多 Agent 军团** | 多进程并行 + DAG 编排 + legion 模式 + spawn_agent 自主协作（并行/差异化视角/仲裁聚合/SDD 审查循环），编排超时可配（`agent.legion.timeoutMs`） |
| 🔌 **多渠道接入** | HTTP + 飞书（官方 encrypt_key 事件解密 + 签名校验 + 防重放）+ 微信（加解密 + 主动推送 + 加密回包） |
| 📄 **文档 + RAG + OCR** | read_document（txt/md/pdf/html）+ ingest_document 分块入库 + ocr_image（本地 tesseract / 云回退） |
| 💬 **CLI 交互** | readline 历史 + /stop 中断 + /reset 清会话 + Ctrl+C 单次中断 |
| 🧩 **MCP 客户端 + 服务端** | 零依赖 MCP 客户端（stdio + HTTP Streamable）接外部工具；`POST /mcp` 暴露 86 工具 + 记忆/轨迹/统计/会话资源 + 方法型 prompts + ppx.* 管理工具 |
| ✅ **任务面板** | 任务队列 + 步骤状态推进 + 结果回填 + 技能模板 |
| ✅ **可观测** | 工具轨迹 JSONL + 结构化事件流（traceId 贯穿）+ tool call result 大摘要 |
| ✅ **场景系统** | 灵魂文件式场景，命中自动切换行为 |
| ✅ **流式输出** | SSE 逐字流式（含工具轮次：增量 tool_call 累积，文本实时可见）+ Web UI 实时渲染；同会话并发互斥、/rewind 会话回卷（fork 分支） |
| 🔐 **HTTP 认证** | Bearer Token，未配置自动生成随机 token 持久化 |

**92 内置工具**（运行时实测，含 MCP 动态注册）：
- **48 内置**：文件/命令/搜索/HTTP/定时/记忆（读图/检索/入库）/文档（加载/OCR/入库）/场景/技能（加载/创建/提炼）/重构 refine /子 agent spawn + 治理运维（repo_map/apply_patch/review_code/goal_board/audit_verify/persona/selfheal_run/self_improve 等）
- **22 × ppx.**\***：** chat.send/stream、sessions.\*、providers.(list/add/update/delete/test/reorder)、settings.get/update、task.(templates/create/list/update/step/delete/run)、session.reset

---

## v3.0 架构（codex 对齐）

v3.0 引入 codex 的 **EQ 事件流 + SQ 在轮账本 + Turn 模型**（详见 docs/ARCHITECTURE-V3.md §三·六），把权限、钩子、编辑、审查、证据能力**分层独立为可替换模块**，并重制零依赖 Web UI：

| 模块 | 出处 | 能力 |
|------|------|------|
| `protocol/` | codex | **EQ 事件流为主出口 + SQ 在轮账本**：EQ(WAL) 落盘结构化事件经 `/events` SSE 桥外发（TURN_\*/APPROVAL_\*/TOOL_CALLED/TOOL_OUTPUT 经 callId 配对）；SQ 承载在轮 USER_TURN op 与 INTERRUPT 控制 op（TTL 防腐烂，`/health` 可观测）。Turn 投影层（Session→Task→Turn 状态机）随轮更新，重启后 WAL seq 续读不撞号 |
| `permissions/` | codex + opencode + CASDK | **三合一权限引擎**：AskForApproval 四档 + SandboxPolicy 三档 + 通配符规则链(last-match-wins) + canUseTool 回调 + Bash/Edit/Plan 审批模板 |
| `hooks/` | claude-code | **六事件钩子链**：PreToolUse(可否决/改参) / PostToolUse / PreCompact / SessionStart/Stop / SubagentStop，超时熔断，纯 JS |
| `edit/` | aider | **SEARCH/REPLACE 编辑块**（多候选/空白容错/失败回灌修复）+ 编辑前快照逐文件回滚 |
| `repomap/` | aider | **仓库地图**：def/ref 提取 → 引用图 → PageRank → token 预算内渲染，缓存 30s |
| `review/` | 分级审查流水线 | plan→group→review→relocate→filter，输出 P0/P1/P2 静态规则报告 |
| `evidence/` | oh-my-hermes | **证据边界**：prepared/observed 双层标记 + handoff manifest(哈希) + 目标看板 |
| `commands/` | claude-code | **斜杠命令统一模型**：内置 /init /plan /review /compact /new /resume /model /status /memory /skills /goal，用户命令从 `.ppx/commands/*.md` 加载 |

> **集成现状**：上述 9 模块中 8 个已装配进运行时（`plugin/v3.js` + `tools/v3.js`，MCP 实测可调）；`session/`（Turn/Rollout/Parts）为 standalone 模块随包保留、有完整单测，但尚未接入主链路，待 v3.1 集成。钩子链 7 个事件（PreToolUse/PostToolUse/PreCompact/PostCompact/SessionStart/SessionStop/SubagentStop）已全部接入 emit 点；语境 Playbook 已形成"经验 → delta → 门禁 → 注入"完整闭环（`evolve/delta-producer.js`）。

**Web UI（codex 风格, `public/` 零依赖重制）**：三栏事件时间线（用户/agent/工具卡/审批卡/计划卡/diff卡）+ 斜杠命令面板 + 审批卡三类模板 + 工作区 Tab（文件树/目标看板/审查报告/设置）+ 子 agent 彩色徽标 + `@` 引用文件 + Esc 中断 + 亮暗主题。

---

## 🚀 快速开始

### 本地开发 · 一键起 Web 应用（推荐）

```bash
# 1. 配置模型 —— 三选一, 约 1 分钟:
npm run setup                                              # 交互式向导: 选厂商 → 粘贴 Key → 自动探活
ppx-setup --provider deepseek --key sk-xxx                 # 或一条命令 (--list 看全部厂商)
# 或启动本地 LM Studio / Ollama, 重启皮皮虾自动识别 (默认端口即可)

# 2. 直接用 (一发即走, 直答退出):
ppx "帮我看看这个仓库的结构"

# 3. 或起整个 Web 应用 (内核+界面同进程同端口, 自动开浏览器):
npm start                          # → http://127.0.0.1:8899
# 等价: node bin/ppx-web.js [--port 9000] [--host 0.0.0.0] [--no-open] [--root D:/ws]
```

> 零配置也能启动 —— 离线记忆模式下皮皮虾照常运行 (记忆/文件/技能), 只是缺对话模型;
> Web 首页会显示「配置模型」按钮, 点进去 1 分钟配好。

**其他启动方式**

```bash
npm run chat          # 终端对话 CLI (ppx / ppxans)
npm run serve         # 仅 HTTP 接口 (无界面): http://127.0.0.1:8899
npm run web:check     # Web UI 静态自检 (图标/DOM id/语法解析/静态资源)
npm test              # 全量测试
```

### MCP 标准端点 (Streamable HTTP)

`POST http://127.0.0.1:8899/mcp`（同 Bearer token 鉴权）。任何 MCP 客户端（Claude Desktop / Cursor / MCP Inspector 等）可直接接入：

- `tools/list` + `tools/call` — 86 工具全量暴露
- resources：`memory://` `traces://` `stats://` `sessions://`
- prompts：`humanize` / `plan` / `debug` / `verify` / `write_article`（方法型技能）
- `ppx.chat.send` / `ppx.chat.stream`（对话工具，驱动完整工具循环）

配置：`config/ppx.json` → `channels.http { port, auth_token }`

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

**回退机制**：路由层选主模型，运行时负责失败切换 —— 选中 provider 连不上自动切下一个直到成功。默认本地优先，配了云端 key 自动云端优先。

### 前缀缓存优化（可选）

默认 system prompt 会写入工作目录的绝对路径（模型少问路径，进程内前缀缓存不退化）。
如需跨机器/跨工作目录共享 provider 前缀缓存，可把 `agent.workspace_prompt_mode` 设为 `"neutral"`
或设置环境变量 `PPX_PROMPT_WORKSPACE_MODE=neutral` —— 此时工作目录段使用稳定占位符，不写绝对路径；
模型可通过 `pwd` / `list_dir` 自行确认实际路径。

---

## 🧪 测试 / 评测 / CI

```bash
npm test                # 全量测试
npm run verify          # 一键本地快检 (12 项, 离线, 无需 LLM; 含功能宣称闸门)
npm run verify:full     # 一键快检 + 全量测试
npm run test:coverage   # 全量测试 + Node 内置覆盖率 (行覆盖 90%+)
npm run coverage:gate   # 覆盖率门禁 (行覆盖 >= 85%, CI 用)
npm run eval            # 本地能力评测 (7 项, 无需 LLM)
npm run eval -- --llm   # LLM 端到端评测 (需 provider)
npm run bench           # 并发/长会话吞吐压测
npm run nightly         # 四基准一键跑分 → docs/bench/nightly-<date>.{json,md} (公开可复现报告)
npm run audit:verify    # 审计哈希链完整性校验 (含 HMAC 签名重放)
npm run selfiterate -- --list-failing   # 全量测试列出失败文件 (自主迭代入口)
npm run selfiterate -- test/x.test.js   # 对失败测试跑 诊断→补丁→验证→回滚 闭环 (默认只出补丁)
npm run evolve:loop                     # 手动一轮持续进化: 弱点学习→代码迭代→度量落账 (--status 看报告)
```

**GitHub Actions CI**：push/PR 自动跑全量测试 + Web 静态自检 + 本地评测。要启用 LLM 回归，在 Settings → Secrets 配置 `PPX_E2E_BASE_URL` / `PPX_E2E_API_KEY` / `PPX_E2E_MODEL`。

---

## 🧠 记忆架构（L0 → L4）

```
对话 → L0 原始对话(会话日志) → L1 原子记忆(高斯衰减) → L2 场景(关键词聚类) → L3 画像(persona)
                                                                           → L4 程序性记忆(技能/流程, 慢遗忘)
```

- **L0**：`data/sessions/*.jsonl` 全量承载 + MemoryTicker 滚动压缩
- **L1**：`facts.json`，score = score × exp(-λt²)，命中加分（λ = `decay_per_day`）
- **L2**：`scenes.json` 相关记忆聚类
- **L3**：`user.persona.md` + `agent.persona.md`
- **L4**：技能/流程程序性记忆，衰减率 0.005 仅为 L1 的 1/4 —— 技能长期留存

**记忆治理（可回滚的遗忘）**：软删(`memory_forget`) + 回滚(`memory_restore`) + 复核(`memory_list_deleted`) + 版本链 + TTL 归并 + 按层清理 + 导出/导入迁移。容量保护仍是硬删(`_prune` 裁最弱项)，治理管「想忘的」、`_prune` 管「装不下的」，两者分工不重叠。

**语义检索（开箱即用）**：`memory_search` 走 dense+BM25 双路 RRF 融合。未配置云端 embedding 时自动注入内置零依赖哈希 embedder（字符 n-gram 特征哈希 256 维，抓子词/词形/CJK 字面近义）；向量落盘缓存（`data/memory/vectors.json`，内容哈希失效键 + embedder 指纹换代作废），配云端/本地模型（`config.embedding`）自动切换且重启不重算。显式 `config.embedding.fallback: "off"` 恢复纯 BM25。

---

## 📂 目录结构（v3.0）

```
PPXANS-Harness/
├── config/         配置 (ppx.json + 人格)
├── src/
│   ├── agent/      Agent 引擎 (工具循环 + 多模型回退 + v3 插件装配)
│   ├── protocol/   [v3] EQ 事件流(WAL) + SQ 在轮账本/控制 op
│   ├── session/    [v3] Turn 状态机 + rollout + parts (standalone, 待 v3.1)
│   ├── permissions/[v3] 审批 + 沙箱 + 规则链 + canUseTool
│   ├── hooks/      [v3] 六事件钩子链
│   ├── edit/       [v3] SR 编辑块 + 快照回滚
│   ├── repomap/    [v3] 仓库地图 (PageRank)
│   ├── review/     [v3] 分级审查流水线
│   ├── evidence/   [v3] 证据边界 + 目标看板 + manifest
│   ├── commands/   [v3] 斜杠命令统一模型
│   ├── plugin/     v3.js 五插件装配 (permissions/hooks/commands/evidence/protocol)
│   ├── tools/      工具系统 (86 个 + v3 工具注册)
│   ├── core/  services/  memory/  audit/  ans/  selfheal/  channels/  orchestrator/  llm/  utils/
├── public/         零依赖 Web UI (index.html/app.js/app.css, codex 风格)
├── bin/            ppx / ppxans / ppx-web / ppx-serve / ppx-channels 入口
├── data/           运行时数据 (不进 git)
├── references/     第三方项目来源登记
├── test/           测试 (1633 项)
└── docs/           文档 (ARCHITECTURE-V3 / QUICKSTART / web-launch 等)
```

---

## 📄 License

Apache License 2.0

## 🙏 架构来源与致谢

- [openhanako (HanaAgent)](https://github.com/liliMozi/openhanako) — 记忆分层、自愈内核、人格系统
- [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) — L0-L3 四层记忆架构
- **ppx-v2 (ppx Harness)** — 审计哈希链、记忆治理、L4 程序性记忆、治理工具
- [openai/codex](https://github.com/openai/codex) — v3.0 主轴架构参照 (SQ/EQ 队列、权限、仓库地图)
- [opencode](https://github.com/sst/opencode)、[claude-code](https://github.com/anthropics/claude-code)、[aider](https://aider.chat)、[OpenHands](https://github.com/All-Hands-AI/OpenHands)、[open-code-review](https://github.com/srikanth235/open-code-review)、[claude-agent-sdk-ts](https://github.com/anthropics/claude-agent-sdk-typescript)、[oh-my-hermes](https://github.com/wintermute-cell/oh-my-hermes) — v3.0 特性吸收来源（源码未直接纳，见 docs/ARCHITECTURE-V3.md 与 references/THIRD-PARTY-SOURCES.md）