# PPXANS-Harness 合并报告

> 合并日期：2026-09-15
> 产物路径：`C:\Users\chen\Desktop\智能体项目\PPXANS-Harness`
> 版本：**v2.0.0**
> 一句话：以 `ppx-agent v1.6.0` 为基座，吸收 `ppx-v2 v0.4.0` 的审计哈希链与记忆治理能力，合并为统一项目。**原项目全部原样保留，未改动一个字节。**

---

## 1. 整合范围与取舍

源目录 `C:\Users\chen\Desktop\智能体项目` 下有 5 个目录，但它们的性质差异极大——**只有 2 个是本仓库自研项目**，其余 3 个不能（也不应）按"整仓合并"处理。

| 目录 | 真实性质 | 关键证据 | 处置 |
|---|---|---|---|
| `ppx-agent` | 自研核心 v1.6.0 | remote `chen6896qqwee/ppx-agent`，84 个 src 文件 / 88 个测试 | ✅ **合并基座**（整体作为代码基底） |
| `ppx-v2` | 自研第二产品线 v0.4.0（dsh 插件版） | remote `chen6896qqwee/ppx-harness`，独立 git 历史 | ✅ **能力吸收**（抽取独有能力移植） |
| `ppx Harness` | ⚠️ **ppx-agent 在 v1.5.1 的旧快照** | remote 与 ppx-agent **完全相同**；version 1.5.1 < 1.6.0 | ❌ **不合并**（见 §5.1） |
| `codex` | **OpenAI 官方仓库**（Rust/Bazel） | remote `git@github.com:openai/codex.git`，7,804 文件 / 111 MB | ❌ **不合并源码**（见 §5.2） |
| `deepseek-harness` | **DeepSeek 官方仓库**（pnpm monorepo） | remote `https://github.com/deepseek-ai/deepseek-harness`，10,319 文件 | ❌ **不合并源码**（已以可选底座接入，见 §5.3） |

**取舍原则**：

1. **不复制第三方源码**——PPXANS-Harness 的核心定位是「零运行时依赖、自包含」。把 111 MB 的 Rust 项目和 1 万文件的 TS monorepo 吞进源码树，会同时破坏这个定位、膨胀仓库两个数量级、并引入无关许可证义务。第三方项目改为**来源登记 + 可选底座**方式接入（`references/THIRD-PARTY-SOURCES.md`）。
2. **不合并旧快照**——`ppx Harness` 是核心自己的旧版，合并等于用 v1.5.1 覆盖 v1.6.0，是**倒退而非吸收**。它缺少 v1.6.0 的四刀重构成果（`src/core/policy.js`、`src/core/trace.js`、`src/services/*`）。
3. **只吸收真独有能力**——对 `ppx-v2` 做了逐文件差异分析，剔除同源重复实现，只移植基座确实没有的能力。

---

## 2. 被吸收项目的贡献点

### 2.1 ppx-agent v1.6.0 —— 提供整个骨架（基座）

不是"贡献点"而是"基座本身"：通道层、插件容器、7 种编排模式、多进程军团、自愈引擎、L0–L3 记忆、33 个工具、MCP 客户端、ANS 模块、命令守卫三层防线、PII 脱敏、Web 壳、577 项测试，全部原样继承。

### 2.2 ppx-v2 v0.4.0 —— 贡献 3 项独有能力

逐文件对比后，ppx-v2 真正**独有**的只有以下两块（其余为同源重复或基座已有更强版本）：

#### ① SHA-256 审计哈希链（P0，最大缺口）

- **来源**：`ppx-v2/bundles/ppx-tools/audit.js`（151 行）
- **基座缺口**：全仓无任何 sha256 / 哈希链 / ndjson 实现
- **与基座已有能力的分工**：基座 `src/audit/verifier.js` 是**语义验证闸门**（防幻觉经验写回持久层）；本模块是**防篡改账本**（防审计日志本身被悄悄改写）。两者互补，不重叠。
- **移植产物**：`src/audit/audit-chain.js`
  - `AuditLog`：append-only 追加 + `prevHash` 链式哈希
  - `verify()`：重放校验，精确报告首个断裂行号（区分「内容被篡改」与「prevHash 断裂」两种断裂语义）
  - `quarantineBroken()`：链损坏时备份损坏段、重建空链、记录隔离事件（自愈语义）
  - `scrubArgs()`：落盘前掩码密钥/手机号
- **增强**：追加 URL query 凭证脱敏规则（`?token=`、`&api_key=` 等），补齐原版遗漏——与基座 v1.6.0 修复的事件流漏洞同类
- **接入点**：`ToolCatalog.call()` 工具执行唯一收口，通过 `setAudit()` 可选注入。**未注入时零开销**，完全向后兼容。

