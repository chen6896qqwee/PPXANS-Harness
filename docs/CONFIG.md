# 配置说明

皮皮虾的配置在 `config/ppx.json`（或 `config/ppx.yaml`）。所有字段都有默认值，未写的字段自动用默认兜底（见 `src/config/index.js` 的 `DEFAULT_CONFIG`）。环境变量可覆盖部分项。

> 位置随安装方式变化：源码仓库 / 桌面工作副本 → `<仓库根>/config/ppx.json`；
> npm 全局或本地安装（代码在 `node_modules` 里）→ `<数据目录>/config.json`
> （默认 `~/.ppx/config.json`）。这样 `npm i -g` 升级替换包目录时不会冲掉用户配置；
> 旧位置残留的 `config/ppx.json` 仍会被读取。

## 快速开始

最少配置：只设一个模型 API key 环境变量即可跑，其余全默认：

```bash
export OPENAI_API_KEY="sk-..."      # 或 DEEPSEEK_API_KEY / DASHSCOPE_API_KEY
npm run chat
```

## providers（模型提供方）

数组，按顺序回退（第一个失败自动切下一个）。每个 provider 的字段：

| 字段 | 说明 |
|------|------|
| `id` | 唯一标识（如 `openai`） |
| `backend` | ~~`openclaw` / `deepseek`（可选引擎）~~ —— v2.5.0 起已移除，仅 `http`（直连 OpenAI 兼容 API，默认） |
| `base_url` | API 端点 |
| `api_key` / `api_key_env` | 直接填 key，或填环境变量名 |
| `api_key_cmd` | 2026-10-31 新增：配一条命令，启动时取其 stdout 作为 key —— 密钥不必明文落盘（PowerShell DPAPI 解密 / `pass show` / 凭据管理器均可）。优先级：`api_key` 明文 > `api_key_cmd` 结果 > `api_key_env`；命令失败按未配置处理 |
| `model` | 模型名 |
| `vision` | `true` 标记为视觉模型（多模态读图时路由到此） |
| `timeout_ms` | 超时（毫秒，默认 120000） |
| `retry_max` | 单次调用内瞬态错误重试次数（默认 3） |
| `context_window` | 上下文窗口（token）。agent 据此收紧会话历史预算，防本地小模型溢出（未配置回退 memory.context_window） |

> **引擎底座（v2.5.0 起）**：仅自研 http 底座，`openclaw` / `deepseek` / `dsh_root` / `mjs` / `.deps/` 相关字段与配置已全部移除。多厂商接入 = 配多个 http provider（OpenAI/DeepSeek/通义/智谱/本地 lmstudio/ollama/vLLM），router 按 key 顺序回退。

### 本地模型：一键接入（v4.4.0）

模型面板的「一键接入本地模型」会扫描 `127.0.0.1` 的常见端口（LM Studio 1234 / Ollama 11434 / vLLM 8000 / llama.cpp·LocalAI 8080 / Jan 1337 / text-generation-webui 5000），
直接从服务端读出**模型名、实际加载的上下文窗口、最大输出、视觉能力**，点选即创建 provider 并设为默认。

- LM Studio 新版默认要求 API Key：扫描返回「需要 Key」时在面板里粘贴一次即可；Key 只写入本机 `config/ppx.json`。
- 窗口取 `loaded_context_length`（实际加载值），不是训练上限；`max_output` 由窗口推导（≥16K → 8192）。
  **不要把它填成几百** —— 推理型模型会把这点 token 全花在思考上，正文为空，表现为“模型没回答”。
- 手写配置时同样建议：`base_url` 带 `/v1`，`model` 用 `/v1/models` 返回的完整 id。
- 接口：`POST /api/providers/discover-local {api_key?, ports?}`；编辑器的「获取可用模型」也会自动带回上述元数据。

## agent（智能体）

