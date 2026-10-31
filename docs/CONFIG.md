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
| `proactive.enabled` | true | **主动任务生成**开关（2026-10-30 校正：代码默认已是 true，本文档此前写 false，属漂移）——1h 扫描一次，无待办不打扰（24h 去重）；彻底静音设 false |
| `proactive.interval_ms` | 3600000 | 主动提醒间隔（毫秒） |
| `max_tool_rounds` | 8 | 工具循环最大轮次（防无限工具调用） |
| `tool_result_budget` | 4000 | 工具结果裁剪预算（超长结果保留头尾，防撑爆上下文） |
| `max_tool_error_retry` | 2 | 工具错误喂回模型修正的重试次数 |
| `max_parallel_tools` | 4 | **同轮工具并发上限**（2026-10-30）：一轮里 LLM 吐出 N 个 `tool_calls` 时按批执行，避免 N 个 shell 同时 spawn。`0` = 不限（旧行为）；未超限时仍走全并发 |
| `exhausted_finalize` | true | **轮次耗尽强制收口**（2026-10-30）：跑满 `max_tool_rounds` 后补一次**不带工具**的调用做收口总结，回复带「轮次已用尽」标注。`false` = 旧行为（直接返回"工具调用轮次过多, 已停止"）。无工具轨迹 / 用户中断 / 预算耗尽时不触发 |
| `tool_exposure` | `"all"` | **工具曝光策略**（2026-10-30）：`"all"` = 全部工具下发完整 schema（默认，行为不变）；`"core"` = 只下发 27 个核心工具的 schema，其余降级为 system prompt 里的【按需工具】名单，模型用 `tool_schema(name)` 现取参数定义。实测固定开销 **14447 → 5602 tok/请求（省 61%）**。也可传字符串数组自定义名单（自动并入 `tool_schema` / `list_capabilities`）。名单字符预算走可选项 `tool_catalog_budget`（默认 1500，同 `skill_catalog_budget` 的"代码内默认、配置文件可不写"处理） |
| `tool_timeout_ms` | 30000 | **全局默认工具超时**（工具未声明 `timeoutMs` 时兑底，防单个慢工具卡死对话；工具级 `timeoutMs` 优先；0=不限时）。超时触发 `tool/timeout` trace 事件（含 elapsedMs/budgetMs/retried），是熔断/自适应预算的数据基础 |
| `workspace_prompt_mode` | absolute | 工作目录段模式：`absolute` 写入绝对路径（默认，模型少问路径）；`neutral` 不写绝对路径，用稳定占位符，换取跨机器/跨工作目录 provider 前缀缓存可共享（模型可用 `pwd` / `list_dir` 自行确认） |

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
| `http.cors_origin` | CORS 来源策略。**2026-10-31 默认收紧**：未配置 = `same-origin` 严格模式（跨源带 Origin 的一律 403，非浏览器请求与 Web UI 自身不受影响）。显式放开：`"*"` / `[]` / 白名单数组 `["http://localhost:3000"]`（旧写法全兼容） |
| `feishu.appId` / `appSecret` / `verifyToken` / `webhookPath` | 飞书通道（事件订阅回调） |
| `wechat.path` / `token` / `encodingAESKey` | 企业微信回调（收消息） |
| `wechat.corpId` / `corpSecret` / `agentId` | 企业微信主动推送（发消息） |
| `log.enabled` / `log.target` | 日志 dummy 通道（输出到 stdout，验证主动提醒契约用） |

每个通道的 `test()` 做真实连通性探测：`ppx-channels test <name>`（如飞书实际换取 tenant_token）。

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

**排队语义**：按通道分组执行 —— 组内串行（同通道消息有序，不并发重发），组间并行（某通道 send 挂起不阻塞其它通道的重试周期）。`mgr.broadcast()` 返回入队回执 `[{channel, id, queued}]`，**不等发送完成**；`mgr.deliveryStats()` 暴露 pending/sent/failed/dropped/retried 与最近 10 条终态失败原因。测试同步断言用 `await mgr.delivery.idle()`。

## security（安全）

| 字段 | 默认 | 说明 |
|------|------|------|
| `allow_all` | false | 放开命令白名单（危险）。**2026-10-31 起不能经 HTTP API 修改**（`PUT /api/settings` 显式 400）—— 只能编辑 config/ppx.json 后重启生效，防 bearer token 泄露即整体放开 |
| `command_timeout_ms` | 30000 | 命令执行超时 |
| `code_act` | false | CodeAct 脚本出口（默认关闭，需显式开启） |
| `deny` | [] | 用户自定义拦截规则（glob 风格，如 `"git push --force*"`），命中后即使 `allow_all` 也拒绝 |

命令守卫三层防线（吸收 Hermes approval 机制）：**用户 `deny` 规则 → 硬黑名单（`rm -rf /`、fork bomb、写裸设备、`curl|sh` 等，`allow_all` 也拦）→ 常规高危黑名单 + 前缀白名单**。检测前先做反混淆规范化（去引号/合并空白），`rm ""-rf /` 这类引号技巧无法绕过。命中拦截会提示 agent 不要重试或改写绕过。

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

**边界如实声明**：`code_act`（默认关闭）的解释器仍在本机执行，docker 模式下其输出会带边界提示；文件工具（read_file/write_file）本就在进程内走宿主文件系统，与容器经挂载看到的是同一份磁盘。

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

发布只靠用户手动盯 Releases 意味着装了旧版的人永远不知道新版出了 —— 这里补上"检查 + 提示 + 一条命令升级"。实现见 `src/update/index.js`，零依赖（网络走 `proxiedFetch`，代理/镜像自动兜底）。

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