#### ② 记忆治理（软删/回滚/版本链/TTL）

- **来源**：`ppx-v2/bundles/ppx-tools/mem-store.js`（311 行）
- **基座缺口**：原版遗忘是**不可逆硬删**（`fact-store._prune()`），误删一条重要记忆无法挽回
- **移植产物**：并入 `src/memory/fact-store.js`

| 新方法 | 语义 |
|---|---|
| `forget(idOrContent, {reason})` | 软删：标记 `status='deleted'` + 删除时间/原因，数据保留，幂等 |
| `restore(id)` | 回滚软删，恢复即刷新 `lastAccess`（防恢复后立刻被衰减清空） |
| `deletedList()` | 列出已遗忘条目（含原因），防误删无人发现 |
| `update(id, content)` | 版本链：旧版存为 `archived` + `prevId` 链接，记忆演化可追溯 |
| `sweepExpired({ttlDays, dryRun})` | 超期未访问则软归档；`dryRun` 支持预演不动数据 |
| `clearLayer(layer, {hard})` | 按层清理，默认软删可回滚 |
| `exportAll()` / `importAll(data, {mode})` | 迁移：`merge` 按内容去重、`replace` 整体替换 |

- **配套改造**：`_live()` 统一过滤 `deleted`/`archived`，检索/列表/相似匹配全部走它；`add()` 去重改为排除软删条目（否则已删记忆会拦截新写入）

#### ③ L4 程序性记忆

- **来源**：`ppx-v2` 的 `LAYER_META` 定义（L4 衰减 λ=0.005）
- **移植产物**：`fact-store.js` 新增 `layer` 字段 + `L4_DECAY_PER_DAY = 0.005`
- **行为**：L4（技能/流程/方法论）衰减率固定为 L1 的 1/4，且 `_prune()` 裁剪时同样按 layer 计衰减——技能不会被当闲聊事实裁掉。**7 天衰减实测：L1 保留 37.5%，L4 保留 78.3%。**

#### ④ 10 个治理与运维工具

- **来源**：`ppx-v2/bundles/ppx-tools/index.js` 的 5 个治理工具 + `ppx-memory`/`ppx-selfheal` 暴露的工具
- **移植产物**：`src/tools/governance.js`
- **工具清单**：`memory_forget`、`memory_restore`、`memory_list_deleted`、`memory_export`、`memory_import`、`memory_clear_layer`、`audit_verify`、`persona_build`、`persona_read`、`selfheal_run`
- **改写**：原版用 cordis 的 `defineTool` + `@deepseek-ai/schemastery`（zod）声明，改为基座原生 `ToolCatalog.register` 风格，**剥离全部外部依赖**

### 2.3 合并前的显式决策：不引入 SQLite

ppx-v2 的记忆库用 `node:sqlite`。它虽是 Node 内置模块（零第三方包），但**要求 Node ≥ 22.5**，而基座是 `engines.node >= 20`。

**决策：放弃 SQLite，改用基座已有的 `facts.json` + `withFileLock` 实现同等治理语义。**

理由：为一个存储引擎把整个项目的 Node 门槛从 20 抬到 22.5，收益与代价严重不对等；基座的 JSON + 文件锁方案已验证可支撑跨进程共享（经验库已在用）。**保住了「零运行时依赖 + Node >= 20」这两条核心 Slogan。**

---

## 3. 合并后的目录结构与模块划分

新建 `PPXANS-Harness/`，不修改任何原项目。

