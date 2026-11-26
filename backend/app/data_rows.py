from __future__ import annotations

from typing import Any

from . import datasets, db


def get_dataset(did: str) -> dict[str, Any]:
    row = db.connect().execute("SELECT * FROM datasets WHERE id=?", (did,)).fetchone()
    if not row:
        raise LookupError(f"data source {did} not found")
    return db.row_to_dict(row)


STATUS_COL = "AutoBrowser status"
MESSAGE_COL = "AutoBrowser message"


def resolve(cfg: dict[str, Any], only_rows: list[int] | None = None) -> tuple[list[str], list[dict[str, Any]], int]:
    """Returns (columns, rows to run, total rows before first_row/max_rows).
    `only_rows` (row numbers of the main file) re-runs exactly those rows, e.g. the failed ones."""
    main = get_dataset(cfg["dataset_id"])
    rows = main["rows"]
    columns = list(main["columns"])
    for j in cfg.get("joins") or []:
        other = get_dataset(j["dataset_id"])
        rows = datasets.join_rows(rows, other["rows"], j["left"], j["right"], j.get("prefix"))
        prefix = j.get("prefix")
        for c in other["columns"]:
            name = f"{prefix}.{c}" if prefix else c
            if name not in columns:
                columns.append(name)
    rows = [dict(r, _row=i + 1) for i, r in enumerate(rows)]  # original row number in the main file
    if only_rows:
        wanted = set(only_rows)
        picked = [r for r in rows if r["_row"] in wanted]
        return columns, picked, len(picked)
    rows = [r for r in rows if datasets.row_matches(r, cfg.get("filter"))]
    if cfg.get("skip_done"):
        rows = [r for r in rows if str(r.get(STATUS_COL, "")).lower() != "success"]
    total = len(rows)
    start = max(1, int(cfg.get("first_row") or 1)) - 1
    rows = rows[start:]
    if cfg.get("max_rows"):
        rows = rows[: int(cfg["max_rows"])]
    return columns, rows, total
