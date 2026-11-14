// src/agent/tool-admit.js - 工具准入链 (plan 模式 + 角色闸 + 权限引擎 + 审批缓存)
//
// 2026-11-12 自 index.js 拆出: 这是"这条调用允不允许开始"的判定, 与 approval.js 的
// "开始之后怎么执行、什么时候问人"分开。两者都在唯一执行收口上, 但改变它们的原因不同
// (准入看策略, 执行看通道/审批面), 混在门面文件里时没人找得到策略改在哪。
import { currentTrace } from "../core/trace.js";

export const admitMethods = {
// 工具准入链 (唯一真相源, 2026-10-10 收敛): plan 模式 + 权限引擎 (deny/ask/allow) 全在此。
  //   此前 plan 判定住在这里、权限判定却内联在 _runTool —— 测试调 _admitToolCall、生产走内联,
  //   两侧各修各的 (正是"测试与产品路径不是同一个"的漂移源)。现 _runTool 也调用本方法。
  //   返回 { ok, error?, args? }:
  //     ok=true  → 放行 (args 可能是审批改参后的新对象)
  //     ok=false → error 为面向模型的可判读理由 (不带 TOOL_ERROR_PREFIX, 由调用方加)
  // 安全不变量: 引擎异常一律 **fail-closed** (拒绝执行) —— 引擎崩了防线不能全开。
  async _admitToolCall(name, args, callId) {
    const sessionKey = currentTrace()?.sessionKey || "default";

    // 0) 角色闸 (2026-11-04): Router 只分派不执行 —— 名单外工具在唯一执行收口硬拒。
    //   装配期的 disable() 只省 schema, 且覆盖不到启动后动态注册的 MCP 工具;
    //   强制边界必须在这里, 与 plan 判定同层。
    if (this.role === "router" && this._routerAllow && !this._routerAllow.has(name)) {
      this.tracer.event("tool/role-denied", { tool: name });
      return {
        ok: false,
        error: `[role] 当前为 Router 角色 (只分派不执行), "${name}" 不在允许名单内。请用 spawn_agent 把这件事分派给 worker 执行; 确需本进程直接执行时, 关闭 config.agent.router_role.enabled 并重启。`,
      };
    }

    // 0.5) ANS 车道加严黑名单 (ans_lane.security.extra_deny_tools): 只增不减,
    //   按会话生效, 与入站共用同一条准入链 (I17)。
    const ansDeny = this._ansDenyToolsBySession?.get(sessionKey);
    if (ansDeny && ansDeny.has(name)) {
      this.tracer.event("tool/ans-denied", { tool: name, sessionKey });
      return {
        ok: false,
        error: `[ans_lane] 工具 "${name}" 被车道安全策略显式拒绝 (extra_deny_tools)。`,
      };
    }

    // 1) plan 模式直判: 不依赖引擎装配, 引擎缺失时 plan 语义仍生效 (只读非破坏工具放行)
    if (this.isPlanMode(sessionKey)) {
      const cap = (this.tools && typeof this.tools.getCapability === "function")
        ? this.tools.getCapability(name)
        : null;
      if (!(cap && cap.readOnly && !cap.destructive)) {
        return {
          ok: false,
          error: `plan 模式: 只允许只读非破坏工具, "${name}" 被拒绝。请先用 /do 退出计划模式, 或先产出计划交用户审阅。`,
        };
      }
    }

    // 2) 权限引擎 (deny/ask/allow)
    if (!this.permissions) return { ok: true, args };
    let perm;
    try {
      perm = await this.permissions.check(name, args, { callId, planEnabled: this.isPlanMode(sessionKey) });
    } catch (e) {
      // fail-closed: 引擎异常 = 无法判定 = 拒绝 (原实现 catch{} fail-open, 引擎崩了工具全放行)
      this.tracer.event("tool/perm-error", { tool: name, error: String(e?.message || e) });
      return { ok: false, error: `[permission] 权限引擎异常, 已拒绝执行 (fail-closed): ${e?.message || e}` };
    }
    if (perm.decision === "deny") {
      this.tracer.event("tool/perm-denied", { tool: name, reason: perm.reason });
      return { ok: false, error: `[permission] 工具 ${name} 被拒绝: ${perm.reason || "命中 deny 规则"}` };
    }
    // 2026-10-24 (R14): MCP 外部工具审批闸门 —— 外部 MCP 服务器提供的工具是未审计的
    //   第三方代码, 名称不可能命中基于名字的 REQUIRES_APPROVAL_TOOLS 名单, ON_REQUEST
    //   模式下会静默放行 (真模型探测实锤: MCP 工具零审批执行)。现按 server 级 trusted
    //   开关 (config.mcp.servers[].trusted, 默认 false = 需审批) 升级为 ask, fail closed。
    //   UNLESS_TRUSTED 档已被"非白名单即问"覆盖 (不会走到这, perm 已是 ask); NEVER 档维持不问。
    if (perm.decision === "allow" && this.permissions?.approvalMode !== "never") {
      const def = this.tools?.metaOf?.(name);
      if (def && def.category === "mcp" && def.mcpTrusted !== true) {
        perm = { decision: "ask", reason: `MCP 外部工具 "${name}" 所在服务器未标记 trusted (config.mcp.servers[].trusted), 默认需审批` };
      }
    }
    if (perm.decision === "ask") {
      // headless: 没有审批面 → 不能把 ask 挂起等人, 直接拒绝。
      // 拒绝消息带 modelHint (点名三种合法写法 + 实际收到的内容), 让模型能自纠而不是僵住。
      if (!this.hasApprovalSurface()) {
        // 无人环境的显式放行开关 (基准 / 无人批处理): config.agent.approval_headless = "auto-approve"
        //   时视为已批准。默认 (未声明) 仍走下面的快拒 —— 防线默认收紧, 放行必须显式声明。
        if (this.config?.agent?.approval_headless === "auto-approve") {
          this.tracer.event("tool/perm-approved-headless", { tool: name, reason: perm.reason, mode: "auto-approve" });
          return { ok: true, args };
        }
        const parts = [`[permission] 工具 ${name} 需要人工确认, 但当前进程没有审批入口 (headless 模式), 已拒绝执行`];
        if (perm.reason) parts.push(`理由: ${perm.reason}`);
        if (perm.modelHint) parts.push(perm.modelHint);
        // 可执行的下一步 (否则模型只会原地重试同一条命令, 直到轮次耗尽):
        //   要么换一个能挂审批面的入口, 要么把该工具显式放行后再重试。
        parts.push("可执行的下一步: ①改用带审批面的入口重跑 (ppx serve / ppx web, 或 CLI 交互式确认); ②或在配置里把该工具显式放行 (config.agent.approval_mode = \"allow\" 或加入 permissions allow 规则) 后重试; ③或换用一个不需要审批的只读工具完成同样的事。");
        this.tracer.event("tool/perm-denied-headless", { tool: name, reason: perm.reason });
        return { ok: false, error: parts.join("\n") };
      }
      // B2: 审批缓存 (codex ApprovalStore 语义) — 会话内相同命令已批准过则不重复 ask
      // 仅命令类工具参与; 缓存 key = `${tool}:${原样命令}` (不归一化引号/空白)
      // 命中 = 本次会话已显式批准, 视为放行; 拒绝/超时永不入缓存
      // 2026-11-03: 三档决策 —— approve(仅本次, 不入缓存) / always(本会话) / persist(永久, 落盘)
      const cacheKey = this._approvalCacheKey(name, args);
      const cached = cacheKey && this.config.agent?.approval_cache !== false && this._approvalCache.get(cacheKey);
      // 2026-11-03: 前缀放行 (本会话) —— 人类点过「前缀放行」后, 同首词的单条简单命令不再重复 ask
      const prefixKey = !cached ? this._approvalPrefixKey?.(name, args) : null;
      const prefixHit = prefixKey && this.config.agent?.approval_cache !== false && this._approvalCache?.get(prefixKey);
      let upd = null;
      if (cached) {
        this.tracer.event("approval/cache-hit", { tool: name, key: cacheKey });
        upd = { decision: "always" }; // 视为已批准
      } else if (prefixHit) {
        this.tracer.event("approval/prefix-hit", { tool: name, key: prefixKey });
        upd = { decision: "always" }; // 视为已批准
      } else {
        upd = await this._requestApproval({ tool: name, args, reason: perm.reason });
        if (upd) {
          this._applyApprovalDecision(cacheKey, upd.decision, perm.reason);
          // prefix 决策: 落前缀缓存 (resolveApproval 也会落一次, Map.set 幂等)
          if (upd.decision === "prefix") {
            const pkey = this._approvalPrefixKey?.(name, args);
            if (pkey) this._applyApprovalDecision(pkey, "always", perm.reason);
          }
        }
      }
      if (upd && typeof upd === "object" && upd.updatedInput) args = upd.updatedInput;
      if (!upd) {
        this.tracer.event("tool/perm-rejected", { tool: name });
        return { ok: false, error: `[permission] 工具 ${name} 审批被拒绝或超时` };
      }
    }
    return { ok: true, args };
  },
};
