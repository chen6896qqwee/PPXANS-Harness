#!/usr/bin/env python3
"""PPTX 工具 —— 纯标准库实现 (zipfile + xml.etree)。

子命令:
  create    Markdown 大纲 -> .pptx (封面页/章节页/内容页; 标题、要点、子要点、页码)
  read      提取每页文本 (按形状分行)
  validate  结构校验 (ZIP CRC / XML 良构 / 母版-版式-幻灯片关系 / 空页检测)

生成的包包含 presentation / slideMaster / 空白版式 / theme 与逐页 slide,
不依赖任何模板文件。只依赖 Python 3.9+ 标准库。
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

A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "{%s}" % A_NS
R = "{%s}" % R_NS
P = "{%s}" % P_NS
ZIP_TIME = (2026, 10, 31, 0, 0, 0)
APP_NAME = "PPXANS-Harness"

SLIDE_W = 12192000
SLIDE_H = 6858000

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"""

THEME_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="%s" name="PPX">
<a:themeElements>
<a:clrScheme name="PPX">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="1F2937"/></a:dk2>
<a:lt2><a:srgbClr val="F3F4F6"/></a:lt2>
<a:accent1><a:srgbClr val="2563EB"/></a:accent1>
<a:accent2><a:srgbClr val="0EA5E9"/></a:accent2>
<a:accent3><a:srgbClr val="10B981"/></a:accent3>
<a:accent4><a:srgbClr val="F59E0B"/></a:accent4>
<a:accent5><a:srgbClr val="8B5CF6"/></a:accent5>
<a:accent6><a:srgbClr val="EF4444"/></a:accent6>
<a:hlink><a:srgbClr val="2563EB"/></a:hlink>
<a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="PPX">
<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface="微软雅黑"/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="微软雅黑"/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="PPX">
<a:fillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>
<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:satMod val="110000"/><a:lumMod val="100000"/><a:shade val="100000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>
</a:fillStyleLst>
<a:lnStyleLst>
<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
</a:lnStyleLst>
<a:effectStyleLst>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
</a:effectStyleLst>
<a:bgFillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill>
<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>
</a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
</a:theme>""" % A_NS

MASTER_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="%s" xmlns:r="%s" xmlns:p="%s">
<p:cSld>
<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree>
</p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
<p:txStyles>
<p:titleStyle><a:lvl1pPr><a:defRPr sz="3200" b="1"/></a:lvl1pPr></p:titleStyle>
<p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr><a:lvl2pPr><a:defRPr sz="1600"/></a:lvl2pPr></p:bodyStyle>
<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>
</p:txStyles>
</p:sldMaster>""" % (A_NS, R_NS, P_NS)

MASTER_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>"""

LAYOUT_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="%s" xmlns:r="%s" xmlns:p="%s" type="blank" preserve="1">
<p:cSld name="Blank">
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree>
</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>""" % (A_NS, R_NS, P_NS)

LAYOUT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>"""

SLIDE_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>"""

SPTREE_HEAD = (
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
)
SPTREE_TAIL = "</p:spTree>"


def clean_text(text):
    text = "" if text is None else str(text)
    return "".join(ch for ch in text if ch in "\t\n\r" or ord(ch) >= 32)


def esc(text):
    return xml_escape(clean_text(text))


def textbox(shape_id, name, x, y, cx, cy, paragraphs, anchor="t", align="l"):
    body = "".join(paragraphs) or "<a:p/>"
    return (
        '<p:sp><p:nvSpPr><p:cNvPr id="%d" name="%s"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
        '<p:spPr><a:xfrm><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
        '<p:txBody><a:bodyPr wrap="square" anchor="%s"><a:normAutofit/></a:bodyPr><a:lstStyle/>%s</p:txBody></p:sp>'
        % (shape_id, esc(name), x, y, cx, cy, anchor, body)
    )


