from __future__ import annotations

import pyotp
from fastapi import APIRouter, HTTPException

from .. import db, vault
from ..schemas import CredentialIn, CredentialPatch, ProfileIn, ProfilePatch

router = APIRouter(tags=["accounts"])


def _cred_public(row) -> dict:
    d = db.row_to_dict(row)
    return {
        "id": d["id"], "profile_id": d["profile_id"], "site": d["site"], "username": d["username"],
        "has_password": bool(d["password_enc"]), "has_totp": bool(d["totp_enc"]),
        "extra_keys": list((d.get("extra") or {}).keys()), "created": d["created"],
    }


def _profile(pid: str) -> dict:
    row = db.connect().execute("SELECT * FROM profiles WHERE id=?", (pid,)).fetchone()
    if not row:
        raise HTTPException(404, "profile not found")
    p = db.row_to_dict(row)
    creds = db.connect().execute("SELECT * FROM credentials WHERE profile_id=? ORDER BY created", (pid,)).fetchall()
    p["credentials"] = [_cred_public(c) for c in creds]
    p["partition"] = f"persist:ab_{pid}"
    return p


@router.get("/profiles")
def list_profiles():
    rows = db.connect().execute("SELECT id FROM profiles ORDER BY created").fetchall()
    return [_profile(r["id"]) for r in rows]


@router.post("/profiles")
def create_profile(body: ProfileIn):
    pid = db.new_id()
    with db.tx() as c:
        c.execute("INSERT INTO profiles(id,name,color,proxy,notes,created) VALUES(?,?,?,?,?,?)",
                  (pid, body.name, body.color, body.proxy, body.notes, db.now()))
    return _profile(pid)


@router.patch("/profiles/{pid}")
def patch_profile(pid: str, body: ProfilePatch):
    _profile(pid)
    fields = body.model_dump(exclude_unset=True)
    if fields:
        with db.tx() as c:
            c.execute(f"UPDATE profiles SET {', '.join(f'{k}=?' for k in fields)} WHERE id=?", (*fields.values(), pid))
    return _profile(pid)


@router.delete("/profiles/{pid}")
def delete_profile(pid: str):
    with db.tx() as c:
        c.execute("DELETE FROM profiles WHERE id=?", (pid,))
    return {"ok": True}


@router.post("/credentials")
def create_credential(body: CredentialIn):
    _profile(body.profile_id)
    cid = db.new_id()
    extra = {k: vault.encrypt(v) for k, v in body.extra.items()}
    with db.tx() as c:
        c.execute("INSERT INTO credentials(id,profile_id,site,username,password_enc,totp_enc,extra,created) VALUES(?,?,?,?,?,?,?,?)",
                  (cid, body.profile_id, body.site, body.username, vault.encrypt(body.password),
                   vault.encrypt(body.totp_secret), db.dumps(extra), db.now()))
    return _cred_public(db.connect().execute("SELECT * FROM credentials WHERE id=?", (cid,)).fetchone())


def _cred(cid: str) -> dict:
    row = db.connect().execute("SELECT * FROM credentials WHERE id=?", (cid,)).fetchone()
    if not row:
        raise HTTPException(404, "credential not found")
    return db.row_to_dict(row)


@router.patch("/credentials/{cid}")
def patch_credential(cid: str, body: CredentialPatch):
    cur = _cred(cid)
    f = body.model_dump(exclude_unset=True)
    sets: dict = {}
    for k in ("site", "username"):
        if k in f:
            sets[k] = f[k]
    if "password" in f:
        sets["password_enc"] = vault.encrypt(f["password"])
    if "totp_secret" in f:
        sets["totp_enc"] = vault.encrypt(f["totp_secret"])
    if "extra" in f:
        extra = cur.get("extra") or {}
        extra.update({k: vault.encrypt(v) for k, v in (f["extra"] or {}).items()})
        sets["extra"] = db.dumps(extra)
    if sets:
        with db.tx() as c:
            c.execute(f"UPDATE credentials SET {', '.join(f'{k}=?' for k in sets)} WHERE id=?", (*sets.values(), cid))
    return _cred_public(db.connect().execute("SELECT * FROM credentials WHERE id=?", (cid,)).fetchone())


@router.delete("/credentials/{cid}")
def delete_credential(cid: str):
    with db.tx() as c:
        c.execute("DELETE FROM credentials WHERE id=?", (cid,))
    return {"ok": True}


@router.get("/profiles/{pid}/secrets")
def profile_secrets(pid: str, site: str | None = None):
    """Used only by the runner at execution time to fill {{account.*}} templates."""
    _profile(pid)
    rows = db.connect().execute("SELECT * FROM credentials WHERE profile_id=? ORDER BY created", (pid,)).fetchall()
    creds = [db.row_to_dict(r) for r in rows]
    if site:
        matching = [c for c in creds if c["site"].lower() in site.lower() or site.lower() in c["site"].lower()]
        creds = matching or creds
    if not creds:
        return {}
    c = creds[0]
    totp_secret = vault.decrypt(c["totp_enc"])
    out = {
        "site": c["site"],
        "username": c["username"],
        "password": vault.decrypt(c["password_enc"]) or "",
        "totp": pyotp.TOTP(totp_secret.replace(" ", "")).now() if totp_secret else "",
    }
    for k, v in (c.get("extra") or {}).items():
        out[k] = vault.decrypt(v) or ""
    return out
