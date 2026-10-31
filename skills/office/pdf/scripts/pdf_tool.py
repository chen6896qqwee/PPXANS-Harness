#!/usr/bin/env python3
"""PDF 工具 —— 纯标准库实现 (zlib + 正则)。

子命令:
  info      版本/页数/加密/元数据/对象与图片计数
  text      尽力提取文本层 (解压 FlateDecode 流, 读 Tj/TJ/'/" 操作符)
  validate  结构校验 (文件头/EOF/startxref/页面树/页数/文本层/是否扫描件)

只读, 不修改原文件, 不联网。
局限: 不含 PDF 解析器, 不解析 ToUnicode CMap, 因此使用 CID/自定义编码的
中文 PDF 可能提取出乱码; 这类文件请用带 OCR 的读文档工具或 pdftotext。
"""

import argparse
import json
import os
import re
import sys
import zlib

STREAM_RE = re.compile(rb"stream\r?\n")
OBJ_RE = re.compile(rb"(\d+)\s+(\d+)\s+obj\b(.*?)\bendobj", re.S)
PAGE_RE = re.compile(rb"/Type\s*/Page(?![sA-Za-z])")
HEX_RE = re.compile(rb"<([0-9A-Fa-f\s]+)>")
STRING_RE = re.compile(rb"\((?:\\.|[^\\()])*\)")
TEXT_TOKEN_RE = re.compile(
    rb"(\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>)"  # 1: 字符串
    rb"|(T\*|'|\")"                                # 2: 换行/带换行显示
    rb"|(TJ|Tj)"                                   # 3: 显示操作符
)


def read_bytes(path):
    with open(path, "rb") as fh:
        return fh.read()


def decode_string(raw):
    """PDF 字符串: (...) 带转义, <...> 十六进制; 尽量还原可读文本。"""
    if raw.startswith(b"<"):
        hexdata = re.sub(rb"\s+", b"", raw[1:-1])
        if len(hexdata) % 2:
            hexdata += b"0"
        try:
            data = bytes.fromhex(hexdata.decode("ascii"))
        except ValueError:
            return ""
    else:
        body = raw[1:-1]
        out = bytearray()
        i = 0
        while i < len(body):
            ch = body[i]
            if ch == 0x5C and i + 1 < len(body):  # 反斜杠转义
                nxt = body[i + 1]
                mapping = {0x6E: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12}
                if nxt in mapping:
                    out.append(mapping[nxt])
                    i += 2
                    continue
                if 0x30 <= nxt <= 0x37:  # 八进制
                    digits = body[i + 1:i + 4]
                    m = re.match(rb"[0-7]{1,3}", digits)
                    out.append(int(m.group(0), 8) & 0xFF)
                    i += 1 + len(m.group(0))
                    continue
                if nxt in (0x28, 0x29, 0x5C):
                    out.append(nxt)
                    i += 2
                    continue
                if nxt in (0x0A, 0x0D):  # 续行
                    i += 2
                    continue
                out.append(nxt)
                i += 2
                continue
            out.append(ch)
            i += 1
        data = bytes(out)

    if data.startswith(b"\xfe\xff"):
        return data[2:].decode("utf-16-be", "replace")
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", "replace")
    return data.decode("latin-1", "replace")


def decompress_stream(dict_slice, payload):
    if b"FlateDecode" not in dict_slice:
        return None
    try:
        return zlib.decompress(payload)
    except zlib.error:
        try:
            return zlib.decompressobj().decompress(payload)
        except zlib.error:
            return None


def iter_streams(data):
    """返回 [(所属对象字典切片, 流内容)]; 含未压缩流与 FlateDecode 流, 跳过图像等二进制流。"""
    out = []
    for m in STREAM_RE.finditer(data):
        start = m.end()
        end = data.find(b"endstream", start)
        if end < 0:
            continue
        payload = data[start:end].rstrip(b"\r\n")
        obj_start = data.rfind(b" obj", 0, m.start())
        dict_slice = data[obj_start if obj_start >= 0 else max(0, m.start() - 1024):m.start()]
        if b"/Filter" in dict_slice and b"FlateDecode" not in dict_slice:
            continue  # DCTDecode/JPXDecode 等图像流, 没有可读文本
        if b"FlateDecode" in dict_slice:
            decoded = decompress_stream(dict_slice, payload)
            if decoded is None:
                continue
        else:
            decoded = payload
        out.append((dict_slice, decoded))
    return out


def raw_or_stream_text(data, streams):
    blob = data + b"\n" + b"\n".join(s for _, s in streams)
    return blob


def pdf_meta(data):
    meta = {}
    m = re.search(rb"/Info\s+(\d+)\s+0\s+R", data)
    if not m:
        return meta
    num = m.group(1)
    obj = re.search(rb"(?<!\d)" + re.escape(num) + rb"\s+0\s+obj\b(.*?)\bendobj", data, re.S)
    if not obj:
        return meta
    body = obj.group(1)
    for key in (b"Title", b"Author", b"Creator", b"Producer", b"CreationDate", b"ModDate"):
        km = re.search(rb"/" + key + rb"\s*(\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>)", body, re.S)
        if km:
            meta[key.decode()] = decode_string(km.group(1)).strip("\x00")
    return meta


