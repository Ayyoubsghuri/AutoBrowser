"""Data sources for row-by-row automation: Excel / CSV tables and PDFs.

Everything here runs locally. PDFs become one row per file; fields come from
fillable-form fields, or from rules (text after a label, or a regex).
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import re
from typing import Any

TRUTHY = {"1", "true", "yes", "y", "x", "✓", "✔", "on", "checked", "oui", "si", "sí", "ja", "نعم", "vrai"}


def norm_cell(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v)
    if isinstance(v, dt.datetime):
        return v.strftime("%Y-%m-%d") if (v.hour, v.minute, v.second) == (0, 0, 0) else v.strftime("%Y-%m-%d %H:%M")
    if isinstance(v, dt.date):
        return v.strftime("%Y-%m-%d")
    return str(v).strip()


def _columns(header: list[Any], width: int) -> list[str]:
    cols, seen = [], {}
    for i in range(width):
        name = norm_cell(header[i]) if i < len(header) else ""
        name = name or f"col_{i + 1}"
        if name in seen:
            seen[name] += 1
            name = f"{name}_{seen[name]}"
        else:
            seen[name] = 1
        cols.append(name)
    return cols


def _to_table(matrix: list[list[Any]], header_row: int = 1) -> tuple[list[str], list[dict[str, str]]]:
    matrix = [r for r in matrix]
    if not matrix:
        return [], []
    hi = max(0, header_row - 1)
    width = max(len(r) for r in matrix)
    cols = _columns(matrix[hi] if hi < len(matrix) else [], width)
    rows = []
    for j, r in enumerate(matrix[hi + 1:], start=hi + 2):
        vals = [norm_cell(r[i]) if i < len(r) else "" for i in range(width)]
        if any(vals):
            row = dict(zip(cols, vals))
            row["_line"] = j  # line number in the original sheet / file (for writing results back)
            rows.append(row)
    # drop trailing all-empty generated columns
    used = [c for c in cols if not c.startswith("col_") or any(row[c] for row in rows)]
    return used, [{**{c: row[c] for c in used}, "_line": row["_line"]} for row in rows]


def parse_table(filename: str, content: bytes, sheet: str | None = None, header_row: int = 1) -> dict[str, Any]:
    name = filename.lower()
    sheets: list[str] = []
    if name.endswith((".xlsx", ".xlsm")):
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        sheets = wb.sheetnames
        ws = wb[sheet] if sheet in sheets else wb[sheets[0]]
        matrix = [list(r) for r in ws.iter_rows(values_only=True)]
        sheet = ws.title
        kind = "excel"
    elif name.endswith(".xls"):
        import xlrd
        book = xlrd.open_workbook(file_contents=content)
        sheets = book.sheet_names()
        ws = book.sheet_by_name(sheet) if sheet in sheets else book.sheet_by_index(0)
        matrix = []
        for r in range(ws.nrows):
            row = []
            for c in range(ws.ncols):
                cell = ws.cell(r, c)
                if cell.ctype == xlrd.XL_CELL_DATE:
                    row.append(xlrd.xldate.xldate_as_datetime(cell.value, book.datemode))
                else:
                    row.append(cell.value)
            matrix.append(row)
        sheet = ws.name
        kind = "excel"
    elif name.endswith((".csv", ".tsv", ".txt")):
        text = content.decode("utf-8-sig", errors="replace")
        try:
            dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel_tab if name.endswith(".tsv") else csv.excel
        matrix = [r for r in csv.reader(io.StringIO(text), dialect)]
        kind = "csv"
    else:
        raise ValueError("Unsupported file. Use .xlsx, .xls, .csv or .pdf")
    columns, rows = _to_table(matrix, header_row)
    return {"kind": kind, "columns": columns, "rows": rows, "sheets": sheets, "sheet": sheet, "header_row": header_row}


# --------------------------------------------------------------------------- PDF

def parse_pdf(filename: str, content: bytes) -> dict[str, Any]:
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(content))
    fields: dict[str, str] = {}
    try:
        for k, f in (reader.get_fields() or {}).items():
            v = f.get("/V")
            if v is not None:
                fields[str(k)] = norm_cell(str(v).lstrip("/") if str(v).startswith("/") else v)
            else:
                fields[str(k)] = ""
    except Exception:
        pass
    text = "\n".join((p.extract_text() or "") for p in reader.pages)
    return {"name": filename, "text": text, "fields": fields, "pages": len(reader.pages)}


def _after_label(text: str, label: str) -> str:
    for i, line in enumerate(text.splitlines()):
        pos = line.lower().find(label.lower())
        if pos < 0:
            continue
        rest = line[pos + len(label):].strip().lstrip(":：-–#").strip()
        if rest:
            return rest
        for nxt in text.splitlines()[i + 1:]:
            if nxt.strip():
                return nxt.strip()
    return ""


def apply_rule(rule: dict[str, Any], f: dict[str, Any]) -> str:
    kind, pattern = rule.get("kind"), rule.get("pattern") or ""
    if kind == "form_field":
        return f.get("fields", {}).get(pattern, "")
    if kind == "after_label":
        return _after_label(f.get("text", ""), pattern) if pattern else ""
    if kind == "regex":
        try:
            m = re.search(pattern, f.get("text", ""), re.I | re.M)
        except re.error:
            return ""
        return (m.group(1) if m and m.groups() else m.group(0) if m else "").strip()
    if kind == "value":  # set by AI extraction or by hand
        return rule.get("values", {}).get(f.get("name"), "")
    return ""


def default_pdf_rules(files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    names: list[str] = []
    for f in files:
        for k in f.get("fields", {}):
            if k not in names:
                names.append(k)
    return [{"name": k, "kind": "form_field", "pattern": k} for k in names]


def pdf_table(files: list[dict[str, Any]], rules: list[dict[str, Any]]) -> tuple[list[str], list[dict[str, str]]]:
    columns = ["_file"] + [r["name"] for r in rules if r.get("name")]
    rows = []
    for f in files:
        row = {"_file": f["name"]}
        for r in rules:
            if r.get("name"):
                row[r["name"]] = apply_rule(r, f)
        rows.append(row)
    return columns, rows


# --------------------------------------------------------------------------- joins & filters

def _key(v: Any) -> str:
    s = norm_cell(v).strip().lower()
    return s[:-2] if s.endswith(".0") and s[:-2].isdigit() else s


def join_rows(rows: list[dict[str, Any]], other: list[dict[str, Any]], left: str, right: str, prefix: str | None = None) -> list[dict[str, Any]]:
    """Left join: every row of the main file gets the matching row of the other file (like VLOOKUP)."""
    index: dict[str, dict[str, Any]] = {}
    for r in other:
        index.setdefault(_key(r.get(right)), r)
    out = []
    for r in rows:
        m = index.get(_key(r.get(left)))
        merged = dict(r)
        if m:
            if prefix:
                merged[prefix] = dict(m)
            else:
                for k, v in m.items():
                    if k not in merged or merged[k] == "":
                        merged[k] = v
        merged["_matched_" + (prefix or right)] = bool(m)
        out.append(merged)
    return out


def row_matches(row: dict[str, Any], flt: dict[str, Any] | None) -> bool:
    if not flt or not flt.get("column"):
        return True
    v = _get(row, flt["column"])
    s = norm_cell(v).strip()
    op, want = flt.get("op", "not_empty"), norm_cell(flt.get("value")).strip()
    if op == "empty":
        return s == ""
    if op == "not_empty":
        return s != ""
    if op == "equals":
        return s.lower() == want.lower()
    if op == "not_equals":
        return s.lower() != want.lower()
    if op == "contains":
        return want.lower() in s.lower()
    if op == "truthy":
        return s.lower() in TRUTHY
    if op == "falsy":
        return s.lower() not in TRUTHY
    return True


def _get(row: dict[str, Any], path: str) -> Any:
    if path in row:
        return row[path]
    cur: Any = row
    for part in path.split("."):
        cur = cur.get(part) if isinstance(cur, dict) else None
    return cur
