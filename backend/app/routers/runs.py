from __future__ import annotations

import csv
import io
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from .. import db
from ..schemas import RunIn, RunPatch

router = APIRouter(tags=["runs"])


def _run(rid: str) -> dict:
    row = db.connect().execute("SELECT * FROM runs WHERE id=?", (rid,)).fetchone()
    if not row:
        raise HTTPException(404, "run not found")
    return db.row_to_dict(row)


@router.get("/runs")
def list_runs(flow_id: str | None = None, limit: int = 50):
    q, args = "SELECT * FROM runs", []
    if flow_id:
        q += " WHERE flow_id=?"
        args.append(flow_id)
    q += " ORDER BY started DESC LIMIT ?"
    args.append(limit)
    return [db.row_to_dict(r) for r in db.connect().execute(q, args).fetchall()]


@router.get("/runs/{rid}")
def get_run(rid: str):
    return _run(rid)


@router.post("/runs")
def create_run(body: RunIn):
    rid = db.new_id()
    with db.tx() as c:
        c.execute("INSERT INTO runs(id,flow_id,profile_id,mode,started) VALUES(?,?,?,?,?)",
                  (rid, body.flow_id, body.profile_id, body.mode, db.now()))
    return _run(rid)


@router.patch("/runs/{rid}")
def patch_run(rid: str, body: RunPatch):
    cur = _run(rid)
    sets: dict = {}
    if body.status:
        sets["status"] = body.status
    if body.log:
        sets["log"] = db.dumps((cur["log"] + body.log)[-2000:])
    if body.output:
        sets["output"] = db.dumps(cur["output"] + body.output)
    if body.finished:
        sets["finished"] = db.now()
    if sets:
        with db.tx() as c:
            c.execute(f"UPDATE runs SET {', '.join(f'{k}=?' for k in sets)} WHERE id=?", (*sets.values(), rid))
    return {"ok": True}


@router.get("/runs/{rid}/output.csv")
def run_csv(rid: str, name: str | None = None):
    run = _run(rid)
    rows: list[dict] = []
    for item in run["output"]:
        if name and item.get("name") != name:
            continue
        data = item.get("data")
        if isinstance(data, list):
            rows += [r if isinstance(r, dict) else {"value": r} for r in data]
        elif isinstance(data, dict):
            rows.append(data)
        else:
            rows.append({"name": item.get("name"), "value": data})
    cols: list[str] = []
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=cols or ["value"])
    w.writeheader()
    for r in rows:
        w.writerow({k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in r.items()})
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="run-{rid}.csv"'})