```
PPXANS-Harness/
├── package.json            name=ppxans-harness, version=2.0.0, engines.node>=20, 零 dependencies
├── README.md               已更新: 43 工具 / L0-L4 / 审计链 / 记忆治理 / 597 测试
├── MERGE-REPORT.md         本文件
├── CHANGELOG.md            继承基座 41 个版本的版本脉络
├── LICENSE                 Apache-2.0
├── .gitignore              + exports/ (记忆导出产物) + *.quarantine-* (审计隔离备份)
├── config/
│   ├── ppx.json            + audit 配置段 + memory.memory_ttl_days
│   ├── identity.md / ishiki.md
├── src/
│   ├── agent/              Agent 引擎 (编排薄委托 + 多模型回退)
│   ├── core/               ★ policy.js 工具循环策略 / trace.js 事件流 traceId 贯穿
│   ├── services/           ★ memory-service 记忆协调 / learning-service 自我学习
│   ├── memory/             L0-L4 记忆 + 会话事件日志 + 经验库 + 压缩层
│   │   └── fact-store.js   ★ +软删/回滚/版本链/TTL/clearLayer/导入导出 +L4 layer
│   ├── audit/              ★ verifier.js 语义验证闸门 (原有)
│   │   └── audit-chain.js  ★ 新增: SHA-256 防篡改哈希链
│   ├── ans/                ANS 神经系 (values/lifecycle/proactive/reward/eviction/guard)
│   ├── bus/                全局 Runtime 总线
│   ├── tools/              工具系统
│   │   ├── catalog.js      ★ +setAudit() 审计收口
│   │   ├── governance.js   ★ 新增: 10 个治理运维工具
│   │   ├── builtin.js      ★ 导出 safePath 供复用
│   │   └── advanced/methods/selfmod/document/custom/delegate/seam/command-guard
│   ├── channels/           通道 (http/feishu/wechat/log)
│   ├── orchestrator/       军团编排 (legion + dag + agent-worker)
│   ├── mode/               7 种编排模式
│   ├── llm/                路由中枢 + client + retry + fence + dsml + embedder
│   ├── mcp/                零依赖 MCP 客户端 (stdio + HTTP Streamable)
│   ├── plugin/             ★ builtin.js +auditPlugin, 12 → 13 个插件
│   ├── selfheal/           自愈引擎
│   ├── persona/ skills/ seam/ utils/
├── references/
│   └── THIRD-PARTY-SOURCES.md  ★ 新增: 第三方项目来源登记（不含源码）
├── scripts/
│   ├── audit-verify.js     ★ 新增: 审计链校验 CLI
│   └── selfheal-bench/eval/bench/release/acceptance ...
├── test/                   88 → 90 个测试文件 (597 项)
│   ├── audit-chain.test.js        ★ 新增 9 项
│   └── memory-governance.test.js  ★ 新增 11 项
├── web/                    Next.js 产品壳 (node_modules 未复制，需自行 npm i)
├── data/                   运行时数据（继承基座，记忆/会话/配置延续）
└── docs/                   架构/配置/快速开始/评测/发布说明
```

★ = 合并引入或修改的文件

---

## 4. 关键依赖与配置的整合方式

### 4.1 依赖：保持零运行时依赖

`package.json` 的 `dependencies` **依然为空**。这是硬约束，所有新增能力均用 Node 标准库实现：

| 新增能力 | 使用的标准库 |
|---|---|
| 审计哈希链 | `node:crypto`（sha256）、`node:fs`、`node:path` |
| 记忆治理 | 复用基座 `utils/store.js`（`withFileLock` + `atomicWrite`） |
| 治理工具 | 复用基座 `ToolCatalog` / `safePath` |

外部能力仍走**可选底座**而非依赖：`dsh` provider（DeepSeek Harness）不装即自动回退 `http`/`cloud`。

### 4.2 包元数据

| 字段 | 变更 |
|---|---|
| `name` | `ppx-agent` → **`ppxans-harness`** |
| `version` | `1.6.0` → **`2.0.0`**（架构合并里程碑） |
| `bin` | 保留 `ppx`/`ppx-serve`/`ppx-channels`（兼容既有习惯），**新增 `ppxans` 别名** |
| `keywords` | + `audit-chain`、`memory-governance`、`agent-nervous-system` |
| `exports` | + `./audit` → `src/audit/audit-chain.js` |
| `scripts` | + `audit:verify` |
| `engines.node` | **保持 `>=20`**（见 §2.3 的 SQLite 决策） |

### 4.3 插件装配顺序（新增 auditPlugin）

`src/plugin/builtin.js` 的装配数组由 12 个增至 **13 个**，插入位置遵循「依赖在前」：

```
bus → healer → persona → facts → experience → session → memory → llm
    → memoryLayers → traces → 【audit】 → tools → modes
```

- `auditPlugin` 必须在 `toolsPlugin` **之前**——后者通过 `ctx.consume("audit")` 取审计实例并 `setAudit()` 注入 catalog
- `auditPlugin` 受 `config.audit.enabled === false` 控制，关闭时 `provide("audit", null)`，catalog 内部走零开销分支

### 4.4 配置文件

```jsonc
// config/ppx.json 新增
"memory": {
  "memory_ttl_days": 90        // 新增：TTL 自动归档阈值
},
"audit": {                     // 新增整段
  "enabled": true              // false 可关闭审计（性能敏感场景）
}
```

### 4.5 接入方式汇总

