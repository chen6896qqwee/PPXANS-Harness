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
| `backend` | 后端类型：`http`（直连 OpenAI 兼容 API，默认）/ `openclaw` / `deepseek`（可选引擎） |
| `base_url` | API 端点（http 后端） |
| `api_key` / `api_key_env` | 直接填 key，或填环境变量名 |
| `model` | 模型名 |
| `vision` | `true` 标记为视觉模型（多模态读图时路由到此） |
| `timeout_ms` | 超时（毫秒，默认 120000） |
| `retry_max` | 单次调用内瞬态错误重试次数（默认 3） |
| `context_window` | 上下文窗口（token）。agent 据此收紧会话历史预算，防本地小模型溢出（未配置回退 memory.context_window） |
| `mjs` | openclaw 引擎的 openclaw.mjs 路径（可留空走 `PPX_OPENCLAW_MJS` 环境变量） |
| `dsh_root` | DeepSeek Harness 源码根（留空自动用内嵌 `.deps/deepseek-harness`，也可用 `PPX_DSH_ROOT` 覆盖） |

**引擎底座**：`dsh` 已在 `providers` 首位（`backend: "deepseek"`，源码内嵌 `.deps/deepseek-harness`）；OpenClaw 作为 `_optional_engines.openclaw` 注释配置保留，要用时把对应对象移入 `providers` 数组（见 `docs/QUICKSTART.md` 第 6 节）。

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
| `proactive.enabled` | false | **主动任务生成**开关（默认关防打扰），开启后定时扫描记忆生成主动提醒 |
| `proactive.interval_ms` | 3600000 | 主动提醒间隔（毫秒） |
| `max_tool_rounds` | 8 | 工具循环最大轮次（防无限工具调用） |
| `tool_result_budget` | 4000 | 工具结果裁剪预算（超长结果保留头尾，防撑爆上下文） |
| `max_tool_error_retry` | 2 | 工具错误喂回模型修正的重试次数 |
| `tool_timeout_ms` | 30000 | **全局默认工具超时**（工具未声明 `timeoutMs` 时兑底，防单个慢工具卡死对话；工具级 `timeoutMs` 优先；0=不限时）。超时触发 `tool/timeout` trace 事件（含 elapsedMs/budgetMs/retried），是熔断/自适应预算的数据基础 |

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

统一走 `ChannelManager` 注册表，推荐用 `ppx-channels` 命令自助配置（交互式引导 + 连通性测试），配置最终落在这里。

| 字段 | 说明 |
|------|------|
| `http.enabled` / `http.port` / `http.host` / `http.auth_token` | HTTP 通道（空 token 时启动自动生成随机 token） |
| `http.cors_origin` | CORS 来源白名单（数组，如 `["http://localhost:3000"]`）。未配置/空 = 默认 `*`（兼容）；配置后仅放行白名单浏览器来源，其余跨域 403（无 Origin 的非浏览器请求不受限） |
| `feishu.appId` / `appSecret` / `verifyToken` / `webhookPath` | 飞书通道（事件订阅回调） |
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

命令守卫三层防线（吸收 Hermes approval 机制）：**用户 `deny` 规则 → 硬黑名单（`rm -rf /`、fork bomb、写裸设备、`curl|sh` 等，`allow_all` 也拦）→ 常规高危黑名单 + 前缀白名单**。检测前先做反混淆规范化（去引号/合并空白），`rm ""-rf /` 这类引号技巧无法绕过。命中拦截会提示 agent 不要重试或改写绕过。

## 环境变量

| 变量 | 说明 |
|------|------|
| `PPX_DATA_DIR` | 数据目录（记忆/会话/经验落盘位置，覆盖默认 root/data） |
| `PPX_AGENT_GLOBAL_DATA_DIR` | 全局共享数据目录（跨 agent 经验库，默认同 dataDir） |
| `PPX_AUTH_TOKEN` | HTTP 认证 token |
| `PPX_PORT` | HTTP 端口 |
| `PPX_OPENCLAW_MJS` | openclaw 引擎路径 |
| `PPX_DSH_ROOT` | DeepSeek Harness 源码根 |
| `PPX_AGENT_DATA_DIR` | 军团 worker 的独立数据目录 |

## 数据目录

默认数据目录是 `root/data`（源码运行时）。**npm 全局/本地安装**（包在 `node_modules` 里）时自动外置到 `~/.ppx`，避免卸载丢数据。可用 `PPX_DATA_DIR` 显式指定。
