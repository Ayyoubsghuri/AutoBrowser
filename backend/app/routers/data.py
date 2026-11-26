from __future__ import annotations

import base64
import binascii
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException

import anthropic
import openai

from .. import ai, data_rows, datasets, db, settings_store
from ..config import DATA_DIR
from pydantic import BaseModel

from ..schemas import DatasetPatch, DatasetUpload

router = APIRouter(tags=["data"])
FILES = DATA_DIR / "datasets"
MAX_PREVIEW = 200


def _public(d: dict, full: bool = False) -> dict:
    meta = d.get("meta") or {}
    out = {
        "id": d["id"], "name": d["name"], "kind": d["kind"], "columns": d["columns"],
        "row_count": len(d["rows"]), "rows": d["rows"] if full else d["rows"][:MAX_PREVIEW],
        "sheets": meta.get("sheets", []), "sheet": meta.get("sheet"), "header_row": meta.get("header_row", 1),
        "files": [{"name": f["name"], "pages": f.get("pages"), "form_fields": list(f.get("fields", {}).keys())} for f in meta.get("files", [])],
        "rules": meta.get("rules", []), "source_path": meta.get("source_path"), "created": d["created"], "updated": d["updated"],
    }
    return out


def _save(did: str, name: str, kind: str, columns, rows, meta, new: bool) -> dict:
    t = db.now()
    with db.tx() as c:
        if new:
            c.execute("INSERT INTO datasets(id,name,kind,columns,rows,meta,created,updated) VALUES(?,?,?,?,?,?,?,?)",
                      (did, name, kind, db.dumps(columns), db.dumps(rows), db.dumps(meta), t, t))
        else:
            c.execute("UPDATE datasets SET name=?, columns=?, rows=?, meta=?, updated=? WHERE id=?",
                      (name, db.dumps(columns), db.dumps(rows), db.dumps(meta), t, did))
    return data_rows.get_dataset(did)


def _decode(b64: str) -> bytes:
    try:
        return base64.b64decode(b64.split(",", 1)[-1], validate=False)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "file is not valid base64")


@router.get("/datasets")
def list_datasets():
    rows = db.connect().execute("SELECT * FROM datasets ORDER BY updated DESC").fetchall()
    return [_public(db.row_to_dict(r)) | {"rows": []} for r in rows]


@router.get("/datasets/{did}")
def get_dataset(did: str, full: bool = False):
    try:
        return _public(data_rows.get_dataset(did), full)
    except LookupError as e:
        raise HTTPException(404, str(e))


@router.post("/datasets")
def upload(body: DatasetUpload):
    if not body.files:
        raise HTTPException(400, "no files")
    pdfs = [f for f in body.files if f.filename.lower().endswith(".pdf")]
    if pdfs and len(pdfs) != len(body.files):
        raise HTTPException(400, "Upload PDFs and spreadsheets separately")

    if pdfs:
        existing = data_rows.get_dataset(body.dataset_id) if body.dataset_id else None
        meta = existing["meta"] if existing else {"files": [], "rules": []}
        for f in pdfs:
            try:
                parsed = datasets.parse_pdf(f.filename, _decode(f.content_b64))
            except Exception as e:  # corrupt / encrypted PDFs
                raise HTTPException(400, f"Could not read {f.filename}: {e}")
            meta["files"] = [x for x in meta["files"] if x["name"] != f.filename] + [parsed]
        if not meta.get("rules"):
            meta["rules"] = datasets.default_pdf_rules(meta["files"])
        columns, rows = datasets.pdf_table(meta["files"], meta["rules"])
        did = existing["id"] if existing else db.new_id()
        # keep the PDFs themselves too (for upload steps: {{row.file_path}})
        folder = FILES / did
        folder.mkdir(parents=True, exist_ok=True)
        for f in pdfs:
            target = folder / Path(f.filename).name
            target.write_bytes(_decode(f.content_b64))
            for x in meta["files"]:
                if x["name"] == f.filename:
                    x["path"] = str(target)
        columns, rows = datasets.pdf_table(meta["files"], meta["rules"])
        name = existing["name"] if existing else (body.name or f"{len(pdfs)} PDF{'s' if len(pdfs) > 1 else ''}")
        return _public(_save(did, name, "pdf", columns, rows, meta, new=not existing))

    if len(body.files) != 1:
        raise HTTPException(400, "Upload one spreadsheet at a time")
    f = body.files[0]
    content = _decode(f.content_b64)
    try:
        parsed = datasets.parse_table(f.filename, content, body.sheet, body.header_row)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(400, f"Could not read {f.filename}: {e}")
    did = db.new_id()
    folder = FILES / did
    folder.mkdir(parents=True, exist_ok=True)
    (folder / Path(f.filename).name).write_bytes(content)  # kept locally to switch sheet / header row later
    meta = {"filename": Path(f.filename).name, "sheets": parsed["sheets"], "sheet": parsed["sheet"], "header_row": parsed["header_row"],
            "source_path": body.source_path}
    name = body.name or Path(f.filename).stem + (f" · {parsed['sheet']}" if len(parsed["sheets"]) > 1 else "")
    return _public(_save(did, name, parsed["kind"], parsed["columns"], parsed["rows"], meta, new=True))


