# PPXANS-Harness 智能体评估报告（实测）

**版本**：v3.2.2 ｜ **评估日期**：2026-10-07 ｜ **评估者**：曙光（Dawn）智能体
**方法**：本机全量实跑（测试套件 + 12 道质量闸门 + 压测），非引用；静态指标由脚本现场统计
**环境**：Windows 10.0.26300 (x64) ｜ Node v26.10.0 ｜ npm 11.19.1 ｜ 工作区 `C:\Users\chen\Desktop\PPXANS-Harness`
**总分：84 / 100**（8 维加权）

---

## 0. 一句话结论

**这不是"能不能跑"的问题，是"账目还差一行没对齐"的问题。** 1554 项测试零失败、12 道闸门里 11 道通过，唯一的红灯是 `readme-sync-check` —— README 里写了 `ctx_tokens=5395`，实测是 `5391`。工程本身是硬的；漂的是门口那块牌子。

---

## 1. 实测基线（本次全部数字均为现场实跑）

| 指标 | 实测值 | 采集方式 |
|---|---|---|
| 源码规模 | **165 个 JS 文件 / 28,968 行** | 递归统计 `src/**/*.js` |
| 测试规模 | **188 个 JS 文件 / 23,497 行** | 递归统计 `test/**/*.js` |
| 测试:源码 比 | **0.81** | 行数比 |
| 全量测试 | **1554 项 / 1550 通过 / 0 失败 / 4 skip（68.5s）** | `node --test --test-force-exit test/*.test.js` |
| 内置工具 | **85 个**（+2 `ppx.*` → MCP 暴露 **87**） | `ctx-profile` 实测 |
| 核心 schema | **26 个**（其余 59 个按需加载） | 渐进披露实测 |
| 固定上下文开销 | **5391 tok/请求**（schema 3337 + `_context()` 2054） | `node scripts/ctx-profile.js` |
| 运行时依赖 | **0**（`package.json` 无 `dependencies` 字段） | 直接读文件 |
| 技能库 | **56 个 SKILL.md** | 递归统计 |
| 专家包 | **10 个 manifest** | `experts/**/manifest.json` |
| 文档 | **23 篇 .md**（`docs/`） | 递归统计 |
| 脚本 / 入口 | **29 个脚本** ｜ **5 个 bin** | 目录统计 |
| CHANGELOG | 1190 行 | 行数统计 |

**模块行数 TOP 8**（钱花在哪）：

| 模块 | 行数 | 模块 | 行数 |
|---|---:|---|---:|
| tools | 5220 | mcp | 1506 |
| memory | 4402 | core | 1034 |
| orchestrator | 2465 | skills | 959 |
| agent | 2392 | utils | 805 |
| channels | 1824 | config | 764 |

---

## 2. 测试与闸门结果（12 道全跑）

| # | 闸门 | 结果 | 关键数字 |
|---|---|---|---|
| 1 | `npm test` | ✅ | 1554 项 / 1550 通过 / 0 失败 / 4 skip |
| 2 | `selfheal-bench` | ✅ 7/7 | 目录重建、JSON 损坏重置、崩溃恢复、三向清理全过 |
| 3 | `ctx-profile --check` | ✅ | 固定开销 5391 ≤ 预算 5800 tok |
| 4 | `audit-verify` | ✅ | 链完整｜条数 **1**｜断裂点 0 |
| 5 | `skill-lint` | ✅ | 56 技能，退出码 0 |
| 6 | `bench/falsify` | ✅ 20/20 | 每任务"参考解判正 + 全部变体判负"，无豁免 |
| 7 | `cache-audit --check` | ✅ 4/4 | 前缀稳定/易变隔离/工具数组/追加史；1 项 WARN（见 §5） |
| 8 | `arch-guard --check` | ✅ | 37 模块 / 92 依赖边 / **依赖环 0** / 越层 1（基线内） |
| 9 | `readme-sync-check` | ❌ **exit 1** | ctx_tokens README=5395 vs 实测=5391（2 处） |
| 10 | `eval.js`（本地能力层） | ✅ 9/0 | 问候/时间/记忆闭环/去重/文件工具全过 |
| 11 | `web:check` | ✅ | 39 图标命中、70 个 id 存在、app.js 语法通过 |
| 12 | `bench/team-longrun` | ✅ | 5 拓扑 × 24 任务，0 饿死、0 在途残留 |

