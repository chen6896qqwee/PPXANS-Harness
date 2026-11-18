// src/evolve/finetune-bridge.js - 权重级学习回路桥 (2026-11-15)
//
// 边界声明 (诚实优先): 零依赖 Node 仓库**无法训练权重** —— 训练永远发生在架构外
//   (Ollama/LM Studio 微调、外部 LoRA 流水线)。本桥的职责是把回路"桥"起来, 让架构图上
//   "模型层认知: 无权重级学习回路"这条边界变成一条**有接口的边界**:
//
//   已验证知识 ──exportDataset──▶ 训练语料 (chat JSONL + Modelfile 模板 + manifest)
//        │                              │
//        │                    (架构外: 微调/训练)
//        │                              ▼
//        └── cohort 对照 ◀── registerModelVersion (新模型版本账本, 经既有 llm/ 适配层回灌)
//
// 准入纪律与蒸馏完全一致: "经验不是自动可信的知识", 同样适用于训练数据 ——
//   lesson: 未退休 + 无冲突 + 带适用条件 (可证伪假设) 才进语料;
//   episode: 有根因 + 有修复 (+置信度达阈) 才进语料;
//   skill: 本就过 verifySkill 闸门才落盘, 这里只补"未停用"过滤。
// 产物: data/finetune/dataset-<ts>.jsonl (chat 格式, 兼容主流微调流水线)
//       data/finetune/Modelfile.template (Ollama 形态)
//       data/finetune/manifest.json (计数/准入规则/语料指纹)
//       data/finetune/model-versions.json (版本账本, 供回灌后的对照评测)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, withFileLock, readJson, writeJson, atomicWrite } from "../utils/store.js";
import { noteCatch } from "../utils/catch-log.js";
import { info } from "../utils/logger.js";

const DEFAULT_MAX_SAMPLES = 2000;
const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_SYSTEM_PROMPT = "你是皮皮虾, 一个谨慎的执行型智能体。回答要包含: 结论、适用条件或前提、验证方式。不确定时明确说不确定, 不编造。";

function sha256(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

// ---- 纯函数: 三源样本构建 (确定性, 可独立测试) ----
// @param {Array} episodes  [{id, tool, error, category, rootCause, fix, confidence}]
// @param {Array} lessons   [{id, task, lesson, applicability, tags, retiredAt, conflicts, challengedBy}]
// @param {Array} skills    [{id, name, description, content}]
// 每行携带 meta {sourceId, exportedAt, applicabilityHash?} (2026-11-15): 语料一旦导出就
//   在外部模型里留下影响, 仓库内的退休/停用不会自动使它失效 —— meta 让"哪条语料来自
//   哪个知识条目"可追溯, 配合 revocations.jsonl 撤回清单, 退休机制才能贯通到权重级。
export function buildDataset({
  episodes = [], lessons = [], skills = [],
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  maxSamples = DEFAULT_MAX_SAMPLES,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  exportedAt = new Date().toISOString(),
} = {}) {
  const sources = { episode: [], skill: [], lesson: [] };
  const rejected = { episode: 0, skill: 0, lesson: 0 };

  // 来源 1: 故障病历 → "失败→根因→修复" (最硬的样本: 有可验证的因果对)
  for (const ep of Array.isArray(episodes) ? episodes : []) {
    const ok = ep && ep.rootCause && ep.fix
      && (ep.confidence == null || Number(ep.confidence) >= minConfidence);
    if (!ok) { rejected.episode += 1; continue; }
    sources.episode.push({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `工具 ${ep.tool || "?"} 执行失败 (类别 ${ep.category || "unknown"}): ${String(ep.error || "").slice(0, 160)}` },
        { role: "assistant", content: `根因: ${ep.rootCause}\n修复: ${ep.fix}` },
      ],
      meta: { source: "episode", sourceId: ep.id ? String(ep.id) : null, exportedAt },
    });
  }

  // 来源 2: 技能 → "任务→工作流" (SKILL.md 本就过 verifySkill 闸门; 停用技能由调用方剔除)
  for (const s of Array.isArray(skills) ? skills : []) {
    const content = String(s?.content || "").trim();
    if (!s?.id || !content) { rejected.skill += 1; continue; }
    sources.skill.push({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `如何完成: ${String(s.description || s.name || s.id).slice(0, 200)}` },
        { role: "assistant", content: content.slice(0, 2000) },
      ],
      meta: { source: "skill", sourceId: String(s.id), exportedAt },
    });
  }

  // 来源 3: 已验证教训 → "场景+适用条件→结论" (准入: 未退休/无冲突/带适用条件)
  //   applicability 是可证伪假设的前提半边 —— 没有它, 教训只是无边界泛化, 不配进语料。
  for (const l of Array.isArray(lessons) ? lessons : []) {
    const conflicted = (Array.isArray(l?.conflicts) && l.conflicts.length)
      || (Array.isArray(l?.challengedBy) && l.challengedBy.length);
    const ok = l && !l.retiredAt && l.applicability && !conflicted && String(l.lesson || "").length >= 5;
    if (!ok) { rejected.lesson += 1; continue; }
    sources.lesson.push({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `任务场景: ${String(l.task || "通用").slice(0, 150)} | 适用条件: ${String(l.applicability).slice(0, 150)}` },
        { role: "assistant", content: String(l.lesson).slice(0, 400) },
      ],
      meta: { source: "lesson", sourceId: String(l.id), exportedAt, applicabilityHash: sha256(l.applicability).slice(0, 12) },
    });
  }

  // 三源轮转交错 (防单一来源淹没), 内容去重, 容量截断
  const out = [];
  const seen = new Set();
  const maxLen = Math.max(sources.episode.length, sources.skill.length, sources.lesson.length);
  for (let i = 0; out.length < maxSamples && i < maxLen; i++) {
    for (const key of ["episode", "skill", "lesson"]) {
      if (out.length >= maxSamples) break;
      const s = sources[key][i];
      if (!s) continue;
      const fp = sha256(s.messages.map((m) => m.content).join("\u0000"));
      if (seen.has(fp)) continue;
      seen.add(fp);
      out.push(s);
    }
  }
  return {
    samples: out,
    manifest: {
      ts: new Date().toISOString(),
      counts: { total: out.length, episode: Math.min(sources.episode.length, out.length), skill: sources.skill.length, lesson: sources.lesson.length },
      rejected,
      admission: { minConfidence, maxSamples, rules: ["episode: rootCause+fix(+confidence阈值)", "skill: verifySkill 已过闸, 未停用", "lesson: 未退休+无冲突+带 applicability"] },
      fingerprint: sha256(out.map((s) => JSON.stringify(s.messages)).join("\n")),
      systemPrompt,
    },
  };
}

