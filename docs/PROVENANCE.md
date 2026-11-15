# 自研溯源与设计对照 (PROVENANCE)

> 结论先行: **本仓库不包含任何上游项目的源码副本。** 所有 `src/` 代码、数据结构、命名、
> 失败语义与测试均为 PPXANS-Harness 自研。下表只记录"设计思想曾参考过谁"，用于学术诚实
> 与后续维护，不构成代码来源声明。

## 1. 判定标准

一个模块被认定为"自研"，必须同时满足：

1. `src/` 中没有任何来自上游的 import、require、动态 import 或 vendored 源文件；
2. 没有上游版权头 / 上游源码路径标记；
3. 每个登记来源都有真实存在的原生模块落点（不是只有一句注释）；
4. 每个来源在本文有独立条目，说明"借鉴了什么、我们改成了什么"；
5. 由 `scripts/native-guard.js` 自动校验，接入 `npm run verify`。

设计思想本身不受版权保护；受保护的是具体表达。本项目的做法是：只读取上游的设计文档或
公开说明，重新定义数据模型与控制流，再用本仓库的约束（零运行时依赖、纯 Node、单写者
dataDir、日志即事实）重写实现。

## 2. 来源 → 原生实现映射

| 来源 id | 设计参照 | 原生落点 | 关键改造（不是移植） |
|---|---|---|---|
| `superagent` | DeepSeek《Super-agent 设计探索》 | `src/flow/*`、`src/workgraph/*`、`src/channels/delivery.js`、`src/orchestrator/thread-bridge.js`、`src/ans/watchdog.js` | 决策内核与传输解耦；append-only 账本折叠；admitted 子集安全恢复；通道分组并行 + 抖动/死信/幂等 |
| `dsh` | deepseek-harness / dsh（会话即事实源、Service Seam、spill） | `src/seam/*`、`src/plugin/context.js`、`src/memory/session.js`、`src/tools/spill.js` | 零依赖同步容器；spill 永不删除、按 locator 续读；seam 带健康探测 |
| `claude-code` | hooks / commands / settings 格式 | `src/hooks/*`、`src/agent/command-registry.js` | 六事件钩子链 + 配置白名单；命令名册与工具目录分离 |
| `codex` | 审批、沙箱、任务指针、输出标准化 | `src/permissions/*`、`src/session/pwf.js`、`src/tools/builtin.js` | deny 恒胜规则链；委派权限取交集；压缩前写任务指针 |
| `opencode` | 通配符规则链、分级审查 | `src/permissions/index.js`、`src/verify/review.js` | last-match-wins 与审批同源；低风险不阻塞主链路 |
| `octop` | TencentCloud/Octop 房间/人格/专家包 | `src/orchestrator/room.js`、`personas.js`、`expert-pack.js` | 全部本地 JSON，无 Python 基础设施；多根覆盖 |
| `openclaw` | 压缩、重试、通道引导 | `src/llm/retry.js`、`src/memory/compaction.js`、`src/channels-cli.js` | 摘要为单一 surface node；重试与预算闸门同层 |
| `aider` | 仓库地图 PageRank | `src/repomap/index.js` | 纯 JS 符号图，无 tree-sitter；按 token 预算裁剪 |
| `hermes` | 审批、证据边界、shell 解析 | `src/tools/command-guard.js`、`src/seam/shell.js`、`src/evidence/index.js` | 先分词后分析的零依赖解析；证据不足拒绝提案 |
| `zcode` | 能力门、Wiki 机制 | `src/permissions/index.js`、`src/repomap/wiki.js` | 能力元数据与审批同源；本地静态分析生成 Wiki |
| `superpowers` | 按需技能加载 | `src/agent/prompts.js`、`src/skills/*` | 触发后读全文省上下文；项目 > 用户 > 内置多根 |
| `hanaagent` | fork 基线、记忆健康 | `src/memory/fork.js`、`src/services/memory-health.js` | 源会话不可变；健康检查给可操作建议 |
| `tencentdb-agent-memory` | 记忆资产、符号画布 | `src/memory/asset-hub.js`、`src/memory/canvas.js` | 资产与事实库解耦；画布为纯文本 |
| `aegis` | 熔断、deny-wins、故障即知识 | `src/bus/circuit-breaker.js`、`src/tools/catalog.js`、`src/memory/failure-episode.js` | 熔断按订阅者隔离；故障病历可检索 |
| `leizai` | leizai-agent / 雷仔 分层意图、provider 能力位 | `src/intent/funnel.js`、`src/llm/protocol.js` | 规则只注入提示不接管决策；层流量统计持久化 |
| `ace` | ACE / agentic-context-engineering | `src/evolve/playbook.js`、`src/evolve/delta-producer.js` | 合并/裁剪/门禁纯代码可测；无 LLM 自动跳过 |
| `reloop-vial` | ReLoop / Vial 故障即知识 | `src/memory/failure-episode.js` | 病历带上下文与恢复建议，非单条错误 |
| `zep-graphiti` | Zep / Graphiti 事实有效期 | `src/memory/fact-store.js` | 五层统一衰减；隔离带占比作为投毒读数 |
| `planning-with-files` | OthmanAdi/planning-with-files | `src/session/pwf.js` | 三文件 + 压缩前指针，压缩后不重读全史 |
| `shell-quote-bash-parser` | ljharb/shell-quote、vorpaljs/bash-parser | `src/security/shell-parse.js` | 不执行、无第三方解析器，只做静态判定 |
| `deepseek-v4-format` | DeepSeek V4 官方工具调用格式 | `src/llm/dsml.js` | 统一进多协议工具循环；格式错误回退纯文本 |
| `langgraph-openai-agents` | LangGraph supervisor / OpenAI Agents SDK handoff | `src/orchestrator/supervisor.js` | 进程内 supervisor，无图运行时；handoff 绑定权限交集 |
| `theone` | TheOne 自我进化入口、长期目标预算 | `src/channels/http.js`、`src/evidence/index.js` | 证据不足不出提案；预算字段可选 |
| `ppx-v2` | 本项目前身 ppx-v2 / ppx-tools（自有代码） | `src/audit/audit-chain.js`、`src/memory/fact-store.js`、`src/tools/catalog.js` | 迁移后按 v3/v4 语义重写，不是原样搬运 |