def text_para(text, size, color, bold=False, bullet=None, level=0, align="l", space_after=600):
    ppr = '<a:pPr algn="%s"' % align
    inner = ""
    if space_after:
        inner += "<a:spcAft><a:spcPts val=\"%d\"/></a:spcAft>" % space_after
    if bullet:
        marl = 285750 + level * 285750
        indent = -285750
        ppr += ' marL="%d" indent="%d"' % (marl, indent)
        inner += '<a:buFont typeface="Arial"/><a:buChar char="%s"/>' % bullet
    ppr += ">%s</a:pPr>" % inner
    rpr = '<a:rPr lang="zh-CN" altLang="en-US" sz="%d" b="%d" dirty="0"><a:solidFill><a:srgbClr val="%s"/></a:solidFill></a:rPr>' % (
        size,
        1 if bold else 0,
        color,
    )
    return '<a:p>%s<a:r>%s<a:t>%s</a:t></a:r><a:endParaRPr lang="zh-CN" sz="%d" dirty="0"/></a:p>' % (
        ppr,
        rpr,
        esc(text),
        size,
    )


def shape(shape_id, name, prst, x, y, cx, cy, color):
    return (
        '<p:sp><p:nvSpPr><p:cNvPr id="%d" name="%s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        '<p:spPr><a:xfrm><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></a:xfrm>'
        '<a:prstGeom prst="%s"><a:avLst/></a:prstGeom>'
        '<a:solidFill><a:srgbClr val="%s"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>'
        "<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>"
        % (shape_id, esc(name), x, y, cx, cy, prst, color)
    )


def ellipse(shape_id, name, x, y, cx, cy, color):
    return shape(shape_id, name, "ellipse", x, y, cx, cy, color)


def slide_xml(shapes, background=None):
    bg = ""
    if background:
        bg = (
            '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="%s"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>'
            % background
        )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<p:sld xmlns:a="%s" xmlns:r="%s" xmlns:p="%s"><p:cSld>%s%s%s</p:cSld>'
        "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
        % (A_NS, R_NS, P_NS, bg, SPTREE_HEAD, "".join(shapes) + SPTREE_TAIL)
    )


def title_slide(title, subtitle):
    shapes = [
        ellipse(2, "Motif", 9448800, -1371600, 4572000, 4572000, "E8EFFD"),
        textbox(3, "Title", 838200, 2057400, 9662160, 1554480,
                [text_para(title, 4400, "1F2937", bold=True, space_after=0)], anchor="b"),
    ]
    if subtitle:
        shapes.append(textbox(4, "Subtitle", 838200, 3749040, 9662160, 800100,
                              [text_para(subtitle, 2000, "4B5563", space_after=0)]))
    return slide_xml(shapes)


def section_slide(title):
    shapes = [
        ellipse(2, "Motif", 8686800, 3200400, 5486400, 5486400, "1E3A8A"),
        textbox(3, "Section Title", 838200, 2286000, 10515600, 1371600,
                [text_para(title, 4000, "FFFFFF", bold=True, space_after=0)], anchor="ctr"),
    ]
    return slide_xml(shapes, background="1F2937")


def bullet_size(count):
    if count > 11:
        return 1400
    if count > 8:
        return 1600
    return 1800


def content_slide(title, bullets, page_no):
    shapes = [ellipse(2, "Motif", 10424160, -1828800, 3657600, 3657600, "EEF3FD")]
    if title:
        shapes.append(textbox(3, "Title", 838200, 502920, 9662160, 822960,
                              [text_para(title, 3000, "1F2937", bold=True, space_after=0)], anchor="b"))
    size = bullet_size(len(bullets))
    paras = []
    for item in bullets:
        level = item.get("level", 0)
        if level == 0:
            paras.append(text_para(item["text"], size, "374151", bullet="•", space_after=600))
        else:
            paras.append(text_para(item["text"], max(size - 200, 1200), "4B5563", bullet="–", level=level, space_after=400))
    if not paras:
        paras.append(text_para("(本页无正文)", size, "9CA3AF"))
    shapes.append(textbox(4, "Body", 838200, 1554480, 10515600, 4267200, paras))
    shapes.append(textbox(5, "Page Number", 10972800, 6309360, 548640, 320040,
                          [text_para(str(page_no), 1000, "9CA3AF", align="r", space_after=0)], anchor="b", align="r"))
    return slide_xml(shapes)


