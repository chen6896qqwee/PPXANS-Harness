// src/channels/output.js - 多信道输出规范 (2026-11-01 v4.1 平台化, 设计稿 §4.2)
//
// 语义 (对齐设计稿): IM 信道 (飞书/微信) 是"通知面", 短平快, 渲染不了 markdown;
//   异步/结构化信道 (HTTP/GitHub/邮件类) 是"阅读面", 保真优先。同一个回复不经整形
//   直接进 IM, 会出现整屏 ###/** 与代码围栏符号 —— 降噪归一化只做"不丢信息"的变换:
//   ① 折叠 3+ 连续空行与行尾空白 (纯排版);
//   ② 剥离 IM 渲染不了的 markdown 修饰符 (**粗体**/*斜体*/行内代码反引号/标题 #),
//      代码围栏只去围栏行、保留内容;
//   ③ 长度截断是"策略"不是"机制" —— 默认关 (im_max_chars: 0), 开了才截, 且诚实标注
//      截了多少 (绝不假装全文)。
// 纯函数: (channelName, text, cfg) -> text, 无 IO, 可独立测试。

// 2026-11-14 渠道补全: Telegram 加入 IM 通知面 (纯文本渲染, markdown 降噪同口径)
const IM_CHANNELS = new Set(["feishu", "wechat", "telegram", "log"]);

export function shapeForChannel(name, text, cfg = {}) {
  let s = String(text ?? "");
  const c = cfg || {};
  // 非IM 信道: 结构化保真, 一字不动 (设计稿 §4.2: GitHub/邮件类要的是完整与格式)
  if (!IM_CHANNELS.has(String(name || ""))) return s;
  // im_flatten 默认开 (降噪是安全变换); 显式 false 关闭
  if (c.im_flatten !== false) {
    let out = s
      .replace(/[ \t]+$/gm, "")          // 行尾空白
      .replace(/\n{3,}/g, "\n\n")        // 3+ 连续空行折叠
      .replace(/^```[a-zA-Z0-9_+#.-]*\s*$/gm, "") // 代码围栏行 (保留围栏内内容)
      .replace(/^#{1,6}\s+(.+)$/gm, "【$1】")      // 标题 → 【标题】
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")          // **粗体** → 粗体
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2") // *斜体* → 斜体 (不误伤已处理的粗体残段)
      .replace(/`([^`\n]+)`/g, "$1")                // 行内代码反引号
      .replace(/\n{3,}/g, "\n\n")        // 剥离后可能再次出现空行, 收尾再折一次
      .trim();
    // 围栏行移除后可能留下成对空行, 再收一次
    out = out.replace(/\n{3,}/g, "\n\n");
    s = out;
  }
  // 截断: 默认 0 = 关; >0 时超长截断并诚实标注 (策略层开关, 不是默认行为)
  const max = Number(c.im_max_chars) || 0;
  if (max > 0 && s.length > max) {
    s = s.slice(0, max) + `\n…[已截断: 全文共 ${s.length} 字符, 完整内容见 Web 端]`;
  }
  return s;
}
