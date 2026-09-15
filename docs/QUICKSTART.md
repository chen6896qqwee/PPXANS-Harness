# 快速上手

皮皮虾 (PPX Agent) 是一个会自我修复、自我学习的超级 Agent。零运行时依赖，纯 Node 原生，支持各大模型 API + 本地模型。

## 1. 环境要求

| 项目 | 要求 |
|------|------|
| Node.js | `>=20` |

> 纯 HTTP 模型（OpenAI/DeepSeek/通义）Node 20 就能跑。openclaw 可选引擎有运行时版本检测，不满足会自动降级提示。

## 2. 安装

### 方式 A：npm 安装（内核，推荐给终端用户）

```bash
npm install -g ppx-agent

ppx            # 进入对话 CLI
ppx-serve      # 启动 HTTP 服务 (http://127.0.0.1:8899)
ppx-channels   # 通道自助管理 (list/add/test/enable/disable/remove)
```

### 方式 B：源码运行（需要 Web UI 或二次开发）

```bash
git clone https://github.com/chen6896qqwee/ppx-agent.git
cd ppx-agent
npm run selfheal   # 启动自愈体检
npm run chat       # CLI 对话
```

> Web UI 目前随源码仓库分发，不在 npm 包内（见下方「Web UI」）。

### 方式 C：Docker（内核 + Web UI 一条命令起）

```bash
docker build -t ppx-agent .
docker run -p 8899:8899 -p 3000:3000 ppx-agent
```

打开 http://localhost:3000 使用 Web UI（内核跑在容器内 8899，数据外置到容器 `/root/.ppx`）。

> 想一键打包发布物（前端 build + 内核 tgz），运行 `npm run release`，产物在 `dist/`。

## 3. 配置模型

模型提供方在 `config/ppx.json` 的 `providers` 数组里，按顺序回退（第一个失败自动切下一个）。纯 HTTP 模型只需配 API key 环境变量：

```bash
# 任选其一（按你用的模型）
export OPENAI_API_KEY="sk-..."
export DEEPSEEK_API_KEY="sk-..."
export VOLCENGINE_API_KEY="..."
export DASHSCOPE_API_KEY="..."
```

不配 key 也能以「离线记忆模式」启动，只是不会真的调用模型。

内置 provider 模板：`openai` / `deepseek` / `volcengine` / `dashscope`（文本）+ `qwen-vl`（多模态）+ `lmstudio`（本地）。

## 4. 三种使用方式

### CLI 对话

```bash
ppx            # 或 npm run chat
```

命令：`quit`/`exit` 退出 · `/stop` 中断当前任务 · `/reset` 清空会话 · `↑↓` 浏览历史 · `Ctrl+C` 单次中断。

### HTTP API

```bash
ppx-serve      # 或 npm run serve / node src/server.js
```

```bash
# 健康检查
curl http://127.0.0.1:8899/health

# 对话（Bearer token 未配置时启动会自动生成随机 token 打印到控制台）
curl -X POST http://127.0.0.1:8899/message \
  -H "Content-Type: application/json" \
  -d '{"message": "你好"}'
```

### Web UI（需源码）

```bash
cd ppx-agent
npm run web:build   # 首次或前端改动后构建
npm run web         # 一条命令同时起内核(8899) + 前端(3000)
```

打开 http://localhost:3000 。前端通过代理自动连到本机 8899 内核。

## 5. 通道（消息接入 + 主动提醒投递）

皮皮虾所有通道统一走 `ChannelManager` 注册表，用 `ppx-channels` 命令自助连接（不改源码）：

```bash
ppx-channels list                     # 查看全部通道 + 启用状态
ppx-channels add feishu               # 交互式引导配置 → 写盘并启用
ppx-channels test feishu              # 连通性测试（真实网络探测）
ppx-channels enable|disable <name>    # 启停
ppx-channels remove <name>            # 移除配置（恢复默认）
```

内置通道类型：`http`（默认开）/ `feishu` / `wechat` / `log`（dummy 输出到 stdout，适合先验证主动提醒契约）。

> 配置写在 `config/ppx.json` 的 `channels` 段，改完重启 `ppx-serve` 生效。主动提醒（`agent.proactive.enabled`）默认关闭，开启后定时把待办提醒广播到所有已启用通道。

## 6. 引擎底座（DeepSeek Harness 已内嵌，OpenClaw 可选）

`config/ppx.json` 的 `providers` 首位已是 dsh（`default_id=dsh`）：

```json
{ "id": "dsh", "backend": "deepseek", "dsh_root": ".deps/deepseek-harness", "timeout_ms": 180000 }
```

首次使用需安装/构建内嵌 dsh：

```bash
npm run dsh:install
npm run dsh:build
```

未安装/构建时，健康检查会把 dsh 判为不可用，皮皮虾自动回退到本地/HTTP/云端，不影响使用。

OpenClaw 仍是可选引擎：要把 `_optional_engines.openclaw` 移入 `providers` 数组，并设置环境变量：

```bash
# OpenClaw 引擎（需先 npm i -g openclaw，找到 openclaw.mjs）
export PPX_OPENCLAW_MJS="/path/to/openclaw/openclaw.mjs"
```

dsh 路径默认自动定位内嵌源码；也可用 `PPX_DSH_ROOT` 覆盖到其它 deepseek-harness clone。

## 7. 常见问题

- **`OpenClaw 引擎未就绪: mjs 路径不存在`** → 设 `PPX_OPENCLAW_MJS`，或改用 HTTP 模型。
- **`dsh 源码未就绪`** → 检查 `.deps/deepseek-harness` 是否存在；**`dsh 依赖未安装`** → 运行 `npm run dsh:install`。
- **端口被占** → 内核端口用 `PPX_PORT` 改；Web UI 端口在 `web/package.json` 的 `start` 里加 `-p`。
- **数据存哪** → 运行数据（记忆/会话/经验）默认在 `data/`（源码运行时）或 `~/.ppx`（npm 全局安装时自动外置，防卸载丢数据）；可用 `PPX_DATA_DIR` 显式指定。
- **LLM 报错** → 检查 `config/ppx.json` 的 `providers` 是否配置了可用的 API key（`export XXX_API_KEY=...`），或 `ppx-channels` 无关；可先跑 `ppx-serve` 看启动日志确认模型加载。
