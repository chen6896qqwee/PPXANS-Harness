// webapp/src/stores/dialog.js - 对话流基础配置 (WorkBuddy 式面板的数据层)
// 欢迎语 / 显示文件修改过程 / 队列发送方式 / 对话过程展示方式 / 完成提示音。
// 纯前端行为开关: localStorage 持久化 (与主题同待遇), 不进服务端档案 ——
// 这些只影响"界面怎么呈现这一轮", 换设备重置也无损。
import { reactive, watch } from "vue";

const KEY = "ppx_dialog_settings_v1";

const DEFAULTS = {
  welcome: { enabled: true, text: "" }, // text 为空 = 用默认欢迎语
  showFileChanges: true,   // 关 = diff 卡折叠成一行摘要
  sendMode: "queue",       // queue = 回合结束后按序发送; immediate = 打断当前回合立刻发
  processDisplay: "concise", // concise = 回合结束后思考/工具链收拢成一行; detailed = 全部平铺
  sound: true,             // 长回合结束(窗口在后台)时给一声提示音
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const j = JSON.parse(raw);
    const out = structuredClone(DEFAULTS);
    if (j && typeof j === "object") {
      if (j.welcome && typeof j.welcome === "object") {
        out.welcome.enabled = j.welcome.enabled !== false;
        out.welcome.text = String(j.welcome.text || "");
      }
      out.showFileChanges = j.showFileChanges !== false;
      out.sendMode = j.sendMode === "immediate" ? "immediate" : "queue";
      out.processDisplay = j.processDisplay === "detailed" ? "detailed" : "concise";
      out.sound = j.sound !== false;
    }
    return out;
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export const dialog = reactive(load());

export const DEFAULT_WELCOME = "你好，我在。选个项目或直接说要做的事 —— 我会自己决定读哪个文件、跑哪条命令。";

let saveTimer = null;
watch(dialog, () => {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { localStorage.setItem(KEY, JSON.stringify(dialog)); } catch { /* 隐私模式等写入失败忽略 */ }
  }, 150);
}, { deep: true });
