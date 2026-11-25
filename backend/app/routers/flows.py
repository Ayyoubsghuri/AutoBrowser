from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import ai, db
from ..schemas import CompileIn, FlowIn, FlowPatch

router = APIRouter(tags=["flows"])


def _flow(fid: str) -> dict:
    row = db.connect().execute("SELECT * FROM flows WHERE id=?", (fid,)).fetchone()
    if not row:
        raise HTTPException(404, "flow not found")
    return db.row_to_dict(row)


@router.get("/flows")
def list_flows():
    rows = db.connect().execute("SELECT * FROM flows ORDER BY updated DESC").fetchall()
    return [db.row_to_dict(r) for r in rows]


@router.get("/flows/{fid}")
def get_flow(fid: str):
    return _flow(fid)


@router.post("/flows")
def create_flow(body: FlowIn):
    fid = db.new_id()
    t = db.now()
    with db.tx() as c:
        c.execute("INSERT INTO flows(id,name,start_url,description,steps,compiled,created,updated) VALUES(?,?,?,?,?,?,?,?)",
                  (fid, body.name, body.start_url, body.description, db.dumps(body.steps),
                   db.dumps(body.compiled) if body.compiled else None, t, t))
    return _flow(fid)


@router.patch("/flows/{fid}")
def patch_flow(fid: str, body: FlowPatch):
    _flow(fid)
    f = body.model_dump(exclude_unset=True)
    for k in ("steps", "compiled"):
        if k in f and f[k] is not None:
            f[k] = db.dumps(f[k])
    f["updated"] = db.now()
    with db.tx() as c:
        c.execute(f"UPDATE flows SET {', '.join(f'{k}=?' for k in f)} WHERE id=?", (*f.values(), fid))
    return _flow(fid)


@router.delete("/flows/{fid}")
def delete_flow(fid: str):
    with db.tx() as c:
        c.execute("DELETE FROM flows WHERE id=?", (fid,))
    return {"ok": True}


@router.post("/flows/{fid}/compile")
def compile_flow(fid: str, body: CompileIn | None = None):
    flow = _flow(fid)
    body = body or CompileIn()
    goal = (body.goal or "").strip() or None
    if goal and goal != flow.get("description"):
        with db.tx() as c:
            c.execute("UPDATE flows SET description=? WHERE id=?", (goal, fid))
        flow["description"] = goal
    try:
        compiled = ai.compile_flow(flow, goal=goal, output_kind=body.output_kind,
                                   output_fields=body.output_fields, feedback=(body.feedback or "").strip() or None)
    except ai.AIUnavailable as e:
        raise HTTPException(400, str(e))
    except ValueError as e:
        raise HTTPException(502, f"AI returned an invalid flow: {e}")
    with db.tx() as c:
        c.execute("UPDATE flows SET compiled=?, updated=? WHERE id=?", (db.dumps(compiled), db.now(), fid))
    return _flow(fid)
