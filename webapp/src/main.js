// webapp/src/main.js - 应用入口
// 装配顺序: 先装配 Markdown 栈 (暴露 window.PPXMarkdown 冒烟契约), 再挂 Vue 应用。

import { createApp } from "vue";
import "./markdown/index.js";       // 副作用导入: window.PPXMarkdown + 渲染库全局
import "./styles/tokens.css";
import "./styles/base.css";
import App from "./App.vue";
import { initChat, chat } from "./stores/chat.js";
import { initChatRail } from "./boot-app.js";
import { dialog } from "./stores/dialog.js";
import { ui } from "./stores/ui.js";

createApp(App).mount("#app");

initChat();
initChatRail();

// 冒烟/截图契约 (window.PPXMarkdown 同款): 暴露三个只读引用给 Electron 端
// executeJavaScript 驱动 —— 桌面冒烟与 UI 截图回合用它注入合成时间线/切视图。
// 本地单机应用, 无提权面; 不暴露任何可写服务端状态。
window.__ppx = { chat, dialog, ui };

