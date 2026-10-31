#!/usr/bin/env python3
"""DOCX 工具 —— 纯标准库实现 (zipfile + xml.etree)。

子命令:
  create    从 Markdown 大纲生成 .docx (标题/段落/列表/表格/引用/粗体/斜体/代码)
  read      把 .docx 转成 Markdown 文本 (段落样式、列表、表格)
  replace   查找替换正文文本 (先按 run 精确替换, 跨 run 命中时折叠段内 run)
  validate  结构校验 (ZIP CRC / XML 良构 / 必需部件 / 正文非空)

只依赖 Python 3.9+ 标准库, 不写临时文件, 不联网。
"""

import argparse
import datetime
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape as xml_escape

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
ZIP_TIME = (2026, 10, 31, 0, 0, 0)
DEFAULT_CREATOR = "PPXANS-Harness"

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"""

DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>"""

SETTINGS_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="%s">
<w:zoom w:percent="100"/>
<w:defaultTabStop w:val="420"/>
<w:characterSpacingControl w:val="compressPunctuation"/>
<w:compat>
<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>
</w:compat>
</w:settings>""" % W_NS

STYLES_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="%s">
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="240" w:after="240"/><w:jc w:val="center"/></w:pPr><w:rPr><w:rFonts w:eastAsia="微软雅黑"/><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:eastAsia="微软雅黑"/><w:b/><w:color w:val="1F2937"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:eastAsia="微软雅黑"/><w:b/><w:color w:val="1F2937"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:rFonts w:eastAsia="微软雅黑"/><w:b/><w:color w:val="374151"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:rFonts w:eastAsia="微软雅黑"/><w:b/><w:color w:val="374151"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="C7D2FE"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="F8FAFC"/><w:ind w:left="360" w:right="240"/></w:pPr><w:rPr><w:color w:val="475569"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>
<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/></w:tblBorders><w:tblCellMar><w:top w:w="72" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="72" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>""" % W_NS


def _lvl(ilvl, fmt, text, left, font=None):
    rpr = '<w:rPr><w:rFonts w:ascii="%s" w:hAnsi="%s"/></w:rPr>' % (font, font) if font else ""
    return (
        '<w:lvl w:ilvl="%d"><w:start w:val="1"/><w:numFmt w:val="%s"/>'
        '<w:lvlText w:val="%s"/><w:lvlJc w:val="left"/>'
        '<w:pPr><w:ind w:left="%d" w:hanging="420"/></w:pPr>%s</w:lvl>'
        % (ilvl, fmt, text, left, rpr)
    )


NUMBERING_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="' + W_NS + '">'
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>'
    + _lvl(0, "bullet", "•", 420, "Arial")
    + _lvl(1, "bullet", "◦", 840, "Arial")
    + _lvl(2, "bullet", "▪", 1260, "Arial")
    + '</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>'
    + _lvl(0, "decimal", "%1.", 420)
    + _lvl(1, "lowerLetter", "%2.", 840)
    + _lvl(2, "lowerRoman", "%3.", 1260)
    + '</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>'
)


def core_xml(title):
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
        ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"'
        ' xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        "<dc:title>%s</dc:title><dc:creator>%s</dc:creator><cp:lastModifiedBy>%s</cp:lastModifiedBy>"
        '<dcterms:created xsi:type="dcterms:W3CDTF">%s</dcterms:created>'
        '<dcterms:modified xsi:type="dcterms:W3CDTF">%s</dcterms:modified>'
        "</cp:coreProperties>" % (xml_escape(title), DEFAULT_CREATOR, DEFAULT_CREATOR, now, now)
    )


APP_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"'
    ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    "<Application>%s</Application></Properties>" % DEFAULT_CREATOR
)

SECT_PR = (
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"'
    ' w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>'
)


# ---------------------------------------------------------------- create

INLINE_RE = re.compile(r"(\*\*.+?\*\*|`[^`]+`|\*[^*\s][^*]*?\*)")