@router.patch("/datasets/{did}")
def patch_dataset(did: str, body: DatasetPatch):
    try:
        d = data_rows.get_dataset(did)
    except LookupError as e:
        raise HTTPException(404, str(e))
    meta, columns, rows, name = d["meta"], d["columns"], d["rows"], body.name or d["name"]
    if d["kind"] == "pdf" and body.rules is not None:
        meta["rules"] = [r.model_dump(exclude_none=True) for r in body.rules]
        columns, rows = datasets.pdf_table(meta.get("files", []), meta["rules"])
    if d["kind"] != "pdf" and (body.sheet or body.header_row):
        path = FILES / did / meta.get("filename", "")
        if not path.is_file():
            raise HTTPException(400, "original file is no longer available; upload it again")
        parsed = datasets.parse_table(path.name, path.read_bytes(), body.sheet or meta.get("sheet"), body.header_row or meta.get("header_row", 1))
        columns, rows = parsed["columns"], parsed["rows"]
        meta.update(sheet=parsed["sheet"], header_row=parsed["header_row"])
    return _public(_save(did, name, d["kind"], columns, rows, meta, new=False))


@router.delete("/datasets/{did}")
def delete_dataset(did: str):
    with db.tx() as c:
        c.execute("DELETE FROM datasets WHERE id=?", (did,))
    shutil.rmtree(FILES / did, ignore_errors=True)
    return {"ok": True}


class FieldsIn(BaseModel):
    fields: list[str] = []


def _ai(fn, *a):
    try:
        return fn(*a)
    except ai.AIUnavailable as e:
        raise HTTPException(400, str(e))
    except (anthropic.AuthenticationError, openai.AuthenticationError):
        raise HTTPException(401, "The AI API key is invalid.")
    except (anthropic.APIConnectionError, openai.APIConnectionError):
        raise HTTPException(503, "Could not reach the AI provider.")
    except (anthropic.APIStatusError, openai.APIStatusError) as e:
        raise HTTPException(502, f"AI provider error: {e.message}")


def _pdf(did: str) -> dict:
    try:
        d = data_rows.get_dataset(did)
    except LookupError as e:
        raise HTTPException(404, str(e))
    if d["kind"] != "pdf":
        raise HTTPException(400, "not a PDF data source")
    return d


@router.post("/datasets/{did}/suggest-rules")
def suggest_rules(did: str, body: FieldsIn):
    """AI proposes extraction rules; in private mode it only sees the PDFs' shared labels."""
    d = _pdf(did)
    files = d["meta"].get("files", [])
    if settings_store.get_privacy() and not ai.is_local_provider() and len(files) < 2:
        raise HTTPException(400, "Private mode: add at least 2 PDFs of the same kind, so the AI can tell the form's labels from the data.")
    res = _ai(ai.suggest_pdf_rules, files, body.fields)
    return {"rules": res.get("rules", []), "notes": res.get("notes", ""),
            "private": settings_store.get_privacy() and not ai.is_local_provider()}


@router.post("/datasets/{did}/ai-extract")
def ai_extract(did: str, body: FieldsIn):
    """AI reads each PDF and fills the fields. Sends full text, so it is blocked in
    private mode unless the AI runs on this computer."""
    d = _pdf(did)
    if settings_store.get_privacy() and not ai.is_local_provider():
        raise HTTPException(403, "Private mode is on: reading whole PDFs needs a local model (Settings → AI → OpenAI with a localhost server), or use extraction rules.")
    fields = [f for f in body.fields if f.strip()]
    if not fields:
        raise HTTPException(400, "list the fields to extract")
    meta = d["meta"]
    values: dict[str, dict[str, str]] = {k: {} for k in fields}
    for f in meta.get("files", []):
        got = _ai(ai.extract_pdf_values, f, fields)
        for k in fields:
            values[k][f["name"]] = str(got.get(k, ""))
    rules = [r for r in meta.get("rules", []) if r.get("name") not in fields]
    rules += [{"name": k, "kind": "value", "values": values[k]} for k in fields]
    meta["rules"] = rules
    columns, rows = datasets.pdf_table(meta.get("files", []), rules)
    return _public(_save(did, d["name"], "pdf", columns, rows, meta, new=False))
