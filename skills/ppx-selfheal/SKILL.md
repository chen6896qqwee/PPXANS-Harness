---
name: ppx-selfheal
description: 皮皮虾自愈引擎——当需要检查/修复记忆数据完整性、检测崩溃残留、重建损坏JSON时使用。启动体检(建目录/修损坏JSON)、崩溃检测(integrity.json)、tmp残留清理。配套 ppx-memory 数据目录做数据自愈。仅在需要自检/修复数据时加载。
origin: custom
version: 1.0.0
---

# 皮皮虾自愈引擎 (ppx-selfheal)

把皮皮虾(ppx-agent)的 Healer 迁进 OpenClaw。零依赖纯 Node。对 ppx-memory 的记忆数据做完整性自愈。

## 能力

| 功能 | 说明 |
|------|------|
| 启动体检 | 建缺失目录(memory/daily/experience/sessions/logs)、校验 facts.json 可解析 |
| 损坏恢复 | facts.json 损坏时备份为 `.corrupt-<ts>` 后重建为 `[]` |
| 崩溃检测 | 读 `integrity.json`，上次非干净退出则报警 + 清理 `.tmp` 残留 |
| 干净标记 | heal 完成后 markClean，崩溃后 markDirty |

## 数据位置

- 默认自愈 `~/.openclaw/memory/ppx/`（ppx-memory 的数据目录）
- 可用 `PPX_MEMORY_DIR` 或 `--root <dir>` 覆盖
- integrity.json 记录进程干净退出状态

## 用法

```bash
SELFHEAL=~/.openclaw/skills/ppx-selfheal/scripts/cli.js

# 完整自愈 (体检+修复+崩溃清理)
node $SELFHEAL

# 只检查不修复
node $SELFHEAL --check

# 指定数据目录
node $SELFHEAL --root "C:\path\to\data"
```

## 集成时机

1. **每次会话启动/唤醒**：跑 `node $SELFHEAL` 自愈记忆数据，再加载 context
2. **记忆读写异常时**：跑 `--check` 定位损坏
3. **崩溃后重启**：自动检测残留并清理

## 与 OpenClaw 的关系

- OpenClaw 有内置 healthcheck/doctor（检查配置/网关），本 skill 专注**记忆数据层的自愈**，两者互补不冲突
- 数据全在本地，不依赖云端