| 能力 | 接入路径 |
|---|---|
| 审计记录 | `ToolCatalog.call()` → `this.audit.append(...)`（可选注入） |
| 记忆治理 | `FactStore` 新增公开方法，工具层 `governance.js` 薄包装 |
| 治理工具 | `toolsPlugin` 调 `registerGovernanceTools(tools, deps)` |
| CLI 校验 | `scripts/audit-verify.js` ← `npm run audit:verify` |

---

## 5. 未合并项的具体说明

### 5.1 `ppx Harness` —— 旧快照，合并即倒退

| 对比项 | `ppx Harness` | `ppx-agent` |
|---|---|---|
| remote | `chen6896qqwee/ppx-agent.git` | `chen6896qqwee/ppx-agent.git`（**同一个仓库**） |
| version | 1.5.1 | 1.6.0 |
| 最新提交 | `4093646 chore: bump v1.5.1` | `a2d5e7f docs: archive legacy release body files` |
| src 文件 | 80 | 84 |
| 缺失文件 | `core/policy.js`、`core/trace.js`、`services/memory-service.js`、`services/learning-service.js` | — |

结论：这是 ppx-agent 在 v1.5.1 时的本地克隆副本。合并它会丢掉 v1.6.0 的四刀重构（内核 1238 → 955 行、结构化事件流、工具超时预算）。**已明确排除**，该目录可自行删除或留作历史对照。

### 5.2 `codex` —— 技术栈不同，零可复用代码

OpenAI 官方 Codex CLI，Rust + Bazel 技术栈，7,804 个文件 / 111 MB。与纯 Node 项目无任何代码可复用，作为架构参考阅读即可。**保留为独立原始仓库。**

### 5.3 `deepseek-harness` —— 已以「可选底座」接入

10,319 个文件。基座原本就通过 `.deps/deepseek-harness` 内嵌 + `dsh` provider 的方式接入（`config/ppx.json` 的 providers 首位），`.deps/` 已在 `.gitignore` 中。**这不是本次合并遗漏，而是既有的、正确的设计**——未安装/未构建时健康检查判其不可用并自动回退，主流程不受影响。

### 5.4 ppx-v2 中未移植的部分及理由

| 未移植项 | 理由 |
|---|---|
| `command-guard.js`（113 行） | 与基座 `src/tools/command-guard.js` **逐行同源**（仅品牌改写）。唯一实质差异：ppx-v2 让常规黑名单「allow_all 也不绕过」，基座放行。**保留基座行为**（`allow_all` 是用户显式授权的逃生阀，语义更合理），未吸收 |
| `ppx-channels`（7.9 KB） | ⊂ 基座 `channels/http.js`（30 KB，含 token 持久化 / 漏桶限流 / CORS 白名单 / inflight 控制） |
| `ppx-feishu`（163 行） | ⊂ 基座 `channels/feishu.js`（含 X-Lark-Request-Token 校验） |
| `ppx-selfheal`（188 行） | ⊂ 基座 `selfheal/healer.js`（多了过期备份清理） |
| `ppx-memory/index.js` | ⊂ 基座 `memory/l3.js`（`PersonaStore` 已有，只是没暴露成工具 → 已通过 `persona_build`/`persona_read` 补齐） |
| 8 个重复工具 | `get_time`/`memory_add`/`memory_search`/`read_file`/`write_file`/`list_dir`/`run_command`/`code_act` 基座均有且更强 |
| `mem-store.js` 的 SQLite 实现 | 见 §2.3，改用 JSON + 文件锁 |
| `ppx-tools/index.js` 的 cordis 声明式框架 | 剥离 `@deepseek-ai/schemastery` / `dsh-tools` / `cordis` 依赖，改写为基座原生风格 |

---

## 6. 验证结果

### 6.1 全量测试

```
597 total / 591 pass / 0 fail / 6 skip
```

| 阶段 | tests | pass | fail | skip |
|---|---|---|---|---|
| 基座复制后（原始状态） | 577 | 568 | **3** | 6 |
| 吸收 ppx-v2 能力后 | 577 | 568 | 3 | 6 |
| 修复基座遗留时区 bug 后 | 577 | **571** | **0** | 6 |
| **新增 20 项测试后（最终）** | **597** | **591** | **0** | 6 |

- **零回退**：吸收全部新能力后，基座 577 项测试结果与复制时完全一致，无一项因合并而失败
- **+20 项新覆盖**：`audit-chain.test.js`（9 项）、`memory-governance.test.js`（11 项）
- **6 项跳过**：均为网络依赖测试（无 API key 时不跑），属设计内行为

### 6.2 顺带修复的基座遗留缺陷（P1）

合并过程中发现并修复了基座一个会让测试**每天稳定失败 3 项**的时区 bug：

