# 架构说明

> **v3.0 (2026-09-18)**: 本文档描述 v2.x 基线架构。v3.0 codex 对齐升级（新增 protocol/session/permissions/hooks/edit/repomap/review/evidence/commands 九层 + codex 风格 Web UI）见 **[ARCHITECTURE-V3.md](./ARCHITECTURE-V3.md)**。

皮皮虾是一个**独立自包含的纯 Node agent**（零运行时依赖）。v2.5.0 起仅保留自研 http 底座直连 OpenAI 兼容 API（OpenAI/DeepSeek/火山/通义/智谱/本地 lmstudio/ollama/vLLM）；OpenClaw / DeepSeek Harness 等外部引擎已全部移除（源码曾内嵌 `.deps/deepseek-harness` 作为可选底座，v2.5.0 删除）。架构理念上仍吸收其记忆分层、自愈内核、工具系统的精华，但实现完全自研。

## 整体架构

```
┌─────────────── 通道层 ───────────────┐
│  CLI    HTTP API   飞书    微信       │
│ (cli.js) (server.js) (feishu) (wechat)│
└──────────────────┬───────────────────┘
                   │
┌──────────────────▼───────────────────┐
│           PPXAgent (内核)             │
│  src/agent/index.js — 编排核心        │
│  · chat / chatStream 主入口           │
│  · _llmWithFallback 多provider回退    │
│  · _llmWithTools 工具调用循环          │
└──────┬────────────┬────────────┬──────┘
       │            │            │
┌──────▼─────┐ ┌────▼─────┐ ┌───▼────────┐
│ 一切皆插件   │ │ 模式注册表 │ │ 军团编排    │
│ Context +   │ │ ModeReg-  │ │ Legion +   │
│ builtinPlu- │ │ istry (7) │ │ DAG (多进程)│
│ gins (14个) │ │            │ │            │
└─────────────┘ └───────────┘ └────────────┘
```

## 核心设计

### 1. 一切皆插件（吸收 dsh Cordis 理念）

`src/plugin/context.js` 提供轻量容器：`provide(key, value)` 注册、`consume(key)` 消费（父子查找）、`onDispose` 可逆效果。`src/plugin/builtin.js` 的 14 个内置插件（bus/healer/persona/facts/experience/session/memory/llm/memoryLayers/traces/audit/tools/evolve/mode）按「依赖在前」的顺序装配，任何模块都可被用户插件替换。

### 2. 会话即唯一事实源（吸收 dsh「Model-visible ⟺ logged」）

`src/memory/session.js` 是 **append-only 事件日志**（不可变），每条 `{seq, ts, type, data}`：
- `deriveMessages()` 投影 user/assistant（模型可见历史）
- `deriveCompacted()` 投影压缩后的历史（compaction 事件替换被压缩区间）
- `fork()` 从边界派生新会话，`replay()` 回放完整事件流

### 3. 五层记忆（L0 → L4）

```
对话 → L0 原始对话(事件日志) → L1 原子记忆(fact-store, 高斯衰减) → L2 场景(聚类) → L3 画像(persona) → L4 程序性记忆(技能/流程, 慢衰减)
```
- L1 检索用**倒排索引**（O(n) 全遍历 → O(候选)），可选 embedding 切 dense+BM25 RRF
- L4 程序性记忆（技能/流程/方法论）衰减率为 L1 的 1/4，长期留存
- 会话压缩层 `src/memory/compaction.js`：超阈值时用 LLM 把旧对话压成结构化摘要（目标/进展/关键决策/待办/关键上下文）

### 4. 能力 seam（吸收 dsh Service|Provider|Consumer）

两层 seam：
- **工具层** `src/tools/seam.js`：Definition（元数据）/ Provider（execute）/ Consumer（`runWithPolicy` 统一策略：禁用/超时/权限/before-after 钩子/错误语义）
- **服务层** `src/seam/shell.js`：命令执行能力抽象，`LocalShellProvider` 默认实现，run_command 通过 `ctx.consume("shell")` 调用，换 provider 即换执行环境（未来沙箱/Docker）

### 5. LLM 客户端 + 重试内核

`src/llm/router.js` **模型路由中枢**（2026-08-21 新增）：占位死配置过滤 + 云端真key优先 + 本地零配置兜底 + 健康排序。`src/llm/client.js` 单后端 `http`（v2.5.0 起唯一后端，直连任意 OpenAI 兼容 API；openclaw/deepseek 引擎已移除）。
- `src/llm/retry.js`：瞬态分类重试（429/5xx/timeout + Retry-After + 可取消指数退避）
- `src/llm/fence.js`：纯文本工具围栏协议（文本工具调用修复：http 后端返回文本工具意图时自动恢复为原生 tool_calls）

### 6. 编排模式

`src/mode/index.js` 的 `ModeRegistry`，7 种可插拔模式：react（默认工具循环）/ single / plan-exec / router / blackboard / graph / legion。