def parse_outline(md):
    """返回 [{kind,title,subtitle,bullets}]"""
    lines = md.splitlines()
    deck_title = None
    slides = []
    current = None
    for raw in lines:
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped:
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if m:
            level, text = len(m.group(1)), m.group(2).strip()
            if level == 1:
                if deck_title is None and not slides:
                    deck_title = text
                else:
                    slides.append({"kind": "section", "title": text, "bullets": []})
                    current = None
            elif level == 2:
                current = {"kind": "content", "title": text, "bullets": []}
                slides.append(current)
            else:
                if current is not None:
                    current["bullets"].append({"text": text, "level": 2})
            continue
        bullet = re.match(r"^(\s*)[-*+]\s+(.*)$", line)
        if bullet:
            if current is None:
                current = {"kind": "content", "title": "", "bullets": []}
                slides.append(current)
            level = 1 if len(bullet.group(1)) >= 2 else 0
            current["bullets"].append({"text": bullet.group(2).strip(), "level": level})
            continue
        if current is None:
            continue
        current["bullets"].append({"text": stripped, "level": 0})
    return deck_title, slides


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
        "</cp:coreProperties>" % (esc(title), APP_NAME, APP_NAME, now, now)
    )


def app_xml(slide_count):
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"'
        ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
        "<Application>%s</Application><PresentationFormat>宽屏</PresentationFormat>"
        "<Slides>%d</Slides></Properties>" % (APP_NAME, slide_count)
    )


def write_pptx(path, slide_xmls, title):
    n = len(slide_xmls)
    ct = CONTENT_TYPES.replace(
        "</Types>",
        "".join(
            '<Override PartName="/ppt/slides/slide%d.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
            % i
            for i in range(1, n + 1)
        )
        + "</Types>",
    )

    pres = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<p:presentation xmlns:a="%s" xmlns:r="%s" xmlns:p="%s">' % (A_NS, R_NS, P_NS),
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>',
        "<p:sldIdLst>",
    ]
    for i in range(1, n + 1):
        pres.append('<p:sldId id="%d" r:id="rId%d"/>' % (255 + i, i + 1))
    pres.append("</p:sldIdLst>")
    pres.append('<p:sldSz cx="%d" cy="%d"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>' % (SLIDE_W, SLIDE_H))

    pres_rels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
                 '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
                 '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>']
    for i in range(1, n + 1):
        pres_rels.append(
            '<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide%d.xml"/>'
            % (i + 1, i)
        )
    pres_rels.append("</Relationships>")

    entries = {
        "[Content_Types].xml": ct,
        "_rels/.rels": ROOT_RELS,
        "docProps/core.xml": core_xml(title),
        "docProps/app.xml": app_xml(n),
        "ppt/presentation.xml": "".join(pres),
        "ppt/_rels/presentation.xml.rels": "".join(pres_rels),
        "ppt/slideMasters/slideMaster1.xml": MASTER_XML,
        "ppt/slideMasters/_rels/slideMaster1.xml.rels": MASTER_RELS,
        "ppt/slideLayouts/slideLayout1.xml": LAYOUT_XML,
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels": LAYOUT_RELS,
        "ppt/theme/theme1.xml": THEME_XML,
    }
    order = [
        "[Content_Types].xml",
        "_rels/.rels",
        "docProps/core.xml",
        "docProps/app.xml",
        "ppt/presentation.xml",
        "ppt/_rels/presentation.xml.rels",
        "ppt/slideMasters/slideMaster1.xml",
        "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        "ppt/slideLayouts/slideLayout1.xml",
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        "ppt/theme/theme1.xml",
    ]
    for i, xml in enumerate(slide_xmls, start=1):
        entries["ppt/slides/slide%d.xml" % i] = xml
        entries["ppt/slides/_rels/slide%d.xml.rels" % i] = SLIDE_RELS
        order.append("ppt/slides/slide%d.xml" % i)
        order.append("ppt/slides/_rels/slide%d.xml.rels" % i)

    tmp = path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in order:
            info = zipfile.ZipInfo(name, date_time=ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, entries[name])
    os.replace(tmp, path)


