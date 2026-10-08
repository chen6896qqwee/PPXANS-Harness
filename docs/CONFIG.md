# 配置说明

皮皮虾的配置在 `config/ppx.json`（或 `config/ppx.yaml`）。所有字段都有默认值，未写的字段自动用默认兜底（见 `src/config/index.js` 的 `DEFAULT_CONFIG`）。环境变量可覆盖部分项。

## 快速开始

最少配置：只设一个模型 API key 环境变量即可跑，其余全默认：

```bash
export OPENAI_API_KEY="sk-..."      # 或 DEEPSEEK_API_KEY / DASHSCOPE_API_KEY / VOLCENGINE_API_KEY
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
| `model` | 模型名 |
| `vision` | `true` 标记为视觉模型（多模态读图时路由到此） |
| `timeout_ms` | 超时（毫秒，默认 120000）。**item 级字段**：默认值硬编码在 `src/llm/client.js`（`provider.timeout_ms \|\| 120000`），没有全局 `provider.timeout_ms` 组，要改就逐项配 |
| `retry_max` | 单次调用内瞬态错误重试次数（默认 3）。同为 item 级字段（`provider.retry_max ?? 3`） |
| `context_window` | 上下文窗口（token）。agent 据此收紧会话历史预算，防本地小模型溢出（未配置回退 memory.context_window） |

> **引擎底座（v2.5.0 起）**：仅自研 http 底座，`openclaw` / `deepseek` / `dsh_root` / `mjs` / `.deps/` 相关字段与配置已全部移除。多厂商接入 = 配多个 http provider（OpenAI/DeepSeek/火山/通义/智谱/本地 lmstudio/ollama/vLLM），router 按 key 顺序回退。

## agent（智能体）

| 字段 | 默认 | 说明 |
|------|------|------|
| `name` | 皮皮虾 | 智能体名字 |
| `yuan` | ppx | 内部代号 |
| `localIntent` | true | 本地意图预判（高置信简单指令不调 LLM，省成本） |
| `mode` | react | 编排模式：react / single / plan-exec / router / blackboard / graph / legion |
| `citation_rule` | 引用规则 | 让 LLM 引用来源的规则文本 |
| `system_extra` | "" | 追加的 system prompt 内容 |
| `values` | 4 条默认 | **核心价值（ANS 价值对齐）**，注入 system 最前（【核心价值·不可违背】），自定义数组直接覆盖默认 |
| `proactive.enabled` | true | **主动任务生成**开关，开启后定时扫描记忆生成主动提醒（默认开：1h 扫描一次，无待办不打扰、24h 去重，实测不构成打扰；嫌吵可关） |
| `proactive.interval_ms` | 3600000 | 主动提醒间隔（毫秒） |
| `max_tool_rounds` | 8 | 工具循环最大轮次（防无限工具调用） |
| `tool_result_budget` | 4000 | 工具结果裁剪预算（超长结果保留头尾，防撑爆上下文） |
| `max_tool_error_retry` | 2 | 工具错误喂回模型修正的重试次数 |
| `tool_timeout_ms` | 30000 | **全局默认工具超时**（工具未声明 `timeoutMs` 时兑底，防单个慢工具卡死对话；工具级 `timeoutMs` 优先；0=不限时）。超时触发 `tool/timeout` trace 事件（含 elapsedMs/budgetMs/retried），是熔断/自适应预算的数据基础 |
| `approval_mode` | on-request | 权限引擎审批档位（`src/permissions`）：never / on-request / unless-trusted |
| `approval_timeout_ms` | 120000 | 等待人工裁决审批的时限；超时=拒绝（不静默放行） |
| `approval_cache` | true | 会话内同命令批准过不再重复 ask（拒绝/超时永不入缓存） |
| `approval_headless_wait` | false | 置 true 才在无审批入口时继续等 `approval_timeout_ms`。默认 false：进程没有 Web UI/`ppx-serve` 在听时**立即拒绝**并把可执行的下一步写进工具错误——原先的 120 秒死等只会烧光任务时间预算，返回的"审批被拒绝或超时"对模型毫无指导性 |
| `sandbox` | workspace-write | 权限引擎沙箱档位（`src/permissions`）：read-only / workspace-write / danger-full-access。默认只允许工作区内写，路径越界拒绝 |
| `network_access` | true | 沙箱是否放行网络访问（`=== false` 才关；关掉不拦宿主已建连接，只作策略标记） |
| `permission_rules` | [] | 用户自定义规则链 `[{pattern, action}]`（opencode 风格，有序 last-match-wins），在内置黑名单之外追加 |
| `capability_gate` | true | 能力闸门（工具调用先过 `src/permissions` 判定）。`=== false` 才旁路；默认开是因为闸门是审批/沙箱的唯一入口 |
| `auto_approve_high_risk` | false | 高危操作自动批准（危险，默认关；只在受信环境显式置 true） |
| `guardAllowList` | [] | 免疫闸门（`installGuard`）豁免名单，命中的工具/命令不被熔断器拦 |
| `turn_projection` | true | 每轮生命周期投影（chat/turn/* 事件，纯可观测），`=== false` 整体旁路 |
| `explore_break_limit` | 3 | 探索熔断：连续 N 轮只有只读/查询无产出即打断（`src/core/policy.js`；0 或非数字回落 3） |
| `repeat_flag_limit` | 2 | 同一工具+args 命中 N 次开始警告重复（防模型原地打转） |
| `parallel_tool_calls` | true | 同轮独立工具并发执行（`=== false` 回退串行；工具间有依赖时串行更稳） |
| `health_cache_ms` | 30000 | provider 健康探测结果 TTL 缓存（每轮 chat 全量探活会叠加串行延迟；0=关闭缓存） |
| `stats_cache_ms` | 2000 | `/api/stats` 聚合 TTL 缓存（原实现每次请求同步聚合整份 JSONL，高频轮询重复付全量成本；0=关闭） |
| `evolve.enabled` | true | 自进化提炼开关（定时从工具调用记录提炼经验），`=== false` 关 |
| `evolve.every_calls` | 20 | 每 N 次工具调用触发一次提炼（太小=烧辅助 LLM 成本，太大=经验沉淀滞后） |
| `evolve.min_interval_ms` | 30000 | 两次提炼最小间隔（与 every_calls 双闸，防空转） |
| `evolve.upgrade_uses` | 3 | 技能用满 N 次自动升级成熟度（用中自进化） |
| `legion.default_size` | 2 | legion 模式默认军团规模（旧 `config.orchestrator.size` 仍可用，新键优先） |
| `legion.max_concurrent_agents` | 8 | **进程级子智能体并发硬上限**（同时存活的子 agent 进程数）。嵌套委派共享同一份配额 —— 该值不随层级翻倍。运行期可用 `legion_set_concurrency` 改 |
| `legion.max_concurrent_per_call` | 4 | 单次 `spawn_agent` / DAG 层内 的最大并行宽度（与全局上限解耦：全局管"总盘子"，这里管"一次吃多少"） |
| `legion.queue_timeout_ms` | 300000 | 排队等并发槽位的耐心；超时返回可行动错误而不是无限挂起 |
| `legion.delegate_timeout_ms` | 120000 | 单个子任务最长等待（原 `tools/delegate.js` 硬编码常量，现可配） |
| `legion.kill_on_finish` | true | 委派结束回收子进程（`=== false` 仅供调试；长跑进程里不回收会线性堆积） |
| `boundary.enabled` | true | **能力边界护栏总开关**。关掉则静态边界块与高风险域动态护栏都不注入（不建议关） |
| `boundary.high_risk_domains` | `["medical","legal","finance","security","compliance"]` | 高风险域白名单：命中即要求人类监督。可按行业增删（如加自定义域需同时在 `src/ans/boundary.js` 的 `RISK_PATTERNS`/`HIGH_RISK_RULES` 补规则） |
| `boundary.require_human_review` | true | 关键决策交回人类把关（置 false 只去掉"不做最终决定/交回人类"的话术，不影响域判定与只读专家约束） |
| `boundary.extra_limits` | [] | 用户自定义追加的边界条款，逐条注入 system 静态区 |

## skills（技能库，v3.2.3+）

| 字段 | 默认 | 说明 |
|------|------|------|
| `builtin` | true | 随包分发的内置技能库（`skills/`），12 个能力域 |
| `user_dir` | `~/.ppx/skills` | **用户级技能根**（跨项目复用；空串 = 关闭）。用户同名技能覆盖内置，且不会被升级冲掉 |
| `project_dir` | "" | 项目级技能根（空 = 关闭） |
| `extra_dirs` | [] | 附加技能根（团队盘 / 从 GitHub 下载的技能包集），优先级最低 |
| `max_depth` | 2 | 领域层级深度：`2` 支持 `skills/<domain>/<skill>/`；`1` 退回只认扁平 `skills/<skill>/` |
| `prompt_hot_shown` | 8 | system prompt 里附上描述的"常用技能"条数（按使用次数排序；名册本身**全量**列出，不截断） |
| `prompt_desc_cap` | 120 | 常用技能单条 description 截断长度 |

装载顺序 = 优先级：`builtin → user_dir → project_dir → extra_dirs`（同 id 先到先得）。新技能落盘位置 = 第一个可写根（`SkillLoader.writeDir`，默认内置 `skills/`）。

## experts（专家库，v3.2.4+ 吸收 TencentCloud/Octop）

专家从"代码里的常量"升级为**可分发的内容资产**：`experts/<id>/` 目录含 `manifest.json`（元数据）+ `SOUL.md`（角色职责正文，即人格骨架）+ 可选 `AGENTS.md`（作业准则）。服务启动时扫描建册，**加一个专家 = 加一个目录**，不改源码。

| 字段 | 默认 | 说明 |
|------|------|------|
| `builtin` | true | 随包分发的内置专家库（`experts/`），当前 10 个包 / 9 个市场类目 |
| `user_dir` | `~/.ppx/experts` | **用户级专家库根**：自己加包、或 `expert_pack_install` 装第三方包都落这里，升级不动内置库（空串 = 关闭） |
| `project_dir` | "" | 项目级专家库根（空 = 关闭） |
| `extra_dirs` | [] | 附加专家库根（团队共享盘），优先级最低 |

装载顺序 = 优先级：`builtin → user_dir → project_dir → extra_dirs`（同 id 先到先得）。同 id 时内置打底、用户覆盖。

`manifest.json` 关键字段：`id`（= 目录名，小写字母/数字/横线，2-48 位）、`label.{zh,en}`、`description.{zh,en}`、`domain`（能力域，取值 = 12 个技能域 ∪ 5 个高风险域）、`category`（市场类目：assistant / engineering / content / data / office / knowledge / life / risk / meta）、`persona_mbti`（推荐人格码）、`skills`（**引用**技能库 id，不拷内容）、`readonly`、`requires_human`、`quick_prompts`、`task_examples`。

导入安全（`expert_pack_install`）：只收文本类扩展名（md/json/txt/yaml/csv/jsonl），单文件 512KB / 单包 4MB / 最多 60 文件；id 白名单 + 落点必须在目标根内（双保险）；**只写文件不执行内容**。

## personas（人格模板，v3.2.4+ 吸收 TencentCloud/Octop）

人格**不是配置项而是数据**：16 型 MBTI + default，每型带四轴维度（`ei/sn/tf/jp`，含极性强度）+ 六项行为映射（answer_style / casual_chat / conflict / creativity / emotion / planning）+ 中英名与昵称。**没有配置键** —— 上游的理由是"persona drift across users would make agent behaviour irreproducible"，改内容要改 `src/orchestrator/personas.js` 并重启。

渲染契约（`renderPersona`）：三变量 `{agent_name}` / `{user_display}` / `{custom}`；**persona 是骨架，`custom` 只做追加，不允许覆盖骨架**。未知人格码回落 default 而不抛错。

与专家的关系：**正交**。专家决定干什么（能力域 + 技能 + 只读约束），人格决定怎么说话。同一个专家可以配 INTJ 也可以配 ENFP。

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
| `ttl_days` | 90 | L1 默认存活期：超过该天数未访问的记忆在每日 02:00 排泄治理时**软归档**（`status=deleted`，可 `restore` 回滚，非硬删）。0 = 关闭 TTL 治理。条目自带 `ttlDays` 时以其为准 |
| `session_max_age_days` | 30 | 会话日志保留天数（启动时清理过期会话，0=不清理） |
| `wal` | true | L1 增量落盘 WAL：变更走追加日志（facts.json.wal）而非每次全量原子写，高频写场景显著减少磁盘写放大；崩溃后启动自动 replay 恢复。设 false 回退旧行为 |
| `walThreshold` | 50 | WAL 追加多少条后 compact 成全量快照（注意是 camel 键，与 FactStore 内部 opts 同名直传） |

> 记忆 token 预算由 `history_token_budget` 承载（上表）。旧版曾预留 `enabled` / `token_budget` / `compile_threshold` 三键但代码始终未读取，已移除（记忆常开、场景聚类 compile 未实现），避免配置谎报不存在的开关。

## embedding（可选，向量检索）

配了才能走 dense 语义检索（否则纯 BM25）：

| 字段 | 默认 | 说明 |
|------|------|------|
| `backend` | cloud | `cloud` = OpenAI 兼容 embedding 端点；`local` = transformers.js 本地向量（需自行安装可选依赖，见 `src/llm/local-embedder.js`） |
| `base_url` | ""（空=不启用） | embedding 端点 |
| `api_key` / `api_key_env` | "" | 直接填 key，或填环境变量名 |
| `model` | —（不代默认） | embedding 模型名。云端兜底 `text-embedding-3-small`、本地兜底 Xenova 小模型，两分支默认不同，故 DEFAULT_CONFIG 不代填，想用哪个显式配置 |

## budget（成本预算，v3.2.0+）

| 字段 | 默认 | 说明 |
|------|------|------|
| `budget.usd` | 0（不限） | **进程累计支出上限（USD）**。达限后 `chat`/`chatStream` 拒绝继续调用模型，返回含调整入口的提示；tracer/bus 发 `budget/exceeded` 事件。只拦用户入口，不拦后台 refine/记忆提炼（避免自学习断粮）。按进程累计，重启归零——跨进程持久预算属外部计量职责 |
| `budget.model_prices` | — | 模型价格覆盖（USD / 1M tokens）：`{"my-model": {"prompt": 0.15, "completion": 0.6}}`。优先级：精确命中 > 前缀命中（最长） > 内置表。未知模型 cost 记 0（不编数字），想纳入预算控制必须显式配置价格 |

内置价格表见 `src/llm/pricing.js`（glm / deepseek / gpt / claude / gemini / qwen / kimi 常用档，公开目录价快照仅供估算）。金额进 `data/usage-stats.json` 的 `cost` / `byModel.*.cost` 字段，每满 10 次调用自动落盘（崩溃最多丢 9 笔），退出兜底 flush。

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

## model_routing（辅助任务分层路由，可选）

| 字段 | 默认 | 说明 |
|------|------|------|
| `aux` | ""（空） | 辅助任务（记忆提取/摘要/压缩等非主对话调用）使用的 provider `id`。留空 = 辅助调用跟随主模型，零配置零门槛；填了但未匹配任何可用 provider 时启动告警并回落主模型。把脏活路由到便宜本地模型省成本 |

## audit（工具调用审计哈希链）

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | true | append-only + SHA-256 链式防篡改审计，落 `data/logs/audit.ndjson`。设 false 可关（性能敏感场景）；校验：对话里调 `audit_verify` 工具或 `npm run audit:verify` |

## protocol（协议总线）

| 字段 | 默认 | 说明 |
|------|------|------|
| `wal_enabled` | true | SQ/EQ 双队列 WAL 落盘 `data/protocol/eq.wal.jsonl`，崩溃后可 replay。`=== false` 才关（纯内存，崩溃丢队列） |

## ocr（文字识别，可选）

| 字段 | 默认 | 说明 |
|------|------|------|
| `tesseract` | "tesseract" | 本地 tesseract 可执行文件路径/命令名（需装系统 tesseract 含中文语言包） |
| `lang` | "chi_sim" | 默认识别语言（`ocr_image` 工具的 `lang` 参数优先于此） |
| `cloud` | null | 云 OCR 配置对象（null = 只用本地 tesseract）；形状见 `src/tools/ocr.js` |

## mcp（MCP 工具服务器）

| 字段 | 说明 |
|------|------|
| `servers` | MCP 服务器列表（`{command, args}` 走 stdio，或 `{url}` 走 HTTP） |
| `auto_connect` | 启动时是否自动连接 |

## channels（通道）

统一走 `ChannelManager` 注册表，推荐用 `ppx-channels` 命令自助配置（交互式引导 + 连通性测试），配置最终落在这里。

| 字段 | 说明 |
|------|------|
| `http.enabled` / `http.port` / `http.host` / `http.auth_token` | HTTP 通道（`host` 默认 `127.0.0.1` 只绑回环；空 token 时启动自动生成随机 token） |
| `http.mcp.enabled` / `http.mcp.path` | MCP 标准端点（默认开，路径 `/mcp`，`=== false` 关）。产品壳 Web 前端走它 |
| `http.mcp.legacy_rest` | true = 保留 REST `/api/*` 兼容（旧脚本/测试依赖）；置 false 后 `/api/*`、`/message*` 返回 410 并引导 `/mcp` |
| `http.cors_origin` | CORS 来源白名单（数组，如 `["http://localhost:3000"]`）。未配置/空 = 默认 `*`（兼容）；配置后仅放行白名单浏览器来源，其余跨域 403（无 Origin 的非浏览器请求不受限） |
| `feishu.appId` / `appSecret` / `verifyToken` / `webhookPath` | 飞书通道（事件订阅回调；`webhookPath` 默认 `/feishu/webhook`） |
| `wechat.path` / `token` / `encodingAESKey` | 企业微信回调（收消息） |
| `wechat.corpId` / `corpSecret` / `agentId` | 企业微信主动推送（发消息） |
| `log.enabled` / `log.target` | 日志 dummy 通道（输出到 stdout，验证主动提醒契约用） |

每个通道的 `test()` 做真实连通性探测：`ppx-channels test <name>`（如飞书实际换取 tenant_token）。

## security（安全）

| 字段 | 默认 | 说明 |
|------|------|------|
| `allow_all` | false | 放开命令白名单（危险） |
| `command_timeout_ms` | 30000 | 命令执行超时 |
| `code_act` | false | CodeAct 脚本出口（默认关闭，需显式开启） |
| `deny` | [] | 用户自定义拦截规则（glob 风格，如 `"git push --force*"`），命中后即使 `allow_all` 也拒绝 |
| `allow_inline_exec` | false | 放开解释器/包执行器的内联代码形态（`node -e`、`python -c`、`bash -c`、`npx pkg`、`find -exec`、`git -c` 等）。这些形态首词合法但参数里是任意代码，默认**连 `allow_all` 也拦**；确需放开才置 true（建议改为 write_file + `node file.js`） |
| `allow_unauthenticated_webhooks` | false | 允许"未配置回调密钥"的飞书/微信 webhook 通道收流量。默认 fail-closed 直接 403——未鉴权的 webhook 等于把"驱动带工具 agent"的入口开放给任何能触达端口的人。仅供本地调试 |

命令守卫五层防线（吸收 Hermes approval 机制）：**用户 `deny` 规则 → 硬黑名单（`rm -rf /`、fork bomb、写裸设备、`curl|sh`、重定向写入 `~/.ssh`/启动项等敏感位置，`allow_all` 也拦）→ 常规高危黑名单 → 内联执行硬规则（`allow_all` 也拦，见 `allow_inline_exec`）→ 前缀白名单**。检测前先做反混淆规范化（去引号/合并空白），`rm ""-rf /` 这类引号技巧无法绕过；内联执行判定会跳过 `env`/`sudo`/`nohup` 等包装器与前导 `FOO=bar` 赋值，管道/`;` 分段逐段解析首词。命中拦截会提示 agent 不要重试或改写绕过。

## 环境变量

| 变量 | 说明 |
|------|------|
| `PPX_DATA_DIR` | 数据目录（记忆/会话/经验落盘位置，覆盖默认 root/data） |
| `PPX_AGENT_GLOBAL_DATA_DIR` | 全局共享数据目录（跨 agent 经验库，默认同 dataDir） |
| `PPX_AUTH_TOKEN` | HTTP 认证 token |
| `PPX_PORT` | HTTP 端口 |
| `PPX_AGENT_DATA_DIR` | 军团 worker 的独立数据目录 |

## 数据目录

默认数据目录是 `root/data`（源码运行时）。**npm 全局/本地安装**（包在 `node_modules` 里）时自动外置到 `~/.ppx`，避免卸载丢数据。可用 `PPX_DATA_DIR` 显式指定。
