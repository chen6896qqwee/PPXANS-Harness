---
name: docx
name_zh: Word 文档
description: 生成、读取、改写 .docx: Markdown 转正式文档、提取正文与表格、批量查找替换、结构校验。用于"写份 Word/做个 docx/改文档里的文字/把这份稿子转成 Word"。
domain: office
tags: Word, docx, 文档, 报告, 排版, 表格
risk: medium
---

# Word 文档

## 适用
- 需要交付 `.docx` (报告、方案、说明、会议纪要), 且正文由我方撰写。
- 已有 `.docx` 需要读成文本、批量替换措辞、或在交付前做结构自检。
- 不适用: 复杂图文混排、目录/交叉引用/页眉页脚定制、修订与批注密集协作 —— 这些用 Word 本身更快, 本技能只保证"内容正确、文件能开"。

## 核心事实
`.docx` 就是一个 ZIP 包: 正文在 `word/document.xml`, 样式在 `word/styles.xml`, 编号在 `word/numbering.xml`, 关系在 `*.rels`。理解这一点, 读写都不需要重型库; 也意味着**任何手工拼接 XML 的错误都会让 Word 报"文件已损坏"**, 所以生成后必须跑 `validate`。

## 工具
脚本目录 `scripts/`, 全部只用 Python 3.9+ 标准库 (无需 pip):

| 命令 | 用途 |
|---|---|
| `python scripts/docx_tool.py create --from-md in.md --title "标题" --out out.docx` | Markdown → docx (标题 1-4 级/段落/无序与有序列表/引用/表格/粗体/斜体/行内代码) |
| `python scripts/docx_tool.py read out.docx [--out text.md]` | docx → Markdown (保留标题层级、列表标记、表格、粗斜体与代码) |
| `python scripts/docx_tool.py replace out.docx --find "旧" --with "新" --out new.docx` | 查找替换; `--all-parts` 连带页眉/页脚/脚注; 必须给 `--out` 或显式 `--in-place` |
| `python scripts/docx_tool.py validate out.docx` | ZIP CRC、XML 良构、必需部件、正文非空、段落/表格计数 |

## 流程

1. **先定交付形态**: 是"内容为主, 版式从简"还是"沿用对方模板"。前者用 `create` 生成; 后者不要重排, 用 `replace` 只改文字, 保留原模板的一切版式与品牌元素。
2. **写 Markdown 底稿, 而不是直接拼 XML**。标题用 `#`~`####`, 列表用 `-` 与 `1.`, 表格用标准 Markdown 表, 强调用 `**`/`*`/反引号。工具只解析这些确定的语法, 不猜 HTML。
3. **结构先过一遍 lint 式自检**: 一级标题唯一、层级不跳级、每张表有表头、列表嵌套不超过 3 层。写进文件后再改结构, 成本远高于改 Markdown。
4. **生成**到目标路径, 文件名与文档标题一致, 不带"副本/final/v2"这类词。
5. **回读校验**: 跑 `read` 抽读前 30 行与所有标题行, 确认标题层级、表格列数、中文标点没有丢。再跑 `validate`, 必须 `ok: true` 且 `text_chars` 与底稿量级相符。
6. **需要看版面时转 PDF/图片** (可选): 本机若有 LibreOffice, 用 `soffice --headless --convert-to pdf out.docx` 再渲染; 没有就明确告知用户"已完成结构校验, 未做视觉核对"。
7. **替换类任务**: 先 `read` 拿到原文确认命中串, 再 `replace --out`。替换后 `read` 抽查上下文, 避免把"系统"换成"体系"时误伤"操作系统"这类词 —— 必要时把 `--find` 写长一点。
8. **交付时说明**: 文件路径、段落/表格数量、已知限制 (如未加目录、未嵌入图片)。

## 边界与限制
- **跨 run 替换会折叠格式**: Word 常把一句话拆成多个 run (拼写检查、修订、不同字体)。命中跨 run 时工具会把整段并到第一个 run 里, 文字正确, 局部加粗/颜色可能丢失。输出 JSON 的 `paragraphs` 计数即发生折叠的次数, 发生时要复核。
- **不生成图片、图表、超链接、目录、页眉页脚、脚注**。需要这些时, 在 Markdown 里留占位 (如 `[图 1: 待插入]`), 交付后由人或 Word 补, 并在回复里写明。
- **不处理 `.doc` (二进制老格式)**: 先让用户另存为 `.docx`。
- **加密/签名文档**不支持; 也不改写 `customXml` 与嵌入对象。

## 反合理化
- "先随便生成一个, 打开看看再说" → 打不开时你拿不到任何反馈, 只能看到 Word 报错。生成后先跑 `validate`, 再谈打开。
- "用字符串拼接 XML 快" → 少一个命名空间或 `xml:space` 就会丢空格、丢文字。必须用工具里已有的构造器。
- "替换全文档肯定没问题" → 短词替换误伤率极高。先用 `read` 核对上下文, 再决定 `--find` 的长度。
- "版式不对就重排" → 对方模板承载品牌与合规要求, 重排等于换了一份文档。模板类任务只改文字。
- "validate 报错但大概能开" → "大概"等于交付事故。任何 error 都必须修到 `ok: true`。

## 验证
- [ ] 底稿是 Markdown, 标题层级连续且只有一个一级标题
- [ ] `create` 成功, 输出 JSON 的 `blocks` 与底稿段落量级一致
- [ ] `read` 回读: 标题、列表、表格列数、中文标点与底稿一致
- [ ] `validate` 返回 `ok: true`, `errors` 为空
- [ ] 替换任务: 命中次数符合预期, 抽查上下文无误伤
- [ ] 回复中写明文件路径、结构统计与未覆盖的能力 (图片/目录等)
