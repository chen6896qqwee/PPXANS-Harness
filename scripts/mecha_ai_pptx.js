const pptxgenjs = require('pptxgenjs');
const pres = new pptxgenjs();

pres.layout = 'LAYOUT_16x9';
pres.author = '皮皮虾';
pres.title = 'AI发展史 — 机甲风格';

// === 机甲配色 ===
const BG   = '0A0A0F';
const CYAN = '00F0FF';
const RED  = 'FF2040';
const ORG  = 'FF6A00';
const GRN  = '00FF88';
const WHT  = 'FFFFFF';
const GRY  = '888899';
const DIM  = '555566';

// === 公共装饰 ===
function decor(slide) {
  slide.addShape(pres.ShapeType.line, {
    x: 0, y: 0.12, w: 10, h: 0,
    line: { color: CYAN, width: 1.5, dashType: 'dash' }
  });
  slide.addShape(pres.ShapeType.line, {
    x: 0, y: 5.38, w: 10, h: 0,
    line: { color: RED, width: 1, dashType: 'dash' }
  });
  slide.addText('[ MECHA // AI ]', {
    x: 0.15, y: 0.02, w: 2, h: 0.3,
    fontSize: 7, color: DIM, fontFace: 'Consolas'
  });
  slide.addText('SYS.ONLINE', {
    x: 8.5, y: 5.42, w: 1.3, h: 0.2,
    fontSize: 6, color: GRN, fontFace: 'Consolas', align: 'right'
  });
}

// === 封面 ===
let s1 = pres.addSlide();
s1.background = { color: BG };
decor(s1);
s1.addText('ARTIFICIAL\nINTELLIGENCE', {
  x: 0.5, y: 1.0, w: 9, h: 2.2,
  fontSize: 52, color: CYAN, fontFace: 'Impact',
  bold: true, align: 'center', lineSpacingMultiple: 1.1
});
s1.addText('发 展 历 程  ·  现 状  ·  未 来', {
  x: 1, y: 3.3, w: 8, h: 0.6,
  fontSize: 20, color: WHT, fontFace: 'Microsoft YaHei',
  align: 'center'
});
s1.addShape(pres.ShapeType.line, {
  x: 2, y: 3.05, w: 6, h: 0,
  line: { color: ORG, width: 2 }
});
s1.addText('// MECHA EDITION  v2.0', {
  x: 3, y: 4.5, w: 4, h: 0.4,
  fontSize: 10, color: GRY, fontFace: 'Consolas', align: 'center'
});

// === 第2页：目录 ===
let s2 = pres.addSlide();
s2.background = { color: BG };
decor(s2);
s2.addText('CONTENTS', {
  x: 0.5, y: 0.4, w: 9, h: 0.8,
  fontSize: 32, color: CYAN, fontFace: 'Impact', bold: true
});
const toc = [
  ['01', '起源 — 图灵与早期思想'],
  ['02', '符号主义 — 专家系统时代'],
  ['03', '低谷 — 两次AI寒冬'],
  ['04', '崛起 — 深度学习革命'],
  ['05', '爆发 — 大模型与AGI之路'],
  ['06', '未来 — 机甲与人类共生']
];
toc.forEach((item, i) => {
  const yy = 1.4 + i * 0.65;
  s2.addText(item[0], {
    x: 0.8, y: yy, w: 0.6, h: 0.5,
    fontSize: 22, color: ORG, fontFace: 'Impact', bold: true
  });
  s2.addText(item[1], {
    x: 1.5, y: yy, w: 7, h: 0.5,
    fontSize: 16, color: WHT, fontFace: 'Microsoft YaHei'
  });
  s2.addShape(pres.ShapeType.line, {
    x: 1.5, y: yy + 0.48, w: 7, h: 0,
    line: { color: DIM, width: 0.5, dashType: 'lgDash' }
  });
});

// === 第3页：起源 ===
let s3 = pres.addSlide();
s3.background = { color: BG };
decor(s3);
s3.addText('01  起源', {
  x: 0.5, y: 0.4, w: 9, h: 0.8,
  fontSize: 30, color: CYAN, fontFace: 'Impact', bold: true
});
s3.addText('图灵与早期思想', {
  x: 0.5, y: 1.1, w: 9, h: 0.5,
  fontSize: 14, color: GRY, fontFace: 'Microsoft YaHei'
});
const origin = [
  '// 1950 — THE IMITATION GAME',
  '• 1950  图灵发表论文《计算机器与智能》，提出"图灵测试"',
  '• 1956  达特茅斯会议，"人工智能"一词正式诞生',
  '• 1958  Rosenblatt 发明感知机（Perceptron）',
  '• 1969  Minsky 指出感知机局限，神经网络陷入低谷',
  '',
  '// 核心思想',
  '▸ 机器能否思考？—— 这个问题定义了整个领域',
  '▸ 符号 vs 连接：两条路线的分歧从此开始'
];
origin.forEach((line, i) => {
  const isComment = line.startsWith('//');
  const isEmpty = line === '';
  if (isEmpty) return;
  s3.addText(line, {
    x: 0.8, y: 1.7 + i * 0.48, w: 8.4, h: 0.45,
    fontSize: isComment ? 11 : 13,
    color: isComment ? GRN : WHT,
    fontFace: isComment ? 'Consolas' : 'Microsoft YaHei',
    italic: isComment
  });
});

