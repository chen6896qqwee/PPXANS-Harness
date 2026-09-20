// src/tools/governance.js - 记忆治理 + 审计 + 运维工具集 (吸收自 ppx-v2)
// 来源: ppx-v2 v0.4.0 bundles/ppx-tools/index.js 的 5 个治理工具 (memory_forget/restore/export/import/clear_layer)
//        + audit_verify, 以及 ppx-memory/ppx-selfheal 暴露的 persona_build/persona_read/selfheal_run。
// 改写: ppx-v2 原版用 cordis 的 defineTool + @deepseek-ai/schemastery (z.object) 声明,
//       这里改写为 ppx-agent 原生的 ToolCatalog.register 风格, 剥离全部外部依赖。
//
// 2026-09-18 重构: 原先是一个 250 行的单一注册函数 (10 个工具挤在一起)。
//   现按文件头注自身的分组拆成三个具名函数, 找某个工具时可直接跳到对应组;
//   对外的 registerGovernanceTools 签名与返回值完全不变。
import fs from "node:fs";
import path from "node:path";
import { safePath } from "./builtin.js";
import { ensureDir, nowISO } from "../utils/store.js";

// 记忆治理 + 审计 + 运维工具注册
// deps: { rootDir, facts, audit, personaStore, healer, experience, dataDir }
export function registerGovernanceTools(catalog, deps = {}) {
  registerMemoryGovernanceTools(catalog, deps);
  registerAuditTools(catalog, deps);
  registerOpsTools(catalog, deps);
  return catalog;
}

