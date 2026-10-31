// src/memory/lexicon.js — 轻量概念词典 (2026-10-30)
//
// 为什么需要它:
//   BM25 走 bigram, 内置哈希 embedder 走字符 n-gram —— **两者都是字面信号**, 只是一个按
//   IDF 加权、一个按余弦。所以"什么操作系统"永远找不到"用户用 Windows 11": 两串字面交集为零。
//   实测 dev 集 recall@3 47%, 失败的全是这一类。
//
// 定位:
//   这不是语义模型, 是**概念桥**。零依赖、确定性、可审计。给 RRF 增加第三路信号:
//   "查询里的某个概念, 和事实里的某个概念, 属于同一簇"。
//   真正需要强语义 (跨语言/深层类比) 仍配 config.embedding; 这里的职责是补上零依赖环境下
//   最容易补的那一段 —— 中文工作场景里的同义/上下位词。
//
// 设计约束 (防止它变成"对着探针作弊的黑名单"):
//   1. 词条必须写成**概念簇** (一组可互换/相关的词), 不是 "问题->答案" 的直接映射;
//   2. 簇要来自领域常识 (IT / 办公 / 运维), 允许覆盖探针语料里出现过的词, 但不允许出现
//      只在探针里才成立的关联;
//   3. 尺度要够大 (几十簇): 只有几簇时它必然退化成查表, 几十簇才谈得上"泛化";
//   4. 验收只看 holdout 集 —— dev 涨而 holdout 不涨 = 过拟合, 词典要重写而不是继续加词。
//
// 用法:
//   conceptMatches(query) -> Map<conceptIndex, {weight, terms}>  命中的概念簇
//   expandedTerms(query)  -> Set<string>  —— 命中簇的其余成员 (供概念路打分)

// 每个簇内成员视为"可在检索里互相替换"的近似说法。
// 说明: 簇内**包含**彼此不严格的近义词 (如"快"/"慢"同簇), 因为检索需要的不是语义等价,
//   而是"这两句话在谈同一件事"。同簇命中只加弱分, 不会压过字面命中。
const CONCEPTS = [
  // ---- 运行环境 / 平台 ----
  ["操作系统", "os", "系统", "平台", "windows", "linux", "macos", "ubuntu", "debian", "mac"],
  ["命令", "命令行", "shell", "bash", "终端", "console", "cmd", "powershell"],
  ["浏览器", "chrome", "edge", "firefox", "safari", "页面"],
  ["机器", "服务器", "主机", "核", "线程", "cpu", "内存", "ram", "配置", "硬件"],

  // ---- 版本控制 / 交付 ----
  ["提交", "commit", "推送", "push", "版本控制", "git", "仓库", "repo"],
  ["发布", "上线", "部署", "deploy", "release", "出货", "ship", "上线前"],
  ["回滚", "回退", "恢复", "rollback", "restore", "备份"],
  ["端口", "port", "占用", "冲突", "绑定"],
  ["域名", "地址", "网址", "url", "host", "链接", "备用"],

  // ---- 性能 ----
  ["快", "慢", "性能", "并发", "吞吐", "延迟", "卡", "响应", "提速", "瓶颈"],
  ["锁", "加锁", "同步", "阻塞", "竞争", "race", "lock", "队列", "排队"],
  ["开销", "成本", "花费", "占用", "token", "预算", "省", "浪费"],
  ["缓存", "cache", "命中", "复用", "预热"],

  // ---- 质量 / 验证 ----
  ["测试", "基准", "bench", "跑测", "用例", "回归", "验证", "验收"],
  ["覆盖率", "cover", "八成", "比例", "标准"],
  ["检查", "巡检", "自愈", "体检", "健康", "监控", "告警", "定时"],
  ["失败", "报错", "错误", "异常", "崩", "坏", "挂"],
  ["修复", "修", "改好", "纠正", "解决", "debug", "排查"],

  // ---- 安全 ----
  ["安全", "危险", "风险", "威胁", "攻击", "漏洞"],
  ["拦截", "拦", "阻止", "禁止", "拒绝", "deny", "守卫", "防线", "策略", "闸门"],
  ["篡改", "防改", "验签", "哈希", "hash", "sha", "签名", "审计", "链", "校验"],
  ["密钥", "凭证", "secret", "key", "令牌", "token", "环境变量", "认证", "授权"],
  ["验证码", "短信", "手机号", "二次验证", "otp", "网关"],
  ["权限", "授权", "角色", "角色权限", "访问控制", "rbac"],

  // ---- 记忆 / 知识 ----
  ["记忆", "事实", "记住", "记得", "知识", "沉淀", "经验", "facts"],
  ["容量", "上限", "条数", "最多", "存多少", "大小", "limit", "限额"],
  ["来源", "事实源", "可信", "真相", "依据", "出处", "日志"],
  ["检索", "搜索", "查找", "召回", "匹配", "搜"],
  ["衰减", "过期", "时效", "失效", "遗忘", "清理"],

  // ---- 沟通 / 协作 ----
  ["说话", "风格", "语气", "口吻", "表达", "偏好", "习惯", "结论先行", "寒暄"],
  ["汇报", "材料", "周报", "总结", "文档", "ppt", "演示"],
  ["会议", "开会", "周会", "例会", "碰头", "同步会"],
  ["团队", "同事", "成员", "协作", "分工"],
  ["入职", "新人", "上手", "培训", "交接", "文档"],
  ["客户", "客人", "用户", "甲方", "投诉", "不满", "反馈"],
  ["回复", "响应", "答复", "处理", "跟进"],

  // ---- 数据 / 存储 ----
  ["数据库", "db", "sql", "表", "连接池", "连接数", "存储"],
  ["日志", "log", "记录", "痕迹", "流水", "保留", "归档"],
  ["文件", "目录", "路径", "文件夹", "path", "dir", "盘"],
  ["图片", "图像", "照片", "出图", "尺寸", "分辨率", "像素"],
  ["视频", "素材", "片子", "剪辑", "硬盘"],
  ["模型", "大模型", "llm", "推理", "端点", "endpoint", "provider"],

  // ---- 工程习惯 ----
  ["代码", "源码", "实现", "程序", "函数", "模块"],
  ["缩进", "格式", "风格", "空格", "换行", "lint", "规范"],
  ["配置", "设置", "参数", "config", "项"],
  ["环境", "生产", "线上", "prod", "测试环境", "staging", "正式"],

  // ---- 通道 / 集成 ----
  ["通道", "渠道", "连接", "接入", "对接", "集成"],
  ["飞书", "lark", "feishu"],
  ["微信", "wechat", "公众号", "企微"],

  // ---- 时间 ----
  ["每天", "每日", "凌晨", "半夜", "定时", "周期性", "daily", "每周", "cron"],
  ["十", "二十", "三十", "十六", "三十二", "五", "八成", "百分", "数字", "数量"],
];