// === 第4页：符号主义 ===
let s4 = pres.addSlide();
s4.background = { color: BG };
decor(s4);
s4.addText('02  符号主义', {
  x: 0.5, y: 0.4, w: 9, h: 0.8,
  fontSize: 30, color: CYAN, fontFace: 'Impact', bold: true
});
s4.addText('专家系统时代', {
  x: 0.5, y: 1.1, w: 9, h: 0.5,
  fontSize: 14, color: GRY, fontFace: 'Microsoft YaHei'
});
const symbolic = [
  '// 1970s-1980s — EXPERT SYSTEMS',
  '• 1972  MYCIN：医学诊断专家系统，准确率 69%',
  '• 1980s  DENDRA、XCON 等商业专家系统涌现',
  '• 日本第五代计算机计划（FGCS）投入 8.5 亿美元',
  '• Lisp 机器与知识工程成为显学',
  '',
  '// 局限',
  '▸ 知识获取瓶颈：专家经验难以形式化',
  '▸ 脆弱性：超出规则范围即崩溃',
  '▸ 1987 年 AI 寒冬再次降临'
];
symbolic.forEach((line, i) => {
  const isComment = line.startsWith('//');
  const isEmpty = line === '';
  if (isEmpty) return;
  s4.addText(line, {
    x: 0.8, y: 1.7 + i * 0.48, w: 8.4, h: 0.45,
    fontSize: isComment ? 11 : 13,
    color: isComment ? GRN : WHT,
    fontFace: isComment ? 'Consolas' : 'Microsoft YaHei',
    italic: isComment
  });
});

// === 第5页：AI寒冬 ===
let s5 = pres.addSlide();
s5.background = { color: BG };
decor(s5);
s5.addText('03  低谷', {
  x: 0.5, y: 0.4, w: 9, h: 0.8,
  fontSize: 30, color: CYAN, fontFace: 'Impact', bold: true
});
s5.addText('两次AI寒冬', {
  x: 0.5, y: 1.1, w: 9, h: 0.5,
  fontSize: 14, color: GRY, fontFace: 'Microsoft YaHei'
});
const winter = [
  '// FIRST WINTER  1974-1980',
  '▸ Lighthill 报告否定 AI 研究价值，英国大幅削减经费',
  '▸ DARPA 削减语音理解研究资助',
  '',
  '// SECOND WINTER  1987-1993',
  '▸ 专家系统商业化失败，Lisp 机市场崩盘',
  '▸ 第五代计算机计划未达预期',
  '▸ "AI" 一度成为学术禁忌词',
  '',
  '// 教训',
  '▸ 过度承诺 + 欠缺交付 = 信任崩塌',
  '▸ 但寒冬中种子仍在：SVM、贝叶斯网络悄然生长'
];
winter.forEach((line, i) => {
  const isComment = line.startsWith('//');
  const isEmpty = line === '';
  if (isEmpty) return;
  s5.addText(line, {
    x: 0.8, y: 1.7 + i * 0.45, w: 8.4, h: 0.42,
    fontSize: isComment ? 11 : 13,
    color: isComment ? GRN : WHT,
    fontFace: isComment ? 'Consolas' : 'Microsoft YaHei',
    italic: isComment
  });
});

// === 第6页：深度学习 ===
let s6 = pres.addSlide();
s6.background = { color: BG };
decor(s6);
s6.addText('04  崛起', {
  x: 0.5, y: 0.4, w: 9, h: 0.8,
  fontSize: 30, color: CYAN, fontFace: 'Impact', bold: true
});
s6.addText('深度学习革命', {
  x: 0.5, y: 1.1, w: 9, h: 0.5,
  fontSize: 14, color: GRY, fontFace: 'Microsoft YaHei'
});
const dl = [
  '// 2012 — THE DEEP LEARNING REVOLUTION',
  '• 2012  AlexNet 赢得 ImageNet，错误率暴降 10%',
  '• 2016  AlphaGo 击败李世石，震惊世界',
  '• 2017  Transformer 架构论文《Attention Is All You Need》',
  '• 2018  BERT 刷新 11 项 NLP 基准',
  '',
  '// 三大驱动力',
  '▸ 算力：GPU → TPU → 专用 AI 芯片',
  '▸ 数据：互联网积累的海量标注数据',
  '▸ 算法：反向传播 + Dropout + 残差连接'
];
dl.forEach((line, i) => {
  const isComment = line.startsWith('//');
  const isEmpty = line === '';
  if (isEmpty) return;
  s6.addText(line, {
    x: 0.8, y: 1.7 + i * 0.48, w: 8.4, h: 0.45,
    fontSize: isComment ? 11 : 13,
    color: isComment ? GRN : WHT,
    fontFace: isComment ? 'Consolas' : 'Microsoft YaHei',
    italic: isComment
  });
});