// ---- 组 1: 记忆治理 (forget / restore / list_deleted / export / import / clear_layer) ----
// 设计原则: 默认软删可回滚, 物理删除必须显式 hard=true —— 治理动作不可逆是最大的风险面。
function registerMemoryGovernanceTools(catalog, { rootDir, facts, dataDir } = {}) {
  const exportsDir = path.join(rootDir || dataDir || ".", "exports");
  // 记忆服务未装配时的统一降级响应 (6 个 memory_* 工具共用, 改文案只动这一处)
  const noFacts = () => JSON.stringify({ error: "记忆未初始化" });

  // 1. 遗忘 (软删, 可回滚) —— ppx-agent 原版只有不可逆硬删, 这是最大的治理缺口
  catalog.register({
    name: "memory_forget",
    description: "遗忘一条记忆 (软删, 数据保留可用 memory_restore 回滚)。传 id 或内容关键字定位。",
    parameters: {
      type: "object",
      properties: {
        id_or_content: { type: "string", description: "记忆 id 或内容 (按内容精确匹配, 去记忆动词前缀后比对)" },
        reason: { type: "string", description: "遗忘原因 (记入审计, 便于后续复核)" },
      },
      required: ["id_or_content"],
    },
    category: "memory",
    power: "user",
    idempotent: true,
    execute: async (args) => {
      if (!facts) return noFacts();
      const f = facts.forget(args.id_or_content, { reason: args.reason || null });
      if (!f) return JSON.stringify({ error: "未找到匹配记忆", target: args.id_or_content });
      return JSON.stringify({ ok: true, id: f.id, content: f.content, status: f.status, note: "已软删, 可用 memory_restore 回滚" });
    },
  });

  // 2. 回滚遗忘
  catalog.register({
    name: "memory_restore",
    description: "恢复一条被遗忘 (软删) 的记忆。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "记忆 id" } },
      required: ["id"],
    },
    category: "memory",
    power: "user",
    idempotent: true,
    execute: async (args) => {
      if (!facts) return noFacts();
      const f = facts.restore(args.id);
      if (!f) return JSON.stringify({ error: "未找到该记忆", id: args.id });
      return JSON.stringify({ ok: true, id: f.id, content: f.content, status: f.status });
    },
  });

  // 3. 查看已遗忘的记忆 (复核入口)
  catalog.register({
    name: "memory_list_deleted",
    description: "列出已遗忘 (软删) 的记忆, 供人工/审计复核, 避免误删无法发现。",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "最多返回条数, 默认 20" } },
      required: [],
    },
    category: "memory",
    power: "user",
    idempotent: true,
    execute: async (args) => {
      if (!facts) return noFacts();
      const list = facts.deletedList().slice(0, args.limit || 20);
      if (!list.length) return "(无已遗忘的记忆)";
      return list.map((f) => `- ${f.id} | ${f.deletedAt || "?"} | ${f.deleteReason || "无原因"} | ${f.content}`).join("\n");
    },
  });

  // 4. 导出记忆 (备份/迁移)
  catalog.register({
    name: "memory_export",
    description: "导出全量记忆到 JSON 文件 (含软删/归档条目), 用于备份与跨机迁移。",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "相对工作区的输出路径, 省略则写到 exports/memory-<时间戳>.json" },
        include_deleted: { type: "boolean", description: "是否包含已软删/归档条目, 默认 true" },
      },
      required: [],
    },
    category: "memory",
    power: "user",
    idempotent: true,
    execute: async (args) => {
      if (!facts) return noFacts();
      const dump = facts.exportAll({ includeDeleted: args.include_deleted !== false });
      let out;
      if (args.file) {
        out = safePath(rootDir || ".", args.file);
      } else {
        ensureDir(exportsDir);
        out = path.join(exportsDir, `memory-${Date.now()}.json`);
      }
      ensureDir(path.dirname(out));
      fs.writeFileSync(out, JSON.stringify(dump, null, 2), "utf8");
      return JSON.stringify({ ok: true, file: out, count: dump.count, exportedAt: dump.exportedAt });
    },
  });

  // 5. 导入记忆 (merge 去重 / replace 整体替换)
  catalog.register({
    name: "memory_import",
    description: "从 JSON 文件导入记忆。mode=merge 按内容去重跳过重复 (默认), mode=replace 整体替换。",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "相对工作区的 JSON 文件路径 (memory_export 的产物)" },
        mode: { type: "string", description: "merge (默认) 或 replace" },
      },
      required: ["file"],
    },
    category: "memory",
    power: "user",
    idempotent: false,
    execute: async (args) => {
      if (!facts) return noFacts();
      const fp = safePath(rootDir || ".", args.file);
      if (!fs.existsSync(fp)) return JSON.stringify({ error: "文件不存在", file: args.file });
      let payload;
      try { payload = JSON.parse(fs.readFileSync(fp, "utf8")); } catch (e) { return JSON.stringify({ error: "JSON 解析失败: " + e.message }); }
      const r = facts.importAll(payload, { mode: args.mode === "replace" ? "replace" : "merge" });
      return JSON.stringify(r);
    },
  });

  // 6. 按层清空 (L1 事实 / L4 程序性记忆)
  catalog.register({
    name: "memory_clear_layer",
    description: "按记忆层级批量清空。layer=1 是事实/用户记忆, layer=4 是程序性记忆(技能/流程)。默认软删可回滚, hard=true 才物理删除。",
    parameters: {
      type: "object",
      properties: {
        layer: { type: "number", description: "记忆层级: 1 (事实) 或 4 (程序性)" },
        hard: { type: "boolean", description: "true 则物理删除不可回滚, 默认 false (软删)" },
      },
      required: ["layer"],
    },
    category: "memory",
    power: "user",
    idempotent: false,
    execute: async (args) => {
      if (!facts) return noFacts();
      const r = facts.clearLayer(Number(args.layer), { hard: args.hard === true });
      return JSON.stringify({ ok: true, ...r, note: r.hard ? "已物理删除" : "已软删, 可用 memory_restore 逐条回滚" });
    },
  });
}