| 字段 | 默认 | 说明 |
|------|------|------|
| `name` | 皮皮虾 | 智能体名字 |
| `yuan` | ppx | 内部代号 |
| `localIntent` | true | 本地意图预判（高置信简单指令不调 LLM，省成本） |
| `mode` | react | 编排模式：react / single / legion |
| `citation_rule` | 引用规则 | 让 LLM 引用来源的规则文本 |
| `system_extra` | "" | 追加的 system prompt 内容 |
| `values` | 4 条默认 | **核心价值（ANS 价值对齐）**，注入 system 最前（【核心价值·不可违背】），自定义数组直接覆盖默认 |
| `proactive.enabled` | true | **主动任务生成**开关（2026-10-30 校正：代码默认已是 true，本文档此前写 false，属漂移）——1h 扫描一次，无待办不打扰（24h 去重）；彻底静音设 false |
| `proactive.interval_ms` | 3600000 | 主动提醒间隔（毫秒） |
| `max_tool_rounds` | 24 | 工具循环最大轮次（防无限工具调用）。2026-11-03 起 8 → 24：8 轮跑不完一次自审/多文件任务；Web 设置「通用 → 工具循环」可调 1-64 |
| `tool_result_budget` | 4000 | 工具结果裁剪预算（超长结果保留头尾，防撑爆上下文） |
| `max_tool_error_retry` | 2 | 工具错误喂回模型修正的重试次数 |
| `max_parallel_tools` | 4 | **同轮工具并发上限**（2026-10-30）：一轮里 LLM 吐出 N 个 `tool_calls` 时按批执行，避免 N 个 shell 同时 spawn。`0` = 不限（旧行为）；未超限时仍走全并发 |
| `exhausted_finalize` | true | **轮次耗尽强制收口**（2026-10-30）：跑满 `max_tool_rounds` 后补一次**不带工具**的调用做收口总结，回复带「轮次已用尽」标注。`false` = 旧行为（直接返回"工具调用轮次过多, 已停止"）。无工具轨迹 / 用户中断 / 预算耗尽时不触发 |
| `tool_exposure` | `"core"` | **工具曝光策略**（2026-11-02 起默认 `core`）：`"core"` = 只下发 31 个主干工具的 schema，其余降级为 system prompt 里的【按需工具】名单，模型用 `tool_schema(name)` 现取参数定义；取过后该工具从下一轮自动进入函数数组。实测固定开销 **5881 tok/请求**（比全量省约 60%）。`"all"` = 全部工具下发完整 schema；也可传字符串数组自定义名单（自动并入 `tool_schema` / `list_capabilities`）。MCP 工具 (`category:"mcp"`) 不受收窄影响。名单字符预算走可选项 `tool_catalog_budget`（默认 1500，同 `skill_catalog_budget` 的"代码内默认、配置文件可不写"处理） |
| `tool_timeout_ms` | 30000 | **全局默认工具超时**（工具未声明 `timeoutMs` 时兑底，防单个慢工具卡死对话；工具级 `timeoutMs` 优先；0=不限时）。超时触发 `tool/timeout` trace 事件（含 elapsedMs/budgetMs/retried），是熔断/自适应预算的数据基础 |
| `workspace_prompt_mode` | absolute | 工作目录段模式：`absolute` 写入绝对路径（默认，模型少问路径）；`neutral` 不写绝对路径，用稳定占位符，换取跨机器/跨工作目录 provider 前缀缓存可共享（模型可用 `pwd` / `list_dir` 自行确认） |
| `work_graph.enabled` | true | **工单账本开关**（2026-11-02）：把入站消息受理结果（同步对话 / `chatAsync` / 线程转发）落盘为可查工单，Webhook 按 `messageId` 去重，重启后可查、可显式重跑。`false` = 完全绕过，行为回到旧版（见 [WORK-GRAPH.md](WORK-GRAPH.md)）；注意账本写失败只告警，不阻塞回复 |
| `work_graph.max_tickets` | 2000 | 账本工单总量上限，超出时自动裁掉最老的**终态**工单（运行中/等待中永不裁） |
| `work_graph.retention_days` | 14 | 终态工单保留天数，过期由后台裁剪；未结束工单不受影响 |
| `work_graph.compact_at` | 5000 | 追加日志行数超过该值时 fold 成快照重写 `tickets.jsonl`（写临时文件后 rename，避免半截文件） |
| `work_graph.dedupe_ms` | 30000 | 已完成/失败工单的重复投递窗口（毫秒）：窗口内同 `source+messageId+from` 直接复用原结果，不再执行；**未结束**工单不受窗口限制，全程去重 |
| `work_graph.recover` | "mark" | 启动恢复策略：`mark` = 把上个实例遗留的进行中工单标记为 `failed/interrupted` 并写事件（**不自动重放**，副作用工具不能盲跑）；`off` = 不扫描 |
| `work_graph.resume_unstarted` | false | **安全自动恢复**（2026-11-02）：仅对 `admitted` 且从未 `begin` 的工单（无执行事实 = 无工具副作用）在通道启动后自动重跑；`working/waiting` 仍一律标记中断。默认关，需要显式开启；`recover` 为 `off` 时不执行恢复扫描，本项也不会生效 |
| `work_graph.resume_started` | false | **无副作用重放**（2026-11-05 Step 6）：额外放行 `working` 且当前指派 `replaySafe=true` 的工单（开跑过的工具全为只读/显式幂等）。有副作用的非幂等工具在执行前已把指派标脏，标脏工单绝不自动重放；`waiting`、旧账本缺字段仍只标记。重放生成新 assignment 从任务开头重跑，不是断点续执行。默认关 |
| `work_graph.resume_checkpoint` | false | **断点续执行**（2026-11-05 Step 7，依赖 `resume_started=true`）：把只读/幂等工具的执行结果写入 `<dataDir>/workgraph/checkpoints/<assignmentId>.jsonl`；重放时注入续跑提示，相同 `(工具, 规范化参数)` 的已完成调用直接复用旧结果（标注 `[断点续执行]`），不再重复执行。有副作用的调用从不进检查点；结果截 4KB、每指派上限 500 条。复用不校验外部依赖是否变化（文件已改仍返回上次结果），需要新鲜数据时改参数或关闭本项。默认关，关闭时不建目录、不写盘 |
| `work_graph.resume_max_age_ms` | 21600000 | 自动恢复的年龄上限（6h）。超龄工单不自动跑，留待 `/work requeue <id>` 人工确认 |
| `work_graph.resume_limit` | 3 | 单次启动最多自动恢复的工单数，防止重启风暴把历史积压一次性拉起来 |
| `work_graph.state_backend` | "jsonl" | **事实存储后端**（2026-11-05 Step 9）：`jsonl` = 逐行日志（默认，行为与之前逐字一致）；`sqlite` = `node:sqlite` 单表 `journal(seq, at, body)` + WAL，压缩在事务内完成（需 Node >= 22.5，不可用时显式配置会报可读错误，不静默回落）。只覆盖工单/指派账本；检查点在任何后端下仍是 per-assignment JSONL；切换后端**不迁移**旧账本，旧文件原样保留 |
| `watchdog.stall_minutes` | 15 | **工单停滞阈值**（2026-11-05）：看门狗心跳里 `working` 工单超过该分钟数无推进（`now − max(updatedAt, startedAt)`）就点名到 prompt 顶部，只报告不自动取消/重跑 |
| `watchdog.drift_repeat` | 6 | **Worker 漂移判据一**（2026-11-05）：最近 N 次工具调用全是同一个工具即报 `tool_repeat`（反复读同一文件/重试同一命令），只报告不建议自动中断 |
| `watchdog.drift_rounds` | 18 | **Worker 漂移判据二**：轮次达到该值且工具步 ≤1 即报 `round_spin`（模型原地打转）。漂移与停滞都只进看门狗简报，处置由看门狗会话或人工 `/work` 决定 |
| `router_role.enabled` | false | **Router 角色**（2026-11-04）：主进程收窄为调度层（工具面只留委派/检索/提问），名单外工具在准入链硬拒；子进程恒为 worker，防递归分派。开启需重启 |
| `router_role.allow` | [] | Router 工具名单追加项（只增不减，`spawn_agent` 不可移除） |
| `delegate_memory_inject` | false | **委派全局上下文**（2026-11-05）：`spawn_agent` 派发前按任务查语义记忆 top 3 + 同角色共享板近 2 条，以 `[全局上下文] …` 前缀拼进 worker 消息（≤800 字符）。默认关；开启后跨会话关键信息随分派共享，注意内容会进入 worker 子进程提示词 |

