"""Runtime configuration. Everything is local to the user's machine."""
from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path


def _default_data_dir() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "AutoBrowser"


DATA_DIR = Path(os.environ.get("AUTOBROWSER_DATA", _default_data_dir()))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "autobrowser.db"
VAULT_KEY_PATH = DATA_DIR / "vault.key"

# Shared secret between the Electron shell and this API. Web pages you browse can
# reach 127.0.0.1, so every request must carry this token or it is rejected.
API_TOKEN = os.environ.get("AUTOBROWSER_TOKEN") or secrets.token_urlsafe(32)

HOST = "127.0.0.1"
PORT = int(os.environ.get("AUTOBROWSER_PORT", "8765"))

DEFAULT_MODEL = "claude-opus-5-5"
