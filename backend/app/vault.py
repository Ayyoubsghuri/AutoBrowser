"""Local encryption for passwords, TOTP secrets and the AI API key.

Uses a Fernet key stored next to the database. On Windows the key file is
additionally protected with DPAPI when pywin32 is available.
"""
from __future__ import annotations

import base64
import os
import sys

from cryptography.fernet import Fernet, InvalidToken

from .config import VAULT_KEY_PATH

_fernet: Fernet | None = None


def _dpapi(data: bytes, protect: bool) -> bytes:
    if sys.platform != "win32":
        return data
    try:
        import win32crypt  # type: ignore
    except ImportError:
        return data
    if protect:
        return b"DPAPI:" + win32crypt.CryptProtectData(data, "AutoBrowser", None, None, None, 0)
    if data.startswith(b"DPAPI:"):
        return win32crypt.CryptUnprotectData(data[6:], None, None, None, 0)[1]
    return data


def _load() -> Fernet:
    global _fernet
    if _fernet is None:
        if VAULT_KEY_PATH.exists():
            key = _dpapi(VAULT_KEY_PATH.read_bytes(), protect=False)
        else:
            key = Fernet.generate_key()
            VAULT_KEY_PATH.write_bytes(_dpapi(key, protect=True))
            try:
                os.chmod(VAULT_KEY_PATH, 0o600)
            except OSError:
                pass
        _fernet = Fernet(key)
    return _fernet


def encrypt(plain: str | None) -> str | None:
    if plain is None or plain == "":
        return None
    return _load().encrypt(plain.encode()).decode()


def decrypt(token: str | None) -> str | None:
    if not token:
        return None
    try:
        return _load().decrypt(token.encode()).decode()
    except InvalidToken:
        return None


def reset_for_tests(key: bytes | None = None) -> None:
    global _fernet
    _fernet = Fernet(key or base64.urlsafe_b64encode(os.urandom(32)))
