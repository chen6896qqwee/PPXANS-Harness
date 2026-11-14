// src/channels/http-api-core.js - HTTP 通道的 /api/* 门禁与路由表 (mixin, 从 http.js 拆出)
// 职责: REST 退役开关 + 鉴权门禁 (_gateApi) 与全部 REST API 的路径分派 (_apiRoute)。
// 路由顺序/状态码/响应体逐字保持拆分前语义; 各 case 的具体实现仍在各自模块 (http-api-v3 / web/*)。
// 依赖约束: 不得 import http.js (宿主), 否则成环。
import fs from "node:fs";
import path from "node:path";
import { readBody } from "../utils/http.js";
import { ensureDir } from "../utils/store.js";
import { listPresets, PROTOCOL_LABELS } from "../llm/presets.js";
import { suggestProactive } from "../ans/proactive.js";
import { voiceStatus } from "../tools/voice.js";
import { handleBotApi } from "../web/bot-api.js";
import { handlePluginApi } from "../web/plugin-api.js";
import { handleUsageStatsApi } from "../web/usage-stats.js";
import { handleSkillsApi } from "../web/skills-api.js";
import { handleMcpApi } from "../web/mcp-api.js";

export const httpApiCoreMethods = {
  // ---- API 门禁: REST 退役开关 + 鉴权。返回 true = 已写响应 (路由结束), false = 放行到具体 API 路由 ----
  // channels.http.mcp.legacy_rest = true (默认) 时保留旧 /api/* REST 端点 (兼容旧脚本/客户端);
  // 显式设为 false 时 /api/* 返回 410 Gone, 引导使用标准 MCP 端点 /mcp
  _gateApi(req, res, reqPath) {
    if (!reqPath.startsWith("/api/")) return false;
    if (!this.mcpLegacyRest) {
      this._json(res, 410, { error: "REST /api/* 已退役, 请使用标准 MCP 端点 POST /mcp (channels.http.mcp.legacy_rest=true 可恢复)" });
      return true;
    }
    // /api/bootstrap 例外: 它本身就是"取 token"的入口, 可信本地请求免鉴权放行
    // (必须用 _isTrustedLocal 而非 _isLoopback —— 否则浏览器里任意网站发来的跨源请求
    //  源地址同样是 127.0.0.1, 会被误判为本机并拿到 token)
    const bootstrapLocal = reqPath === "/api/bootstrap" && this._isTrustedLocal(req);
    if (!bootstrapLocal && !this._requireAuth(req, res)) return true;
    return false;
  },

  // API 路由表: 每个 handler 返回 true (已处理)
  async _apiRoute(req, res, reqPath) {
    const get = req.method === "GET";
    // 2026-10-27: 本体 (bot) 形态接口 —— /api/bot.state 聚合首屏快照, /api/bot.manage 单入口写
    // 必须排在 switch 之前: 这几个路径不在 case 表里, 落到 default 会 404
    if (await handleBotApi(this, req, res, reqPath)) return true;
    // 2026-10-30: 用户插件管理 (列表/详情/创建/更新/启停/删除)
    if (await handlePluginApi(this, req, res, reqPath)) return true;
    // 2026-10-31: 「使用统计」页 —— 按天 token 账本 + 会话时长 + 连续天数
    if (await handleUsageStatsApi(this, req, res, reqPath)) return true;
    // 2026-11-03: 技能 / MCP 管理页 (停用启停 / 服务器增删改 + 热重连)
    if (await handleSkillsApi(this, req, res, reqPath)) return true;
    if (await handleMcpApi(this, req, res, reqPath)) return true;
    // v3.0 (codex 对齐): 命令面板 / 审批流 / 目标看板 / 审查报告 / 权限热更新
    if (await this._apiV3(req, res, reqPath, get)) return true;
    switch (reqPath) {
      // 引导信息 API (前端启动时刷新用): 版本/端口/token(仅回环)/能力开关
      case "/api/bootstrap":
        if (!get) return false;
        this._json(res, 200, this.bootstrapPayload(req), { "Cache-Control": "no-store" });
        return true;
      case "/api/traces": {
        if (!get) return false;
        const limit = Number((req.url.split("limit=")[1] || "").split("&")[0] || 50);
        this._json(res, 200, this.agent.traces.read(undefined, limit));
        return true;
      }
      case "/api/stats":
        if (!get) return false;
        this._json(res, 200, this.agent.stats ? this.agent.stats() : this.agent.traces.stats());
        return true;
      case "/api/memory": {
        if (!get) return false;
        const facts = this.agent.facts ? this.agent.facts.list().slice(0, 20).map((f) => ({ content: f.content, score: f.score, type: f.type })) : [];
        const scenes = this.agent.scenes ? this.agent.scenes.listWithDesc().slice(-10) : [];
        this._json(res, 200, { facts, scenes });
        return true;
      }
      // 主动任务生成 API (ANS 自主性): 扫描记忆待办/偏好, 返回主动提醒 + 结构化 items (含 id)
      case "/api/proactive":
        if (!get) return false;
        try {
          const out = await suggestProactive(this.agent);
          this._json(res, 200, { message: out ? out.text : null, items: out ? out.items : [] });
        } catch (e) {
          this._json(res, 200, { message: null, items: [], error: e.message });
        }
        return true;
      // 标记待办完成 (ANS): POST /api/proactive/done { id } → 之后不再主动提醒
      case "/api/proactive/done": {
        if (req.method !== "POST") return false;
        if (!this._requireAuth(req, res)) return true;
        const body = await this._readBody(req, res);
        if (body === null) return true;
        try {
          const data = JSON.parse(body || "{}");
          const ok = this.agent.proactiveMarkDone(data.id);
          this._json(res, ok ? 200 : 404, { ok });
        } catch (e) {
          this._fail(res, e);
        }
        return true;
      }
      // 生命周期状态 API (ANS): 阶段/年龄/进化/繁衍
      case "/api/lifecycle":
        if (!get) return false;
        this._json(res, 200, this.agent.lifecycleStatus ? this.agent.lifecycleStatus() : {});
        return true;

      // 提供方 API - 模型配置 Web UI 后端
      // GET 列出 (key 抹掉, 只回 api_key_set) / POST 新增 / PUT 更新 / DELETE 删除
      case "/api/providers":
        return this._apiProviders(req, res);
      // 厂商预设库 (只读): 让前端"选厂商 → 自动带出 base_url / 常用模型 / 环境变量名 / 申请地址"
      // 纯静态数据, 不碰磁盘配置, 因此不涉及写权限
      case "/api/providers/presets":
        if (!get) return false;
        if (!this._requireAuth(req, res)) return true;
        this._json(res, 200, { presets: listPresets(), protocols: PROTOCOL_LABELS });
        return true;
      // 健康探测 (body: { id }), 复用 LLMClient.health()
      case "/api/providers/test":
        if (req.method !== "POST") return false;
        return this._apiProviderTest(req, res);
      // v4.2 (2026-11-01): 模型目录拉取 (body: {id} 或 {base_url, protocol, api_key?}) ——
      //   "获取可用模型"按钮后端: 按协议 GET /models, 失败带三态分类 (auth/balance/not_found/...)
      case "/api/providers/fetch-models":
        if (req.method !== "POST") return false;
        return this._apiProviderFetchModels(req, res);
      // 2026-11-02: 本机模型一键发现 (只扫环回固定端口表) —— 「一键接入本地模型」后端
      case "/api/providers/discover-local":
        if (req.method !== "POST") return false;
        return this._apiProviderDiscoverLocal(req, res);
      // 重排 (body: { order: [id1, id2, ...] })
      case "/api/providers/reorder":
        if (req.method !== "POST") return false;
        return this._apiProviderReorder(req, res);
      // 2026-10-24 (R16): 分层路由 (aux 辅助模型 + local/cloud 优先序) 读写
      case "/api/routing":
        return this._apiRouting(req, res);
      // 2026-10-24 (R16): per-provider 用量 (usageStats.byModel 按模型→提供方聚合)
      case "/api/providers/usage":
        if (!get) return false;
        return this._apiProviderUsage(req, res);
      // v4.2 (2026-11-01): 意图漏斗层流量 (rule/context/llm 占比 —— 漏斗健康度: 大部分请求
      //   应在上层消化, 进入 LLM 兜底层的保持较低比例)
      case "/api/intent/stats":
        if (!get) return false;
        if (!this._requireAuth(req, res)) return true;
        this._json(res, 200, { funnel: (this.agent.intentState && this.agent.intentState.snapshot()) || null });
        return true;

      // 2026-10-30: 最近一次生成运行态 + 用量快照 + 累计用量 —— 供 Web 底部状态条常驻显示
      //   (刷新后不丢, 不必等下一次生成才有数; 此前这套数只在内存算, 刷新即消失)。
      case "/api/run.state":
        if (!get) return false;
        return this._apiRunState(req, res);

      // 通用设置 API: 用户名 / HTTP 端口 / 安全 / agent 预设
      case "/api/settings":
        return this._apiSettings(req, res);

      // 工作区文件树 + 读取 (Web UI 项目文件引用)
      case "/api/workspace/tree":
        if (!get) return false;
        return this._apiWorkspaceTree(res, req);
      case "/api/workspace/read":
        if (!get) return false;
        return this._apiWorkspaceRead(res, req);

      // 文件上传 (Web UI 附件): JSON { name, data(base64) } → 存 <root>/uploads/ → 返回相对路径。
      //   图片: 路径拼进消息后 visionUserContent 会自动注入多模态 (8MB 上限, 防 base64 撑爆上下文);
      //   其他文件 (pdf/docx/zip/代码等): 路径进消息文本, agent 用 read_document/read_file 等工具读取 (20MB 上限)。
      case "/api/upload": {
        if (req.method !== "POST") return false;
        const body = await readBody(req, { maxBytes: 28 * 1024 * 1024 }); // base64 ≈ 4/3 原体积
        if (body === null) { this._json(res, 413, { error: "文件过大 (上限 20MB)" }); return true; }
        try {
          const p = JSON.parse(body || "{}");
          const name = String(p.name || "file.bin").replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_").slice(-80) || "file.bin";
          const ext = path.extname(name).toLowerCase();
          const isImg = /^\.(png|jpe?g|gif|webp|bmp)$/.test(ext);
          const b64 = String(p.data || "").replace(/^data:[^,]*,/, "");
          const buf = Buffer.from(b64, "base64");
          const limit = isImg ? 8 * 1024 * 1024 : 20 * 1024 * 1024;
          if (!buf.length) { this._json(res, 400, { error: "文件为空" }); return true; }
          if (buf.length > limit) {
            this._json(res, 413, { error: (isImg ? "图片" : "文件") + "过大 (上限 " + (isImg ? 8 : 20) + "MB)" });
            return true;
          }
          const dir = path.join(this.agent.root, "uploads");
          ensureDir(dir);
          // 防覆盖: 同名追加序号
          let file = path.join(dir, name);
          if (fs.existsSync(file)) {
            const stem = name.slice(0, -ext.length) || name;
            let i = 1;
            while (fs.existsSync(file)) file = path.join(dir, `${stem}-${i++}${ext}`);
          }
          fs.writeFileSync(file, buf);
          const rel = "uploads/" + path.basename(file);
          this._json(res, 200, { ok: true, path: rel, bytes: buf.length, kind: isImg ? "image" : "file" });
        } catch (e) { this._fail(res, e, 400); /* swallowed-ok(2026-11-03): 错误已回 400 给客户端 */ }
        return true;
      }

      // LLM 运行时切换 (Web UI 模型胶囊 / 思考强度滑杆):
      //   GET  → 现状 + 候选 provider 列表 + 语音能力状态
      //   POST → { provider?, reasoning? } 写 config.llm 并热重载 LLM 客户端
      case "/api/llm":
        return this._apiLlm(req, res);

      // 语音输入: 状态查询 + 音频转写 (复用 tools/voice.js 的云端 ASR)
      case "/api/voice/status":
        if (!get) return false;
        this._json(res, 200, { ok: true, ...voiceStatus(this.agent.config || {}) });
        return true;
      case "/api/voice/transcribe":
        if (req.method !== "POST") return false;
        return this._apiVoiceTranscribe(req, res);

      default:
        return false;
    }
  },
};