// === 第7页：大模型 ===
let s7 = pres.addSlide();
s7.background = { color: BG };
decor(s7);
s7.addText('05  爆发', {
  x: 0.5, y: 0.4, w: 9, h: 0.8,
  fontSize: 30, color: CYAN, fontFace: 'Impact', bold: true
});
s7.addText('大模型与AGI之路', {
  x: 0.5, y: 1.1, w: 9, h: 0.5,
  fontSize: 14, color: GRY, fontFace: 'Microsoft YaHei'
});
const llm = [
  '// 2020-2025 — THE SCALING ERA',
  '• GPT-3 (175B) → GPT-4 → GPT-4o → o1/o3',
  '• Claude、Gemini、Llama、Qwen 百花齐放',
  '• 涌现能力：规模大到一定程度，新能力突然出现',
  '• RLHF / DPO：对齐人类偏好',
  '• Agent：AI 不只聊天，开始行动',
  '',
  '// 关键趋势',
  '▸ 模型变小变强：蒸馏 + 量化 + MoE',
  '▸ 多模态融合：文本 + 图像 + 语音 + 视频',
  '▸ 从 Chatbot 到 Agent：自主规划与执行'
];
llm.forEach((line, i) => {
  const isComment = line.startsWith('//');
  const isEmpty = line === '';
  if (isEmpty) return;
  s7.addText(line, {
    x: 0.8, y: 1.7 + i * 0.48, w: 8.4, h: 0.45,
    fontSize: isComment ? 11 : 13,
    color: isComment ? GRN : WHT,
    fontFace: isComment ? 'Consolas' : 'Microsoft YaHei',
    italic: isComment
  });
});

// === 第8页：未来 ===
let s8 = pres.addSlide();
s8.background = { color: BG };
decor(s8);
s8.addText('06  未来', {
  x: 0.5, y: 0.4, w: 9, h: 0.8,
  fontSize: 30, color: CYAN, fontFace: 'Impact', bold: true
});
s8.addText('机甲与人类共生', {
  x: 0.5, y: 1.1, w: 9, h: 0.5,
  fontSize: 14, color: GRY, fontFace: 'Microsoft YaHei'
});
const future = [
  '// 2025+ — TOWARDS AGI',
  '▸ 具身智能：AI 有了身体，走进物理世界',
  '▸ 世界模型：AI 理解物理规律，不只是模式匹配',
  '▸ 自我进化：AI 优化 AI，递归提升',
  '▸ 人机融合：脑机接口 + AI 助手 = 认知增强',
  '',
  '// THE MECHA VISION',
  '▸ 机甲不是冰冷的钢铁，而是意志的延伸',
  '▸ AI 不是替代者，而是共生体',
  '▸ 未来不是 AI 替代人类，而是人类 + AI = 超越两者之和'
];
future.forEach((line, i) => {
  const isComment = line.startsWith('//');
  const isEmpty = line === '';
  if (isEmpty) return;
  s8.addText(line, {
    x: 0.8, y: 1.7 + i * 0.55, w: 8.4, h: 0.5,
    fontSize: isComment ? 11 : 13,
    color: isComment ? GRN : WHT,
    fontFace: isComment ? 'Consolas' : 'Microsoft YaHei',
    italic: isComment
  });
});

// === 第9页：结尾 ===
let s9 = pres.addSlide();
s9.background = { color: BG };
decor(s9);
s9.addText('THANK YOU', {
  x: 0.5, y: 1.5, w: 9, h: 1.5,
  fontSize: 48, color: CYAN, fontFace: 'Impact', bold: true, align: 'center'
});
s9.addShape(pres.ShapeType.line, {
  x: 3, y: 3.1, w: 4, h: 0,
  line: { color: ORG, width: 2 }
});
s9.addText('THE FUTURE IS MECHA', {
  x: 2, y: 3.3, w: 6, h: 0.6,
  fontSize: 18, color: WHT, fontFace: 'Impact', align: 'center'
});
s9.addText('// SYSTEM.STANDBY  ·  POWERED BY 皮皮虾', {
  x: 2.5, y: 4.3, w: 5, h: 0.4,
  fontSize: 10, color: DIM, fontFace: 'Consolas', align: 'center', italic: true
});

// === 输出 ===
const outPath = 'C:\\Users\\chen\\Desktop\\AI发展史_机甲风格.pptx';
pres.writeFile({ fileName: outPath }).then(() => {
  console.log('DONE: ' + outPath);
}).catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
