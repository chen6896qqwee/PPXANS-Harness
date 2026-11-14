// webapp/src/stores/settings.js - 「设置」弹窗数据: 提供商 / 预设 / 分层路由 / 本地发现
// 自旧 settings-ui.js 移植 (874 行 vanilla → store + 组件)。模型变更后广播到 chat store
// 刷新徽标 (旧实现走 ppx:models-changed DOM 事件, 现在直接函数调用)。
// 2026-11-13: 410 行按域拆到 stores/settings/{state,providers,editor,quick}.js,
//   本文件只做重新导出 —— 组件与 composable 的 import 路径不变。

export * from "./settings/state.js";
export * from "./settings/providers.js";
export * from "./settings/editor.js";
export * from "./settings/quick.js";