### 权限与可访问范围（2026-11-08 补）

> 这一组是**审批档位与沙箱**，和 `security` 段不是一回事。`security` 管命令黑名单，
> 这里管"它能碰哪些文件、要不要先问你"。改档位**必须写在这里并重启**：UI 上的
> 「完全权限」开关只改内存，重启即还原。

| 字段 | 默认 | 说明 |
|------|------|------|
| `approval_mode` | `on-request` | 审批策略：`on-request`（有风险才问）/ `never`（不问直接做）/ `unless-trusted`（可信工具外都问）。**`never` 下 `riskLevel: high` 的工具会被降级拒绝**，除非同时满足下一条 |
| `sandbox` | `workspace-write` | 可访问范围：`read-only`（只看）/ `workspace-write`（工作区内读写）/ `danger-full-access`（**整机不限路径**） |
| `auto_approve_high_risk` | false | `high` 风险工具（`run_command` 就是）免确认。**不开这个，`never` 档位下跑命令会被直接拒绝**——这是"选了完全权限却什么都跑不了"的原因 |
| `workspace_allow` | `[]` | **额外允许的目录**（绝对路径数组）。不开整机权限时用这个给中间档位：`["C:\\Users\\me\\Desktop"]` 让 `workspace-write` 也能读写桌面。工具层与权限层都会认它 |

三种典型组合：

```jsonc
// A. 默认：只动工作区，写/执行前问你
"approval_mode": "on-request", "sandbox": "workspace-write"

// B. 工作区 + 桌面（推荐给"想让它整理桌面又不想全放开"的场景）
"approval_mode": "on-request", "sandbox": "workspace-write",
"workspace_allow": ["C:\\Users\\me\\Desktop", "D:\\项目"]

// C. 完全放开：整机不限路径，命令不问直接跑
"approval_mode": "never", "sandbox": "danger-full-access", "auto_approve_high_risk": true
```

`critical` 级能力任何组合下都不放行；`.ppx/audit-hmac-key`、`data/http-token`、
`config/ppx.json` 的**读**始终被拦（与沙箱无关）。

## budget（预算与计费，2026-11-12）

用量账本（`data/usage-stats.json`）按 `src/llm/pricing.js` 的内置价格表折算金额。内置表是公开目录价快照，**不是账单**：厂商改价/上新模型后需要覆盖。

