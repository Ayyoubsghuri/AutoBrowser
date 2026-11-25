from __future__ import annotations

import json
from typing import Any

from . import db, vault
from .config import DEFAULT_MODEL

PROVIDERS = ("anthropic", "openai", "nvidia")

DEFAULT_MODELS = {
    "anthropic": DEFAULT_MODEL,
    "openai": "gpt-5",
    "nvidia": "meta/llama-3.3-70b-instruct",
}
NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"

DEFAULTS: dict[str, Any] = {"provider": "anthropic", "human_speed": 1.0, "stealth": True, "privacy_mode": True}

# settings keys per provider (anthropic keeps its original key names)
_KEY = {"anthropic": "anthropic_api_key_enc", "openai": "openai_api_key_enc", "nvidia": "nvidia_api_key_enc"}
_MODEL = {"anthropic": "model", "openai": "openai_model", "nvidia": "nvidia_model"}


def _get(key: str) -> Any:
    row = db.connect().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return json.loads(row["value"]) if row else DEFAULTS.get(key)


def _set(key: str, value: Any) -> None:
    with db.tx() as c:
        c.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))


def get_provider() -> str:
    p = _get("provider")
    return p if p in PROVIDERS else "anthropic"


def get_api_key(provider: str | None = None) -> str | None:
    return vault.decrypt(_get(_KEY[provider or get_provider()]))


def get_model(provider: str | None = None) -> str:
    p = provider or get_provider()
    return _get(_MODEL[p]) or DEFAULT_MODELS[p]


def get_base_url(provider: str | None = None) -> str | None:
    p = provider or get_provider()
    if p == "nvidia":
        return NVIDIA_BASE_URL
    if p == "openai":
        return _get("openai_base_url") or None
    return None


def get_privacy() -> bool:
    return bool(_get("privacy_mode"))


def public() -> dict[str, Any]:
    return {
        "provider": get_provider(),
        "has_api_key": bool(get_api_key()),  # for the active provider
        "model": get_model(),
        "providers": {
            p: {"has_key": bool(get_api_key(p)), "model": get_model(p),
                **({"base_url": _get("openai_base_url") or ""} if p == "openai" else {})}
            for p in PROVIDERS
        },
        "human_speed": _get("human_speed"),
        "stealth": _get("stealth"),
        "privacy_mode": get_privacy(),
    }


def update(**kw: Any) -> dict[str, Any]:
    for p in PROVIDERS:
        if kw.get(f"{p}_api_key") is not None:
            k = kw[f"{p}_api_key"].strip()
            _set(_KEY[p], vault.encrypt(k) if k else None)
    if kw.get("provider") in PROVIDERS:
        _set("provider", kw["provider"])
    # `model` without a provider prefix targets the active provider (backwards compatible)
    if kw.get("model"):
        _set(_MODEL[kw.get("provider") or get_provider()], kw["model"].strip())
    for p in PROVIDERS:
        if kw.get(f"{p}_model"):
            _set(_MODEL[p], kw[f"{p}_model"].strip())
    if kw.get("openai_base_url") is not None:
        _set("openai_base_url", kw["openai_base_url"].strip().rstrip("/") or None)
    for key in ("human_speed", "stealth", "privacy_mode"):
        if kw.get(key) is not None:
            _set(key, kw[key])
    return public()
