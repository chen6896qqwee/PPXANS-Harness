# Agent 变强框架对账表（2026-10-09）

> 依据"想记做学评"框架（模型×上下文×工具×记忆×规划×反馈×安全）逐维对账皮皮虾现状。
> 每行附代码锚点，缺什么补什么——本次补齐：回归检测。

| 框架方向 | 皮皮虾现状 | 代码锚点 | 完成度 |
|---|---|---|---|
| 1. 定义"强"+评估 | taskbench 20 任务 + 可证伪判分（88 mutants）+ GPA 五指标 + 计数稳定性基线 + **单位成本成功率（通过任务/10万tok）** | scripts/taskbench.js, bench/falsify.js | ✅ |
| 2. 上下文工程 | 渐进披露（26 核心 + 59 按需）+ 分节 _context() + 溢出收缩 + 前缀缓存静态区审计 + 记忆上下文注入 | src/agent/context.js, scripts/cache-audit.js | ✅ |
| 3. 工具与环境 | 85 工具（schema 校验/幂等重试决策/超时预算）+ postcondition 结果验证 + MCP server+client 双向 | src/tools/, src/core/postcondition.js | ✅ |
| 4. 规划与推理 | ReAct（默认）+ plan-exec 模式 + 多方案仲裁（arbitrate/judge，专家模式实测）+ 关键节点纠错（postcondition + steering 失败不堵墙） | src/mode/, src/tools/delegate.js | ✅ |
| 5. 记忆与学习 | 五层记忆（BM25 检索/TTL 遗忘/WAL）+ 经验库 + **失败案例库（--learn 联动 taskbench 失败→failure-episode）** + A-Mem 卡片演化 + 技能自造（create_skill） | src/memory/, src/skills/ | ✅ |
| 6. 多智能体（别过度） | 单 agent 默认、委派 opt-in（符合"单 agent 能做好不硬上多 agent"）+ 军团并发治理 + 跨进程配额 + supervisor 收敛 | src/orchestrator/legion.js | ✅ |
| 7. 工程化与安全 | 可观测（tracer/回放/审计链）+ 可靠（熔断/预算/降级链/治理器）+ 安全五层纵深（免疫闸门→权限→审批→PII→postcondition）+ redteam | src/audit/, src/ans/guard.js, test/redteam.test.js | ✅ |
| **反馈闭环** | 评估失败→**--learn 写失败案例库**→学习服务检索反思；**--baseline 建基线 → --check-regression 检测退化（本次补齐）→ 门禁** | scripts/taskbench.js | ✅ 本次补齐 |

## 剩余差距（诚实清单）

- **微调/DPO/RLHF**：不适用（零依赖定位；经验库+技能吸收已是轻内核等价物）
- **树搜索/多方案投票的系统性使用**：arbitrate 已有，按需启用（框架也警告"别过度"）
- **自动生成工作流**：create_skill/code_act 已有，自动化编排待 trait 接口后评估
- **在线 A/B 流量**：无线上部署场景，不适用（分级自评已诚实标注）

## 最小迭代闭环（皮皮虾版）

```
定目标(ROADMAP 验收标准) → 执行(taskbench) → 观察(轨迹/GPA) → 评估失败(判分器+triage 归因)
→ 反思原因(失败案例库 --learn) → 写入记忆/改工具/改提示 → 再评测(--check-regression 防退化)
```