| 字段 | 默认 | 说明 |
|------|------|------|
| `usd` | 0 | 累计支出上限（美元）。`0` = 不限；达到后 `chat` / `chatStream` 拒绝继续调用并返回预算提示。按进程累计，重启从 `usage-stats.json` 恢复 |
| `model_prices` | {} | 覆盖内置价格表。键为模型前缀（精确命中优先，其次最长前缀），值为 `{prompt, completion, cached?, currency?, peak?, tiers?}`。国内厂商可直接写人民币：`{"glm-4.7": {"prompt": 2, "completion": 8, "cached": 0.4, "currency": "CNY"}}` |
| `assume_price` | null | 未定价模型的兜底单价（USD / 1M tokens，形如 `{prompt: 1, completion: 3}`）。不配时未定价模型按 `$0` 记账，但会写入账本 `unpriced`、进程内告警一次，并在「使用统计」页/状态条标出 —— 不要把 `$0` 误当免费 |

价格表支持三类 2026 年后的计价规则：**峰谷**（DeepSeek 工作日高峰价 `peak`）、**输入长度阶梯**（GLM-4.7 / Qwen-Plus 的 `tiers`，按单次请求取档）与**缓存命中价**（`cached`）。内置快照的日期/汇率写在 `PRICING_META`；`node scripts/pricing-audit.js` 可打印全表并核对预设覆盖（`--check` 已接入 `npm run verify`）。

## audit（审计链）

| 字段 | 默认 | 说明 |
|------|------|------|
| `lifecycle_events` | true | **调度生命周期入链**（2026-11-05）：`TICKET_*` / `ASSIGNMENT_*` / `DELIVERY_*` 事件以白名单字段（ticketId / status / worker / assignmentId / origin / route）追加进 SHA-256 哈希链；`text/result` 不入链。配置文件可不写（缺省即开启），`false` 关闭 |

## user

| 字段 | 默认 | 说明 |
|------|------|------|
| `name` | 兄弟 | 如何称呼用户 |

## memory（记忆）

| 字段 | 默认 | 说明 |
|------|------|------|
| `decay_per_day` | 0.02 | L1 记忆高斯衰减率（snake 键，实际生效） |
| `hit_bonus` | 5 | 命中加分（实际生效） |
| `base_importance` | 10 | 基础重要性（实际生效） |
| `forget_speed` | 1 | 遗忘速度（实际生效） |
| `max_history_items` | 40 | 会话历史条数上限 |
| `history_token_budget` | 4000 | 会话历史 token 预算（超阈值触发压缩） |
| `context_window` | 8192 | 上下文窗口兜底（未知窗口时保守默认，溢出防护用）|
| `context_window_ratio` | 0.6 | 历史+工具结果占用上下文窗口的安全比例上限 |
| `max_facts` | 1000 | L1 记忆总量上限 |
| `session_max_age_days` | 30 | 会话日志保留天数（启动时清理过期会话，0=不清理） |
| `enabled` / `token_budget` / `compile_threshold` | — | **预留字段，当前代码未读取**（记忆开关/注入预算/场景聚类阈值暂未实现） |

## embedding（可选，向量检索）

配了才能走 dense 语义检索（否则纯 BM25）：

| 字段 | 说明 |
|------|------|
| `base_url` | embedding 端点 |
| `api_key` | key |
| `model` | embedding 模型名 |

## experience / selfheal / tools / plugins

| 字段 | 默认 | 说明 |
|------|------|------|
| `experience.enabled` | true | 经验库开关（预留，经验库常开） |
| `selfheal.enabled` | true | 启动自愈体检（兼容保留，自愈由命令显式触发） |
| `selfheal.check_interval_ms` | 60000 | 自愈检查间隔（预留，未接入配置定时器） |
| `tools.enabled` | true | 工具系统开关 |
| `tools.custom_dir` | custom-tools | 自定义工具目录 |
| `tools.disabled` | [] | 需禁用的工具名列表（Web 设置页「启停」写盘） |
| `plugins.dir` | plugins | 插件目录 |

## mcp（MCP 工具服务器）

| 字段 | 说明 |
|------|------|
| `servers` | MCP 服务器列表（`{command, args}` 走 stdio，或 `{url}` 走 HTTP） |
| `auto_connect` | 启动时是否自动连接 |

## channels（通道）

统一走 `ChannelManager` 注册表，推荐用 `ppx channels` 命令自助配置（交互式引导 + 连通性测试），配置最终落在这里。

