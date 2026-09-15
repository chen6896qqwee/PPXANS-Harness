# ppx-agent v1.0.0-dev → **v1.3.1** — 皮皮虾（PPX Agent）测试版

一个会自我修复、自我学习的超级 Agent。**零运行时依赖**，纯 Node 原生，支持各大模型 API + 本地模型。

架构参考 [openhanako/HanaAgent](https://github.com/openhanako/HanaAgent) 与 TencentDB-Agent-Memory 的记忆分层、自愈内核与工具系统精华，用干净自包含实现重搭。

---

## ✨ 本次 v1.3.x 重点

### 🧹 控制台中文乱码根治
新增 `src/utils/winutf8.js`：启动强制 chcp 65001 + stdout/stderr 锁 utf8，挂进全部 5 个入口（CLI / HTTP 服务 / 通道 CLI / Agent 引擎 / Web 启动器）。**解决 Windows + PowerShell 下中文输出被 GBK 解成 "鐨尰铏?" 乱码的问题。**

### 🖼️ 多模态接入智谱 GLM-5V-Turbo
providers 新增 `zhipu`（glm-5v-turbo, vision:true, 用 ZHIPU_API_KEY）。同时关闭 lmstudio 本地 gemma 的视觉标记（本地小模型读图不可靠），确保收到图片时路由到真正能看图的智谱。

### ⚙️ 配置占位符校验落地
`validateConfig` 增加占位符检测：model/base_url/api_key 含 `REPLACE_WITH_` / `your_endpoint` / `your_api_key` 时启动即警告，**不再静默失败**。

### 📐 context_window 按模型预设
openai=128k、deepseek=64k、qwen-turbo=131k、qwen-vl=32k、zhipu/glm-5v=64k；本地 lmstudio 保持 8192 保守默认。长对话不再被过早压缩。

### 🔔 主动提醒温和通电
proactive 默认开启（1h 扫描）：无待办返回 null 不打扰 + 24h 去重 + 过期检测兜底。

### 🛡️ 安全
`scripts/start-web.js` 去掉 shell:true（数组传参 + 显式 npm.cmd），消除 DEP0190 子进程参数注入风险。

---

## 安装 / 升级

```bash
npm i -g ppx-agent    # 需 Node.js >= 20
```

## 快速开始

```bash
setx ZHIPU_API_KEY "你的智谱key"   # 多模态看图用（或 OpenAIDeepSeek 任意其一）
setx OPENAI_API_KEY "sk-..."      # 至少配一个云端 LLM key
ppx
```

> 首次运行前必须配置至少一个云端 LLM API key，详见 README「快速开始」。