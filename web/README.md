# 皮皮虾 Web 前端

皮皮虾（PPX Agent）的 Web 聊天与控制界面，基于 Next.js (App Router) 构建。默认通过 `scripts/start-web.js` 启动，会同时拉起 HTTP 内核服务（默认 `127.0.0.1:8899`）。

## 路由

| 路径 | 页面 |
|------|------|
| `/` | 聊天主页（SSE 流式、工具卡片、会话增删改查、场景/记忆/轨迹/统计） |
| `/settings/general` | 通用设置 |
| `/settings/model` | 模型与 Provider 管理 |
| `/settings/plugins` | 插件与能力（工具启停 / MCP / 方法技能） |
| `/settings/presets` | 智能体预设 |

## 本地开发

需要在仓库根目录先把内核依赖与环境准备好（`config/ppx.json` 中 Provider 的 `api_key_env` 对应环境变量）。

```bash
npm run dev --prefix web
# 访问 http://localhost:3000 （需后端 8899 已启动或由代理转发 /api）
```

> 提示：本仓库是**零运行时依赖**智能体内核，`web/` 仅是可选的 Web 控制台，核心功能走 `ppx` / `ppx-serve` 命令行即可。

## 与内核的联调

前端通过 `/api/*` 与内核 HTTP 服务通信（见 `src/server.js`），需要 Bearer token（配置或自动生成，见 `data/http-token`）。生产构建：

```bash
npm run build --prefix web
```