# 贡献指南

感谢关注 PPXANS-Harness！这是一个**零运行时依赖**的纯 Node.js Agent 内核，
贡献前请先理解这条红线，它决定了大部分设计取舍。

## 开始之前

```bash
# 零依赖 = 不需要 npm install, clone 即可跑
npm test          # 全量测试 (node:test 内置)
npm run selfheal  # 自愈基准 (7/7 是发布门禁)
npm run web:check # Web UI 静态自检
npm run eval      # 本地能力评测 (无需 LLM key)
```

要求 Node ≥ 20。Windows / macOS / Linux 均可开发（CI 双系统跑）。

## 铁律 (违反 = PR 被拒)

1. **零运行时依赖**：`src/` 里不许出现任何 `import` npm 包的语句。
   Node 内置模块（node:fs / node:crypto / node:vm / node:worker_threads ...）随便用。
   可选增强能力一律走**动态 `import()`**，包未安装时必须优雅降级
   （参考 `src/llm/local-embedder.js` 的降级链写法）。
2. **同步 API 不许膨胀**：热路径禁加 `readFileSync`/`writeFileSync`（现有存量除外），
   新代码用 `node:fs/promises`。
3. **写操作必须过安全链**：文件写入走 `atomicWrite`（utils/store.js），
   跨进程"读-改-写"必须包 `withFileLock`，路径必须过 `safePath` 校验。
4. **测试必须跟着功能走**：新功能带新测试，bug 修复带回归测试。
   全量测试必须绿（当前基线 1000+ 项）。
5. **不泄密**：不许提交任何 API key / token / 个人数据。
   配置一律用 `api_key_env` 引用环境变量，示例进 `config/ppx.json.example`。
   `data/` 目录（用户记忆/会话/审计账本）永远不进 git（.gitignore 已闸）。

## 代码结构速览

```
src/
├── agent/        Agent 引擎 (工具循环 + 多模型回退)
├── core/         工具循环策略 (runToolLoop, 可独立测试)
├── memory/       L0-L4 五层记忆 (fact-store / sqlite-store / session)
├── tools/        工具注册 (builtin / advanced / document / voice / sandbox / vad)
├── llm/          多模型客户端 + embedder
├── channels/     HTTP / 飞书 / 微信 通道
├── permissions/ hooks/ edit/ repomap/ review/ evidence/ commands/   v3 模块
├── protocol/     SQ·EQ 双队列事件流
├── session/      Turn 状态机 (+ projection 投影层)
├── audit/        SHA-256 审计哈希链
├── selfheal/     自愈内核
└── utils/        基础设施 (原子写 / 文件锁 / crashguard)
```

## 提交 PR

1. Fork → 分支 → 改动 → `npm test && npm run selfheal` 全绿
2. PR 描述写清：动机 / 改动点 / 测试证据（测试计数变化）
3. 涉及安全的改动（权限/沙箱/命令守卫）请在 PR 里单独标注，会重点 review
4. 提交信息用祈使句中文或英文均可，一事一提交

## 报告 Bug

用 Issue 模板。**不要**在 Issue 里贴你的 `data/` 内容、API key 或真实对话记录。

## 架构问题

想加大型特性（新记忆层、新通道、新执行后端）？先开 Issue 讨论设计再动手，
避免返工——这个项目的取舍逻辑见 `docs/ARCHITECTURE-V3.md`。