### 7. 多 agent 军团（多进程）

`src/orchestrator/legion.js` spawn 独立 agent 子进程（`agent-worker.js`），支持 broadcast（广播取首答）/ runDag（DAG 依赖编排）；`spawn_agent` 工具（`src/tools/delegate.js`）走并行/差异视角/仲裁/SDD 审查循环，是生产主力路径（`dispatch` 按角色分工保留为军团 API，生产无内置消费方）。子进程经 stdin/stdout JSON 行协议通信（请求带 id，worker 错误行回带 id，send 有 30s 超时兜底），step 事件实时上报进度。

### 8. 自愈引擎

`src/selfheal/healer.js`：启动体检（补建目录/修复损坏 JSON）、崩溃恢复、corrupt 备份清理。

### 9. ANS 模块（Agent Nervous System 演进）

`src/ans/` 三个**可更换的独立模块**，agent 只委托持有，可单独替换实现：
- `values.js`：**价值对齐**——`config.agent.values` 核心价值数组，注入 system prompt 最前（【核心价值·不可违背】），独立于普通指令
- `proactive.js`：**主动任务生成**——`pendingTasks()` 扫描 L1 记忆待办信号，`suggestProactive()` 生成结构化 payload `{ts, items, text}`；`agent.proactive.enabled` 时才接定时器
- `lifecycle.js`：**生命周期状态机**——born → growing（首次对话）→ mature（10 次对话），evolving（进化）/ reproducing（繁衍）计数，`status()` 人类可读摘要

### 10. 通道注册表（统一挂载）

`src/channels/index.js` 的 `ChannelManager` 是**所有通道的统一入口**：
- `start()` 按注册表（`BUILTIN_CHANNEL_TYPES`）connect 全部启用通道，再给 webhook 型通道统一 `mount(httpServer)` 挂路由
- 每个通道 = `Channel` 子类（`connect/send/disconnect`）+ 可选 `test()`（连通性探测）+ `mount()`（webhook 挂载）
- `broadcast(text)` 把消息广播到所有已启用通道（主动提醒投递入口）
- `test(name)` 用独立实例验证配置连通性，不干扰已启动通道
- 新增通道类型 = 注册一个类即可，不改 manager；`ppx-channels` CLI（`src/channels-cli.js`）让用户自助配置/测试

## 目录结构

```
src/
├── core/        核心纯逻辑（policy.js 工具循环策略 / trace.js 事件流 traceId 贯穿）
├── services/    业务服务（memory-service 记忆协调 / learning-service 自我学习，agent 薄委托）
├── agent/       Agent 引擎（编排薄委托 + 多模型回退；工具循环/记忆/学习已抽 core/services）
├── ans/         ANS 模块（values 价值对齐 / proactive 主动任务 / lifecycle 生命周期 / guard 免疫闸门，可更换）
├── plugin/      插件装配（Context + 14 个内置插件）
├── memory/      五层记忆存储 + 会话事件日志 + 压缩层
├── tools/       工具系统（catalog + seam + builtin/advanced/methods/selfmod/document/ocr）
├── seam/        服务层能力 seam（shell 等）
├── llm/         LLM 客户端（router 路由中枢 + client + retry + fence + dsml + embedder）
├── mode/        编排模式（react/single/plan-exec/router/blackboard/graph/legion）
├── orchestrator/ 多 agent 军团（legion + dag + worker）
├── mcp/         MCP 客户端
├── channels/    通道注册表（http/feishu/wechat/log）+ base（test/mount）
├── selfheal/    自愈引擎
├── persona/     人格系统
├── skills/      方法型 Skill 加载
├── utils/       基础设施（store/logger/trace/pii）
└── config/      配置中心（index + providers + channels 配置 CRUD）
```

CLI 入口：`src/cli.js`（对话）/ `src/server.js`（HTTP 服务）/ `src/channels-cli.js`（通道自助管理）。

## 数据流（一次对话）

```
用户消息 → chat()/chatStream()
  → 本地意图预判(可选) → 模式分发(react 默认)
  → buildMessages(组装 system[核心价值+persona+记忆+压缩后历史])
  → 路由: router.js(占位过滤/云优先/本地兜底/健康排) → client 直连, 失败再切下一 provider
  → _llmWithTools(工具循环, 每轮发 step 事件)
      → apiChat(http 直连, 瞬态重试, 工具调用修复)
      → _runTool(工具执行, before/after 钩子, 轨迹记录)
  → 落会话事件日志 → 记忆提炼 → 场景归档 → 画像刷新 → 生命周期推进
```

## 主动提醒链路

```
config.agent.proactive.enabled → startProactiveTicker(interval)
  → suggestProactive() 扫描 L1 待办信号 → payload {ts, items, text}
  → 回调 → ChannelManager.broadcast(payload.text)
  → 所有已启用通道 send() (log 打 stdout / 飞书主动推送 / 企业微信)
```
