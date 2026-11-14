// webapp/src/chat/composer/usePermissionScope.js - 权限座椅: 档位 + 实际可访问范围
//
// 从 Composer.vue 抽出来 (2026-11-13)。档位名 (workspace-write) 是抽象词, 用户看不出
// 边界在哪, 于是出现"选了完全权限却仍然写不了桌面"的困惑 —— 这里把范围直接写成一句话,
// 悬停再给完整目录清单与加目录的配置路径。
import { computed } from "vue";
import { chat, curPermLevel } from "../../stores/chat.js";

export function usePermissionScope() {
  const curPerm = computed(() => curPermLevel());

  const scopeText = computed(() => {
    if (chat.sandbox === "danger-full-access") return "可访问：整台机器（不限路径）";
    const rootName = chat.wsRoot ? String(chat.wsRoot).replace(/\\/g, "/").split("/").filter(Boolean).pop() : "工作区";
    if (chat.wsAllow && chat.wsAllow.length) return "可访问：" + rootName + " + " + chat.wsAllow.length + " 个额外目录";
    return "可访问：" + rootName + "（仅此目录）";
  });
  const scopeTitle = computed(() => {
    if (chat.sandbox === "danger-full-access") return "整机不限路径。想收窄：设置 → 权限，或改 config/ppx.json 的 agent.sandbox";
    const list = [chat.wsRoot || "(工作区)", ...(chat.wsAllow || [])].filter(Boolean);
    return list.join("\n") + "\n\n想加目录：config/ppx.json → agent.workspace_allow: [\"D:\\\\某目录\"]";
  });

  function openPerm() {
    chat.seatOpen = false;
    chat.permOpen = !chat.permOpen;
  }

  return { curPerm, scopeText, scopeTitle, openPerm };
}
