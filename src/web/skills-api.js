// src/web/skills-api.js - 技能管理 Web 接口 (2026-11-03)
//
// 只管"停用/启用"这一件事: 技能的增删改仍由 create_skill / refine_skill / 手动落盘完成,
// 这里不碰文件。停用清单落 config/ppx.json 的 skills.disabled, 与工具 disabled 同规:
//   - 停用 = 提示注入不出现 + load_skill 拒绝 (见 skills/loader.js 的 read 过滤);
//   - 元数据仍可列出, 管理页据此展示并恢复;
//   - 写盘后热重载 (agent.reloadSettings) —— 下一轮对话立即生效, 不用重启。
import { updateSettings } from "../config/settings.js";
import { readJson } from "./read-json.js";

function publicSkill(s, disabledSet, usage) {
  const u = usage[s.id] || { uses: 0, lastUsed: null };
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    domain: s.domain,
    tags: s.tags,
    source: s.source,
    version: s.version,
    enabled: !disabledSet.has(String(s.id).toLowerCase()),
    uses: Number(u.uses) || 0,
    lastUsed: u.lastUsed || null,
  };
}

function readAll(channel) {
  const loader = channel.agent?.skills;
  if (!loader || typeof loader.listAll !== "function") {
    const err = new Error("技能加载器未装配");
    err.status = 409;
    throw err;
  }
  const list = loader.listAll();
  const usage = typeof loader.usageAll === "function" ? loader.usageAll() : {};
  const disabled = [...(loader.disabled || [])];
  const disabledSet = new Set(disabled.map((x) => String(x).toLowerCase()));
  return { skills: list.map((s) => publicSkill(s, disabledSet, usage)), disabled };
}

function summary(skills, disabled) {
  return {
    ok: true,
    skills,
    disabled,
    total: skills.length,
    enabled: skills.filter((s) => s.enabled).length,
  };
}

function fail(channel, res, e) {
  channel._json(res, Number(e?.status) || 400, { ok: false, error: String(e?.message || e) });
}

export async function handleSkillsApi(channel, req, res, reqPath) {
  const get = req.method === "GET";

  if (get && reqPath === "/api/skills") {
    try {
      const { skills, disabled } = readAll(channel);
      channel._json(res, 200, summary(skills, disabled), { "Cache-Control": "no-store" });
    } catch (e) { fail(channel, res, e); }
    return true;
  }

  if (req.method === "POST" && reqPath === "/api/skills/disable") {
    const body = await readJson(channel, req, res);
    if (body === null) return true;
    try {
      const id = String(body.id || "").trim();
      if (!id) throw new Error("需要 id");
      const enabled = body.enabled === true; // 缺省 = 停用
      const loader = channel.agent?.skills;
      const known = loader && typeof loader.listAll === "function"
        && loader.listAll().some((s) => String(s.id).toLowerCase() === id.toLowerCase());
      if (!known) {
        const err = new Error(`技能不存在: ${id}`);
        err.status = 404;
        throw err;
      }
      const current = Array.isArray(channel.agent?.config?.skills?.disabled)
        ? channel.agent.config.skills.disabled
        : [];
      const next = current.map(String).filter((x) => x.toLowerCase() !== id.toLowerCase());
      if (!enabled) next.push(id);
      updateSettings(channel.agent.root, { skills: { disabled: next } });
      channel.agent.reloadSettings();
      const all = readAll(channel);
      channel._json(res, 200, {
        ...summary(all.skills, all.disabled),
        message: enabled ? `已启用技能: ${id}` : `已停用技能: ${id}`,
      });
    } catch (e) { fail(channel, res, e); }
    return true;
  }

  return false;
}