def cmd_create(args):
    if args.from_md:
        with open(args.from_md, "r", encoding="utf-8") as fh:
            md = fh.read()
    elif args.text is not None:
        md = args.text
    else:
        md = sys.stdin.read()

    deck_title, slides = parse_outline(md)
    deck_title = args.title or deck_title or "未命名演示"
    subtitle = args.subtitle or ""

    if not slides:
        slides = [{"kind": "content", "title": "", "bullets": [{"text": "（请补充大纲）", "level": 0}]}]

    xmls = []
    page = 1
    warnings = []
    for idx, slide in enumerate(slides):
        if idx == 0 and slide["kind"] == "content" and not slide["title"] and not args.no_title_slide:
            xmls.append(title_slide(deck_title, subtitle))
            page += 1
            xmls.append(content_slide("", slide["bullets"], page))
            page += 1
            continue
        if idx == 0 and not args.no_title_slide:
            xmls.append(title_slide(deck_title, subtitle))
            page += 1
        if slide["kind"] == "section":
            xmls.append(section_slide(slide["title"]))
            page += 1
        else:
            if len(slide["bullets"]) > 11:
                warnings.append("「%s」有 %d 条要点, 单页过密, 建议拆分" % (slide["title"] or "无标题页", len(slide["bullets"])))
            xmls.append(content_slide(slide["title"], slide["bullets"], page))
            page += 1

    write_pptx(args.out, xmls, deck_title)
    stats = {
        "out": os.path.abspath(args.out),
        "slides": len(xmls),
        "deck_title": deck_title,
        "warnings": warnings,
        "bytes": os.path.getsize(args.out),
    }
    print(json.dumps(stats, ensure_ascii=False))
    return 0


# ---------------------------------------------------------------- read

def load_presentation_slides(zf):
    pres = ET.fromstring(zf.read("ppt/presentation.xml"))
    rels = ET.fromstring(zf.read("ppt/_rels/presentation.xml.rels"))
    targets = {}
    for rel in rels:
        target = rel.get("Target") or ""
        if target.startswith("/"):
            target = target.lstrip("/")
        elif not target.startswith("ppt/"):
            target = "ppt/" + target
        targets[rel.get("Id")] = target.replace("/./", "/")
    out = []
    for sld in pres.findall(P + "sldIdLst/" + P + "sldId"):
        rid = sld.get(R + "id")
        if rid in targets:
            out.append(targets[rid])
    return out


def slide_text(part_xml):
    root = ET.fromstring(part_xml)
    blocks = []
    for sp in root.iter(P + "sp"):
        name = ""
        cnv = sp.find(P + "nvSpPr/" + P + "cNvPr")
        if cnv is not None:
            name = cnv.get("name") or ""
        paras = []
        for para in sp.iter(A + "p"):
            text = "".join(t.text or "" for t in para.iter(A + "t"))
            if text.strip():
                paras.append(text.strip())
        if paras:
            blocks.append((name, paras))
    if not blocks:
        # 表格/组合等其他承载文本的图形
        all_text = ["".join(t.text or "" for t in p.iter(A + "t")).strip() for p in root.iter(A + "p")]
        all_text = [t for t in all_text if t]
        if all_text:
            blocks.append(("", all_text))
    return blocks