def analyse(path):
    data = read_bytes(path)
    streams = iter_streams(data)
    blob = raw_or_stream_text(data, streams)
    header = re.search(rb"%PDF-(\d\.\d)", data[:1024])
    pages = len(PAGE_RE.findall(blob))
    count_m = re.findall(rb"/Count\s+(\d+)", blob)
    if pages == 0 and count_m:
        pages = max(int(x) for x in count_m)
    text = extract_text(streams)
    info = {
        "file": os.path.abspath(path),
        "bytes": len(data),
        "version": header.group(1).decode() if header else None,
        "pages": pages,
        "encrypted": b"/Encrypt" in data,
        "linearized": b"/Linearized" in data,
        "objects": len(OBJ_RE.findall(data)),
        "images": len(re.findall(rb"/Subtype\s*/Image", blob)),
        "fonts": len(re.findall(rb"/Type\s*/Font", blob)),
        "has_text_layer": bool(text.strip()),
        "metadata": pdf_meta(data),
    }
    return info, data, streams, blob, text


# ---------------------------------------------------------------- text

def extract_text(streams):
    lines = []
    for _, content in streams:
        if b"BT" not in content:
            continue
        for block in re.findall(rb"BT(.*?)ET", content, re.S):
            buf = []
            for m in TEXT_TOKEN_RE.finditer(block):
                if m.group(1):
                    buf.append(decode_string(m.group(1)))
                elif m.group(2):
                    buf.append("\n")
            text = "".join(buf).replace("\x00", "").strip()
            if text:
                lines.append(text)
    return "\n".join(lines)


def cmd_text(args):
    _, _, _, _, text = analyse(args.file)
    printable = sum(1 for ch in text if ch.isprintable() or ch in "\n\t")
    ratio = (printable / len(text)) if text else 0.0
    payload = {
        "file": os.path.abspath(args.file),
        "chars": len(text),
        "printable_ratio": round(ratio, 3),
    }
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
        payload["out"] = os.path.abspath(args.out)
        print(json.dumps(payload, ensure_ascii=False))
    else:
        if text:
            sys.stdout.write(text + "\n")
        sys.stderr.write(json.dumps(payload, ensure_ascii=False) + "\n")
    if text and ratio < 0.9:
        sys.stderr.write("提示: 可打印字符比例偏低, 该 PDF 可能使用自定义编码 (常见于中文 PDF), 建议改用 OCR/专用解析工具。\n")
    return 0


# ---------------------------------------------------------------- info / validate

def cmd_info(args):
    info, _, _, _, _ = analyse(args.file)
    print(json.dumps(info, ensure_ascii=False, indent=2))
    return 0


def cmd_validate(args):
    errors = []
    warnings = []
    try:
        info, data, _, blob, _ = analyse(args.file)
    except OSError as exc:
        print(json.dumps({"file": args.file, "ok": False, "errors": [str(exc)]}, ensure_ascii=False, indent=2))
        return 1

    if not data.lstrip().startswith(b"%PDF-"):
        errors.append("文件头不是 %PDF- (可能不是 PDF 或被截断)")
    if b"%%EOF" not in data[-4096:]:
        warnings.append("文件末尾 4KB 内没有 %%EOF: 文件可能被截断")
    if b"startxref" not in data:
        warnings.append("缺少 startxref: 交叉引用表可能损坏")
    if b"/Type/XRef" not in blob and b"/Type /XRef" not in blob and b"xref" not in data:
        warnings.append("未发现 xref: 需用修复工具重建交叉引用")
    if b"/Type/Catalog" not in blob and b"/Type /Catalog" not in blob:
        errors.append("找不到文档目录对象 (/Type /Catalog)")
    if info["pages"] == 0:
        errors.append("页数为 0: 页面树缺失或损坏")
    if info["encrypted"]:
        warnings.append("PDF 已加密: 文本与结构检查可能不完整")
    if info["pages"] and not info["has_text_layer"]:
        warnings.append("没有文本层: 可能是扫描件, 需 OCR 才能取字")
    if info["images"] and not info["has_text_layer"]:
        warnings.append("含 %d 张图片且无文本层: 扫描件特征" % info["images"])

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
    ap = argparse.ArgumentParser(prog="pdf_tool.py", description="PDF 结构/文本/校验 (纯标准库)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    i = sub.add_parser("info", help="页数/版本/加密/元数据/对象计数")
    i.add_argument("file")
    i.set_defaults(func=cmd_info)

    t = sub.add_parser("text", help="尽力提取文本层")
    t.add_argument("file")
    t.add_argument("--out", help="写入文件而不是打印到 stdout")
    t.set_defaults(func=cmd_text)

    v = sub.add_parser("validate", help="结构校验")
    v.add_argument("file")
    v.set_defaults(func=cmd_validate)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
