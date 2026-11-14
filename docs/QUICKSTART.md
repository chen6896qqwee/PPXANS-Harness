# 快速上手

皮皮虾 (PPX Agent) 是一个会自我修复、自我学习的超级 Agent。零运行时依赖，纯 Node 原生，支持各大模型 API + 本地模型。

## 1. 环境要求

| 项目 | 要求 |
|------|------|
| Node.js | `>=20` |

> 纯 HTTP 模型（OpenAI/DeepSeek/通义）Node 20 就能跑（v2.5.0 起已移除外部引擎依赖, 只保留自研 HTTP 底座）。
> 可选的 `memory.backend=sqlite` 使用 Node 内置 `node:sqlite`，需要 **Node >= 22.5**（默认 `json` 后端无此要求）。

## 2. 安装

### 方式 A：npm 安装（内核，推荐给终端用户）

```bash
npm install -g ppxans-harness

ppx            # 进入对话 CLI
ppx doctor     # 一键体检: 配置/密钥/数据目录/技能库
ppx serve      # 启动 HTTP 服务 (http://127.0.0.1:8899)
ppx web        # 启动并打开 Web 界面 (校验令牌自动注入)
ppx channels   # 通道自助管理 (list/add/test/enable/disable/remove)
```

> npm 上的包名是 `ppxans-harness`（`ppx-agent` 是早期旧包，不要装）。npm 版本可能滞后于
> [GitHub Releases](https://github.com/chen6896qqwee/PPXANS-Harness/releases/latest)，以 Releases 为准。

### 方式 B：源码运行桌面客户端（推荐给日常使用）

```bash
git clone https://github.com/chen6896qqwee/PPXANS-Harness.git
cd PPXANS-Harness
npm install    # 安装桌面运行时 (Electron) 与开发依赖
npm start      # 打开桌面窗口（Windows 也可双击 启动皮皮虾.bat）
npm run setup  # 模型配置向导 (选厂商 → 粘贴 Key → 自动探活)
```

> 内核零运行时依赖，源码跑内核不需要 `npm ci`；只有运行桌面客户端/打包/跑 lint 和测试时需要开发依赖。
> 普通用户建议直接下载安装包，不需要 Node.js，也不需要浏览器或手记端口。

## 3. 配置模型

**用桌面客户端的话，不需要改任何文件**：首次启动的向导只问两样 —— 模型名称（如 `deepseek-chat`）和
API Key，接口地址按模型名自动识别。本地模型（LM Studio / Ollama）留给你自己在「设置 → 模型」里加；
这一步也可以直接跳过，不配模型也能打开界面，之后随时补。

下面是给 CLI / 服务端场景用的配置文件写法：

模型提供方在 `config/ppx.json` 的 `providers` 数组里，按顺序回退（第一个失败自动切下一个）。纯 HTTP 模型只需配 API key 环境变量：

```bash
# 任选其一（按你用的模型）
export OPENAI_API_KEY="sk-..."
export DEEPSEEK_API_KEY="sk-..."
export DASHSCOPE_API_KEY="..."
```

不配 key 也能以「离线记忆模式」启动，只是不会真的调用模型。

内置 provider 模板见 `docs/MODEL-SETUP.md`（文本：`openai` / `deepseek` / `zhipu` / `dashscope` / `moonshot` / `openrouter` / `groq` / `siliconflow` 等；多模态：`qwen-vl`；本地：`lmstudio` / `ollama`）。

## 4. 常用方式

### 桌面客户端

```bash
npm start           # 打开桌面窗口（等价 npm run desktop）
```

对话、记忆、设置、工单都在桌面窗口里完成；无需打开浏览器，也不用记地址或端口。

### CLI 对话

```bash
ppx            # 或 npm run chat
```

命令：`quit`/`exit` 退出 · `/stop` 中断当前任务 · `/reset` 清空会话 · `↑↓` 浏览历史 · `Ctrl+C` 单次中断。

### HTTP API（开发者 / 集成）

```bash
ppx serve      # 或 npm run serve / node src/server.js
```

```bash
# 健康检查
curl http://127.0.0.1:8899/health

# 对话（Bearer token 未配置时启动会自动生成随机 token 打印到控制台）
curl -X POST http://127.0.0.1:8899/message \
  -H "Content-Type: application/json" \
  -d '{"message": "你好"}'
```

## 5. 通道（消息接入 + 主动提醒投递）

皮皮虾所有通道统一走 `ChannelManager` 注册表，用 `ppx channels` 命令自助连接（不改源码）：

```bash
ppx channels list                     # 查看全部通道 + 启用状态
ppx channels add feishu               # 交互式引导配置 → 写盘并启用
ppx channels test feishu              # 连通性测试（真实网络探测）
ppx channels enable|disable <name>    # 启停
ppx channels remove <name>            # 移除配置（恢复默认）
```

内置通道类型：`http`（默认开）/ `feishu` / `wechat` / `log`（dummy 输出到 stdout，适合先验证主动提醒契约）。

> 配置写在 `config/ppx.json` 的 `channels` 段，改完重启皮皮虾生效。主动提醒（`agent.proactive.enabled`）默认关闭，开启后定时把待办提醒广播到所有已启用通道。

## 6. 引擎底座（v2.5.0 起仅自研 http 底座）

皮皮虾**不再内置/依赖任何外部引擎**（DeepSeek Harness / OpenClaw 已全部移除）。模型接入 = 在 `config/ppx.json` 的 `providers` 配多个 **http provider**（OpenAI / DeepSeek / 通义 / 智谱 / 本地 lmstudio / ollama / vLLM），router 按配置顺序回退：

```json
{ "id": "deepseek", "base_url": "https://api.deepseek.com/v1", "api_key_env": "DEEPSEEK_API_KEY", "model": "deepseek-chat" }
```

多厂商自由叠加、互不冲突：配了哪个 key 就走哪个，全没配且本地服务在跑则回退本地模型。

## 7. 常见问题

- **卡住了 / 不确定配置对没对** → 先跑 `ppx doctor`，它会逐项告诉你 配置/密钥/数据目录/技能库 哪里有问题；加 `--net` 会多发一条最小请求验证模型连通。
- **LLM 报错** → 检查 `config/ppx.json` 的 `providers` 是否配置了可用的 API key（`export XXX_API_KEY=...`）；本地模型（lmstudio）是否在运行；可打开桌面端日志目录查看启动日志确认模型加载。