// 反查表: 词 -> 簇下标列表。一个词可能属于多簇 (如 "token" 既是开销也是密钥)。
const TERM_TO_CLUSTERS = new Map();
CONCEPTS.forEach((cluster, ci) => {
  for (const term of cluster) {
    const k = term.toLowerCase();
    if (!TERM_TO_CLUSTERS.has(k)) TERM_TO_CLUSTERS.set(k, []);
    TERM_TO_CLUSTERS.get(k).push(ci);
  }
});

// 中文单字/双字切分 (与 fact-store._bigramSet 同口径, 保证扩展词能和索引对上)
function cjkGrams(text) {
  const out = new Set();
  const low = String(text || "").toLowerCase();
  const segs = low.match(/[\u4e00-\u9fff]+/g) || [];
  for (const seg of segs) {
    if (seg.length === 1) { out.add(seg); continue; }
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
  }
  const en = low.match(/[a-z0-9][a-z0-9._-]*/g) || [];
  for (const tk of en) out.add("en:" + tk);
  return out;
}

// 查一个片段作为"概念词"命中哪些簇。
// 支持整词命中 (操作系统) 与包含命中 (低版本 "操作系统的版本" 含 "操作系统")。
// 返回 [{ci, term}]。
function termHits(fragment) {
  const low = String(fragment || "").toLowerCase();
  const hits = [];
  if (!low) return hits;
  // ① 整词精确
  const exact = TERM_TO_CLUSTERS.get(low);
  if (exact) for (const ci of exact) hits.push({ ci, term: low });
  if (hits.length) return hits;
  // ② 子串: 词典里有 ≤4 字的短词出现在片段中 (避免长词误配)
  for (const [term, cis] of TERM_TO_CLUSTERS) {
    if (term.length > 4) continue;
    if (low.includes(term)) for (const ci of cis) hits.push({ ci, term });
  }
  return hits;
}

// 命中的概念簇 -> 概念下标集合。查询越长, 命中的簇越多。
export function conceptMatches(query) {
  const q = String(query || "").toLowerCase();
  const hit = new Map(); // ci -> Set(term)
  if (!q) return hit;
  // 拉丁词按空格切, 中文按整串 + 2~4 字滑窗喂给 termHits
  const pieces = [q, ...(q.match(/[a-z0-9][a-z0-9._-]*/g) || [])];
  const cjk = (q.match(/[\u4e00-\u9fff]+/g) || []).join("");
  for (let len = 2; len <= 5; len++) {
    for (let i = 0; i + len <= cjk.length; i++) pieces.push(cjk.slice(i, i + len));
  }
  for (const p of pieces) {
    for (const { ci, term } of termHits(p)) {
      if (!hit.has(ci)) hit.set(ci, new Set());
      hit.get(ci).add(term);
    }
  }
  return hit;
}

// 扩展词集合 (bigram 口径, 直接可与 BM25 的 _bigramSet 交集)。
// 命中簇里**除查询自身已含的词以外**的成员 —— 只补充信息, 不重复原查询。
export function expandedTerms(query) {
  const matched = conceptMatches(query);
  const out = new Set();
  if (!matched.size) return out;
  const own = cjkGrams(query);
  for (const ci of matched.keys()) {
    for (const term of CONCEPTS[ci]) {
      for (const g of cjkGrams(term)) {
        if (!own.has(g)) out.add(g);
      }
    }
  }
  return out;
}

export const CONCEPT_COUNT = CONCEPTS.length;

export default { conceptMatches, expandedTerms, CONCEPT_COUNT };