**压测**：
- `bench.js`：并发 20 × 200 调用，失败 0，p50 342ms / p95 741ms / p99 775ms；同 session 200 轮 50.6ms/轮
- `taskbench`：3/3 = 100%，33285 tok，9.01 通过任务/10万 tok
- `team-longrun`：parallel/supervisor/debate/pipeline/review 五拓扑吞吐 110–220 t/s，全部达标

**4 个 skip（均为网络/密钥门控，合理）**：`http_request GET`、`web_search`、`fetch_page 抓正文`、`LLMClient.health /models`。

**CI 对照**：`.github/workflows/ci.yml` 已覆盖上述 1–12 中的绝大多数（test → readme-sync-check → arch-guard → team-longrun --tasks 40 → skill-lint → ctx-profile --check → cache-audit --check → selfheal-bench → audit-verify → falsify → web:check → eval.js），矩阵 **ubuntu + windows × node 20/22/24**。**结论：由于本地 `readme-sync-check` 失败，CI 当前应为红灯。**

---

## 3. 八维加权评分

| # | 维度 | 权重 | 得分 | 加权 | 等级 |
|---|---|---:|---:|---:|---|
| 1 | 架构与模块化 | 15% | 84 | 12.60 | 🟢 强 |
| 2 | 记忆与知识 | 14% | 84 | 11.76 | 🟢 强 |
| 3 | 工具与生态 | 13% | 78 | 10.14 | 🟡 中 |
| 4 | 多 Agent 协作 | 14% | 86 | 12.04 | 🟢 强 |
| 5 | 权限与治理 | 13% | 86 | 11.18 | 🟢 最强项 |
| 6 | 可测试性与 CI | 11% | 86 | 9.46 | 🟢 强 |
| 7 | 内容资产与可增长性 | 10% | 78 | 7.80 | 🟡 中 |
| 8 | 工程克制与零依赖 | 10% | 92 | 9.20 | 🟢 差异化最高 |
| | **合计** | **100%** | | **84.18 → 84** | |

> 较上一份评估（83）**+1**：主要来自 `bench/team-longrun.js` 落地（协作层首次有真实长任务压测）与 CI 闸门数增加。

---

## 4. 逐维要点

**1 架构与模块化 84** — `core → plugin → agent → tools/orchestrator` 装配链清晰，DI 容器而非直接 import；`arch-guard` 把"依赖单向无环"变成自动化守卫（37 模块 92 边 0 环）。扣分：`tools`(5220)+`memory`(4402) 占源码 33%，是明显胖模块，改动 blast radius 大。

**2 记忆与知识 84** — L0–L4 五层 + 自建 BM25（IDF/长度归一/时效衰减）+ 可插拔 dense embedder 接口 + provenance + `experience`/`failure-episode` 经验沉淀 + sqlite/WAL。扣分：dense 默认关闭，"说法不同意思相同"召回会漏；缺跨层一致性断言。

**3 工具与生态 78** — 85 内置工具、MCP **服务端+客户端双向**、渐进披露（26 常驻/59 按需）、`skill_import` 带白名单+SSRF/超时防护。扣分：**无在线市场、无 A2A/跨进程协议、工具 schema 无版本化（无 deprecated 通道）**。

**4 多 Agent 协作 86** — 23 专家 / 10 班组 × 5 拓扑 / 10 专家包 / 17 人格；常驻房间六态 + 按 callee 并发 + 回调闭环 + 在途账本；`team-longrun` 实测 0 饿死。扣分：`ConcurrencyGovernor` 仅本进程，`spawn_agent` 子进程绕开全局配额。

**5 权限与治理 86（最强）** — `permissions/intersection.js` **deny-wins**；`ans/boundary.js` 六条硬边界写进 system 指令区；五高危域关键词动态护栏；`verify/postcondition`；`audit/audit-chain.js` append-only + SHA-256 链。扣分：关键词护栏换说法可绕；审计链实测仅 1 条。

**6 可测试性与 CI 86** — 188 文件 / 1554 断言 / 0 失败；`falsify` 反证门禁（判分器必须"参考解判正 + 变体全判负"）是同赛道少见设计；CI 双 OS × node 20/22/24。扣分：**无覆盖率阈值门禁**；4 个 skip 未标注解禁条件。

**7 内容资产与可增长性 78** — 56 技能（12 能力域 100% 覆盖）、10 专家包、23 篇文档、`refine`/`refine_skill`/`playbook`/`failure-episode` 自增长闭环。扣分：**README 数字漂移（本次唯一红灯）**；26 篇历史审计/评估文档未归档，新读者分不清 canonical。