def runs(text):
    out = []
    pos = 0
    for m in INLINE_RE.finditer(text):
        if m.start() > pos:
            out.append('<w:r><w:t xml:space="preserve">%s</w:t></w:r>' % xml_escape(text[pos:m.start()]))
        token = m.group(0)
        if token.startswith("**"):
            out.append(
                '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r>'
                % xml_escape(token[2:-2])
            )
        elif token.startswith("`"):
            out.append(
                '<w:r><w:rPr><w:rStyle w:val="CodeChar"/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r>'
                % xml_escape(token[1:-1])
            )
        else:
            out.append(
                '<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r>'
                % xml_escape(token[1:-1])
            )
        pos = m.end()
    if pos < len(text):
        out.append('<w:r><w:t xml:space="preserve">%s</w:t></w:r>' % xml_escape(text[pos:]))
    return "".join(out)


def para(text, style=None, num_id=None, ilvl=0, spacing=None):
    ppr = ""
    if style or num_id or spacing:
        ppr = "<w:pPr>"
        if style:
            ppr += '<w:pStyle w:val="%s"/>' % style
        if num_id:
            ppr += '<w:numPr><w:ilvl w:val="%d"/><w:numId w:val="%d"/></w:numPr>' % (ilvl, num_id)
        if spacing:
            ppr += spacing
        ppr += "</w:pPr>"
    return "<w:p>%s%s</w:p>" % (ppr, runs(text))


def table(rows):
    cols = max(len(r) for r in rows) if rows else 1
    width = 9000 // max(cols, 1)
    grid = "".join('<w:gridCol w:w="%d"/>' % width for _ in range(cols))
    body = []
    for idx, row in enumerate(rows):
        cells = []
        for col in range(cols):
            text = row[col] if col < len(row) else ""
            shade = '<w:shd w:val="clear" w:color="auto" w:fill="EEF2F7"/>' if idx == 0 else ""
            cells.append(
                '<w:tc><w:tcPr><w:tcW w:w="%d" w:type="dxa"/>%s</w:tcPr>%s</w:tc>'
                % (width, shade, para(text, spacing="<w:spacing w:after=\"0\"/>"))
            )
        trpr = "<w:trPr><w:tblHeader/></w:trPr>" if idx == 0 else ""
        body.append("<w:tr>%s%s</w:tr>" % (trpr, "".join(cells)))
    return (
        '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>'
        '<w:tblW w:w="%d" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr>'
        '<w:tblGrid>%s</w:tblGrid>%s</w:tbl>'
        % (width * cols, grid, "".join(body))
    )


