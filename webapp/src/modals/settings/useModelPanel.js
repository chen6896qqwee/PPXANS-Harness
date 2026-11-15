// webapp/src/modals/settings/useModelPanel.js - 设置 · 模型面板的交互动作
//
// 从 SettingsModal.vue 抽出来 (2026-11-13)。提供商列表本身归 stores/settings.js,
// 这里只放"点按钮之后发生什么": 测试连通性、删除、编辑器的预设联动与目录增删、
// 以及分层路由的保存。纯视图派生 (卡片/标签) 仍留在模板里。
import { computed, ref, watch } from "vue";
import { showToast } from "../../stores/toast.js";
import { settings, presetOf, removeProvider, testProvider, normalizeCatalogIn, loadModelPanel } from "../../stores/settings.js";

/**
 * @param {import("vue").Ref<object|null>} ed 二级编辑器状态 (settings.editor)
 * @param {import("vue").ComputedRef<Array>} provs 提供商列表
 */
export function useModelPanel(ed, provs) {
  const testResult = ref({});
  async function doTest(p) {
    testResult.value[p.id] = { text: "探测中…" };
    const r = await testProvider(p);
    testResult.value[p.id] = r;
    setTimeout(() => { delete testResult.value[p.id]; }, 6000);
  }
  async function doRemove(p) {
    await removeProvider(p);
  }

  function presetOfEd(id) { return presetOf(id); }
  function onPresetChange() {
    const e = ed.value;
    if (!e) return;
    const p = presetOf(e.presetId);
    if (!p) return;
    if (e.editingId == null) {
      e.id = p.id;
      e.displayName = p.label || "";
      e.baseP = p.base_url || "";
      e.catalog = normalizeCatalogIn(p.models);
    } else if (!e.catDirty) {
      e.catalog = normalizeCatalogIn(p.models);
    }
    if (!e.presetBaseTouched) e.baseP = p.base_url || "";
  }
  function onCatalogInput(m, field, ev) {
    const e = ed.value;
    if (!e) return;
    e.catDirty = true;
    if (field === "id") m.id = ev.target.value.trim();
    else if (field === "label") m.label = ev.target.value.trim();
    else if (field === "ctx") m.context_window = Number(ev.target.value) > 0 ? Number(ev.target.value) : null;
    else if (field === "out") m.max_output = Number(ev.target.value) > 0 ? Number(ev.target.value) : null;
    else if (field === "img") {
      const inputs = ["text"];
      if (ev.target.checked) inputs.push("image");
      m.inputs = inputs;
    }
  }
  function catAdd() {
    const e = ed.value;
    if (!e) return;
    e.catalog.push({ id: "", label: "", context_window: null, max_output: null, inputs: ["text"] });
    e.catDirty = true;
  }
  function catDel(i) {
    const e = ed.value;
    if (!e) return;
    e.catalog.splice(i, 1);
    e.catDirty = true;
  }
  function presetKeyHint() {
    const e = ed.value;
    if (!e) return "";
    const preset = presetOf(e.presetId);
    if (!preset) return "Key 写入本机 config/ppx.json (写盘前自动备份 .bak), 不会回传到前端";
    const hint = [];
    if (preset.api_key_env) hint.push("环境变量 " + preset.api_key_env);
    if (preset.cloud === false) hint.push("本地推理, Key 可留空");
    if (preset.key_url) hint.push("申请: " + preset.key_url);
    return hint.join(" · ") || "Key 写入本机 config/ppx.json";
  }

  const routing = computed(() => settings.routing);
  const routingOpen = computed(() => !!(routing.value && provs.value.length));
  const rtAux = ref("");
  const rtPref = ref("local");
  watch(routing, (r) => {
    if (r) { rtAux.value = r.aux || ""; rtPref.value = r.preference || "local"; }
  });
  async function saveRouting() {
    try {
      const { routingPutApi } = await import("../../api/endpoints.js");
      await routingPutApi({ aux: rtAux.value || undefined, preference: rtPref.value });
      showToast("路由已保存");
      loadModelPanel();
    } catch (e) {
      showToast("路由保存失败: " + ((e && e.message) || "未知错误"), true);
    }
  }

  return {
    testResult, doTest, doRemove, presetOfEd, onPresetChange, onCatalogInput,
    catAdd, catDel, presetKeyHint, routingOpen, rtAux, rtPref, saveRouting,
  };
}
