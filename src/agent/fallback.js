// src/agent/fallback.js — provider 回退链与降级提示 (2026-11-03 从 index.js 下沉)
// 行为与拆分前完全一致; 以 prototype descriptor 方式挂回 PPXAgent, 调用方无感知.
import { info, warn } from "../utils/logger.js";
import { EMPTY_REPLY } from "./loop/policy.js";
import { explainError } from "../utils/public-error.js";

const FALLBACK_NOTICE_TAG = "\n\n> ⚠ ";

class FallbackMixin {
  // 多 provider 回退: 依次尝试, 失败切下一个
  // 多 provider 并发健康探测 + 回退: 只对可用 provider 调用, 避免串行等待 180s 超时
  // 2026-10-24 (R10): onDelta/signal 透传 —— 流式通道 (chatStream) 从直连
  //   _llmWithTools 改为走本回退链: 主模型宕机时健康探测过滤 + 逐 provider 流式尝试,
  //   Web 用户不再承受"整轮重来 + 退化为非流式"。
  // 2026-11-01 (二期②): onReasoning 透传 (推理模型思考链, 同 onDelta 逐 provider 传递)。
  async _llmWithFallback(seedMessages, onDelta = null, signal = null, onReasoning = null) {
    let clients = (this.allProviders || []).length ? this.allProviders : [this.llm];
    // 多模态路由: 消息含图片 (image_url 块) 时, 优先 vision provider, 避免图片发到文本后端浪费
    const hasImage = seedMessages.some((m) => Array.isArray(m.content) && m.content.some((c) => c && c.type === "image_url"));
    if (hasImage) {
      const visionClients = clients.filter((c) => c.vision);
      if (visionClients.length) clients = visionClients;
      else info("消息含图片但无 vision provider, 图片将无法被模型理解 (请配置 vision: true 的 provider)");
    }
    // 工具类任务: 优先原生 tool_calls 后端 (http)。
    // openclaw 是完整 agent 运行时, 会拒绝围栏协议(视为伪协议); 实测 http 原生 tool_calls 全链路通过。
    // v2.5.0: 外部引擎底座已移除, 仅 http 后端 (原生 tool_calls + 文本工具修复)。
    if (this.toolsEnabled) {
      const native = clients.filter((c) => c.supportsNativeToolCalls);
      const fence = clients.filter((c) => !c.supportsNativeToolCalls);
      if (native.length) clients = [...native, ...fence];
    }
    if (clients.length > 1) {
      try {
        // 健康探测 TTL 缓存 (2026-10-03m): 高频对话每轮全量探活会串行等一整轮网络往返。
        //   TTL 内复用上次结果 (config.agent.health_cache_ms, 默认 30s); 过期即重新探测。
        //   缓存只影响"要不要探", 不影响"探出来怎样" —— 不健康 provider 的跳过语义不变。
        const ttl = Number(this.config.agent?.health_cache_ms ?? 30000);
        const cache = (this._healthCache ||= new Map());
        const now = Date.now();
        const states = await Promise.all(clients.map(async (c) => {
          if (!c.health) return true;
          const hit = cache.get(c);
          if (hit && (now - hit.ts) < ttl) return hit.ok;
          let ok = true;
          try { ok = !!(await c.health()); } catch { ok = false; }
          cache.set(c, { ok, ts: Date.now() });
          return ok;
        }));
        const healthy = clients.filter((_, i) => states[i]);
        if (healthy.length) clients = healthy;
        else info("所有 provider 健康探测失败, 按原配置顺序尝试兜底");
      } catch (e) {
        warn("health 探测异常, 按原顺序回退:", e.message);
      }
    }
    let lastErr = null;
    // v1.0.8 修复 (P2-2): 记录"本轮发生了降级切换"这一事实并对外广播。
    //   原实现只在日志里 warn 一句, 用户侧完全静默 —— 拿到的是备用模型的回答却无从感知。
    //   注意: **不改动返回值** (回退语义本身保持透明, chaos 测试锁死了成功时返回原始文本)。
    const failed = [];
    let idx = 0;
    for (const client of clients) {
      const hasMore = idx < clients.length - 1;
      idx++;
      try {
        const out = await this._llmWithTools(seedMessages, client, onDelta, signal, onReasoning);
        // 2026-10-24 (R10): 空回复哨兵 —— provider "成功"返回但什么都没说 (空 content
        //   无 tool_calls), 还有备选时视同失败切换下一个, 不把"(无回复)"交付给用户。
        if (out === EMPTY_REPLY && hasMore) {
          failed.push({ model: client.model, message: "空回复 (无 content 且无 tool_calls)" });
          this._turnAttempt = (this._turnAttempt || 0) + 1;
          warn("provider 返回空回复, 切换下一个:", client.model);
          continue;
        }
        if (failed.length) {
          this._lastFallback = {
            from: failed[0].model,
            to: client.model,
            reason: failed[0].message,
            chain: failed.map((f) => f.model),
            ts: Date.now(),
          };
          this.bus?.emit("llm/fallback", this._lastFallback, { source: "agent._llmWithFallback" });
          warn(`provider 降级: ${this._lastFallback.from} 不可用 → 已切至 ${client.model} (${failed[0].message})`);
        }
        return out;
      } catch (e) {
        // 2026-10-24 (R12): 用户中断不是 provider 故障 —— 立即上抛, 不切下一个
        //   provider (否则叫停被回退链吞掉并换模型重跑 = 二次计费 + 无视用户取消)。
        //   2026-11-06 (评估 P1-4): 中断判定走会话隔离入口, 其它会话的中断不再影响本回退链。
        if (e?.name === "AbortError" || e?.code === "ABORT_ERR" || (this._isInterrupted ? this._isInterrupted() : this._interrupted) || signal?.aborted) throw e;
        lastErr = e;
        failed.push({ model: client.model, message: e.message });
        // 2026-10-24 (R2): 进入下一次尝试 —— 非幂等工具的回放缓存自此开始消费 (防双执行)
        this._turnAttempt = (this._turnAttempt || 0) + 1;
        warn("provider 失败, 切换下一个:", client.model, e.message);
      }
    }
    throw lastErr || new Error("所有 provider 均失败");
  }

  // 降级原因"人话化": 原始错误常带整段 JSON 报错体 (含 key 片段/内部字段),
  // 既不适合直接给用户看, 也没必要。这里归一到几类常见故障。
  _shortReason(msg) {
    // 2026-10-09: 判定逻辑收敛到 utils/public-error (与硬失败路径 LLM_FAILED_HINT 共用),
    //   原先这里与 loop/policy 各写一套, 是"两条路径口径不一致"的根因。
    return explainError(msg);
  }

  // 降级提示文案 (用户可见) —— 由 chat/chatStream 在回复末尾追加
  _fallbackNotice(fb) {
    if (!fb) return "";
    const chain = fb.chain && fb.chain.length > 1 ? ` (失败链: ${fb.chain.join(" → ")})` : "";
    return `${FALLBACK_NOTICE_TAG}主模型 ${fb.from} 不可用: ${this._shortReason(fb.reason)}。本轮回答已自动切换到 ${fb.to}${chain}。`;
  }

  // 从回复中剥掉降级提示: 保证写入会话历史/记忆的是模型原文, 提示只面向当轮用户可见
  _stripFallbackNotice(text) {
    const s = String(text ?? "");
    const i = s.indexOf(FALLBACK_NOTICE_TAG);
    return i === -1 ? s : s.slice(0, i).trimEnd();
  }
}

const d = Object.getOwnPropertyDescriptors(FallbackMixin.prototype);
delete d.constructor;
export const fallbackMethods = d;