| 字段 | 说明 |
|------|------|
| `http.enabled` / `http.port` / `http.host` / `http.auth_token` | HTTP 通道（空 token 时启动自动生成随机 token） |
| `http.cors_origin` | CORS 来源策略。**2026-10-31 默认收紧**：未配置 = `same-origin` 严格模式（跨源带 Origin 的一律 403，非浏览器请求与 Web UI 自身不受影响）。显式放开：`"*"` / `[]` / 白名单数组 `["http://localhost:3000"]`（旧写法全兼容） |
| `feishu.appId` / `appSecret` / `verifyToken` / `webhookPath` | 飞书通道（事件订阅回调） |
| `wechat.path` / `token` / `encodingAESKey` | 企业微信回调（收消息） |
| `wechat.corpId` / `corpSecret` / `agentId` | 企业微信主动推送（发消息） |
| `telegram.botToken` | **Telegram 通道（2026-11-14 新增，long polling）**：找 @BotFather 创建 bot 取 token（也可用环境变量 `TELEGRAM_BOT_TOKEN`）。getUpdates 长轮询，不需要公网 webhook |
| `telegram.api_base` / `poll_timeout_seconds` / `poll_interval_ms` | API 端点（自建代理可改） / 长轮询秒数（1-60，默认 50） / 空轮询间隔与失败退避基数 |
| `telegram.allowed_chats` | 渠道级首道白名单（逗号分隔 chat_id，空=不限）；群/发送者细粒度黑白名单仍走跨渠道 `agent.trigger_policy` |
| `log.enabled` / `log.target` | 日志 dummy 通道（输出到 stdout，验证主动提醒契约用） |

> **token 下发边界（2026-11-13）**：`/api/bootstrap` 与首页注入只在“回环 + 可信 Host/Origin + 浏览器形态（Sec-Fetch-* 或同源 Referer）”时返回 `auth_token`。Node/脚本客户端（包括 agent 自己的 `browse` 兜底抓取）不再拿到凭据；Web UI 与 Electron 正常导航不受影响。

每个通道的 `test()` 做真实连通性探测：`ppx channels test <name>`（如飞书实际换取 tenant_token）。

### delivery（渠道投递队列，2026-10-31 新增）

主动提醒/广播（`broadcast`）此前是 fire-and-forget —— 飞书/企业微信 API 限流一次、网络抖一下，提醒就永远丢了（连"丢了"都不可见）。现在经投递队列：**失败指数退避重试 → 过期丢弃 → WAL 续投**，全部可观测。入站回复不排队（用户在等，直发）。

| 字段 | 默认 | 说明 |
|------|------|------|
| `delivery.enabled` | true | false = 回退旧同步直发（await 即发送完成） |
| `delivery.retry_max` | 3 | 首发后的最大重试次数（总尝试 = 1 + retry_max） |
| `delivery.backoff_ms` | 2000 | 首次退避，之后指数 ×2（2s→4s→8s，上限 60s） |
| `delivery.ttl_ms` | 3600000 | 入队超 1h 未投出即丢弃 —— 提醒过期即噪音，重试期间也检查 |
| `delivery.max_queue` | 200 | 积压上限，超限丢最旧（宁可丢旧不可挤爆） |
| `delivery.wal` | true | WAL 落 `<dataDir>/channels/delivery.wal.jsonl`；重启 replay 续投未送出的，已终态的打 done 标记不重发，启动时压缩 |
| `delivery.jitter_ratio` | 0.1 | 退避抖动比例（±10%），避免多通道/多实例同一时刻重撞；0 = 精确指数退避 |
| `delivery.dead_letter` | true | 终态失败的消息落 `<dataDir>/channels/delivery.dead.jsonl`（完整正文/元数据/原因） |
| `delivery.dead_letter_max` | 50 | 内存死信环上限（最近 N 条完整现场，`deliveryStats().deadLetters`） |

**排队语义**：按通道分组执行 —— 组内串行（同通道消息有序，不并发重发），组间并行（某通道 send 挂起不阻塞其它通道的重试周期）。`mgr.broadcast()` 返回入队回执 `[{channel, id, queued}]`，**不等发送完成**；`mgr.deliveryStats()` 暴露 pending/sent/failed/dropped/retried 与最近 10 条终态失败原因。测试同步断言用 `await mgr.delivery.idle()`。

## security（安全）

| 字段 | 默认 | 说明 |
|------|------|------|
| `allow_all` | false | 放开命令白名单（危险）。**2026-10-31 起不能经 HTTP API 修改**（`PUT /api/settings` 显式 400）—— 只能编辑 config/ppx.json 后重启生效，防 bearer token 泄露即整体放开 |
| `command_timeout_ms` | 30000 | 命令执行超时（`run_command` 单次可传 `timeout_ms` 覆盖；后台任务默认 10 分钟、上限 1 小时） |
| `escalation_ttl_minutes` | 0 | 提权 TTL 自动回落（分钟，0=关闭）。开启后权限放宽（如切到"完全权限"）N 分钟自动回落到提权前档位并通知；回落走 tracer + 审计哈希链留痕。默认关闭——即时生效语义不变（2026-11-03 决策），给想要兜底的部署 opt-in |
| `max_output_bytes` | 8388608 | `run_command` 输出缓冲上限（默认 8MB；超限前保留已有 stdout/stderr，不再把 `maxBuffer` 溢出当成命令失败） |
| `code_act` | false | CodeAct 脚本出口（默认关闭，需显式开启） |
| `computer_control` | false | 桌面控制工具 `computer`（截图/鼠标/键盘/打开程序/窗口/剪贴板，仅 Windows）。默认关闭——开启后模型可代你点击和输入 |
| `deny` | [] | 用户自定义拦截规则（glob 风格，如 `"git push --force*"`），命中后即使 `allow_all` 也拒绝 |

