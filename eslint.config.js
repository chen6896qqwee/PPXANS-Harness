// eslint.config.js — PPXANS-Harness 静态检查基线 (P0: 2026-10-11)
//
// 现状: 本项目此前无任何 linter, 全靠 review 人工保证。加这一层的目的是**安全网**,
// 给后续拆分 agent/index.js、channels/http.js 等大文件兜底, 不是追求零告警。
//
// 策略: 存量历史问题不阻塞 (降为 warn), 只把**真正可疑**的规则留作 error。
//   - no-unused-vars / no-empty  → warn (存量多, 不阻塞 CI)
//   - no-undef / no-redeclare / no-unreachable 等 → error (真会咬人的)
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "dist-desktop/**", // electron-builder 产物 (内含打包后的源码副本, 不应重复 lint)
      "build/**",
      ".ppxtest/**",
      "data/**",
      "uploads/**",
      "references/**",
      "fixtures/**",
      "skills/content/**", // 第三方/参考素材模板 (如 p5.js 画布脚本), 非本仓维护代码
      "**/*.min.js",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    // 保留手写的 eslint-disable 指令: 本仓多处 disable 是针对尚未启用的规则
    // (如 bench/ 的 no-await-in-loop), 默认行为会让 --fix 静默删掉它们, 等于毁掉作者意图。
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // 存量历史问题: 降级为 warn, 不阻塞 CI; 新代码请尽量清零
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // 意图明确 / 纯风格类: 降为 warn, 不阻塞 CI
      "no-useless-escape": "warn",
      "no-control-regex": "warn",
      "no-sparse-arrays": "warn",
      "no-constant-condition": ["error", { checkLoops: false }],
      // 真会咬人的保持 error (js.configs.recommended 默认已含: no-undef / no-unreachable ...)
    },
  },
  {
    // 浏览器侧代码: public/ 下的 Web UI
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser },
    },
  },
];
