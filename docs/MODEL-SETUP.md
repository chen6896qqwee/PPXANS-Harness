# 模型 API 配置指南 + MCP 统一接口

> 2026-10-01: 主流开箱体验对齐。内置 12+ 家厂商预设, 用户**只需输入 API Key**, base_url/环境变量/模型名零记忆负担。

## 一、最快路径: 配置向导

```bash
npm run setup
```

向导流程: **选厂商 → 粘贴 API Key (回车可用环境变量) → 自动探活 → 写入 config/ppx.json**。

非交互式 (CI / 脚本):

```bash
node bin/ppx-setup.js --list                          # 列出全部内置厂商
node bin/ppx-setup.js --provider deepseek --key sk-xxx --model deepseek-chat
node bin/ppx-setup.js --provider lmstudio             # 本地厂商免 Key, 自动探活
```

### 可选: 分层路由 (辅助任务走便宜模型)

记忆提取/摘要/压缩等辅助调用默认跟随主模型。想省成本, 可指定一个便宜厂商专门跑辅助任务:

```bash
node bin/ppx-setup.js --aux deepseek     # 辅助任务走 deepseek (需已配置该厂商 Key)
node bin/ppx-setup.js --aux off          # 取消, 恢复全走主模型
```

- **不配置 = 全走主模型**, 零配置零门槛; 配置了但厂商不可用 (无 Key/探活失败) 也自动回落主模型。
- 主对话、工具循环、多 Agent 军团不受影响, 永远走主模型/降级链。

## 二、内置厂商预设

### 云端 (需 API Key)

| 厂商 | 预设 id | base_url (内置) | 环境变量 | 默认模型 |
|---|---|---|---|---|
| DeepSeek 深度求索 | `deepseek` | https://api.deepseek.com/v1 | `DEEPSEEK_API_KEY` | deepseek-chat |
| 智谱 GLM | `zhipu` | https://open.bigmodel.cn/api/paas/v4 | `ZHIPU_API_KEY` | glm-4.7 |
| 阿里通义千问 | `dashscope` | https://dashscope.aliyuncs.com/compatible-mode/v1 | `DASHSCOPE_API_KEY` | qwen-max |
| 月之暗面 Kimi | `moonshot` | https://api.moonshot.cn/v1 | `MOONSHOT_API_KEY` | kimi-k2-0711-preview |
| 火山方舟豆包 | `volcengine` | https://ark.cn-beijing.volces.com/api/v3 | `VOLCENGINE_API_KEY` | 填接入点 ID (ep-xxx) |
| OpenAI | `openai` | https://api.openai.com/v1 | `OPENAI_API_KEY` | gpt-4o-mini |
| Anthropic | `anthropic` | https://api.anthropic.com/v1 (OpenAI 兼容层) | `ANTHROPIC_API_KEY` | claude-sonnet-4-5 |
| Google Gemini | `gemini` | https://generativelanguage.googleapis.com/v1beta/openai/ | `GEMINI_API_KEY` | gemini-2.5-flash |
| OpenRouter 聚合 | `openrouter` | https://openrouter.ai/api/v1 | `OPENROUTER_API_KEY` | 自选 |
| Groq | `groq` | https://api.groq.com/openai/v1 | `GROQ_API_KEY` | llama-3.3-70b |
| 硅基流动 | `siliconflow` | https://api.siliconflow.cn/v1 | `SILICONFLOW_API_KEY` | Qwen/Qwen3-32B |

### 本地 (免 Key, 自动探活)

| 厂商 | 预设 id | base_url (内置) |
|---|---|---|
| LM Studio | `lmstudio` | http://127.0.0.1:1234/v1 |
| Ollama | `ollama` | http://127.0.0.1:11434/v1 |

全部厂商均走 **OpenAI 兼容协议** (chat/completions), 由自研 `LLMClient` 直连, 无 SDK 依赖。
多厂商可并存, `config/ppx.json` 的 `providers` **数组首位 = 默认厂商**, 探活失败自动回退下一个。

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

## 四、探活失败排查

1. Key 是否复制完整 / 是否已开通对应模型权限
2. 模型名是否正确 (火山方舟需填接入点 ID `ep-xxx`)
3. 本地厂商: LM Studio / Ollama 服务是否已启动
4. 手动复测: `node bin/ppx-setup.js --provider <id> --key <key>` 会再次探活
