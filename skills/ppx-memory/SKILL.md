---
name: ppx-memory
description: 皮皮虾记忆引擎（ppx-memory）的读写规程与独立 CLI 用法：五层记忆结构、什么时候记、记到哪层、怎么检索与安全遗忘。涉及长期记忆、用户偏好、跨会话召回时使用。
domain: meta
---

# 皮皮虾记忆引擎 (ppx-memory)

五层结构（L0 对话 → L1 原子事实 → L2 场景 → L3 画像 → L4 程序性记忆），自带高斯衰减、软删回滚、版本链与 WAL 增量落盘。

本技能附带 `scripts/cli.js`，是一个**不依赖主项目**的独立可运行版本，可直接对记忆库做增删查。

## 流程

### 1. 判断该不该记

只记**跨会话仍然成立**的信息：偏好、约定、稳定事实。
不记：寒暄、提问、一次性的中间结果。（引擎已做句式过滤，但边界情况要自己判——脏记忆会喂回上下文污染判断。）

### 2. 写入（选层）

| 内容类型 | 目标层 | 工具 |
|---|---|---|
| 用户偏好 / 稳定事实 | L1 | `memory_add` |
| 可复用的方法 / 流程 | L4（衰减仅 L1 的 1/4） | `memory_add`（layer=4）或 `create_skill` |
| 场景知识 | L2 | 由 `afterTurn` 自动聚类归档 |

内容必须**自包含**——脱离当前上下文也能读懂，否则三个月后检索出来也不知道在说什么。

### 3. 检索

- `memory_search` 走"粗召回（倒排索引）→ 精排（BM25 × 时间新鲜度 + 命中权重 + 重要性）"，门槛 1 分。
- 需要更宽上下文时，同时取 L2 场景与 L3 画像（`persona_read`）。
- 疑问句/多义词可用 `queryMulti` 的查询扩展（RRF 融合多路结果）。

### 4. 遗忘（可回滚）

```
memory_forget        → 软删（状态置 deleted，检索立即不可见，数据保留）
memory_restore       → 回滚（恢复即视为一次访问，避免刚恢复就被衰减清空）
memory_list_deleted  → 复核已遗忘条目（含原因与时间）
memory_clear_layer   → 按层清理（默认软删，hard=true 才物理删除）
```

**分不清该不该删时一律先软删。**

### 5. 迁移

`memory_export` / `memory_import` 用于换机或备份。导入前确认 `mode`：`merge`（按内容去重）还是 `replace`（整体替换，**会覆盖现有库**）。

### 6. 独立 CLI 用法（不依赖主项目）

```bash
# 写入一条原子记忆（自动 PII 脱敏）
node skills/ppx-memory/scripts/cli.js add "用户偏好深色主题"

# 检索
node skills/ppx-memory/scripts/cli.js search "主题偏好"

# 组装完整上下文（今日 + 长期摘要 + 高分事实）
node skills/ppx-memory/scripts/cli.js context

# 读取最近会话
node skills/ppx-memory/scripts/cli.js session --limit 50

# 软删 / 回滚
node skills/ppx-memory/scripts/cli.js forget <id>
node skills/ppx-memory/scripts/cli.js restore <id>
```

数据目录默认 `<root>/data`，可用环境变量 `PPX_DATA_DIR` 覆盖。

### 7. 集成到 OpenClaw 的时机

满足以下任一条时，把本技能的 `scripts/` 目录挂到目标 harness：
- 目标 harness 没有持久记忆，但需要跨会话召回用户偏好；
- 需要与主项目的记忆库**共享同一份数据**（同一 `PPX_DATA_DIR`）；
- 只想用记忆能力、不想引入整个 Agent 内核。

> 注意：独立版与主项目 `src/memory/` 共享数据格式。**同一数据目录不要被两个进程同时写入**（主项目有文件锁，独立 CLI 也有，但跨进程仍建议串行使用）。

## 反合理化

- "先记下来再说"——记忆越用越脏，且会喂回上下文。
- "记了删不掉"——软删可回滚，别因为怕删就不敢记。
- "把用户原话整段存进去"——提问和寒暄不该入库。
- "L4 和 L1 一样处理"——技能应该长期留存，衰减率不同正是为此。
- "直接改 facts.json 更快"——绕过锁会损坏 WAL 一致性，务必走工具或 CLI。

## 验证

完成后必须确认：① 写入内容脱离上下文仍可读；② 软删→恢复可逆；③ 检索能命中刚写入的条目；④ 若用 CLI，跑完 `cli.js context` 能看到新条目。