def cmd_read(args):
    with zipfile.ZipFile(args.file) as zf:
        parts = load_presentation_slides(zf)
        chunks = []
        for idx, part in enumerate(parts, start=1):
            if part not in zf.namelist():
                chunks.append("## 第 %d 页 (部件缺失: %s)" % (idx, part))
                continue
            chunks.append("## 第 %d 页" % idx)
            for name, paras in slide_text(zf.read(part)):
                label = ("[%s] " % name) if args.labels and name else ""
                for i, text in enumerate(paras):
                    chunks.append(label + text if i == 0 else text)
            chunks.append("")
        text = "\n".join(chunks).rstrip("\n") + "\n"
        if args.out:
            with open(args.out, "w", encoding="utf-8") as fh:
                fh.write(text)
            print(json.dumps({"out": os.path.abspath(args.out), "slides": len(parts), "chars": len(text)}, ensure_ascii=False))
        else:
            sys.stdout.write(text)
    return 0


# ---------------------------------------------------------------- validate

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
            for part in (
                "[Content_Types].xml",
                "_rels/.rels",
                "ppt/presentation.xml",
                "ppt/slideMasters/slideMaster1.xml",
                "ppt/slideLayouts/slideLayout1.xml",
                "ppt/theme/theme1.xml",
            ):
                if part not in names:
                    errors.append("缺少必需部件: %s" % part)
            for name in sorted(names):
                if name.endswith((".xml", ".rels")):
                    try:
                        ET.fromstring(zf.read(name))
                    except ET.ParseError as exc:
                        errors.append("XML 不良构: %s (%s)" % (name, exc))
            parts = []
            if "ppt/presentation.xml" in names and "ppt/_rels/presentation.xml.rels" in names:
                parts = load_presentation_slides(zf)
                if not parts:
                    warnings.append("演示文稿没有任何幻灯片")
                for idx, part in enumerate(parts, start=1):
                    if part not in names:
                        errors.append("第 %d 页指向缺失部件: %s" % (idx, part))
                        continue
                    rels_part = part.rsplit("/", 1)[0] + "/_rels/" + part.rsplit("/", 1)[1] + ".rels"
                    if rels_part not in names:
                        warnings.append("%s 没有关系文件: 打开时可能提示修复" % part)
                    blocks = slide_text(zf.read(part))
                    chars = sum(len(t) for _, paras in blocks for t in paras)
                    if chars == 0:
                        warnings.append("第 %d 页没有任何文本" % idx)
                    info.setdefault("slide_text_chars", []).append(chars)
            info["slides"] = len(parts)
            info["media"] = len([n for n in names if n.startswith("ppt/media/")])
            info["shapes"] = sum(
                1
                for n in names
                if n.startswith("ppt/slides/slide")
                and n.endswith(".xml")
                for _ in ET.fromstring(zf.read(n)).iter(P + "sp")
            )
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
    ap = argparse.ArgumentParser(prog="pptx_tool.py", description="PPTX 生成/读取/校验 (纯标准库)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("create", help="Markdown 大纲 -> pptx")
    c.add_argument("--from-md", help="Markdown 大纲文件 (缺省读 --text 或 stdin)")
    c.add_argument("--text", help="直接传入 Markdown 大纲")
    c.add_argument("--title", help="封面主标题 (缺省取大纲第一个 # 标题)")
    c.add_argument("--subtitle", default="", help="封面副标题")
    c.add_argument("--no-title-slide", action="store_true", help="不自动追加封面页")
    c.add_argument("--out", required=True)
    c.set_defaults(func=cmd_create)

    r = sub.add_parser("read", help="提取每页文本")
    r.add_argument("file")
    r.add_argument("--labels", action="store_true", help="标注形状名称")
    r.add_argument("--out", help="写入文件而不是打印到 stdout")
    r.set_defaults(func=cmd_read)

    v = sub.add_parser("validate", help="结构校验")
    v.add_argument("file")
    v.set_defaults(func=cmd_validate)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