def parse_markdown(md):
    blocks = []
    lines = md.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            i += 1
            continue

        if stripped.startswith("|") and i + 1 < len(lines) and re.match(r"^\|?[\s:|-]+\|?$", lines[i + 1].strip()):
            rows = [split_row(stripped)]
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(split_row(lines[i].strip()))
                i += 1
            blocks.append(table(rows))
            continue

        m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if m:
            level = min(len(m.group(1)), 4)
            blocks.append(para(m.group(2).strip(), style="Heading%d" % level))
            i += 1
            continue

        if stripped.startswith(">"):
            blocks.append(para(stripped.lstrip("> ").strip(), style="Quote"))
            i += 1
            continue

        m = re.match(r"^(\s*)[-*+]\s+(.*)$", line)
        if m:
            ilvl = min(len(m.group(1)) // 2, 2)
            blocks.append(para(m.group(2).strip(), style="ListParagraph", num_id=1, ilvl=ilvl))
            i += 1
            continue

        m = re.match(r"^(\s*)(\d+)[.)]\s+(.*)$", line)
        if m:
            ilvl = min(len(m.group(1)) // 2, 2)
            blocks.append(para(m.group(3).strip(), style="ListParagraph", num_id=2, ilvl=ilvl))
            i += 1
            continue

        buf = [stripped]
        i += 1
        while i < len(lines):
            nxt = lines[i].strip()
            if not nxt or nxt.startswith(("#", ">", "|", "- ", "* ", "+ ")) or re.match(r"^\d+[.)]\s", nxt):
                break
            buf.append(nxt)
            i += 1
        blocks.append(para(" ".join(buf)))
    return blocks


def split_row(line):
    inner = line.strip()
    if inner.startswith("|"):
        inner = inner[1:]
    if inner.endswith("|"):
        inner = inner[:-1]
    return [c.strip() for c in inner.split("|")]


def build_document(body_blocks):
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<w:document xmlns:w="%s" xmlns:r="%s">'
        "<w:body>%s%s</w:body></w:document>"
        % (W_NS, R_NS, "".join(body_blocks), SECT_PR)
    )


def write_docx(path, document_xml, title):
    parts = {
        "[Content_Types].xml": CONTENT_TYPES,
        "_rels/.rels": ROOT_RELS,
        "word/document.xml": document_xml,
        "word/_rels/document.xml.rels": DOC_RELS,
        "word/styles.xml": STYLES_XML,
        "word/numbering.xml": NUMBERING_XML,
        "word/settings.xml": SETTINGS_XML,
        "docProps/core.xml": core_xml(title),
        "docProps/app.xml": APP_XML,
    }
    tmp = path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in [
            "[Content_Types].xml",
            "_rels/.rels",
            "docProps/core.xml",
            "docProps/app.xml",
            "word/document.xml",
            "word/_rels/document.xml.rels",
            "word/styles.xml",
            "word/numbering.xml",
            "word/settings.xml",
        ]:
            info = zipfile.ZipInfo(name, date_time=ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, parts[name])
    os.replace(tmp, path)


def cmd_create(args):
    if args.from_md:
        with open(args.from_md, "r", encoding="utf-8") as fh:
            md = fh.read()
    elif args.text is not None:
        md = args.text
    else:
        md = sys.stdin.read()

    blocks = parse_markdown(md)
    title = args.title or ""
    if title:
        blocks.insert(0, para(title, style="Title"))
    if not blocks:
        raise SystemExit("输入为空: 没有可写入的段落 (用 --from-md / --text / stdin)")
    write_docx(args.out, build_document(blocks), title)
    stats = {
        "out": os.path.abspath(args.out),
        "blocks": len(blocks),
        "bytes": os.path.getsize(args.out),
    }
    print(json.dumps(stats, ensure_ascii=False))
    return 0


# ---------------------------------------------------------------- read

def numbering_formats(zf):
    """numId -> (numFmt, lvlText) for level 0; 用于把列表还原成 Markdown 标记。"""
    try:
        root = ET.fromstring(zf.read("word/numbering.xml"))
    except KeyError:
        return {}
    abstract = {}
    for an in root.findall(W + "abstractNum"):
        aid = an.get(W + "abstractNumId")
        lvl = an.find(W + "lvl")
        if lvl is None:
            continue
        fmt = lvl.find(W + "numFmt")
        abstract[aid] = fmt.get(W + "val") if fmt is not None else "decimal"
    out = {}
    for num in root.findall(W + "num"):
        nid = num.get(W + "numId")
        ref = num.find(W + "abstractNumId")
        if ref is not None:
            out[nid] = abstract.get(ref.get(W + "val"), "decimal")
    return out


def render_para(p):
    """段内 run 级还原: 粗体/斜体/代码用 Markdown 标记, 其余按原文拼接。"""
    out = []
    for run in p.iter(W + "r"):
        text = ""
        for node in run.iter():
            if node.tag == W + "t":
                text += node.text or ""
            elif node.tag == W + "tab":
                text += "\t"
            elif node.tag in (W + "br", W + "cr"):
                text += "\n"
        if not text:
            continue
        rpr = run.find(W + "rPr")
        bold = italic = code = False
        if rpr is not None:
            bold = rpr.find(W + "b") is not None
            italic = rpr.find(W + "i") is not None
            style = rpr.find(W + "rStyle")
            code = style is not None and style.get(W + "val") == "CodeChar"
        if code:
            text = "`" + text + "`"
        elif bold and italic:
            text = "***" + text + "***"
        elif bold:
            text = "**" + text + "**"
        elif italic:
            text = "*" + text + "*"
        out.append(text)
    return "".join(out).strip()


def heading_level(p):
    ppr = p.find(W + "pPr")
    if ppr is None:
        return None
    style = ppr.find(W + "pStyle")
    if style is None:
        return None
    val = style.get(W + "val") or ""
    if val == "Title":
        return 0
    m = re.match(r"Heading(\d)", val)
    if m:
        return int(m.group(1))
    return None


def list_info(p, formats):
    ppr = p.find(W + "pPr")
    if ppr is None:
        return None
    numpr = ppr.find(W + "numPr")
    if numpr is None:
        return None
    ilvl_el = numpr.find(W + "ilvl")
    numid_el = numpr.find(W + "numId")
    ilvl = int(ilvl_el.get(W + "val")) if ilvl_el is not None else 0
    numid = numid_el.get(W + "val") if numid_el is not None else None
    return ilvl, numid, formats.get(numid, "decimal")


def render_table(tbl):
    rows = []
    for tr in tbl.findall(W + "tr"):
        cells = []
        for tc in tr.findall(W + "tc"):
            parts = [render_para(p) for p in tc.findall(W + "p")]
            cells.append(" ".join(x for x in parts if x).replace("|", "\\|"))
        rows.append(cells)
    if not rows:
        return ""
    cols = max(len(r) for r in rows)
    lines = ["| " + " | ".join(r + [""] * (cols - len(r))) + " |" for r in rows]
    lines.insert(1, "| " + " | ".join(["---"] * cols) + " |")
    return "\n".join(lines)


def cmd_read(args):
    with zipfile.ZipFile(args.file) as zf:
        names = zf.namelist()
        doc_part = "word/document.xml"
        if doc_part not in names:
            raise SystemExit("不是有效的 .docx: 缺少 word/document.xml")
        root = ET.fromstring(zf.read(doc_part))
        formats = numbering_formats(zf)
        body = root.find(W + "body")
        blocks = []
        counters = {}
        if body is not None:
            for child in body:
                if child.tag == W + "p":
                    text = render_para(child)
                    if not text:
                        continue
                    lvl = heading_level(child)
                    li = list_info(child, formats)
                    if lvl:
                        blocks.append(("heading", "#" * lvl + " " + text))
                    elif li is not None:
                        ilvl, numid, fmt = li
                        key = (numid, ilvl)
                        if fmt == "bullet":
                            marker = "-"
                        else:
                            counters[key] = counters.get(key, 0) + 1
                            marker = "%d." % counters[key]
                        blocks.append(("list", "  " * ilvl + marker + " " + text))
                    else:
                        counters.clear()
                        blocks.append(("para", text))
                elif child.tag == W + "tbl":
                    rendered = render_table(child)
                    if rendered:
                        blocks.append(("table", rendered))
        chunks = []
        for idx, (kind, text) in enumerate(blocks):
            if idx == 0:
                chunks.append(text)
            elif kind == "list" and blocks[idx - 1][0] == "list":
                chunks.append("\n" + text)
            else:
                chunks.append("\n\n" + text)
        text = "".join(chunks) + "\n"
        if args.out:
            with open(args.out, "w", encoding="utf-8") as fh:
                fh.write(text)
            print(json.dumps({"out": os.path.abspath(args.out), "chars": len(text)}, ensure_ascii=False))
        else:
            sys.stdout.write(text)
    return 0


# ---------------------------------------------------------------- replace

PARA_RE = re.compile(r"<w:p\b[^>]*>.*?</w:p>", re.S)
TEXT_RE = re.compile(r"(<w:t\b[^>]*>)(.*?)(</w:t>)", re.S)


def unescape(s):
    return (
        s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&apos;", "'")
        .replace("&amp;", "&")
    )


def replace_in_part(xml, find, repl):
    """两级替换: 先在单个 <w:t> 内替换 (保格式), 再对跨 run 命中做段内折叠。"""
    direct = 0
    folded = 0

    def per_run(m):
        nonlocal direct
        content = unescape(m.group(2))
        if find not in content:
            return m.group(0)
        direct += content.count(find)
        return m.group(1) + xml_escape(content.replace(find, repl)) + m.group(3)

    xml = TEXT_RE.sub(per_run, xml)

    def per_para(m):
        nonlocal folded
        block = m.group(0)
        matches = list(TEXT_RE.finditer(block))
        if not matches:
            return block
        joined = "".join(unescape(x.group(2)) for x in matches)
        if find not in joined:
            return block
        folded += joined.count(find)
        new_text = xml_escape(joined.replace(find, repl))
        pieces = []
        last = 0
        for idx, mt in enumerate(matches):
            pieces.append(block[last:mt.start()])
            pieces.append('<w:t xml:space="preserve">%s</w:t>' % new_text if idx == 0 else "<w:t></w:t>")
            last = mt.end()
        pieces.append(block[last:])
        return "".join(pieces)

    xml = PARA_RE.sub(per_para, xml)
    return xml, direct, folded


def replace_parts(zf_src, out_path, find, repl, all_parts):
    pat = re.compile(r"^word/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$")
    stats = {}
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zf_src.infolist():
            data = zf_src.read(info.filename)
            if info.filename == "word/document.xml" or (all_parts and pat.match(info.filename)):
                xml = data.decode("utf-8")
                new_xml, direct, folded = replace_in_part(xml, find, repl)
                if direct or folded:
                    stats[info.filename] = {"runs": direct, "paragraphs": folded}
                data = new_xml.encode("utf-8")
            zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zout.writestr(zi, data)
    return stats


def cmd_replace(args):
    if not args.out and not args.in_place:
        raise SystemExit("为避免覆盖原件, 请指定 --out <新文件> 或显式 --in-place")
    target = args.file if args.in_place else args.out
    with zipfile.ZipFile(args.file) as zf:
        stats = replace_parts(zf, target, args.find, args.with_text, args.all_parts)
    total = sum(v["runs"] + v["paragraphs"] for v in stats.values())
    if total == 0:
        print(json.dumps({"out": os.path.abspath(target), "replaced": 0, "hint": "未命中, 检查原文是否被拆分为多个 run 或位于未处理的部件"}, ensure_ascii=False))
    else:
        print(json.dumps({"out": os.path.abspath(target), "replaced": total, "parts": stats}, ensure_ascii=False))
    return 0


# ---------------------------------------------------------------- validate

REQUIRED_PARTS = [
    "[Content_Types].xml",
    "_rels/.rels",
    "word/document.xml",
]


def cmd_validate(args):
    errors = []
    warnings = []
    info = {"file": os.path.abspath(args.file)}
    try:
        with zipfile.ZipFile(args.file) as zf:
            bad = zf.testzip()
            if bad:
                errors.append("ZIP CRC 校验失败: %s" % bad)
            names = set(zf.namelist())
            for part in REQUIRED_PARTS:
                if part not in names:
                    errors.append("缺少必需部件: %s" % part)
            for name in sorted(names):
                if name.endswith((".xml", ".rels")):
                    try:
                        ET.fromstring(zf.read(name))
                    except ET.ParseError as exc:
                        errors.append("XML 不良构: %s (%s)" % (name, exc))
            if "word/document.xml" in names:
                root = ET.fromstring(zf.read("word/document.xml"))
                body = root.find(W + "body")
                if body is None:
                    errors.append("document.xml 缺少 w:body")
                else:
                    text = "".join(t.text or "" for t in root.iter(W + "t")).strip()
                    info["text_chars"] = len(text)
                    if not text:
                        errors.append("正文没有任何文本")
                    info["paragraphs"] = len(list(root.iter(W + "p")))
                    info["tables"] = len(list(root.iter(W + "tbl")))
            media = [n for n in names if n.startswith("word/media/")]
            info["media"] = len(media)
            if "word/styles.xml" not in names:
                warnings.append("没有 word/styles.xml: 标题层级在 Word 里可能显示为普通段落")
    except zipfile.BadZipFile as exc:
        errors.append("不是有效的 ZIP 容器: %s" % exc)
    info["errors"] = errors
    info["warnings"] = warnings
    info["ok"] = not errors
    print(json.dumps(info, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


# ---------------------------------------------------------------- cli

def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8")
            except (ValueError, OSError):
                pass
    ap = argparse.ArgumentParser(prog="docx_tool.py", description="DOCX 读写/替换/校验 (纯标准库)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("create", help="从 Markdown 生成 .docx")
    c.add_argument("--from-md", help="Markdown 源文件 (缺省读 --text 或 stdin)")
    c.add_argument("--text", help="直接传入 Markdown 文本")
    c.add_argument("--title", default="", help="文档标题 (写入 Title 样式与元数据)")
    c.add_argument("--out", required=True, help="输出 .docx 路径")
    c.set_defaults(func=cmd_create)

    r = sub.add_parser("read", help="提取 .docx 文本为 Markdown")
    r.add_argument("file")
    r.add_argument("--out", help="写入文件而不是打印到 stdout")
    r.set_defaults(func=cmd_read)

    p = sub.add_parser("replace", help="查找替换正文文本")
    p.add_argument("file")
    p.add_argument("--find", required=True)
    p.add_argument("--with", dest="with_text", default="")
    p.add_argument("--out", help="输出到新文件")
    p.add_argument("--in-place", action="store_true", help="覆盖原文件 (需显式指定)")
    p.add_argument("--all-parts", action="store_true", help="同时处理页眉/页脚/脚注/尾注")
    p.set_defaults(func=cmd_replace)

    v = sub.add_parser("validate", help="结构校验")
    v.add_argument("file")
    v.set_defaults(func=cmd_validate)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
