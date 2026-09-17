# DeepSeek Harness 吸收与底座切换说明

> 🚫 **已废弃（v2.5.0 起，2026-09-16）**
>
> 本文记录的是历史上把 `deepseek-harness` 作为**可选后端底座**接入的方案。该方案**已整体移除**：
> `openclaw` / `dsh` 后端代码、`_optional_engines` 配置、`.deps/` 内嵌目录、`dsh` npm 脚本、
> `openclaw-smoke.js` 全部删除；皮皮虾现在只有自研 http 底座（`src/llm/client.js` 直连任意
> OpenAI 兼容 API）。
>
> **本文中的 `npm run dsh:install` / `dsh:build` / `npm run dsh` 等命令已不存在，不可执行。**
> 仅作为决策沿革留档。当前模型接入方式见 [CONFIG.md](CONFIG.md) 与
> [PROJECT-OVERVIEW.md](PROJECT-OVERVIEW.md) 第 5 章。

本文件记录 ppx-agent 对 `deepseek-harness` 的完整吸收与整合结果。

## 1. 吸收内容

- `deepseek-harness` 全部架构与源码已复制到：
  ```
  .deps/deepseek-harness/
  ```
- 包含 `packages/`、`apps/`、`docs/`、`scripts/`、`vendor/`、`native/`、`examples/`、`python/`、`website/`、`.agents/` 等完整源码树。
- 保留 deepseek-harness 自身的 README（MIT 声明）、AGENTS.md、架构文档与全部测试/构建脚本。

## 2. 底座切换

皮皮虾的 LLM 客户端 `src/llm/client.js` 已把 `DEFAULT_DSH_ROOT` 自动指向 `.deps/deepseek-harness`：

- 未显式设置 `PPX_DSH_ROOT` 时，`dsh` 后端直接使用内嵌源码。
- 仍可用环境变量 `PPX_DSH_ROOT` 覆盖为任意 deepseek-harness clone。
- `config/ppx.json` 的 `providers` 首位已加入 dsh，`dsh_root` 为 `.deps/deepseek-harness`。

### 启用 dsh 底座

```bash
# 首次安装并构建内嵌 dsh（需要网络拉取依赖）
npm run dsh:install
npm run dsh:build

# 运行 dsh CLI（web / headless / ...）
npm run dsh -- web
```

`dsh` 已加入 `config/ppx.json` 的 `providers` 首位：

```json
{
  "id": "dsh",
  "backend": "deepseek",
  "dsh_root": ".deps/deepseek-harness",
  "timeout_ms": 180000
}
```

未安装/构建 dsh 时，健康检查会把它判为不可用，皮皮虾自动回退到本地/HTTP/云端，不受影响。

## 3. 新增 Skills

整合后已将以下两个技能加入 `skills/`：

| 技能目录 | 来源 | 说明 |
| --- | --- | --- |
| `skills/agent-professional-training/` | `Agent-Professional-Training.md` | Agent 专业训练规程：闭环五步、轨迹飞轮、Qwen/DeepSeek 训练方法、V4 架构 |
| `skills/cupid-lover-comms/` | `丘比特SKILL.md` | 可自定义角色沟通素材库：亲密关系沟通、反诈识别、去 AI 味表达 |

两个技能都采用 ppx-agent 的 `skills/<id>/SKILL.md` 格式，可被 `src/skills/loader.js` 自动发现，也可通过 `load_skill` 工具按需加载。

同时已复制到 `.deps/deepseek-harness/.dsh/skills/`，dsh 底座运行时按 project-dsh 根（rank 100）自动发现，因此皮皮虾技能层和 dsh 底座都能加载这两个技能。

## 4. 架构对应关系

| deepseek-harness 概念 | ppx-agent 落地 |
| --- | --- |
| Cordis 插件体系（everything is a plugin） | `src/plugin/` 轻量 Context/插件装配 |
| 会话事件日志（Model-visible ⟺ logged） | `src/memory/session.js` append-only 事件日志 |
| Capability Seam（Service / Provider / Consumer） | `src/tools/seam.js`、`src/seam/shell.js` |
| skill 能力族（catalog + loader） | `src/skills/loader.js`、`skills/` 目录 |
| self-modification（自检/挂载/卸载） | `src/tools/selfmod.js` |
| dsh 后端引擎 | `src/llm/client.js` `deepseek` backend + `src/llm/fence.js` 围栏协议 |

## 5. 验证

- `skills/agent-professional-training/SKILL.md` 存在且 frontmatter 可解析
- `skills/cupid-lover-comms/SKILL.md` 存在且 frontmatter 可解析
- `.deps/deepseek-harness/apps/cli/src/bin.ts` 存在（dsh 源码就绪）
- `src/llm/client.js` 的 `DEFAULT_DSH_ROOT` 默认指向 `.deps/deepseek-harness`
- `config/ppx.json` 的 `providers[0]` 为 dsh（`backend: "deepseek"`、`dsh_root: ".deps/deepseek-harness"`）
