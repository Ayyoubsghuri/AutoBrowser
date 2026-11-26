"""Write a data run's results back into the user's own spreadsheet (and the data source)."""
from __future__ import annotations

import csv
import io
from pathlib import Path
from typing import Any

from . import data_rows, db
from .data_rows import MESSAGE_COL, STATUS_COL
from .config import DATA_DIR

FILES = DATA_DIR / "datasets"


def row_results(run: dict[str, Any]) -> list[dict[str, Any]]:
    """Latest result per data row of a run: {_row, _line, status, message, values{}}."""
    by_row: dict[int, dict[str, Any]] = {}
    for item in run.get("output") or []:
        if item.get("name") != "_rows":
            continue
        for r in item.get("data") or []:
            if not isinstance(r, dict) or r.get("_row") is None:
                continue
            values = {k: r.get(k) for k in (r.get("_extracted") or []) if not str(k).startswith("_")}
            by_row[int(r["_row"])] = {"_row": int(r["_row"]), "_line": r.get("_line"), "status": r.get("_status", ""),
                                      "message": r.get("_message", ""), "values": values}
    return [by_row[k] for k in sorted(by_row)]


def _result_columns(results: list[dict[str, Any]]) -> list[str]:
    cols = [STATUS_COL, MESSAGE_COL]
    for r in results:
        for k in r["values"]:
            if k not in cols:
                cols.append(k)
    return cols


def apply_to_dataset(dataset_id: str, results: list[dict[str, Any]]) -> dict[str, Any]:
    """Store statuses / extracted values in the data source, so 'skip rows already done' works."""
    d = data_rows.get_dataset(dataset_id)
    rows, columns = d["rows"], list(d["columns"])
    for c in _result_columns(results):
        if c not in columns:
            columns.append(c)
    for r in results:
        i = r["_row"] - 1
        if 0 <= i < len(rows):
            rows[i][STATUS_COL] = r["status"]
            rows[i][MESSAGE_COL] = r["message"]
            for k, v in r["values"].items():
                rows[i][k] = "" if v is None else str(v)
    with db.tx() as c:
        c.execute("UPDATE datasets SET columns=?, rows=?, updated=? WHERE id=?", (db.dumps(columns), db.dumps(rows), db.now(), dataset_id))
    return data_rows.get_dataset(dataset_id)


def _line_of(d: dict[str, Any], r: dict[str, Any]) -> int | None:
    if r.get("_line"):
        return int(r["_line"])
    i = r["_row"] - 1
    if 0 <= i < len(d["rows"]) and d["rows"][i].get("_line"):
        return int(d["rows"][i]["_line"])
    return None


def updated_file(dataset_id: str, results: list[dict[str, Any]]) -> tuple[str, bytes, str]:
    """The original file with result columns added (formatting of .xlsx kept)."""
    import openpyxl

    d = data_rows.get_dataset(dataset_id)
    meta = d["meta"]
    cols = _result_columns(results)
    src = FILES / dataset_id / meta.get("filename", "")
    name = meta.get("filename") or f"{d['name']}.xlsx"

    if d["kind"] == "excel" and src.is_file() and src.suffix.lower() in (".xlsx", ".xlsm"):
        wb = openpyxl.load_workbook(src, keep_vba=src.suffix.lower() == ".xlsm")
        ws = wb[meta["sheet"]] if meta.get("sheet") in wb.sheetnames else wb.worksheets[0]
        hr = int(meta.get("header_row") or 1)
        header = {str(c.value).strip(): c.column for c in ws[hr] if c.value is not None}
        col_idx = {}
        next_col = ws.max_column + 1
        for c in cols:
            if c in header:
                col_idx[c] = header[c]
            else:
                ws.cell(row=hr, column=next_col, value=c).font = openpyxl.styles.Font(bold=True)
                col_idx[c] = next_col
                next_col += 1
        for r in results:
            line = _line_of(d, r)
            if not line:
                continue
            ws.cell(row=line, column=col_idx[STATUS_COL], value=r["status"])
            ws.cell(row=line, column=col_idx[MESSAGE_COL], value=r["message"] or None)
            for k, v in r["values"].items():
                ws.cell(row=line, column=col_idx[k], value=v)
        buf = io.BytesIO()
        wb.save(buf)
        return name, buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

    if d["kind"] == "csv" and src.is_file():
        text = src.read_bytes().decode("utf-8-sig", errors="replace")
        try:
            dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
        matrix = list(csv.reader(io.StringIO(text), dialect))
        hr = int(meta.get("header_row") or 1) - 1
        width = max((len(r) for r in matrix), default=0)
        header = matrix[hr] + [""] * (width - len(matrix[hr])) if matrix else []
        idx = {}
        for c in cols:
            if c in header:
                idx[c] = header.index(c)
            else:
                header.append(c)
                idx[c] = len(header) - 1
        matrix[hr] = header
        for r in results:
            line = _line_of(d, r)
            if not line or line - 1 >= len(matrix):
                continue
            row = matrix[line - 1] + [""] * (len(header) - len(matrix[line - 1]))
            row[idx[STATUS_COL]] = r["status"]
            row[idx[MESSAGE_COL]] = r["message"] or ""
            for k, v in r["values"].items():
                row[idx[k]] = "" if v is None else str(v)
            matrix[line - 1] = row
        buf = io.StringIO()
        csv.writer(buf, delimiter=dialect.delimiter).writerows(matrix)
        return name, ("﻿" + buf.getvalue()).encode("utf-8"), "text/csv"

    # PDFs or .xls (cannot be edited in place): a new workbook with the data + results
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Results"
    base_cols = [c for c in d["columns"] if c not in cols]
    ws.append(base_cols + cols)
    by_row = {r["_row"]: r for r in results}
    for i, row in enumerate(d["rows"], start=1):
        r = by_row.get(i)
        extra = [r["status"], r["message"]] + [r["values"].get(k) for k in cols[2:]] if r else [""] * len(cols)
        ws.append([row.get(c, "") for c in base_cols] + extra)
    buf = io.BytesIO()
    wb.save(buf)
    stem = Path(name).stem if meta.get("filename") else d["name"]
    return f"{stem} - results.xlsx", buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