// ---- 装配形态: 从 agent 注入的存储收集 → 导出 → 版本账本 ----
export class FinetuneBridge {
  // @param {object} deps {dataDir, experience?, skills?, failures?, audit?}  全部可选
  //   audit (AuditLog, 2026-11-15): 导出/注册/撤回都往审计链留锚点事件 —— 权重级学习
  //   这条链上的事实必须能在 SHA-256 链上被证明发生过, 不能只在 data/finetune 各自落盘。
  constructor({ dataDir, experience = null, skills = null, failures = null, audit = null } = {}) {
    this.dir = path.join(dataDir, "finetune");
    ensureDir(this.dir);
    this.experience = experience;
    this.skills = skills;
    this.failures = failures;
    this.audit = audit;
    this.revocationsFile = path.join(this.dir, "revocations.jsonl");
  }

  _anchor(event, fields = {}) {
    try {
      if (this.audit && typeof this.audit.appendEvent === "function") {
        this.audit.appendEvent({ event, fields });
      }
    } catch (e) { noteCatch("src/evolve/finetune-bridge.js#_anchor", e); /* 审计锚点失败不阻断主流程 */ }
  }

  _collectSkills() {
    if (!this.skills || typeof this.skills.listAll !== "function") return [];
    return (this.skills.listAll() || [])
      .filter((m) => !(this.skills.isDisabled?.(m.id)))
      .map((m) => ({ id: m.id, name: m.name, description: m.description, content: this.skills.read ? this.skills.read(m.id) : null }))
      .filter((s) => s.content);
  }

