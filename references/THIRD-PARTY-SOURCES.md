# 外部参考项目来源说明

本目录不包含第三方源码，仅登记 `C:\Users\chen\Desktop\智能体项目` 下**非本仓库自研**项目的来源与获取方式。

PPXANS-Harness 是**零运行时依赖**的自包含项目。第三方引擎一律以「外部可选底座」形式接入，永不复制进本仓库源码树——这既保持自包含定位，也避免上游许可证与体积污染。

---

## 1. openai/codex（未被吸收）

| 项 | 值 |
|---|---|
| 目录 | `../codex` |
| 来源 | https://github.com/openai/codex （本地 remote: `git@github.com:openai/codex.git`） |
| 性质 | OpenAI 官方 Codex CLI，**Rust / Bazel** 技术栈 |
| 规模 | 7,804 个受版本控制文件，约 111 MB |
| 为何不吸收 | 技术栈完全不同（Rust vs 纯 Node），无任何代码可复用；作为架构参考阅读即可，纳管源码只会让仓库体积膨胀两个数量级并引入无关许可证义务 |

**结论**：保留为独立原始仓库，不纳入 PPXANS-Harness。若需查阅请直接使用 `../codex` 目录。

---

## 2. deepseek-ai/deepseek-harness（以可选底座接入，不复制源码）

| 项 | 值 |
|---|---|
| 目录 | `../deepseek-harness` |
| 来源 | https://github.com/deepseek-ai/deepseek-harness （本地 remote 同名） |
| 性质 | DeepSeek 官方 Harness（pnpm monorepo + TypeScript） |
| 规模 | 10,319 个受版本控制文件 |
| 接入方式 | 通过 `.deps/deepseek-harness` 内嵌目录 + `dsh` provider（`config/ppx.json` 的 providers 首位，`backend: "deepseek"`） |

**定位说明**：dsh 在 PPXANS-Harness 中是**可选的 LLM 引擎后端**，不是依赖。未安装/未构建时，健康检查会把它判为不可用并自动回退到 `http` / `cloud` provider，主流程不受影响。

启用步骤（README「独立底座」节亦有说明）：

```bash
npm run dsh:install   # 首次安装内嵌 dsh 依赖 (需网络)
npm run dsh:build     # 构建
npm run dsh -- web    # 直接跑 dsh CLI
```

`dsh` 后端定位优先级：`PPX_DSH_ROOT` 环境变量 > provider 的 `dsh_root` 配置 > 内嵌 `.deps/deepseek-harness` 默认目录。

**结论**：以「可选底座」形式接入，源码不复制进本仓库（`.deps/` 已在 `.gitignore` 中排除）。

---

## 3. 已吸收的自研项目

| 项目 | 版本 | 处理方式 |
|---|---|---|
| `../ppx-agent` | v1.6.0 | **合并基座**——整体作为 PPXANS-Harness 的代码基底 |
| `../ppx-v2`（ppx Harness） | v0.4.0 | **能力吸收**——抽取独有能力移植，不整仓合并（详见 `MERGE-REPORT.md`） |

---

## 4. 未吸收的重复副本

| 目录 | 判定 | 证据 |
|---|---|---|
| `../ppx Harness` | **ppx-agent 在 v1.5.1 的旧快照，不合并** | 其 remote 与 ppx-agent 完全相同（`chen6896qqwee/ppx-agent.git`），版本号 1.5.1 < 1.6.0，且缺少 v1.6.0 的 `src/core/policy.js`、`src/core/trace.js`、`src/services/*` |

合并旧快照会导致 v1.6.0 的四刀重构成果被覆盖回退，因此明确排除。该目录可自行删除或留作历史对照。