命令守卫三层防线（吸收 Hermes approval 机制）：**用户 `deny` 规则 → 硬黑名单（`rm -rf /`、fork bomb、写裸设备、`curl|sh` 等，`allow_all` 也拦）→ 常规高危黑名单 + 前缀白名单**。检测前先做反混淆规范化（去引号/合并空白），`rm ""-rf /` 这类引号技巧无法绕过。命中拦截会提示 agent 不要重试或改写绕过；同一会话内同一命令再次出现会被硬短路（权限配置变更后签名变化，不会误伤）。

### 长任务后台执行（2026-11-13 新增）

`run_command` 适合 ≤30s 的命令；`npm test` / 构建 / GUI 冒烟这类长任务用 **`run_background`**：

- `run_background({command, timeout_ms})`：启动前同样过命令守卫 / 会话自写脚本 / 包清单三道闸门，立即返回 `job id`、`pid`、日志路径；不占用工具轮次。
- `job({action:"status"|"output"|"list"|"kill", id})`：读状态与尾部输出（`output` 支持 `offset`/`limit` 分页），需要停止时 `kill`。
- 日志落 `dataDir/jobs/<id>.log`，单文件封顶 10MB；`read_file` 将其列为受保护路径，只能经 `job` 工具读取。
- 子进程不 detach，进程退出时统一终止；跨重启不续跑（需要跨重启请用 `add_schedule`）。

### Windows 命令兼容（2026-11-13）

- 末尾的 `| tail -N` / `| head -N` 在 Windows 上由内置截取器处理，不再把 `tail` 丢给 `cmd.exe`。
- `findstr` 退出码 1 且无输出 = “无匹配”正常负结果，不再记为命令故障。
- 本地 shell 以 Buffer 捕获输出，UTF-8 解码失败时回退 GBK（Node 全量 ICU），修复 CP936 乱码。
- 失败命令保留 stdout/stderr（不再只回 “Command failed” 外壳），并把 `execFile` 超时透传为 `timedOut`。

### 桌面控制（2026-11-03 新增）

`security.computer_control: true` 开启 `computer` 工具（仅 Windows）。它把宿主桌面变成可操作面：

| 动作 | 说明 |
|---|---|
| `screens` / `screenshot` | 显示器布局 / 全屏截图落 `<workspace>/data/ui-shots/desktop-*.png`，可直接 `read_image` 查看 |
| `move` / `click` / `drag` / `scroll` | 鼠标移动、点按（左/右/中、双击）、拖拽、滚轮；坐标用截图的虚拟屏像素坐标 |
| `type` / `key` | 文本输入（走剪贴板+Ctrl+V，支持中文）/ SendKeys 组合键（如 `{ENTER}`、`^s`） |
| `open` | 打开网址 / 文件 / 程序；**拒绝解释器 + 参数**（`powershell -enc` 这类任意脚本入口） |
| `windows` / `activate` | 列出可见窗口 / 按 pid 或标题子串切到前台 |
| `clipboard_get` / `clipboard_set` | 读写剪贴板（单次上限 4000 字符） |

实现是**固定动作 + 内置 PowerShell 脚本**（`-EncodedCommand` 传入，零 npm 依赖），模型只能选动作和填参数，不能提交任意脚本。典型用法：`screenshot` → `read_image` 看清屏幕 → 按截图坐标 `click` → 再截图确认结果。

**风险声明**：这是本仓库权限最大的一件工具（等价于"替用户操作电脑"）。只在你自己信任的会话里开启；被提示注入的模型能借它点击和输入。默认 `false`，且不受 `allow_all` 影响。

### shell 执行环境（2026-10-31 新增）

| 字段 | 默认 | 说明 |
|------|------|------|
| `shell_provider` | `local` | 命令执行环境：`local`=宿主 shell 直执行；`docker`=容器沙箱（放行后的执行由内核边界兜底，判定遗漏不再穿透） |
| `docker.image` | `node:22-bookworm` | 容器镜像（官方 node 镜像自带 git/python3/g++，覆盖常见构建命令） |
| `docker.network` | `none` | 容器网络：`none`=断网（默认）；`bridge`=允许联网 |
| `docker.memory` / `docker.cpus` / `docker.pids_limit` | `1g` / `2` / `256` | 资源上限 |
| `docker.user` | "" | 容器内 uid（如 `"1000:1000"`）；空=镜像默认。Linux bind-mount 写入需与宿主 uid 匹配时设置 |
| `docker.env_pass` | `["LANG","LC_ALL","TZ"]` | 宿主环境变量透传白名单（**默认零透传**，防密钥入容器；不要透传 PATH） |
| `docker.missing` | `fallback` | Docker 不可用时：`fallback`=回退本地执行+一次性告警；`error`=命令 fail-closed 报错 |
| `docker.bin` | `docker` | docker 可执行文件名/路径 |

