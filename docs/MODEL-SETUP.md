# 模型 API 配置指南 + MCP 统一接口

> 2026-10-01: 主流开箱体验对齐。内置 12+ 家厂商预设, 用户**只需输入 API Key**, base_url/环境变量/模型名零记忆负担。

## 一、最快路径: 配置向导

```bash
npm run setup
```

向导流程: **选厂商 → 粘贴 API Key (回车可用环境变量) → 自动探活 → 写入 config/ppx.json**。

非交互式 (CI / 脚本):

```bash
node bin/ppx.js setup --list                          # 列出全部内置厂商
node bin/ppx.js setup --provider deepseek --key sk-xxx --model deepseek-chat
node bin/ppx.js setup --provider lmstudio             # 本地厂商免 Key, 自动探活
```

### 可选: 分层路由 (辅助任务走便宜模型)

记忆提取/摘要/压缩等辅助调用默认跟随主模型。想省成本, 可指定一个便宜厂商专门跑辅助任务:

```bash
node bin/ppx.js setup --aux deepseek     # 辅助任务走 deepseek (需已配置该厂商 Key)
node bin/ppx.js setup --aux off          # 取消, 恢复全走主模型
```

- **不配置 = 全走主模型**, 零配置零门槛; 配置了但厂商不可用 (无 Key/探活失败) 也自动回落主模型。
- 主对话、工具循环、多 Agent 军团不受影响, 永远走主模型/降级链。

## 二、内置厂商预设

### 向量记忆: 开箱即用, 无需配置

记忆检索 (FactStore) 默认就是 **dense+BM25 混合检索**:
- **零配置**: 内置本地哈希向量化 (字符 n-gram, 零网络零 Key) — 开箱即有模糊匹配/错别字容忍。
- **可选升级**: 配置 `config.embedding` (OpenAI 兼容 /embeddings 端点) 获得真语义向量;
  外部端点连续 2 次失败自动熔断切本地, 死端点不拖慢检索。

### 语音 TTS: 开箱即用 (tts 工具)

Agent 可直接调用 `tts` 工具朗读文本:
- **Windows**: 系统内置 SAPI (PowerShell), 零安装直接出声
- **macOS**: say; **Linux**: 需安装 espeak (`apt install espeak`)
- 可选: `rate` 语速 (-10~10)、`voice` 发音人
- 边界: 语音转文字 (ASR) 需云厂商 Key, 暂不在开箱范围

### 云端 (需 API Key)

| 厂商 | 预设 id | base_url (内置) | 协议 | 环境变量 | 默认模型 |
|---|---|---|---|---|---|
| DeepSeek 深度求索 | `deepseek` | https://api.deepseek.com/v1 | openai-completions | `DEEPSEEK_API_KEY` | deepseek-chat |
| 智谱 GLM | `zhipu` | https://open.bigmodel.cn/api/paas/v4 | openai-completions | `ZHIPU_API_KEY` | glm-4.7 |
| 阿里通义千问 | `dashscope` | https://dashscope.aliyuncs.com/compatible-mode/v1 | openai-completions | `DASHSCOPE_API_KEY` | qwen-max |
| 月之暗面 Kimi | `moonshot` | https://api.moonshot.cn/v1 | openai-completions | `MOONSHOT_API_KEY` | kimi-k2-0711-preview |
| OpenAI | `openai` | https://api.openai.com/v1 | openai-completions | `OPENAI_API_KEY` | gpt-4o-mini |
| Anthropic | `anthropic` | https://api.anthropic.com/v1 | **anthropic-messages** (原生) | `ANTHROPIC_API_KEY` | claude-sonnet-4-5 |
| Google Gemini | `gemini` | https://generativelanguage.googleapis.com/v1beta/openai/ | openai-completions | `GEMINI_API_KEY` | gemini-2.5-flash |
| OpenRouter 聚合 | `openrouter` | https://openrouter.ai/api/v1 | openai-completions | `OPENROUTER_API_KEY` | 自选 |
| Groq | `groq` | https://api.groq.com/openai/v1 | openai-completions | `GROQ_API_KEY` | llama-3.3-70b |
| 硅基流动 | `siliconflow` | https://api.siliconflow.cn/v1 | openai-completions | `SILICONFLOW_API_KEY` | Qwen/Qwen3-32B |

