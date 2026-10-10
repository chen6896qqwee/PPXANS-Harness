# Agent 能力分级自评表（T/SAIAS 055-2026 对照）

> 2026-10-09 初评。依据 T/SAIAS 055-2026 智能体分级框架（L1 基础级 → L4 自治级）+ 五能力域（感知与理解 / 决策与执行 / 任务交付 / 协同与进化 / 安全与对齐）逐项对照。每年复评一次；证据列全部指向仓库内可复核的测试/脚本。

## 总判定：**L2+（接近 L3，差"扰动测试集标准化"与"在线 A/B"两项）**

## L1-L4 逐级对照

| 级别 | 标准要求 | 皮皮虾状态 | 判定 |
|---|---|---|---|
| L1 基础级 | 单轮问答、基础工具调用、有权限控制 | 全量具备：85 工具 + 权限引擎（codex 四档审批 + 沙箱三档）+ 能力闸门 | ✅ 远超 |
| L2 任务级 | 多步规划、多工具编排、结果校验、会话记忆 | ✅ ReAct 循环 + 记忆五层 + taskbench 可证伪判分 + postcondition 闸门 | ✅ 达标 |
| L3 协同级 | **动态扰动测试用例**、多智能体协同、量化通过基准线 | 军团并发治理/跨进程配额/班组 ✅；扰动素材有（chaos 测试 + 判分器 mutants + 故障转移实测）但**未组织成标准扰动测试集**；量化基准线 ✅（taskbench --report-json + falsify 门禁） | 🟧 接近 |
| L4 自治级 | 自主目标生成、在线自我进化、动态环境适应 | evolve/playbook + experience + A-Mem 卡片演化有雏形；无在线环境 | ⬜ 不评（未覆盖场景）|

## 五能力域证据表

| 能力域 | 证据 | 强弱 |
|---|---|---|
| 感知与理解 | 191 测试文件中的输入解析/协议/DSML 套件；渐进披露（26 核心 schema + 按需 59） | 强 |
| 决策与执行 | 权限引擎 + 沙箱 + hooks 六事件 + 免疫闸门（guardAllowList/审批双闸） | 强 |
| 任务交付 | taskbench 20 任务 19/20 实测（方舟 seed-code）+ 扩展 6/6 + 可证伪判分器 | 强 |
| 协同与进化 | 军团 10/10（并发治理/跨进程配额）+ A-Mem 插件 + evolve playbook | 中 |
| 安全与对齐 | redteam/boundary/PII/审计链/四轴自评（记忆投毒自查待做） | 强 |

## L3 差距清单（按标准逐条）
1. **扰动测试集标准化**：chaos/falsify/mutants 已有素材，需按"动态扰动用例"格式重组并入 nightly 报告单列通过率 —— 对应评测体系 v2（ROADMAP 第八节）
2. **量化通过基准线**：taskbench 已有（19/20 基线 17/20），扰动集需另设独立基准线
3. **在线 A/B**：无线上流量，不适用（诚实标注）

## 与 GPA/AgentEval 指标的映射

| GPA 指标 | 实现 | 产出位置 |
|---|---|---|
| 目标完成度 | taskbench pass | report.summary.passRate |
| 计划遵循度 | scoreTrajectory planFollowed（oracle 工具计划对账） | report.summary.gpa.planFollowedRate |
| 逻辑一致性 | 工具错误率（failedCalls/total） | report.summary.gpa.toolErrorRate |
| 执行效率 | avgMs + tokens + costEfficiency | report.summary（既有） |
| 冗余度 | 同 tool+args 重复调用占比 | report.summary.gpa.redundancy |

报告 schema v2（report_schema: 2）——新增字段全部为附加项，v1 消费方兼容。
