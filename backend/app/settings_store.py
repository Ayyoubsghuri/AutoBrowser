from __future__ import annotations

import json
from typing import Any

from . import db, vault
from .config import DEFAULT_MODEL

DEFAULTS: dict[str, Any] = {"model": DEFAULT_MODEL, "human_speed": 1.0, "stealth": True}


def _get(key: str) -> Any:
    row = db.connect().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return json.loads(row["value"]) if row else DEFAULTS.get(key)


def _set(key: str, value: Any) -> None:
    with db.tx() as c:
        c.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))


def get_api_key() -> str | None:
    return vault.decrypt(_get("anthropic_api_key_enc"))


def get_model() -> str:
    return _get("model") or DEFAULT_MODEL


def public() -> dict[str, Any]:
    return {
        "has_api_key": bool(get_api_key()),
        "model": get_model(),
        "human_speed": _get("human_speed"),
        "stealth": _get("stealth"),
    }


def update(**kw: Any) -> dict[str, Any]:
    if kw.get("anthropic_api_key") is not None:
        k = kw["anthropic_api_key"].strip()
        _set("anthropic_api_key_enc", vault.encrypt(k) if k else None)
    for key in ("model", "human_speed", "stealth"):
        if kw.get(key) is not None:
            _set(key, kw[key])
    return public()
