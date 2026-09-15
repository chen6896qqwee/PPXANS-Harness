# 外部参考项目来源说明

本目录不包含第三方源码，仅登记 `C:\Users\chen\Desktop\智能体项目` 下**非本仓库自研**项目的来源与获取方式。

PPXANS-Harness 是**零运行时依赖**的自包含项目。第三方引擎一律以「外部可选底座」形式接入，永不复制进本仓库源码树——这既保持自包含定位，也避免上游许可证与体积污染。

---

## 1. openai/codex（未被吸收）

| 项 | 值 |
|---|---|
| 目录 | `../codex` |
| 来源 | https://github.com/openai/codex （本地 remote: `git@github.com:openai/codex.git`） |
| 性质 | OpenAI 官方 Codex CLI，**Rust / Bazel** 技术栈 |
| 规模 | 7,804 个受版本控制文件，约 111 MB |
| 为何不吸收 | 技术栈完全不同（Rust vs 纯 Node），无任何代码可复用；作为架构参考阅读即可，纳管源码只会让仓库体积膨胀两个数量级并引入无关许可证义务 |

**结论**：保留为独立原始仓库，不纳入 PPXANS-Harness。若需查阅请直接使用 `../codex` 目录。

---

## 2. deepseek-ai/deepseek-harness（以可选底座接入，不复制源码）

| 项 | 值 |
|---|---|
| 目录 | `../deepseek-harness` |
| 来源 | https://github.com/deepseek-ai/deepseek-harness （本地 remote 同名） |
| 性质 | DeepSeek 官方 Harness（pnpm monorepo + TypeScript） |
| 规模 | 10,319 个受版本控制文件 |
| 接入方式 | 通过 `.deps/deepseek-harness` 内嵌目录 + `dsh` provider（`config/ppx.json` 的 providers 首位，`backend: "deepseek"`） |

**定位说明**：dsh 在 PPXANS-Harness 中是**可选的 LLM 引擎后端**，不是依赖。未安装/未构建时，健康检查会把它判为不可用并自动回退到 `http` / `cloud` provider，主流程不受影响。

启用步骤（README「独立底座」节亦有说明）：

```bash
npm run dsh:install   # 首次安装内嵌 dsh 依赖 (需网络)
npm run dsh:build     # 构建
npm run dsh -- web    # 直接跑 dsh CLI
```

`dsh` 后端定位优先级：`PPX_DSH_ROOT` 环境变量 > provider 的 `dsh_root` 配置 > 内嵌 `.deps/deepseek-harness` 默认目录。

**结论**：以「可选底座」形式接入，源码不复制进本仓库（`.deps/` 已在 `.gitignore` 中排除）。

---

## 3. 已吸收的自研项目

| 项目 | 版本 | 处理方式 |
|---|---|---|
| `../ppx-agent` | v1.6.0 | **合并基座**——整体作为 PPXANS-Harness 的代码基底 |
| `../ppx-v2`（ppx Harness） | v0.4.0 | **能力吸收**——抽取独有能力移植，不整仓合并（详见 `MERGE-REPORT.md`） |

---

## 5. P0 (2026-09-15) 借鉴登记 — Aegis / HookBus / dsh / ACE 设计思想

> 仅借鉴**设计思想**，未复制任何源码；全部用皮皮虾自有结构重写。新增能力对应的实现文件见下表。

| 借鉴来源 | 借鉴点 | 皮皮虾自研实现 |
|---|---|---|
| Aegis / HookBus（UK Patent GB2608069.7 论文描述） | Deny-Wins 策略合并：任一高优先级 deny 一票否决，安全策略不可被低优先级 allow 投票覆盖 | `src/tools/catalog.js` 的 `addPolicySubscriber()` + `consolidateDecisions()` |
| Aegis / HookBus | 订阅者熔断器三态（Closed/Open/Half-Open），防故障订阅者拖垮工具链 | `src/bus/circuit-breaker.js`（新增，基础设施层，区别于 agent 探索熔断） |
| deepseek-harness / dsh | seam 三分法注册表：Service Definition / Provider / Consumer，一行换实现 | `src/seam/registry.js`（新增，与既有 `src/seam/shell.js`、`src/tools/seam.js` 互补） |
| dsh | 事件源事实（model-visible = logged）：会话日志是模型可见内容的唯一事实源 | `src/utils/trace.js` 新增 turn/step 边界事件 + `verifyReplay()` 不变量断言 |
| MERGE-REPORT 遗留 P2 | guard 免疫闸门空转（工具走 catalog 不走总线） | `src/ans/guard.js` 新增 `installGuardOnCatalog()`，guard 接入 ToolCatalog 策略链，与总线版共享状态 |
| ACE（ICLR 2026，agentic-context-engineering） | 语境即 Playbook：bullets + Generator/Reflector/Curator + 增量 delta 合并 + grow-and-refine | `src/evolve/playbook.js`（applyDelta / growAndRefine / createGate / renderBullets） |
| HanaAgent（openhanako） | 记忆管线健康监控（healthy/degraded + 分步失败计数 + 降级） | `src/services/memory-health.js`（MemoryHealthMonitor） |
| ReLoop / Vial / Aegis | 故障记忆：结构化失败 episode + 相似检索 + 元学习命中 | `src/memory/failure-episode.js`（FailureEpisodeStore） |
| Hermes 生产数据（51 工具 MCP 服务器工具名碰撞） | MCP 命名空间隔离：serverName__toolName 前缀 + 精确匹配短路 | `src/mcp/index.js` 的 `serverLabel()` / `namespacedMcpName()`，描述清洗增危险 flag 剔除 |
| TencentDB-Agent-Memory | 符号画布记忆：任务状态画成 Mermaid 图，node_id 全链路追踪（上层结构、下层证据） | `src/memory/canvas.js`（buildCanvasFromEvents / toMermaid / CanvasStore） |
| HanaAgent（openhanako） | 会话 fork 基线：子代理带记忆快照，结束 merge/discard | `src/memory/fork.js`（exportMemorySnapshot / mergeSnapshotBack） |
| HanaAgent（openhanako） | 插件两级权限：restricted / full-access | `src/plugin/context.js` 的 SENSITIVE_SERVICES + `src/plugin/index.js` 的 compose 权限装配 |
| LangGraph supervisor 拓扑 / OpenAI Agents SDK handoff | supervisor 模式：监督者分解→派发→评审→修正循环 | `src/orchestrator/supervisor.js`（runSupervisor / findDisagreement / judgeRound） |
| TencentDB-Agent-Memory | 记忆资产中枢：资产登记 + 可见性 + 装备（loadout）+ 使用计数 | `src/memory/asset-hub.js`（AssetHub） |

---

## 4. 未吸收的重复副本

| 目录 | 判定 | 证据 |
|---|---|---|
| `../ppx Harness` | **ppx-agent 在 v1.5.1 的旧快照，不合并** | 其 remote 与 ppx-agent 完全相同（`chen6896qqwee/ppx-agent.git`），版本号 1.5.1 < 1.6.0，且缺少 v1.6.0 的 `src/core/policy.js`、`src/core/trace.js`、`src/services/*` |

合并旧快照会导致 v1.6.0 的四刀重构成果被覆盖回退，因此明确排除。该目录可自行删除或留作历史对照。
