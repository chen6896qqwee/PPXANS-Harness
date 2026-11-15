// webapp/src/main.js - 应用入口
// 装配顺序: 先装配 Markdown 栈 (暴露 window.PPXMarkdown 冒烟契约), 再挂 Vue 应用。

import { createApp } from "vue";
import "./markdown/index.js";       // 副作用导入: window.PPXMarkdown + 渲染库全局
import "./styles/tokens.css";
import "./styles/base.css";
import App from "./App.vue";
import { initChat } from "./stores/chat.js";
import { initChatRail } from "./boot-app.js";

createApp(App).mount("#app");

initChat();
initChatRail();
