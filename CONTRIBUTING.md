# 贡献指南

感谢关注 PPXANS-Harness！这是一个**零运行时依赖**的纯 Node.js Agent 内核，
贡献前请先理解这条红线，它决定了大部分设计取舍。

## 开始之前

```bash
# 零依赖 = 不需要 npm install, clone 即可跑
npm test           # 全量测试 (node:test 内置)
npm run verify     # 18 道门禁: 架构/依赖/宣称/文案/版本/审计链/静默catch…
npm run lint       # eslint
npm run selfheal   # 自愈基准 (7/7 是发布门禁)
npm run web:check  # 界面静态自检
npm run eval       # 本地能力评测 (无需 LLM key)
npm run bench:edit # 编辑协议成本基准 (锚点 vs SEARCH/REPLACE, 离线可复算)
npm run bench:gate # 任务成功率回归门禁 (先有 bench/baseline.json + report.json)
```

要求 Node ≥ 20。Windows / macOS / Linux 均可开发（CI 双系统跑）。

## 新增一个工具要动哪些地方

照着这份清单走, 门禁才不会在 PR 上拦你 (2026-11 的十项优化就是这么被拦出来的):

1. **注册**: `catalog.register({ name, description, parameters, execute, capability })` ——
   `capability` 必须显式声明 (readOnly / riskLevel / destructive / sideEffect), 否则
   `test/capability-guard.test.js` 会红;
2. **只读工具**: 若 `readOnly: true`, 还要把名字加进该测试文件里的 `READ_ONLY_SURFACE`
   快照 —— 这是"只读豁免面"的显式评审, 不是走过场;
3. **核心名单**: 想默认下发给模型, 加进 `src/tools/catalog.js` 的 `CORE_TOOL_EXPOSURE`,
   并重跑 `node scripts/readme-sync-check.js --fix` (schema token 与工具数会变);
4. **同族低频**: 优先挂到 `src/tools/facade.js` 的门面里 (action 分派), 别再加第 108 个名词;
5. **配置键**: 新配置必须有消费点, 并在 `test/config-consistency.test.js` 的 CONSUMED 表登记;
6. **安全面**: 文件写入走 `safePath` + 撤销快照; 命令执行过 `checkCommand`;
   新的 `catch` 要么 `noteCatch(e)`, 要么写 `swallowed-ok(日期): 理由`;
7. **测试**: 纯函数优先 (便于离线断言), 工具层再补一条端到端。

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

### 测试文件命名 (2026-11-08 起)

存量里有一批按「修复批次」命名的测试（`fixes-2026-09-xx` / `user-test-round2` / `*r13*`），
从文件名看不出它覆盖哪个模块 —— 改一个模块不知道该跑哪几个。新文件按下面的规则起名：

| 场景 | 命名 | 例子 |
|---|---|---|
| 覆盖单个模块 | `<模块名>.test.js` | `permissions.test.js` |
| 跨模块的端到端契约 | `<场景>.test.js` | `channel-delivery.test.js` |
| 一次性回归（确实需要留档） | `<模块>-<问题>.test.js`，**不用日期** | `permission-full-access.test.js` |

查「改某个模块要跑哪些测试」：

```bash
npm run test:map permissions      # 相关测试 + 可直接复制的 node --test 命令
npm run test:map -- --uncovered   # 哪些 src 模块没有任何测试直接 import
```

全量映射表见 [docs/TEST-MAP.md](docs/TEST-MAP.md)（由脚本生成，勿手改）。
存量日期文件不要求批量改名（321 个文件重命名的风险远大于收益），但**同一模块的新测试
请归并到已有的 `<模块>.test.js`**，不要再新建日期文件。

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