### 本地 (免 Key, 自动探活 + 自动发现)

| 厂商 | 预设 id | base_url (内置) |
|---|---|---|
| LM Studio | `lmstudio` | http://127.0.0.1:1234/v1 |
| Ollama | `ollama` | http://127.0.0.1:11434/v1 |

**本机自动发现** (2026-11-14): 交互向导输 `0`, 或 Web「设置 → 模型 → 一键接入本机模型」——
自动扫描 6 个回环端口 (LM Studio 1234 / Ollama 11434 / vLLM 8000 / llama.cpp 8080 / Jan 1337 /
textgen 5000), 列出每个服务的已加载模型与上下文窗口, 选中即写入配置。

协议由自研 `LLMClient` + 三协议适配器直连 (**openai-completions / openai-responses /
anthropic-messages 原生 Messages**, 不依赖 OpenAI 兼容层), 无 SDK 依赖。
多厂商可并存, `config/ppx.json` 的 `providers` **数组首位 = 默认厂商**, 探活失败自动回退下一个。

### Key 的三种给法 (安全口径)

- `api_key_env: "DEEPSEEK_API_KEY"` — **推荐**: key 只在环境变量里, 不落盘
- `api_key_cmd: "op read ..."` — 命令取 key (密码管理器场景), 5s 超时, 失败视为未配置
- `api_key: "sk-..."` — 明文内联可用 (setup 向导写入), doctor 会提示改用前两种
- Web 端在「设置 → 模型」粘贴 key; `sanitizeProvider` 保证任何 API/日志都**不回显明文**

## 三、接口统一使用 MCP 协议

PPXANS 对外集成面统一收敛到 **MCP (Model Context Protocol)**:

- 服务端: `http://127.0.0.1:8899/mcp` (标准 MCP 协议, 现代无握手流式 + legacy initialize 握手双兼容)
- 能力: `tools/list` 枚举全部内置工具 (文件/命令/记忆/技能/git/审计...), `tools/call` 执行
- 客户端: PPXANS 亦可作为 MCP 客户端连接其他 MCP 服务器, 挂载其工具到本目录

### Claude Desktop / Cursor 接入 (无需任何胶水代码)

```json
{
  "mcpServers": {
    "ppxans": {
      "url": "http://127.0.0.1:8899/mcp"
    }
  }
}
```

> 前提: `npm start` 或 `npm run setup` 探活通过后保持服务运行。
> 其余 MCP 客户端同理 — 任何支持 MCP 的宿主 (Claude Code / Cursor / Cline / ...) 配置这一个 URL 即可。

## 四、体检与探活失败排查

**一条命令出全部答案** (2026-11-14 起 doctor 会读 `data/llm/needs-action.json` —— 坏 Key/欠费
等需要用户处理的通道故障直接点名; 修好后成功调用一次自动清除):

```bash
node bin/ppx.js doctor          # 离线体检: 配置/密钥三通道/权限/数据目录/技能
node bin/ppx.js doctor --net    # 加联网: 对每个就绪 provider 做协议正确的 /models 探活
```

Web 端等价物: 状态条会实时上浮模型通道故障 (「设置 → 模型」里的「测试」按钮可当场复测)。

探活失败排查清单:

1. Key 是否复制完整 / 是否已开通对应模型权限
2. 模型名是否正确 (部分厂商要求填**部署/接入点 ID** 而不是模型名, 按其控制台给出的标识填)
3. 本地厂商: LM Studio / Ollama 服务是否已启动 (或直接用向导输 `0` 自动发现)
4. 手动复测: `node bin/ppx.js setup --provider <id> --key <key>` 会再次探活;
   「设置 → 模型」每张 provider 卡也有「测试」按钮 (与 CLI 探活同一函数)
5. 401/欠费/404 类故障会持久记在 `data/llm/needs-action.json` 并在 doctor 与状态条点名