**Docker 模式语义**：workspace bind-mount 到容器 `/workspace` 并作为 cwd（命令用相对路径即可，文件改动实时落回宿主）；每条命令 `docker run --rm` 起一次性容器 —— 文件副作用经挂载持久，**容器内全局状态不跨命令持久**（要装依赖请装进 workspace，`node_modules` 在挂载里天然持久）；cwd 必须在 workspace 内（越界 fail-closed）；宿主侧数组形式 execFile，命令串不经宿主 shell 解析。

**边界如实声明（2026-11-14 更新）**：`code_act`（默认关闭）已接入 shell seam —— docker 模式下脚本真正在容器内执行（临时脚本落 workspace 挂载内，回执带 `[execEnv: docker 容器沙箱]` 标注），本地模式保持进程级约束；文件工具（read_file/write_file）本就在进程内走宿主文件系统，与容器经挂载看到的是同一份磁盘。容器联网需求（如 `pip install`）：把 `docker.network` 设为 `"bridge"`，代价是放弃断网默认值。

## voice（语音：TTS / ASR）

TTS 开箱即用（Windows SAPI / macOS say / Linux espeak）。ASR 双路：

| 键 | 默认 | 说明 |
|---|---|---|
| `voice.asr.backend` | "cloud" | `"local"` 时走本地 whisper 二进制；缺省（或任意非 local 值）+ `base_url`+`api_key` = 云端 |
| `voice.asr.base_url` / `voice.asr.api_key` | — | 云端 OpenAI 兼容 `/audio/transcriptions` 端点 |
| `voice.asr.model` | `whisper-1` | 云端模型名 |
| `voice.asr.bin` | — | **本地必填**：whisper 可执行文件（openai-whisper 的 `whisper`，或 whisper.cpp 的 `whisper-cli`） |
| `voice.asr.flavor` | `cli` | `cli`=openai-whisper 参数风格；`whispercpp`=whisper.cpp（需 `model_path` 指向 ggml 模型文件） |
| `voice.asr.model_path` | — | 本地模型文件（whispercpp 必填；openai-whisper 可传 .pt 路径） |
| `voice.asr.timeout_ms` | `120000` | 本地转写超时 |
| `voice.asr.language` | — | 识别语言（如 `zh`），可被调用参数覆盖 |
| `voice.asr_fallback` | — | 可选兜底块（与 `asr` 同构）：主路（asr）失败时自动切换，回执 `engine` 注明 `(fallback)` |

转写统一走 `transcribeAudio`（`voice_transcribe` 工具与 Web 端 `/api/voice/transcribe` 同一实现）；缺配置时诚实报错给指引，不编结果。

## hooks（用户配置钩子，2026-10-31 新增）

吸收 claude-code settings.json hooks 格式。此前钩子链只能代码注册（安全闸/记账等内置钩子），用户没有任何配置入口；现在可配置命令钩子，在钩子链事件点上执行任意命令。实现见 `src/hooks/user-hooks.js`。