- **现象**：全量测试 577 项中恒定 3 项失败（`trace.test.js` 的 traceId 贯穿 / PII 脱敏 / span 耗时）
- **根因**：实现 `src/core/trace.js` 用 **本地日期** `logicalDay()` 拼事件文件名，而测试 `test/trace.test.js` 用 **UTC 日期** `new Date().toISOString().slice(0,10)` 拼读取路径。在 UTC+8 的 **00:00–08:00 窗口**两者相差一天，导致读到不存在的文件
- **为何 CI 未发现**：GitHub Actions 跑在 UTC 时区，两者恰好一致 —— 这是发布声明「0 fail」与本地实跑「3 fail」矛盾的根因
- **修复**：测试改用 `logicalDay()` 与实现对齐（一行导入 + 一行替换）
- **结果**：3 项失败消失，571 全过

### 6.3 自愈基准

```
Self-heal score: 7/7 (100.0%)
All self-heal scenarios passed.
```

7 个注入破坏场景（rebuild_missing_dirs / corrupt_json_reset / crash_recovery_clean_loop / prune_stale_corrupt / prune_stale_backup_dirs / prune_stale_bak / clean_run_no_fixes）全部通过。

### 6.4 功能实测

| 验证项 | 结果 |
|---|---|
| Agent 启动 | ✅ 正常，13 个插件按序装配 |
| 工具注册总数 | ✅ **43 个**（基座 33 + 治理 10） |
| 治理工具注册 | ✅ 10/10 全部就位 |
| 审计链注入 | ✅ `tools.audit` 非空 |
| `audit_verify` 实调 | ✅ `{"ok":true,"total":0,"detail":"空审计日志"}` |
| `selfheal_run` 实调 | ✅ `{"ok":true,"health":{"fixes":[],"crashed":false}}` |
| 审计链篡改检测 | ✅ 篡改第 2 行 → `brokenAt: 2`，报「hash 不匹配」 |
| 审计链隔离重建 | ✅ 备份 `audit.ndjson.quarantine-*` + 重建空链 + 记录隔离事件 |
| 参数脱敏 | ✅ `sk-***` / `?token=[REDACTED]` / `1**********` |
| 记忆软删回滚 | ✅ 软删后检索不可见，`restore` 后恢复可见 |
| 版本链 | ✅ 旧版存为 `archived` + `prevId` 链接 |
| TTL 归档 | ✅ 200 天旧记忆被归档，新记忆不受影响 |
| 导出/导入 | ✅ 导出 3 条，导入 3 条，重复导入 0 导入 3 跳过 |
| L4 慢衰减 | ✅ 7 天后 L1 保留 37.5%，L4 保留 78.3% |
| `npm run audit:verify` | ✅ exit 0 |

---

## 7. 使用方式

```bash
cd C:\Users\chen\Desktop\智能体项目\PPXANS-Harness

# 跑测试
npm test

# 自愈基准
npm run selfheal

# 审计链校验
npm run audit:verify
npm run audit:verify -- --fix      # 损坏则隔离重建
npm run audit:verify -- --tail 20  # 附最近 20 条

# 对话 / 服务
npm run chat
npm run serve

# Web 壳 (需先装前端依赖，node_modules 未随合并复制)
cd web && npm i && npm run dev
```

---

## 8. 已知事项与后续建议

| 优先级 | 事项 |
|---|---|
| P2 | `web/node_modules` 未随合并复制（体积考虑），首次使用需 `cd web && npm i` |
| P2 | 基座 `src/ans/guard.js` 自述仅覆盖「走总线的命令」，而现有工具走 catalog/seam 局部策略 → 全局免疫闸门实际近乎空转。本次合并把**审计**接进了工具收口，**下一步可顺势把 guard 也接进同一收口点**，让免疫闸门真正生效 |
| P3 | `test/context-eng-optimize.test.js` 用相对路径 `__nonexistent__` 构造 agent，会在项目根留下磁盘残留目录（含 7 个运行时文件，已被 `.gitignore` 兜住）。跑完测试后已手动清理；根治方式是把该测试的 `root` 改为 `os.tmpdir()` 临时目录 |
| P3 | `data/` 运行时数据已随基座继承（记忆/会话/配置延续，开箱即用）。若要全新起步，删除 `data/` 即可 |
| P3 | `ppx Harness`（v1.5.1 旧快照）确认无价值后可删除，避免与 PPXANS-Harness 混淆 |

---

*本报告由合并过程实录整理，所有结论均有实测证据支撑。原 `ppx-agent`、`ppx-v2`、`ppx Harness`、`codex`、`deepseek-harness` 五个目录**均未被修改**。*
