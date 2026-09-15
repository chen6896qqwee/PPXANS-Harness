---
name: ppx-memory
description: 皮皮虾四层记忆引擎——当任务需要持久记忆、跨会话召回、场景激活、用户画像提炼时使用。腾讯式 L0原始→L1原子(高斯衰减遗忘)→L2场景(关键词聚类激活)→L3画像(频率统计) 四层架构，零依赖纯Node。处理"记住XX/上次聊过XX/这个人的偏好/场景上下文"等需求。仅在实际需要读写记忆、跨会话上下文时加载，纯对话闲聊不要加。
origin: custom
version: 1.0.0
---

# 皮皮虾四层记忆引擎 (ppx-memory)

把皮皮虾(ppx-agent)的腾讯式记忆内核搬进 OpenClaw。四层架构，零依赖，纯 Node ESM。

## 四层架构

| 层 | 文件 | 作用 |
|----|------|------|
| L0 | `scripts/l0.js` | 原始对话记录，每日一个 JSONL，自动过滤噪音/命令/寒暄 |
| L1 | `scripts/fact-store.js` | 原子记忆，高斯衰减遗忘(score·exp(-λt²))，命中加分 |
| L2 | `scripts/l2.js` | 场景记忆，中文关键词聚类，命中自动激活场景上下文 |
| L3 | `scripts/l3.js` | 核心画像，从记忆提炼 user.persona.md / agent.persona.md |
| - | `scripts/memory-ticker.js` | 水位线：today.md → daily/ → longterm.md，滚动压缩 |
| - | `scripts/experience.js` | 经验库：任务→结果→教训，自学习召回 |
| - | `scripts/pii.js` | PII/凭证自动脱敏（API key/私钥/身份证/卡号） |

## 数据位置

- 默认：`~/.openclaw/memory/ppx/`（可用 `PPX_MEMORY_DIR` 覆盖）
- 结构：`memory/l0/*.jsonl`、`memory/facts.json`、`memory/l2/scenes.json`、
  `memory/l3/user.persona.md`、`memory/today.md`、`memory/longterm.md`、`experience/lessons.json`

## 用法

```bash
SCRIPT=~/.openclaw/skills/ppx-memory/scripts/cli.js

# 写入原子记忆（自动PII脱敏）
node $SCRIPT add "兄弟偏好 A股主板+中小板+创业板，不碰科创板688和ST" --type preference --importance 15

# 检索（关键词 + 高斯衰减排序）
node $SCRIPT query "止损规则"

# 场景激活（返回匹配场景的人设+能力上下文块）
node $SCRIPT scene "帮我分析今天的资金流"

# 组装完整记忆上下文（today + longterm + topFacts）
node $SCRIPT context

# 记录一轮对话到水位线
node $SCRIPT tick u:"用户说的话" a:"助手回复"

# 沉淀经验
node $SCRIPT learn --task "跑资金流扫描" --outcome "东财被风控" --lesson "东财push2间歇HTTP000,用问财兜底" --tags "数据源,兜底"

# 构建用户画像
node $SCRIPT persona --force
```

## 集成到 OpenClaw 的时机

1. **会话开始/唤醒**：跑 `node $SCRIPT context` 拿记忆上下文块注入 prompt
2. **每次对话后**：`tick u:... a:...` 记入水位线；关键事实 `add`
3. **跨会话查询**：`query "关键词"` 召回相关记忆
4. **任务失败/踩坑**：`learn` 沉淀，下次同类任务 `lessons` 召回
5. **定期**：`persona --force` 重炼用户画像

## 安全

- 所有写入前自动过 `pii.js` 脱敏，检测到密钥/凭证会打 `[PII]` 日志并替换为 `[REDACTED]`
- 数据全在本地 `~/.openclaw/memory/ppx/`，不上云
- 高斯衰减：lambda 默认 0.02/天，长时间不访问的记忆自动淡出
## ⚠️ Windows 中文编码铁律（重要）

本机 PowerShell → node 传中文 **不可靠**（系统代码页 936/GBK，exec 传命令时好时坏）。
**禁止**把中文直接写进 exec 命令/argv/stdin。

### 可靠用法（写→验→重跑）
1. 用 here-string 写 spec 文件（UTF-8）：`[System.IO.File]::WriteAllText(path, $spec, (New-Object System.Text.UTF8Encoding($false)))`
2. **必须验证**：用 OpenClaw 的 `read` 工具读回 spec 文件，确认中文无损；或 node 读字节检测乱码（`/鍏|鍥|鐩|鏉/`）
3. 若乱码 → 重写一次。exec 编码抽风，重写通常能过
4. 再 `node cli.js --spec <file>`

### 识别乱码
- 正确中文：`兄弟偏好A股`
- GBK 乱码特征：`鍏勫紵`、`浣犲ソ`、`杩欎釜`、`鐨勮`（UTF-8 被当 GBK 读）
- 检测命令：`node -e "const s=require('fs').readFileSync('<file>','utf8');console.log(/鍏|鍥|鐩|鏉/.test(s)?'MANGLE':'ok')"`

### 数据目录
- 默认 `~/.openclaw/memory/ppx/`，可用 `PPX_MEMORY_DIR` 覆盖
- 测试请用独立目录，避免污染生产数据
## 会话持久化（解决"重启丢失历史"）

每个 sessionKey 落盘为 `sessions/<key>.jsonl`，重启不丢。

```bash
# 追加一轮对话
spec: { "cmd":"session-push", "content":"消息内容", "flags":{"session":"trading","role":"user"} }
# 读取会话(最近50轮)
spec: { "cmd":"session-load", "content":"trading" }
# 列出所有会话
spec: { "cmd":"session-list" }
```

- 单会话最多 200 轮，超出滚动截断；单条消息截断 2000 字
- sessionKey 仅允许字母数字 `_` `-`，其余自动替换为 `_`

## 反合理化

- "这一步可以跳过，直接记住就行" → 反驳：不先 `query` 去重就 `add`，会重复记相同事实；先去重是记忆质量的前提。
- "先不脱敏，内容没有敏感信息" → 反驳：PII 脱敏是自动的、零成本，跳过它等于把密钥写进明文记忆文件。
- "中文直接写进 exec 命令更快" → 反驳：Windows 936 代码页会把 UTF-8 中文读成 GBK 乱码（鍏勫紵），必须先写 UTF-8 文件再读回验证。

## 验证

- [ ] 写入记忆后用 `query` 读回，确认内容无损（中文无乱码、无意外 `[REDACTED]`）
- [ ] 检测到乱码特征（`/鍏|鍥|鐩|鏉/`）时已重写 UTF-8 文件
- [ ] 测试用独立目录（`PPX_MEMORY_DIR`），未污染生产记忆

## 已知限制（待改进）

- **记忆检索仍为子串匹配**（FactStore.query 用 includes）——下一步接 OpenClaw 官方向量/语义检索
- **web_search**：ppx 原 DDG HTML 正则脆弱——OpenClaw 底座下直接用 OpenClaw 的 tavily/brave，勿迁