机器可读版本见 [`config/native-provenance.json`](../config/native-provenance.json)。

## 3. 为什么不等于"换皮移植"

| 维度 | 上游常见形态 | 本项目形态 |
|---|---|---|
| 运行时 | TypeScript + 框架/DB/消息队列 | 纯 Node ≥20，零运行时依赖 |
| 状态 | 外部数据库 / 分布式锁 | 单写者 `data/` + append-only JSONL 折叠 |
| 入站 | Router 直接接管消息 | `flow` 决策内核只产出 plan，通道执行 |
| 恢复 | 失败即重跑 | 默认只标记中断；仅 admitted 且从未 begin 的子集可安全恢复 |
| 投递 | 成功即丢、失败只打日志 | WAL 续投 + 抖动退避 + 死信 + 幂等键 |
| 扩展 | 插件运行时 / 动态加载框架 | 七段装配 + seam 注册表 + 用户插件受限接缝 |
| 验证 | 单元测试为主 | 2461 项测试 + 架构守卫 + 上下文预算 + Web 静态门禁 |

## 4. 如何验证

```bash
node scripts/native-guard.js        # 来源/模块/文档/禁止 import 四项校验
npm run verify                      # 已包含 native-guard
npm test                            # 全量行为回归
```

`native-guard` 的硬性检查：

- `src/` 下出现 `dsh`、`deepseek-harness`、`openclaw`、`claude-code` 等上游 import → 失败；
- 出现上游版权头或上游 `src/` 路径标记 → 失败；
- 注册表里的模块路径不存在 → 失败；
- 来源 id 在本文缺失 → 失败；
- token 重复归属两个来源 → 失败。

## 5. 诚实边界

- 本文记录的是**设计思想对照**，不是法律意见；上游项目的 LICENSE 仍归其作者所有。
- 三个尚未吸收的能力（计算/存储彻底分离、daemon 远程通道分体部署、执行中途续跑）
  不在本表宣称范围内；它们需要产品决策与幂等标注，不靠改注释完成。
- 若未来引入任何第三方源码，必须先更新本表与注册表，并通过 `native-guard`；
  当前策略是 `design-only`，即只有思想对照，没有源码引入。