// ---- 组 2: 审计链校验 (吸收自 ppx-v2 audit.js: SHA-256 哈希链防篡改验证) ----
function registerAuditTools(catalog, { audit } = {}) {
  catalog.register({
    name: "audit_verify",
    description: "校验工具调用审计日志的 SHA-256 哈希链完整性, 定位首个被篡改/截断的位置。quarantine=true 时隔离损坏段并重建空链。",
    parameters: {
      type: "object",
      properties: {
        quarantine: { type: "boolean", description: "校验失败时是否自动隔离损坏日志并重建, 默认 false" },
        tail: { type: "number", description: "附带返回最近 n 条审计记录, 默认 0 (不返回)" },
      },
      required: [],
    },
    category: "system",
    power: "user",
    idempotent: true,
    execute: async (args) => {
      if (!audit) return JSON.stringify({ error: "审计未启用 (config.audit.enabled = false)" });
      let v = audit.verify();
      let quarantined = false;
      let backup = null;
      if (!v.ok && args.quarantine) {
        const { quarantineBroken } = await import("../audit/audit-chain.js");
        const q = quarantineBroken(audit.dataDir);
        quarantined = !!q.quarantined;
        backup = q.backup || null;
        v = audit.verify();
      }
      const out = { ok: v.ok, total: v.total, brokenAt: v.brokenAt, detail: v.detail, quarantined, backup };
      if (args.tail) out.recent = audit.tail(Number(args.tail) || 10);
      return JSON.stringify(out);
    },
  });
}

// ---- 组 3: 运维 (画像重建/读取 + 自愈体检) ----
function registerOpsTools(catalog, { personaStore, healer, experience, facts } = {}) {
  // 7. 画像重建 (ppx-v2 ppx-memory 的 persona_build, 这里薄包装 l3 PersonaStore)
  catalog.register({
    name: "persona_build",
    description: "从当前记忆与经验重新提炼用户画像 / agent 人格, 写入 L3 层。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "user (默认) 或 agent" },
        force: { type: "boolean", description: "true 则忽略频率限制强制重建" },
      },
      required: [],
    },
    category: "memory",
    power: "user",
    idempotent: false,
    execute: async (args) => {
      if (!personaStore) return JSON.stringify({ error: "画像存储未初始化" });
      const target = args.target === "agent" ? "agent" : "user";
      if (target === "agent") {
        const lessons = experience ? (experience.list?.() || []) : [];
        const r = personaStore.buildAgentPersona(lessons, { force: args.force === true });
        return JSON.stringify({ ok: true, target, ...(typeof r === "object" ? r : { built: true }) });
      }
      const factsList = facts ? facts.list() : [];
      const r = personaStore.buildUserPersona(factsList, { force: args.force === true });
      return JSON.stringify({ ok: true, target, ...(typeof r === "object" ? r : { built: true }) });
    },
  });

  // 8. 画像读取
  catalog.register({
    name: "persona_read",
    description: "读取 L3 层沉淀的用户画像 / agent 人格全文。",
    parameters: {
      type: "object",
      properties: { target: { type: "string", description: "user (默认) 或 agent" } },
      required: [],
    },
    category: "memory",
    power: "user",
    idempotent: true,
    execute: async (args) => {
      if (!personaStore) return JSON.stringify({ error: "画像存储未初始化" });
      const target = args.target === "agent" ? "agent" : "user";
      const text = target === "agent" ? personaStore.agentPersona() : personaStore.userPersona();
      return text || "(画像尚未生成, 可用 persona_build 提炼)";
    },
  });

  // 9. 自愈体检 (ppx-v2 selfheal_run, 薄包装 Healer)
  catalog.register({
    name: "selfheal_run",
    description: "手动跑一次自愈体检: 补建缺失目录、修复损坏 JSON、清理崩溃残留与过期备份。",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    category: "system",
    power: "user",
    idempotent: true,
    execute: async () => {
      if (!healer) return JSON.stringify({ error: "自愈引擎未初始化" });
      const health = healer.heal();
      return JSON.stringify({ ok: true, healedAt: nowISO(), health });
    },
  });
}