  // 导出训练语料: 返回 manifest (含落盘路径 + 撤回清单指针)
  exportDataset({ maxSamples = DEFAULT_MAX_SAMPLES, minConfidence = DEFAULT_MIN_CONFIDENCE } = {}) {
    const lessons = this.experience?.list?.({ includeRetired: true }) || [];
    const episodes = this.failures?.list?.(500) || [];
    const exportedAt = new Date().toISOString();
    const { samples, manifest } = buildDataset({
      episodes, lessons, skills: this._collectSkills(), minConfidence, maxSamples, exportedAt,
    });
    const ts = exportedAt.replace(/[:.]/g, "-");
    const datasetFile = path.join(this.dir, `dataset-${ts}.jsonl`);
    atomicWrite(datasetFile, samples.map((s) => JSON.stringify(s)).join("\n") + (samples.length ? "\n" : ""));
    // 撤回清单指针 (2026-11-15): 退休/停用发生在导出之后 → 外部训练端**下次训练前必须**
    //   按本清单剔除已撤回样本。这不是自动回收 (外部模型改不了), 是让撤回可追溯。
    const revocations = this.listRevocations();
    const full = {
      ...manifest,
      files: { dataset: datasetFile, revocations: this.revocationsFile },
      revocationCount: revocations.length,
    };
    atomicWrite(path.join(this.dir, "manifest.json"), JSON.stringify(full, null, 2));
    // Modelfile 模板 (Ollama 形态): FROM 留占位 —— 基座模型由使用者选择
    atomicWrite(path.join(this.dir, "Modelfile.template"), [
      "# Ollama Modelfile 模板 (由 finetune-bridge 生成, 2026-11-15)",
      "# 用法: 把微调产物 (GGUF/适配器) 放同目录, FROM 指向基座或合并后模型, 然后:",
      "#   ollama create ppx-finetuned -f Modelfile.template",
      `FROM <base-model-or-merged-gguf>`,
      ``,
      `SYSTEM """${manifest.systemPrompt}"""`,
      ``,
      `# 训练语料指纹 (sha256): ${manifest.fingerprint}`,
      `# 语料计数: ${JSON.stringify(manifest.counts)}`,
      ``,
      `# 回灌后: 在 config.model_routing 里指向新模型, 并调用`,
      `#   finetuneBridge.registerModelVersion({version, model, datasetRef}) 落版本账本;`,
      `#   后续对照评测走既有 effect cohort 机制 (src/evolve/effect.js)。`,
      ``,
    ].join("\n"));
    info(`[finetune-bridge] 语料导出: ${manifest.counts.total} 样本 → ${datasetFile}`);
    this._anchor("FINETUNE_DATASET_EXPORTED", { samples: manifest.counts.total, dataset: path.basename(datasetFile), fingerprint: manifest.fingerprint, revocationCount: revocations.length });
    return { ...full, samplesWritten: samples.length };
  }

  // ---- 撤回清单 (2026-11-15): knowledge-governance 的退休/停用贯通到权重级这条链 ----
  // append-only JSONL; 外部训练端下次训练前按 sourceId 剔除。返回值供调用方确认。
  _revoke(kind, id, reason = "") {
    if (!id) return { ok: false, reason: "id 必填" };
    const entry = { ts: new Date().toISOString(), kind, id: String(id), reason: String(reason || "").slice(0, 200) };
    return withFileLock(this.revocationsFile, () => {
      fs.appendFileSync(this.revocationsFile, JSON.stringify(entry) + "\n", "utf8");
      return { ok: true, entry };
    });
  }

  revokeLesson(id, reason = "") {
    const r = this._revoke("lesson", id, reason);
    if (r.ok) info(`[finetune-bridge] 语料撤回: lesson ${id}`);
    this._anchor("FINETUNE_SAMPLE_REVOKED", { kind: "lesson", id, reason });
    return r;
  }

  revokeSkill(id, reason = "") {
    const r = this._revoke("skill", id, reason);
    if (r.ok) info(`[finetune-bridge] 语料撤回: skill ${id}`);
    this._anchor("FINETUNE_SAMPLE_REVOKED", { kind: "skill", id, reason });
    return r;
  }

  listRevocations() {
    try {
      return fs.readFileSync(this.revocationsFile, "utf8").split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  // 模型版本账本: 外部训练产物回灌时登记 (供对照评测按版本分桶)
  registerModelVersion({ version, model, datasetRef = null, notes = "" } = {}) {
    if (!version || !model) return { ok: false, reason: "version 与 model 必填" };
    const file = path.join(this.dir, "model-versions.json");
    const result = withFileLock(file, () => {
      const list = readJson(file, []);
      for (const v of Array.isArray(list) ? list : []) v.latest = false;
      const entry = {
        ts: new Date().toISOString(),
        version: String(version).slice(0, 60),
        model: String(model).slice(0, 120),
        datasetRef: datasetRef ? String(datasetRef).slice(0, 200) : null,
        notes: String(notes).slice(0, 300),
        latest: true,
      };
      list.push(entry);
      writeJson(file, list.slice(-100));
      return { ok: true, entry };
    });
    if (result?.ok) info(`[finetune-bridge] 模型版本已登记: ${result.entry.version} (${result.entry.model})`);
    this._anchor("MODEL_VERSION_REGISTERED", { version, model, datasetRef });
    return result;
  }

  listModelVersions() {
    return readJson(path.join(this.dir, "model-versions.json"), []);
  }
}