**8 工程克制与零依赖 92（差异化最高）** — `package.json` 无任何依赖，全部 Node 内置（`node:fs/path/os`、内置 `fetch`、`node:sqlite`）；`node bin/ppx-web.js` 即起，无 `npm install`。代价已在 README 明确披露（无向量库、无 YAML、无官方 SDK）——**取舍诚实**。

---

## 5. 发现（P0 / P1 / P2）

### 🔴 P0 — 下次发布前必修

| # | 问题 | 证据 | 处置 |
|---|---|---|---|
| P0-1 | **README 数字漂移 → 闸门红灯** | `readme-sync-check` exit 1：`ctx_tokens` README=5395 vs 实测=5391（表格 + 散文各 1 处） | 跑 `node scripts/readme-sync-check.js --fix` 同步为 5391 |
| P0-2 | **tests 数字仍陈旧** | 徽章 `tests-1543_passing` + `npm test # (1543 项)`，实测 1554 项/1550 通过；`--with-tests` 校验当前报"实测失败,跳过"，等于该数字**无门禁保护** | 手动改徽章/注释为 1550，并修 `readme-sync-check` 的 tests 解析使其真正生效 |

### 🟡 P1 — 两个版本内

| # | 项 | 对策 |
|---|---|---|
| P1-1 | 无覆盖率门禁 | CI 加 `--experimental-test-coverage` + 阈值（全局 60%，`permissions`/`audit`/`governor` 90%） |
| P1-2 | 审计链样本≈0（仅 1 条） | 断言"任意一次工具调用后链非空"，把落点写进默认会话 |
| P1-3 | 并发治理只覆盖本进程 | `spawn_agent` 子进程加跨进程配额（共享状态文件 + 原子锁）或明确降级为"软约束"并写文档 |
| P1-4 | 关键词护栏可绕过 | 加"低置信度即按高风险处理"的保守兜底 |
| P1-5 | 4 个 skip 无解禁标注 | 注释解禁条件（需网络 / 需 provider key） |
| P1-6 | 26 篇历史文档未归档 | 归档到 `docs/archive/`，`docs/` 只留 canonical |

### 🟢 P2 — 有空再说

- 4 个 skip 测试的理由与解禁条件补全
- `workdir` 写入静态缓存前缀导致跨机器/跨目录不共享 provider 缓存（`cache-audit` WARN）——如可接受则文档化，否则把工作目录移出静态区
- `supervisor` 按负载在 5 拓扑间自适应切换
- 专家包用户贡献路径文档
- A2A 协议只读监听（不投入实现）

---

## 6. 诚实清单（本次没做 / 做不到）

| 项 | 说明 |
|---|---|
| **没跑真实 LLM 端到端** | 本机无 provider key，`eval.js --llm` 未跑；9/0 是**本地能力层**，非 LLM 任务成功率。"任务成功率"这一维**仍未采信** |
| **协作层压测是桩执行器** | `team-longrun` 明确用"桩执行器（离线零密钥）"，验证的是调度/账本/时间线，不是"8 小时真实 LLM 长任务"的成员饿死数据 |
| **未做跨进程/跨机器实测** | `P0-3` 跨进程配额、provider 缓存跨机共享均未实测 |
| **未与 GitHub 对标项目逐项复检** | 上一份评估的 18 项目对标未在本次重跑，沿用其结论 |
| **工作区未提交** | `git status`：109 files changed，+9789/-1217，全部滞留工作区；本次**未执行任何 `git commit`** |

---

## 7. 复现命令

```bash
cd PPXANS-Harness
npm test                                    # 1554 项 / 1550 通过 / 0 失败 / 4 skip
node scripts/selfheal-bench.js              # 7/7
node scripts/ctx-profile.js --check         # 5391 ≤ 5800 tok
node scripts/audit-verify.js                # 链完整｜条数 1
node scripts/skill-lint.js                  # 56 技能
node bench/falsify.js                       # 20/20
node scripts/cache-audit.js --check         # 4/4
node scripts/arch-guard.js --check          # 37 模块 / 0 环
node scripts/readme-sync-check.js           # ❌ 当前 exit 1（唯一红灯）
node scripts/eval.js                        # 9/0（本地能力层）
node scripts/check-web.mjs                  # 全过
node bench/team-longrun.js --tasks 24       # 5 拓扑全过
```