```json
{
  "hooks": {
    "trust_project_roots": ["D:/work/myproj"],
    "PreToolUse": [
      { "matcher": "run_command|write_file",
        "hooks": [ { "type": "command", "command": "node scripts/guard.js", "timeout": 10, "fail_closed": false } ] }
    ],
    "PostToolUse": [
      { "hooks": [ { "type": "command", "command": "node scripts/annotate.js" } ] }
    ]
  }
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `<Event>` | — | 事件名同内置六事件：`PreToolUse` / `PostToolUse` / `PreCompact` / `PostCompact` / `SessionStart` / `SessionStop` / `SubagentStop`。值为钩子组数组 |
| 钩子组 `matcher` | "" | 工具名匹配（仅 PreToolUse/PostToolUse 有意义）：正则整词匹配（`"run_command\|write_file"`），空=匹配全部 |
| 钩子组 `hooks` | — | 该组命令列表。`type` 仅支持 `"command"`；`command` 为 shell 命令串；`timeout` 秒（默认 10，上限 120）；`fail_closed` true 时故障/超时=拒绝（仅 PreToolUse 有否决语义，默认 false） |
| `trust_project_roots` | `[]` | 允许加载项目级钩子的项目根白名单（见下） |

**执行契约（claude-code 语义）**：命令经 shell 执行（cwd=项目根，env 注入 `PPX_PROJECT_DIR`），载荷 JSON 从 **stdin** 喂入 `{ hook_event_name, tool_name, tool_input, tool_result, cwd, ...原始 payload }` —— 模型数据不走 argv，命令串不经模型之手，无注入面。**退出码 0**：stdout 可选 JSON —— PreToolUse `{"decision":"block","reason"}` 否决 / `{"args":{...}}` 改参（链式传递，agent 落地）；PostToolUse `{"additionalContext"}` 附加进模型上下文；非 JSON stdout=放行。**退出码 2**：blocking error（stderr 喂回作否决理由；非 PreToolUse 事件记错误不阻断）。其它退出码/spawn 失败/超时：记为该钩子错误，默认不阻断链；用户钩子排在系统钩子（安全闸）之后（priority 200）。无效配置（未知事件名/非法正则/空 command）启动时逐条告警，不静默、不阻断。

**两级来源与信任模型**：
- **引擎配置**（config/ppx.json；npm 装机时 `~/.ppx/config.json`）的 `hooks` —— 用户自己写的，与 `api_key_cmd`（配置里配执行命令）同信任级，默认生效。
- **项目级 `.ppx/settings.json`** 的 `hooks` —— 随仓库分发 = 不可信输入，**默认不加载**；仅当项目根出现在 `trust_project_roots` 白名单（在引擎配置里，仓库改不了自己）才注册，未信任时启动日志显式说明。残余风险：信任后仓库仍可改钩子内容 —— 与信任整个仓库代码同级，信任前请先看一眼 `.ppx/settings.json` 内容。

## update（自动更新，2026-10-31 新增）

发布只靠用户手动盯 Releases 意味着装了旧版的人永远不知道新版出了 —— 这里补上"检查 + 提示 + 一条命令升级"。实现见 `src/services/update.js`，零依赖（网络走 `proxiedFetch`，代理/镜像自动兜底）。

| 入口 | 行为 |
|------|------|
| `ppx update` | 检查并升级：npm 装机 → `npm install -g ppxans-harness@<最新版>`（跑完提示重启生效）；源码装机 → 打印 `git pull` + `npm install` 指引（**不代跑**，本地改动不可被覆盖） |
| `ppx update --check` | 只查不装 |
| 启动通知 | CLI REPL 启动后台检查（非阻塞，不打扰对话），有新版出一行提示 |
| `ppx doctor --net` | "版本"一项显示最新版/已是最新（只提示，不算体检失败项） |
| 桌面端 | 启动后查 GitHub Releases（24h 缓存），有新版弹系统通知点击进下载页。**只提示不代装** —— 安装包未签名时静默自装会撞 SmartScreen，且不引入 electron-updater 重依赖 |

## skills（技能源，2026-10-31 优先级反转）

方法技能 = 目录 + SKILL.md。多根装配，**优先级：项目级 > 用户级 > 内置 > 附加目录**（roots 顺序即优先级，同 id 先到的根胜出）。2026-10-31 队列⑥之前顺序是内置优先 —— 用户/项目放同 id 技能形同虚设；且 agent 主路径只扫内置单根，用户级/项目级技能根本不可见，本轮一并接线。

| 字段 | 默认 | 说明 |
|------|------|------|
| `skills.project_dir` | `<工作目录>/.ppx/skills` | 项目级技能根（与 `.ppx/commands` 同锚点）。`""` 显式关闭 |
| `skills.user_dir` | `~/.ppx/skills` | 用户级技能根（跨项目复用）。`""` 显式关闭 |
| `skills.builtin` | true | 随包内置技能（`skills/`）。false 关闭（配置误用时兜底仍留内置） |
| `skills.extra_dirs` | [] | 附加根（团队共享盘/下载的技能包），优先级最低 |
| `skills.max_depth` | 2 | 目录层级深度（1=只认 `skills/<skill>/`，2=额外认 `skills/<domain>/<skill>/`） |

**写入根**（create_skill / refine_skill / 技能导入落盘处）：可写根中第一个 = 项目根，其次用户级；**内置根只读** —— 用户产物不写进代码树（npm 装机时内置根在 node_modules 里，升级替换包目录即冲掉）。若项目里已有同 id 技能，create_skill 写项目根即自然覆盖。

检查语义：npm 通道查 `registry.npmjs.org/ppxans-harness/latest`（`PPX_UPDATE_REGISTRY` 可换镜像），桌面通道查 GitHub Releases latest tag；结果缓存 `<dataDir>/update-check.json` 默认 24h 一次；响应版本号先过 semver 形状校验再进展示/比较；网络/解析失败一律静默降级（显式 `ppx update` 除外，会给出代理/镜像配置提示）。`PPX_UPDATE_CHECK=0` 关闭启动通知与 doctor 检查，**不影响显式 `ppx update`**。

## 环境变量

| 变量 | 说明 |
|------|------|
| `PPX_DATA_DIR` | 数据目录（记忆/会话/经验落盘位置，覆盖默认 root/data） |
| `PPX_AGENT_GLOBAL_DATA_DIR` | 全局共享数据目录（跨 agent 经验库，默认同 dataDir） |
| `PPX_AUTH_TOKEN` | HTTP 认证 token |
| `PPX_PORT` | HTTP 端口 |
| `PPX_AGENT_DATA_DIR` | 军团 worker 的独立数据目录 |
| `PPX_UPDATE_CHECK` | `0` = 关闭更新检查/启动通知（`ppx update` 显式命令不受影响） |
| `PPX_UPDATE_REGISTRY` | 更新检查的 npm registry 覆盖（国内镜像如 `https://registry.npmmirror.com`） |

## 数据目录

默认数据目录是 `root/data`（源码运行时）。**npm 全局/本地安装**（包在 `node_modules` 里）时自动外置到 `~/.ppx`，避免卸载丢数据。可用 `PPX_DATA_DIR` 显式指定。
