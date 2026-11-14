// src/agent/runtime.js - 生命周期 / 可观测 / 退出收口 mixin (2026-11-03 从 index.js 拆出)
// 2026-11-02 单体拆分时这几块留在核心类里; 2026-11-03 为把 index.js 压到 600 行以下再下沉,
// 以 mixin 挂回 prototype —— 实例方法与调用方不感知 (与 context/prompts 等拆分同一模式)。
import { noteCatch, catchSummaryLine } from "../utils/catch-log.js";
import { scrubPII } from "../utils/pii.js";
import { warn } from "../utils/logger.js";
import { status as rewardStatus } from "../ans/reward.js";
import { scan as evictionScan, status as evictionStatus } from "../memory/eviction.js";
import { guardStatus } from "../ans/guard.js";

export const runtimeMethods = {
  // PII 回复掩码 (2026-10-09, 合规敏感部署): security.pii_reply_mask=true 时对**用户可见回复**
  //   做脱敏 (邮箱/手机/证件号/凭证 → [REDACTED])。只作用于对外输出 —— 落库与会话历史里仍是模型
  //   原文 (掩码不该让记忆层失真)。默认 false, 不破坏开发工作流。非字符串/异常一律原样返回。
  _maskReplyPII(reply) {
    if (this.config?.security?.pii_reply_mask !== true) return reply;
    if (typeof reply !== "string" || !reply) return reply;
    try { return scrubPII(reply).cleaned || reply; } catch { return reply; }
  },

  // 生命周期: 每次对话计数 + 阶段转换 (委托 ans/lifecycle 模块)
  _lifecycleTick() {
    this.lifecycle.tick();
  },

  // 生命周期摘要 (可观测, 委托 ans/lifecycle 模块)
  lifecycleStatus() {
    return this.lifecycle.status();
  },

  // Reward 行为倾向可观测 (⑦内分泌)
  rewardStatus() {
    return rewardStatus(this);
  },

  // 排泄治理可观测 (⑤遗忘-归档)
  evictionStatus() {
    return evictionStatus(this);
  },

  // 立即手动触发一次记忆治理扫描 (冗余识别 + 冷热分层)
  runMemoryEviction() {
    return evictionScan(this);
  },

  // TTL 治理 (G5, 2026-10-10 接线): 超过 config.memory.ttl_days 未访问的条目**软归档** (可回滚)。
  //   ttl_days=0/缺省 = 完全关闭 TTL 治理 (显式 disabled, 不是静默什么都不做)。
  //   与 runMemoryEviction 的分工: 那个是容量/冗余治理 (硬删), 这个是时效治理 (软归档)。
  sweepMemoryTtl() {
    const ttl = Number(this.config?.memory?.ttl_days ?? 0);
    if (!ttl || ttl <= 0) return { swept: 0, disabled: true };
    try {
      const r = this.facts.sweepExpired({ ttlDays: ttl }) || {};
      return { swept: Number(r.swept) || 0, ttlDays: ttl };
    } catch (e) {
      this.debug?.(`[memory] TTL 治理失败: ${e?.message || e}`);
      return { swept: 0, error: String(e?.message || e) };
    }
  },

  // 免疫闸门可观测 (⑧安全治理)
  guardStatus() {
    return guardStatus(this);
  },

  // 单次审批: 放行一个危险命令 verb (一次用完自动失效)
  approveGuard(verb) {
    return this.__guard ? this.__guard.approveOnce(String(verb)) : null;
  },

  // 关闭 agent。
  // 2026-10-10 (L2): 改为**异步**并 await 军团子进程回收完成 —— 原实现同步 fire-and-forget,
  //   调用方 (worker 的 shutdown 分支 / CLI 退出) 可能在子 worker 收尾前就 process.exit,
  //   留下孤儿进程。返回 Promise 后调用方可选择 await (旧调用方不 await 也兼容)。
  async shutdown() {
    this.stopProactiveTicker();
    this.stopWatchdog();
    // 2026-11-13: 挂起审批/提问必须在首个 await 之前同步收口 ——
    //   它们各自的定时器不再 unref (否则超时永不触发), 不能指望"进程自己走掉"。
    try { this.cancelApprovals?.("shutdown"); } catch { /* 收口失败不阻塞退出 */ }
    try { this.cancelQuestions?.(); } catch { /* 同上 */ }
    // 2026-10-24: SessionStop 钩子接线 —— 供外部钩子做会话收尾观测。
    //   刻意 fire-and-forget (不 await): shutdown 原时序里紧跟着使用统计/记忆落盘,
    //   在这里插入 await 会推迟它们一个微任务, 与"调用方不等 shutdown 就删数据目录"
    //   的调用模式 (CLI 退出/测试) 相撞, 产生锁超时竞态。钩子链自带超时熔断, 自行收敛。
    try { this.hooks?.emit?.("SessionStop", { sessions: [...(this._seenSessions || [])] })?.catch?.(() => {}); } catch { /* 不阻塞退出 */ }
    // 使用统计落盘 (ZCode 使用统计对齐): data/usage-stats.json
    this._flushUsageStats();
    this._mcp?.close?.();
    // 2026-11-01 (三期): 撤驻话题 worker 登记 (worker 进程由下方 shutdownAll 统一回收)。
    //   ⚠ 必须先判存在再 await —— async 函数体在首个 await 前是同步执行的, 无条件
    //   `await undefined?.x?.()` 也会让出微任务, 把后续 _saveState 推迟到调用方的
    //   rmSync 之后 (sync 测试不 await shutdown 即删目录 → 文件锁 3.5s 超时崩 15 个测试文件)。
    if (this.__threadBridge) {
      try { await this.__threadBridge.detachAll?.(); } catch (e) { noteCatch(e); /* 回收失败不阻塞退出 */ }
    }
    // v1.0.8: 清理军团子进程 (spawn_agent 派生的 worker), 防后台残留
    if (this._legion && typeof this._legion.shutdownAll === "function") {
      try { await this._legion.shutdownAll(); } catch (e) { noteCatch(e); /* 回收失败不阻塞退出 */ }
    }
    // 归档合批队列收口 (2026-10-30): 优雅退出时把 turns 里还没落盘的行写完 ——
    //   合批只在"达阈值/超时/强制点"落盘, 退出路径必须显式 flush, 否则最后几轮归档丢失
    //   (可从 events 重建, 但没理由让正常退出也丢)。
    // 2026-11-02 (L3): 会话事件同样有 write-behind 窗口, 必须在退出前同步收口。
    // 2026-11-03: 优先走 dispose() —— 除落盘外还要从进程退出兜底登记里摘除该实例。
    const ss = this.sessionStore;
    try {
      if (typeof ss?.dispose === "function") ss.dispose();
      else ss?.flushAll?.({ sync: true });
    } catch (e) { noteCatch(e); /* 落盘失败不阻塞退出 */ }
    this.memory.flushTurnArchive?.();
    this.memory._saveState?.();
    this.scheduler?.shutdown?.(); // ⑤/②: 清定时器防进程挂起
    // 架构优化 ⑦: 语言服务器是外部子进程, 必须显式收口, 否则退出后残留
    try { await this.ctx?.consume?.("lspPool")?.closeAll?.(); } catch (e) { noteCatch(e); /* 收口失败不阻塞退出 */ }
    // 架构优化 ⑧: 常驻 shell 是子进程, 必须显式收口
    try { await this.ctx?.consume?.("shellSession")?.dispose?.(); } catch (e) { noteCatch(e); /* 同上 */ }
    // 2026-10-30: memory.backend=sqlite 时释放数据库句柄 (JSON 后端无 close, 可选链兼容)
    try { this.facts?.close?.(); } catch (e) { noteCatch("src/agent/runtime.js#shutdown", e); /* 已关闭或释放失败不阻塞退出 */ }
    // 留痕读取端: 只写不读等于静默存错 —— 退出时把本次运行被吞下的关键路径异常汇总一次。
    const catchLine = catchSummaryLine();
    if (catchLine) warn(`[catch] ${catchLine}`);
    this.healer.markClean();
  },
};
