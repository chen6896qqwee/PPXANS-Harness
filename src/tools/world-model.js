// src/tools/world-model.js - 世界模型推演工具 (MCP 插入点) (2026-11-15, 默认不挂载)
//
// 定位: 给"不可逆操作先在模拟中推演一步"留一个干净的插入点 —— 世界模型作为**外部
//   本地服务** (wm-mcp 形态的 HTTP 端点), 通过 {simulate(action) -> observation} 契约
//   调用。内核零改动: plan-exec/react 的提示规则、路由、契约全都不动, 只多一个工具面;
//   推演结果只进上下文供决策参考, 不代替真实执行 (模拟 ≠ 现实, 观测须过 evidence 标记)。
//
// 纪律 (与"零运行时依赖"默认路径兼容):
//   · config.agent.world_model.endpoint 未设置 → 工具自报未配置 (不注册 HTTP 逻辑路径),
//     模型看到明确提示, 知道该环境没有世界模型可推演;
//   · 只有显式配置端点后才真正出网 (fetch POST, 8s 超时, 响应截断);
//   · 推演是只读动作: sideEffect=none —— 模拟端点约定不产生真实世界变更 (契约注释)。
import { TOOL_ERROR_PREFIX } from "./seam.js";

const SIM_TIMEOUT_MS = 8000;
const MAX_OBSERVATION_CHARS = 2000;

export function registerWorldModelTools(catalog, { config = null } = {}) {
  catalog.register({
    name: "world_model_simulate",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "在世界模型 (模拟环境) 中推演动作, 观察后果后再决定是否在真实环境执行。"
      + "【适用范围声明】文件域: 读写/追加/移动/删除/建目录全部建模; 命令域: type=exec 支持 "
      + "rm/mv/cp/mkdir/touch/truncate/dd/cd 的**简单命令** (不可逆的 rm -rf 想在执行前看后果, 用它) —— "
      + "但含通配符/变量/管道/子shell 的命令会明确返回 simulated:false, 因为影响面无法静态确定; "
      + "网络、数据库、git push、npm publish 等操作仍完全不在模拟域内, 必须人工确认。"
      + "文件域+命令子集模拟不是通用安全网。"
      + "未配置世界模型端点时本工具不可用。",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "结构化动作序列 (模拟要求精确动作, 推荐用这个): 每项 {type: write|append|delete|move|mkdir|read|exec, path, content?, to?, recursive?, command?, cwd?}",
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "动作类型" },
              path: { type: "string", description: "目标路径" },
              content: { type: "string", description: "write/append 的内容" },
              to: { type: "string", description: "move 的目标路径" },
              recursive: { type: "boolean", description: "delete 非空目录时必须 true" },
              command: { type: "string", description: "type=exec 时的 shell 命令 (仅限 rm/mv/cp/mkdir/touch/truncate/dd/cd 简单命令)" },
              cwd: { type: "string", description: "type=exec 时相对路径的基准目录 (缺省用世界根目录)" },
            },
            required: ["type", "path"],
          },
        },
        action: { type: "string", description: "兼容参数: 自然语言动作 (服务端会提示改用 steps —— 模拟不吃自然语言)" },
        context: { type: "string", description: "可选: 当前世界状态摘要 (给模拟端点的上下文)" },
      },
    },
    execute: async (args) => {
      const endpoint = String(config?.agent?.world_model?.endpoint || "").trim();
      if (!endpoint) {
        return TOOL_ERROR_PREFIX + " world_model.endpoint 未配置 —— 当前环境没有挂载世界模型, "
          + "无法推演。请直接在真实环境执行, 或先让管理员配置 config.agent.world_model.endpoint"
          + " (内置服务: config.agent.world_model.builtin=true)。";
      }
      const action = String(args?.action || "").trim();
      const steps = Array.isArray(args?.steps) && args.steps.length ? args.steps : null;
      if (!steps && !action) return TOOL_ERROR_PREFIX + " 需要 steps (结构化动作序列) 或 action (自然语言, 会被降级提示)";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SIM_TIMEOUT_MS);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            op: "simulate",
            ...(steps ? { steps } : { action }),
            context: String(args?.context || "").slice(0, 4000),
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          return TOOL_ERROR_PREFIX + ` 世界模型端点返回 ${res.status} (契约: POST {op:"simulate", action} -> observation)`;
        }
        const text = await res.text();
        return `【世界模型推演 (模拟, 非现实)】\n${text.slice(0, MAX_OBSERVATION_CHARS)}`;
      } catch (e) {
        const reason = e?.name === "AbortError" ? `超时 (${SIM_TIMEOUT_MS}ms)` : String(e?.message || e);
        return TOOL_ERROR_PREFIX + ` 世界模型推演失败: ${reason}`;
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
