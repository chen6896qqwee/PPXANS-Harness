# 文档索引

> 本项目文档中文优先。第一次来, 按「先读这一段」的顺序走; 要改代码再看「开发」。
> 所有数字由脚本维护 (`npm run verify` 会拦下手改的臆测值), 文档里的结论都对应可复算的命令。

## 先读这一段

| 文档 | 一句话 | 什么时候读 |
|---|---|---|
| [../README.md](../README.md) | 项目门面: 是什么 / 三分钟上手 / 下载安装 | 第一次打开仓库 |
| [QUICKSTART.md](QUICKSTART.md) | 从零到跑通第一条任务 | 装完想跑起来 |
| [PROJECT-OVERVIEW.md](PROJECT-OVERVIEW.md) | 分层图 / 运行模式 / 自愈路径 | 想理解它怎么组织 |
| [ARCHITECTURE-CURRENT.md](ARCHITECTURE-CURRENT.md) | 模块表与依赖预算 (含实测数字) | 要动结构之前 |

## 配置与模型

| 文档 | 一句话 |
|---|---|
| [CONFIG.md](CONFIG.md) | 全部配置键、默认值、消费点 |
| [MODEL-SETUP.md](MODEL-SETUP.md) | 各家 API 的模型名/地址/协议对照 + 本地模型 |
| [MCP-STDIO.md](MCP-STDIO.md) | 把本仓当 MCP 服务器 (`ppx mcp serve`) 挂给别的客户端 |

## 运行机制

| 文档 | 一句话 |
|---|---|
| [WORK-GRAPH.md](WORK-GRAPH.md) | 工单账本: 一条输入 → 工单 → 指派 → 投递, 跨重启可查可续跑 |
| [DATA-FLOWS.md](DATA-FLOWS.md) | 数据流透明披露: 什么数据存在哪、发到哪 |
| [MEMORY-FOUR-AXIS-SELF-CHECK.md](MEMORY-FOUR-AXIS-SELF-CHECK.md) | 记忆四轴自评 (依据公开分类学的自检, 不是营销) |
| [AGENT-GRADING-L1-L4.md](AGENT-GRADING-L1-L4.md) | 能力分级自评表 (对照 T/SAIAS 055-2026) |
| [EXTERNAL-BENCH.md](EXTERNAL-BENCH.md) | 外部基准适配器: GAIA 风格数据集接入 + 可证伪判分器 |

## 发布与交付

| 文档 | 一句话 |
|---|---|
| [PACKAGING.md](PACKAGING.md) | 桌面端打包 (Windows/macOS/Linux) 与发布流程 |
| [SIGNING.md](SIGNING.md) | Windows 代码签名: 免费/OV/自签的取舍与操作 |
| [../CODE_SIGNING_POLICY.md](../CODE_SIGNING_POLICY.md) | 签名策略声明 (发布合规要求) |

## 开发与自证

| 文档 | 一句话 |
|---|---|
| [ARCHITECTURE-OPTIMIZATION-2026-11.md](ARCHITECTURE-OPTIMIZATION-2026-11.md) | 5.2.0 的十项架构优化: 论证、证据、**故意没做什么** |
| [PROVENANCE.md](PROVENANCE.md) | 每个模块的设计来源对照 (哪些是借鉴、哪些是自研) |
| [TEST-MAP.md](TEST-MAP.md) | 测试地图 (脚本生成): 哪个 src 模块被哪些测试覆盖 |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | 提交前要跑什么、门禁在哪、怎么写测试 |
| [../SECURITY.md](../SECURITY.md) | 漏洞报告流程与安全边界 |

## 常用命令 (都是本地可跑, 不需要模型 Key)

```bash
npm test                 # 全量测试
npm run verify           # 18 道门禁 (架构/依赖/宣称/文案/版本/审计链…)
npm run lint             # eslint
npm run bench:edit       # 编辑协议成本基准 (锚点 vs SEARCH/REPLACE)
npm run bench:gate       # 任务成功率回归门禁 (需要基线报告)
npm run doctor           # 环境体检
```

## 读文档时注意

- **数字不要手改**: README 里的工具数/测试数由 `node scripts/readme-sync-check.js --fix` 写回,
  手改会被 `verify` 拦下;
- **"预留"不等于"可用"**: 标了 `预留:` / `未接消费方` 的配置或模块, 是骨架不是能力 ——
  [PROVENANCE.md](PROVENANCE.md) 与 CHANGELOG 里会明确写出来。
