// src/config/placeholder.js - 配置占位符判定 (唯一真相源)
//
// 背景: 配置模板 (config/ppx.json.example) 中留给用户填写的位置通常写成
//   REPLACE_WITH_YOUR_ENDPOINT / YOUR_API_KEY / YOUR_LOCAL_MODEL_NAME / <your-host> 等。
// 这些字符串一旦被当成"真实值", 会引发两类故障:
//   1) 启动时误判"已配置模型", 跳过配置引导, 用户以为万事俱备;
//   2) 路由把占位 provider 选成主模型 (尤其 lmstudio 这类 base_url 落在 127.0.0.1 的本地条目,
//      会被 isLocal 判为"零配置可用"), 于是每次请求都必然失败再回退 —— 表现为"静默降级",
//      用户拿到的是备用模型的回答, 却完全不知道主模型根本没配好。
//
// v1.0.8 (P2-3) 修复: 原实现有三份独立正则, 分别位于
//   src/llm/router.js (PLACEHOLDER_RE) / src/config/index.js (validateConfig) /
//   src/config/providers.js (validateProvider),
// 三份都只覆盖 REPLACE_WITH_* / YOUR_ENDPOINT / YOUR_API_KEY, **共同漏掉了
// `YOUR_*_MODEL` / `YOUR_*_NAME` 这一形态** —— 恰好就是模板里 lmstudio 的 model 值
// `YOUR_LOCAL_MODEL_NAME`, 于是它一路畅通无阻成了主模型。
// 现收敛到本模块, 三处共用, 杜绝再次漂移。

// 注意 `\b` 前缀: 占位符一定是独立 token, 避免误伤含 "your_xxx" 的正常标识串
export const PLACEHOLDER_RE = /\bREPLACE_WITH_|\bYOUR_[A-Z0-9_]{2,}|\bsk-xxx|<your[-_]/i;

// 单个字段是否为占位符 (仅对字符串生效)
export function isPlaceholder(v) {
  return typeof v === "string" && PLACEHOLDER_RE.test(v);
}

// provider 是否含任一占位字段 (model / base_url / api_key)
export function hasPlaceholderField(p, fields = ["model", "base_url", "api_key"]) {
  if (!p || typeof p !== "object") return false;
  return fields.some((f) => isPlaceholder(p[f]));
}
