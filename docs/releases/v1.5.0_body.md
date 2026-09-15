# ppx-agent v1.3.1 → **v1.5.0** — 皮皮虾（PPX Agent）测试版

一个会自我修复、自我学习的超级 Agent。**零运行时依赖**，纯 Node 原生，支持各大模型 API + 本地模型。

---

## 🎯 本次 v1.5.0 重点

### 🧠 模型接入重构：本地优先、云端自由接入
- 新增 `src/llm/router.js` 模型路由中枢：占位死配置过滤（REPLACE_WITH_YOUR_ENDPOINT 自动剔除）+ 本地/云端优先级可配。
- **新增 `agent.model_preference` 配置（默认 local）**：本地测试直接走本地模型（LM Studio 等 127.0.0.1 零配置），配了云端 key 也先走本地；显式设 `cloud` 即切换为云端真 key 优先。
- 启动告警重构：有本地模型或有云端 key 都不再告警，仅「无任何可用模型」才提示。消除「没配云端 key 就报错」的噪音。
- 修本地兜底死穴：lmstudio 带字面 api_key 被误排除 → 本地服务全部收。
- 修复 `package.json` 重复 `selfheal` 键、README「零配置想当然」等发布卫生问题。

### 🌱 有机体八系统全通（P0-P4）
- **循环系·全局总线** `src/bus/`：RuntimeBus 事件广播 + Command/Result 回路 + State 槽 + intercept 拦截器。
- **内分泌系·Reward 闭环** `src/ans/reward.js`：订阅总线自动采集，EWMA 维护工具倾向权重，低可靠工具注入 system prompt。
- **排泄系·排遗自治** `src/ans/eviction.js`：bigram overlap 冗余识别 + 冷热分层 + 每日自动治理扫描。
- **免疫系·全局闸门** `src/ans/guard.js`：危险 verb（delete/clear/wipe）未授信默认阻断，静态白名单 + 单次审批双模式授权，全部命令记 Auditor 账本。

### 🛡️ 安全（v1.4.0-dev 已含）
- Auditor 独立验证 + held-out 回归 + 探索熔断 + 重复命令检测。

### 🎨 WebUI 美感升级
- 设计令牌品牌色系、毛玻璃、进场动画、发送按钮渐变发光、会话/记忆/轨迹卡片统一动效；settings 四页规范统一。

### 测试
- 全量 **525/529 通过（0 失败）**，自愈基准 7/7 满分，CI node20/22 矩阵 + web 类型检查 + 构建 + eval。

---
部署见 README。