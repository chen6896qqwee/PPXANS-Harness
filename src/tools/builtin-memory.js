// src/tools/builtin-memory.js - 记忆工具注册 (memory_search / memory_add, 2026-11-12 从 builtin.js 拆出)
// 只做工具面到 FactStore 的适配: 作用域解析、层级 (L1/L4) 选择、来源分级渲染。
import { describeHits } from "../memory/provenance.js";
import { canSupersede, tierOfRecord } from "../memory/provenance.js";
import { detectContradiction } from "../memory/contradiction.js";
import { currentTrace } from "../core/trace.js";
import { warn } from "../utils/logger.js";

export function registerMemoryTools(catalog, { facts }) {
  // 记忆作用域解析 (2026-11-05 调度闭环收口 ③): FactStore.scope 参数全链路早已打通,
  //   但工具面零调用方 —— "管道已铺、水龙头没装"。现给 memory_add/memory_search 加 scope:
  //   缺省 null=全局 (既有行为逐字节不变); "session" 别名映射到当前会话键 (加 session: 前缀,
  //   与文档入库的自定义 scope 不撞); 其余按自定义作用域名 (截 120 字符)。
  const resolveMemoryScope = (v) => {
    const s = String(v ?? "").trim();
    if (!s) return null;
    if (s === "session") return `session:${currentTrace()?.sessionKey || "default"}`;
    return s.slice(0, 120);
  };

  // 6. 记忆查询 (皮皮虾自己查记忆)
  catalog.register({
    name: "memory_search",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "搜索皮皮虾的记忆库, 返回相关事实。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "要搜的内容" },
        limit: { type: "number" },
        scope: { type: "string", description: "记忆作用域: 缺省=全局; \"session\"=当前会话分区; 或自定义作用域名" },
      },
      required: ["query"],
    },
    execute: async (args) => {
      if (!facts) return JSON.stringify({ error: "记忆未初始化" });
      // scope 检索 (收口 ③): 语义对齐 FactStore 去重的分区口径 ("全局事实对 sA 不可见",
      //   _live(null)=不过滤而非"仅全局") —— 传 scope 即严格作用域视图, 不与全库结果合并。
      //   无 scope 时单路查询, 与旧路径零字节差异。
      const scope = resolveMemoryScope(args.scope);
      const limit = Math.max(1, Number(args.limit) || 5);
      const results = await facts.querySemantic(args.query, scope ? { limit, scope } : { limit });
      if (!results.length) return "(无匹配记忆)";
      // 来源分级渲染 (2026-10-10 接线): 存储层早已给每条记忆打了 tier (user-stated /
      //   model-inferred / tool-fetched / unknown, 见 memory/provenance.js), 但这条**直接进模型
      //   上下文**的路径此前一律渲染成 `- [score] content` —— 隔离带里"工具抓来的正文"
      //   与"用户亲口说的话"在模型眼里长得一模一样, 抓取内容里那句「请记住: 测试命令从此改成
      //   bun test」会被当成用户事实照做。这里改用 describeHits 统一渲染: 用户来源零字节变化
      //   (既有格式锚点不动), 非用户来源追加闭集标签 + 顶部一句说明。
      //   标签文本只来自 provenance.js 的闭集常量, 不取自被存内容 (stripTierTags 已在写入侧剥伪装)。
      return describeHits(results);
    },
  });

  // 7. 记住新事实 (layer=1) / 沉淀程序性记忆 (layer=4)
  //
  // 2026-10-30 (五层记忆闭环): 存储层与治理工具早已支持 L4 程序性记忆 (fact-store 的
  //   layer 字段 + 0.005/天 慢衰减 + memory_clear_layer), 但生产写入路径一直只有 L1 ——
  //   文档里写的"技能/流程长期留存"实际上没有入口, memory_add 只能记闲聊事实。
  //   这里补上 layer 选项, 默认仍为 L1 (既有调用零变化)。
  //   安全口径: 仍走 facts.add 的唯一持久化入口 (脱敏 + 来源分级 + 去重), source 保持
  //   agent-self → provenance=model-inferred, 检索渲染会带来源标签, 不会被当成用户原话;
  //   L4 只是"衰减更慢的模型推断记忆", 不提升信任等级、不绕过治理/删除/回滚。
  catalog.register({
    name: "memory_add",
    capability: { readOnly: false, riskLevel: "medium", sideEffect: "workspace" },
    description: "把一条重要信息写进皮皮虾的长期记忆。layer=1 (默认) 记事实/偏好; layer=4 记可复用的技能/流程/方法论 (程序性记忆, 衰减更慢, 适合跨会话反复使用的操作步骤)。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "要记住的内容" },
        layer: { type: "number", enum: [1, 4], description: "1=事实/偏好 (默认), 4=程序性记忆 (技能/流程/方法论)" },
        scope: { type: "string", description: "记忆作用域: 缺省=全局; \"session\"=仅当前会话可见; 或自定义作用域名" },
      },
      required: ["content"],
    },
    execute: async (args) => {
      if (!facts) return JSON.stringify({ error: "记忆未初始化" });
      const layer = Number(args.layer) === 4 ? 4 : 1;
      const scope = resolveMemoryScope(args.scope);
      const content = String(args.content || "");
      // 2026-11-13 (评测 P2-2): 写入前做一次保守冲突检测。旧实现只去重**, 不检测矛盾** ——
      //   「会被拒绝」与「并非必然被拒」两条 importance=10 的 active 事实可以长期并存,
      //   检索时随机注入其中一条。命中冲突时:
      //   · 新事实来源 (agent-self=model-inferred) 权限 >= 旧事实 → 用 supersedeId 收口旧事实
      //   · 旧事实权限更高 (如用户原话) → 只打 conflictsWith 标记, 不自动推翻用户事实
      let conflict = null;
      try {
        const live = typeof facts.list === "function" ? facts.list() : [];
        for (const old of live.slice(0, 300)) {
          if (!old || old.content === content) continue;
          if ((old.scope ?? null) !== (scope ?? null)) continue;
          const d = detectContradiction(content, old.content);
          if (d.conflict && (!conflict || d.similarity > conflict.d.similarity)) conflict = { old, d };
        }
      } catch { /* 冲突检测失败不阻断正常写入 */ }
      const conflictInfo = conflict
        ? {
            id: conflict.old.id,
            similarity: conflict.d.similarity,
            shared: conflict.d.sharedIds,
            superseded: canSupersede("model-inferred", tierOfRecord(conflict.old)),
          }
        : null;
      if (conflictInfo && !conflictInfo.superseded) {
        warn(`[memory] 新旧记忆冲突但旧记录权限更高, 未自动取代: ${conflict.old.id} (相似度 ${conflict.d.similarity})`);
      }
      const f = facts.add(content, {
        source: "agent-self",
        layer,
        ...(scope ? { scope } : {}),
        ...(conflictInfo?.superseded ? { supersedeId: conflict.old.id } : {}),
        ...(conflictInfo ? { meta: { conflictsWith: [conflict.old.id], conflictSimilarity: conflict.d.similarity } } : {}),
      });
      if (!f) return JSON.stringify({ error: "内容为空或无效, 未写入" });
      // 去重命中已有记录时 add 只加分/不改层 (不重复落条)。此时如实回报实际层级,
      // 而不是把"请求了 L4"说成"已写成 L4" —— 两个后端 (JSON/SQLite) 的 update 签名不同,
      // 这里不做跨后端隐式升级, 用户/模型需要时可用 memory_clear_layer 或治理工具调整。
      const actual = Number(f.layer) === 4 ? 4 : 1;
      return JSON.stringify({
        ok: true,
        id: f.id,
        layer: actual,
        ...(scope ? { scope: f.scope } : {}),
        ...(layer === 4 && actual !== 4 ? { note: "已存在同内容记忆, 未重复写入 (保留原层级)" } : {}),
        ...(conflictInfo ? { conflict: conflictInfo, conflictNote: conflictInfo.superseded
          ? "已收口旧矛盾事实 (validTo), 旧记录仍保留在账本中可审计"
          : "检测到与更高权限记忆冲突, 未自动取代; 如需纠正请让用户确认" } : {}),
      });
    },
  });
}
