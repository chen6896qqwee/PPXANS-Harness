#!/usr/bin/env python3
"""XLSX 工具 —— 纯标准库实现 (zipfile + xml.etree)。

子命令:
  create    从 CSV/TSV 或 JSON 生成 .xlsx (首行表头加粗冻结+筛选, 数字/公式识别, 列宽自适应)
  read      读取工作表为 TSV/JSON (共享字符串/内联字符串/数字/布尔/日期/公式)
  validate  结构校验 (ZIP CRC / XML 良构 / 必需部件 / 单元格引用 / 公式缓存值)

单元格内容以 "=" 开头时写成公式; 公式不带缓存值, 打开时由 Excel/LibreOffice 重算。
只依赖 Python 3.9+ 标准库, 不联网。
"""

import argparse
import csv
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape as xml_escape

S_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
S = "{%s}" % S_NS
ZIP_TIME = (2026, 10, 31, 0, 0, 0)
APP_NAME = "PPXANS-Harness"
MAX_ROWS = 1048576
MAX_COLS = 16384
NUM_RE = re.compile(r"^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$")

STYLES_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="%s">
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>
<font><i/><sz val="11"/><color rgb="FF9CA3AF"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF2F6FA"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD0D7DE"/></left><right style="thin"><color rgb="FFD0D7DE"/></right><top style="thin"><color rgb="FFD0D7DE"/></top><bottom style="thin"><color rgb="FFD0D7DE"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>""" % S_NS


def col_letter(idx):
    """1 -> A, 27 -> AA"""
    out = ""
    while idx > 0:
        idx, rem = divmod(idx - 1, 26)
        out = chr(65 + rem) + out
    return out


def col_index(letters):
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch.upper()) - 64)
    return n


def cell_ref(row, col):
    return "%s%d" % (col_letter(col), row)


REF_RE = re.compile(r"^([A-Z]+)(\d+)$")


def display_len(text):
    return sum(2 if ord(ch) > 127 else 1 for ch in str(text))


# ---------------------------------------------------------------- create

def sniff_delimiter(sample):
    try:
        return csv.Sniffer().sniff(sample, delimiters=",\t;|").delimiter
    except csv.Error:
        return ","


def load_rows(args):
    if args.from_json:
        with open(args.from_json, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, list):
            raise SystemExit("JSON 必须是二维数组, 或对象数组")
        if data and isinstance(data[0], dict):
            headers = []
            for item in data:
                for key in item:
                    if key not in headers:
                        headers.append(key)
            return [headers] + [[item.get(h, "") for h in headers] for item in data]
        return [list(row) for row in data]

    if args.from_csv:
        with open(args.from_csv, "r", encoding="utf-8-sig", newline="") as fh:
            sample = fh.read(8192)
            fh.seek(0)
            delim = args.delimiter or sniff_delimiter(sample)
            return [row for row in csv.reader(fh, delimiter=delim)]
    if args.text is not None:
        delim = args.delimiter or sniff_delimiter(args.text[:4096])
        return [row for row in csv.reader(args.text.splitlines(), delimiter=delim)]
    delim = args.delimiter or sniff_delimiter(sys.stdin.read(8192))
    return [row for row in csv.reader(sys.stdin, delimiter=delim)]


def number_like(value):
    if not NUM_RE.match(value):
        return False
    mantissa = value.lstrip("+-").split("e")[0].split("E")[0]
    int_part = mantissa.split(".", 1)[0]
    if len(int_part) > 15:
        return False
    if len(int_part) > 1 and int_part.startswith("0"):
        return False  # 保留工号/电话/邮编等前导零
    return True


def cell_xml(ref, raw, style):
    if raw is None:
        return ""
    if isinstance(raw, bool):
        return '<c r="%s" s="%d" t="b"><v>%d</v></c>' % (ref, style, 1 if raw else 0)
    if isinstance(raw, (int, float)):
        return '<c r="%s" s="%d"><v>%s</v></c>' % (ref, style, raw)
    text = str(raw)
    if text == "":
        return '<c r="%s" s="%d"/>' % (ref, style)
    if text.startswith("=") and len(text) > 1:
        formula = xml_escape(text[1:])
        return '<c r="%s" s="%d"><f>%s</f></c>' % (ref, style, formula)
    if number_like(text):
        return '<c r="%s" s="%d"><v>%s</v></c>' % (ref, style, text)
    space = ' xml:space="preserve"' if text != text.strip() else ""
    return '<c r="%s" s="%d" t="inlineStr"><is><t%s>%s</t></is></c>' % (
        ref,
        style,
        space,
        xml_escape(text),
    )


def sheet_xml(rows, header):
    ncols = max((len(r) for r in rows), default=0)
    nrows = len(rows)
    if nrows > MAX_ROWS or ncols > MAX_COLS:
        raise SystemExit("超出工作表上限: %d 行 x %d 列" % (nrows, ncols))
    widths = []
    for c in range(ncols):
        longest = max((display_len(r[c]) for r in rows if c < len(r) and r[c] is not None), default=0)
        widths.append(min(52, max(8, int(longest * 1.15) + 2)))

    parts = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<worksheet xmlns="%s" xmlns:r="%s">' % (S_NS, R_NS),
        '<dimension ref="A1:%s"/>' % cell_ref(max(nrows, 1), max(ncols, 1)),
        '<sheetViews><sheetView workbookViewId="0">',
    ]
    if header and nrows > 1:
        parts.append(
            '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
            '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
        )
    parts.append("</sheetView></sheetViews><sheetFormatPr defaultRowHeight=\"15\"/>")
    if widths:
        parts.append("<cols>")
        for idx, width in enumerate(widths, start=1):
            parts.append('<col min="%d" max="%d" width="%d" customWidth="1"/>' % (idx, idx, width))
        parts.append("</cols>")
    parts.append("<sheetData>")
    for r_idx, row in enumerate(rows, start=1):
        is_header = header and r_idx == 1
        style = 1 if is_header else 2
        cells = "".join(
            cell_xml(cell_ref(r_idx, c_idx), value, style)
            for c_idx, value in enumerate(row, start=1)
        )
        parts.append('<row r="%d" spans="1:%d">%s</row>' % (r_idx, max(ncols, 1), cells))
    parts.append("</sheetData>")
    if header and nrows > 1 and ncols > 0:
        parts.append('<autoFilter ref="A1:%s"/>' % cell_ref(nrows, ncols))
    parts.append("</worksheet>")
    return "".join(parts)


def sanitize_sheet_name(name):
    name = re.sub(r"[\[\]:*?/\\\"']", "_", (name or "").strip()) or "Sheet1"
    return name[:31]


def write_xlsx(path, sheets, header=True):
    """sheets: [(name, rows)]"""
    if not sheets:
        raise SystemExit("没有工作表")
    names = []
    for name, _ in sheets:
        base = sanitize_sheet_name(name)
        candidate, n = base, 2
        while candidate in names:
            suffix = "(%d)" % n
            candidate = base[: 31 - len(suffix)] + suffix
            n += 1
        names.append(candidate)

    ct = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    ]
    for i in range(1, len(sheets) + 1):
        ct.append(
            '<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            % i
        )
    ct.append("</Types>")

    rels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']
    wb = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="%s" xmlns:r="%s">' % (S_NS, R_NS),
          "<sheets>"]
    for i, name in enumerate(names, start=1):
        wb.append('<sheet name="%s" sheetId="%d" r:id="rId%d"/>' % (xml_escape(name), i, i))
        rels.append(
            '<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>'
            % (i, i)
        )
    rels.append(
        '<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        % (len(sheets) + 1)
    )
    rels.append("</Relationships>")
    wb.append("</sheets>")
    # 公式没有缓存值, 必须让应用打开时重算
    wb.append('<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>')

    root_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"""

    core = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
        ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"'
        ' xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        "<dc:title>%s</dc:title><dc:creator>%s</dc:creator><cp:lastModifiedBy>%s</cp:lastModifiedBy>"
        "</cp:coreProperties>" % (xml_escape(names[0]), APP_NAME, APP_NAME)
    )
    app = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"'
        ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
        "<Application>%s</Application></Properties>" % APP_NAME
    )

    tmp = path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        entries = {
            "[Content_Types].xml": "".join(ct),
            "_rels/.rels": root_rels,
            "docProps/core.xml": core,
            "docProps/app.xml": app,
            "xl/workbook.xml": "".join(wb),
            "xl/_rels/workbook.xml.rels": "".join(rels),
            "xl/styles.xml": STYLES_XML,
        }
        for i, (_, rows) in enumerate(sheets, start=1):
            entries["xl/worksheets/sheet%d.xml" % i] = sheet_xml(rows, header=header)
        for name in [
            "[Content_Types].xml",
            "_rels/.rels",
            "docProps/core.xml",
            "docProps/app.xml",
            "xl/workbook.xml",
            "xl/_rels/workbook.xml.rels",
            "xl/styles.xml",
        ] + ["xl/worksheets/sheet%d.xml" % i for i in range(1, len(sheets) + 1)]:
            info = zipfile.ZipInfo(name, date_time=ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, entries[name])
    os.replace(tmp, path)


