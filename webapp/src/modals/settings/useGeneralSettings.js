// webapp/src/modals/settings/useGeneralSettings.js - 设置 · 通用面板
//
// 从 SettingsModal.vue 抽出来 (2026-11-13)。这一块只和"非模型"的设置有关:
//   审批模式 / 沙箱 / 外观 / 工具轮次上限 / 云端 ASR / 永久允许清单。
// 进入面板时拉一次现状 (bootstrap + settings + approval_rules), 保存各自独立,
// 失败原样冒泡成 toast —— 不做乐观更新, 避免"界面已改但服务端没变"的错觉。
import { ref } from "vue";
import { showToast } from "../../stores/toast.js";
import { chat, setApprovalMode, setSandboxMode } from "../../stores/chat.js";
import { theme, setTheme } from "../../stores/theme.js";
import { settingsPutApi } from "../../api/endpoints.js";

function providerLabelShort(p) {
  const name = p.display_name || p.id || "";
  const first = Array.isArray(p.models) && p.models.length ? p.models[0] : null;
  const m = (first && (first.label || first.id)) || p.model || "";
  return name && m && m !== name ? name + " · " + m : (m || name || "未指定模型");
}

export function useGeneralSettings() {
  /* 通用设置表单 */
  const approval = ref(chat.perm);
  const sandbox = ref(chat.sandbox);
  const themePref = ref(theme.pref);
  const toolRounds = ref("");
  const asrUrl = ref("");
  const asrKey = ref("");
  const asrKeyPh = ref("sk-... (留空 = 保留已存密钥)");
  const asrModel = ref("");
  const asrState = ref("");
  const setInfo = ref("");
  const apprRules = ref([]);
  const savingAsr = ref(false);
  const savingRounds = ref(false);

  async function loadGeneral() {
    approval.value = chat.perm;
    sandbox.value = chat.sandbox;
    themePref.value = theme.pref;
    // 已永久允许的命令
    try {
      const { approvalRulesApi } = await import("../../api/endpoints.js");
      const j = await approvalRulesApi();
      apprRules.value = (j && j.rules) || [];
    } catch {
      apprRules.value = null;
    }
    try {
      const { bootstrapApi, settingsApi } = await import("../../api/endpoints.js");
      const b = await bootstrapApi();
      let info = "";
      if (b) info = "版本 " + (b.version || "-") + " · 模型 " + (chat.providers[0] ? providerLabelShort(chat.providers[0]) : (b.agent || "-")) + " · 工作区 " + (b.port ? (b.host || "127.0.0.1") + ":" + b.port : "-");
      const j = await settingsApi();
      const s2 = (j && j.settings) || {};
      const ag = s2.agent || {};
      const pc = ag.proactive;
      const bits = [];
      if (ag.name) bits.push("Agent " + ag.name);
      if (ag.mode) bits.push("模式 " + ag.mode);
      if (pc && pc.enabled != null) bits.push("主动提醒 " + (pc.enabled ? "开" : "关"));
      if (s2.user && s2.user.name) bits.push("用户 " + s2.user.name);
      if (bits.length) info += " · " + bits.join(" · ");
      setInfo.value = info || "引导信息不可用";
      toolRounds.value = String(ag.max_tool_rounds || 24);
      const asr = (s2.voice && s2.voice.asr) || {};
      asrUrl.value = asr.base_url || "";
      asrKey.value = "";
      asrKeyPh.value = asr.api_key_set ? "已配置 (输入新值可覆盖, 留空保留)" : "sk-... (留空 = 保留已存密钥)";
      asrModel.value = (asr.model && asr.model !== "whisper-1") ? asr.model : "";
      asrState.value = asr.api_key_set && asr.base_url
        ? "● 云端 ASR 已配置 (" + (asr.model || "whisper-1") + ")"
        : "○ 未配置 — 未配置时语音输入回退浏览器识别";
    } catch { /* 设置读取失败不影响主流程 */ }
  }

  async function saveAsr() {
    const asr = {};
    if (asrUrl.value.trim()) asr.base_url = asrUrl.value.trim();
    if (asrKey.value.trim()) asr.api_key = asrKey.value.trim();
    if (asrModel.value.trim()) asr.model = asrModel.value.trim();
    savingAsr.value = true;
    try {
      const j = await settingsPutApi({ patch: { asr } });
      const a = (j && j.settings && j.settings.voice && j.settings.voice.asr) || {};
      asrState.value = a.api_key_set && a.base_url
        ? "● 云端 ASR 已配置 (" + (a.model || "whisper-1") + ")"
        : "○ 未配置 — 语音输入将回退浏览器识别";
      showToast(a.api_key_set && a.base_url ? "语音配置已保存并生效" : "语音配置已清除", !(a.api_key_set && a.base_url));
      asrKey.value = "";
      asrKeyPh.value = a.api_key_set ? "已配置 (输入新值可覆盖, 留空保留)" : "sk-...";
    } catch (e) {
      showToast("语音配置保存失败: " + ((e && e.message) || "未知错误"), true);
    } finally {
      savingAsr.value = false;
    }
  }

  async function saveRounds() {
    const rounds = parseInt(String(toolRounds.value), 10);
    if (!Number.isFinite(rounds) || rounds < 1 || rounds > 64) {
      showToast("工具轮次上限必须是 1-64 的整数", true);
      return;
    }
    savingRounds.value = true;
    try {
      await settingsPutApi({ patch: { agent: { max_tool_rounds: rounds } } });
      showToast("已保存 — 下一轮对话生效 (当前 " + rounds + " 轮)");
    } catch (e) {
      showToast("工具循环设置保存失败: " + ((e && e.message) || "未知错误"), true);
    } finally {
      savingRounds.value = false;
    }
  }

  async function forgetRule(key) {
    try {
      const { approvalForgetApi } = await import("../../api/endpoints.js");
      await approvalForgetApi(key);
      showToast("已撤销永久允许");
      loadGeneral();
    } catch (e) {
      showToast((e && e.message) || "撤销失败", true);
    }
  }

  function onApprovalChange() { setApprovalMode(approval.value); }
  function onSandboxChange() { setSandboxMode(sandbox.value); }
  function onThemeChange() { setTheme(themePref.value); }

  return {
    approval, sandbox, themePref, toolRounds, asrUrl, asrKey, asrKeyPh, asrModel,
    asrState, setInfo, apprRules, savingAsr, savingRounds,
    loadGeneral, saveAsr, saveRounds, forgetRule,
    onApprovalChange, onSandboxChange, onThemeChange,
  };
}