def cmd_create(args):
    rows = load_rows(args)
    rows = [row for row in rows if any(str(c).strip() for c in row)]
    if not rows:
        raise SystemExit("输入没有任何数据行")
    header = not args.no_header
    write_xlsx(args.out, [(args.sheet, rows)], header=header)
    print(json.dumps({
        "out": os.path.abspath(args.out),
        "sheet": args.sheet,
        "rows": len(rows),
        "cols": max(len(r) for r in rows),
        "header": header,
        "bytes": os.path.getsize(args.out),
    }, ensure_ascii=False))
    return 0


# ---------------------------------------------------------------- read

def load_shared_strings(zf):
    try:
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    out = []
    for si in root.findall(S + "si"):
        out.append("".join(t.text or "" for t in si.iter(S + "t")))
    return out


def load_sheets(zf):
    """返回 [(name, part_path)]"""
    wb = ET.fromstring(zf.read("xl/workbook.xml"))
    rels_root = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    targets = {}
    for rel in rels_root:
        rid = rel.get("Id")
        target = rel.get("Target") or ""
        if target.startswith("/"):
            target = target.lstrip("/")
        elif not target.startswith("xl/"):
            target = "xl/" + target
        targets[rid] = target.replace("/./", "/")
    sheets = []
    for sh in wb.findall(S + "sheets/" + S + "sheet"):
        rid = sh.get("{%s}id" % R_NS)
        sheets.append((sh.get("name"), targets.get(rid)))
    return sheets


def cell_value(cell, shared):
    t = cell.get("t")
    f = cell.find(S + "f")
    formula = f.text if f is not None else None
    if t == "inlineStr":
        value = "".join(x.text or "" for x in cell.iter(S + "t"))
    else:
        v = cell.find(S + "v")
        raw = v.text if v is not None else None
        if raw is None:
            value = ""
        elif t == "s":
            value = shared[int(raw)] if raw.isdigit() and int(raw) < len(shared) else ""
        elif t == "b":
            value = "TRUE" if raw == "1" else "FALSE"
        elif t == "e":
            value = raw
        else:
            value = raw
            if t is None:
                try:
                    value = int(raw) if re.match(r"^-?\d+$", raw) else float(raw)
                except ValueError:
                    value = raw
    return formula, value


def read_sheet(zf, part, shared, want_formula):
    root = ET.fromstring(zf.read(part))
    rows = []
    for row in root.findall(S + "sheetData/" + S + "row"):
        cells = {}
        for cell in row.findall(S + "c"):
            ref = cell.get("r") or ""
            m = REF_RE.match(ref)
            if m:
                col = col_index(m.group(1))
            else:
                col = len(cells) + 1
            formula, value = cell_value(cell, shared)
            if formula and (want_formula or value == ""):
                value = "=" + formula
            cells[col] = value
        width = max(cells) if cells else 0
        rows.append([cells.get(i, "") for i in range(1, width + 1)])
    return rows


def cmd_read(args):
    with zipfile.ZipFile(args.file) as zf:
        shared = load_shared_strings(zf)
        sheets = load_sheets(zf)
        if not sheets:
            raise SystemExit("工作簿里没有工作表")
        if args.sheet:
            matched = [(n, p) for n, p in sheets if n == args.sheet]
            if not matched and args.sheet.isdigit():
                idx = int(args.sheet) - 1
                if 0 <= idx < len(sheets):
                    matched = [sheets[idx]]
            if not matched:
                raise SystemExit("找不到工作表: %s (可用: %s)" % (args.sheet, ", ".join(n for n, _ in sheets)))
            selected = matched
        else:
            selected = sheets

        if args.json:
            payload = {"sheets": []}
            for name, part in selected:
                rows = read_sheet(zf, part, shared, args.formulas)
                payload["sheets"].append({"name": name, "rows": rows})
            text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
        else:
            chunks = []
            for name, part in selected:
                rows = read_sheet(zf, part, shared, args.formulas)
                if len(selected) > 1:
                    chunks.append("## 工作表: %s" % name)
                for row in rows:
                    chunks.append("\t".join(str(v).replace("\t", " ") for v in row))
                if len(selected) > 1:
                    chunks.append("")
            text = "\n".join(chunks).rstrip("\n") + "\n"

        if args.out:
            with open(args.out, "w", encoding="utf-8") as fh:
                fh.write(text)
            print(json.dumps({"out": os.path.abspath(args.out), "chars": len(text)}, ensure_ascii=False))
        else:
            sys.stdout.write(text)
    return 0


# ---------------------------------------------------------------- validate

def cmd_validate(args):
    errors = []
    warnings = []
    info = {"file": os.path.abspath(args.file), "sheets": []}
    try:
        with zipfile.ZipFile(args.file) as zf:
            bad = zf.testzip()
            if bad:
                errors.append("ZIP CRC 校验失败: %s" % bad)
            names = set(zf.namelist())
            for part in ("[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"):
                if part not in names:
                    errors.append("缺少必需部件: %s" % part)
            for name in sorted(names):
                if name.endswith((".xml", ".rels")):
                    try:
                        ET.fromstring(zf.read(name))
                    except ET.ParseError as exc:
                        errors.append("XML 不良构: %s (%s)" % (name, exc))
            if "xl/workbook.xml" in names:
                try:
                    sheets = load_sheets(zf)
                except (KeyError, ET.ParseError) as exc:
                    sheets = []
                    errors.append("工作簿关系不可读: %s" % exc)
                for name, part in sheets:
                    if not part or part not in names:
                        errors.append("工作表 %s 指向缺失部件: %s" % (name, part))
                        continue
                    root = ET.fromstring(zf.read(part))
                    cells = list(root.iter(S + "c"))
                    formulas = list(root.iter(S + "f"))
                    no_cache = 0
                    for c in cells:
                        if c.find(S + "f") is not None and c.find(S + "v") is None:
                            no_cache += 1
                    bad_ref = 0
                    for c in cells:
                        ref = c.get("r")
                        if ref and not REF_RE.match(ref):
                            bad_ref += 1
                    rows = len(list(root.findall(S + "sheetData/" + S + "row")))
                    info["sheets"].append({
                        "name": name,
                        "rows": rows,
                        "cells": len(cells),
                        "formulas": len(formulas),
                        "formulas_without_cache": no_cache,
                    })
                    if bad_ref:
                        warnings.append("%s: %d 个单元格引用不是 A1 形式" % (name, bad_ref))
                    if no_cache:
                        warnings.append("%s: %d 个公式没有缓存值, 需 Excel/LibreOffice 打开后重算" % (name, no_cache))
                    if rows == 0:
                        warnings.append("%s: 工作表为空" % name)
                if "xl/styles.xml" not in names:
                    warnings.append("没有 xl/styles.xml: 表格会显示为无边框纯文本")
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
    ap = argparse.ArgumentParser(prog="xlsx_tool.py", description="XLSX 读写/校验 (纯标准库)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("create", help="CSV/TSV/JSON -> xlsx")
    src = c.add_mutually_exclusive_group()
    src.add_argument("--from-csv", help="CSV/TSV 文件")
    src.add_argument("--from-json", help="二维数组 JSON, 或对象数组 JSON")
    src.add_argument("--text", help="直接传入 CSV 文本")
    c.add_argument("--delimiter", help="分隔符, 缺省自动识别")
    c.add_argument("--sheet", default="Sheet1", help="工作表名")
    c.add_argument("--no-header", action="store_true", help="首行是数据, 不加粗冻结与筛选")
    c.add_argument("--out", required=True)
    c.set_defaults(func=cmd_create)

    r = sub.add_parser("read", help="读取工作表为 TSV/JSON")
    r.add_argument("file")
    r.add_argument("--sheet", help="工作表名或 1-based 序号")
    r.add_argument("--formulas", action="store_true", help="有公式时输出公式而非缓存值")
    r.add_argument("--json", action="store_true", help="输出 JSON")
    r.add_argument("--out", help="写入文件而不是打印到 stdout")
    r.set_defaults(func=cmd_read)

    v = sub.add_parser("validate", help="结构校验")
    v.add_argument("file")
    v.set_defaults(func=cmd_validate)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
