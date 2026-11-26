"""Tiny SQLite layer (stdlib only, JSON columns)."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from typing import Any, Iterator

from .config import DB_PATH

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#7c9cff',
  proxy TEXT,
  notes TEXT,
  created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  site TEXT NOT NULL,
  username TEXT NOT NULL,
  password_enc TEXT,
  totp_enc TEXT,
  extra TEXT NOT NULL DEFAULT '{}',
  created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  start_url TEXT,
  description TEXT,
  steps TEXT NOT NULL DEFAULT '[]',
  compiled TEXT,
  created REAL NOT NULL,
  updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  flow_id TEXT REFERENCES flows(id) ON DELETE SET NULL,
  profile_id TEXT,
  mode TEXT NOT NULL DEFAULT 'replay',
  status TEXT NOT NULL DEFAULT 'running',
  log TEXT NOT NULL DEFAULT '[]',
  output TEXT NOT NULL DEFAULT '[]',
  started REAL NOT NULL,
  finished REAL
);
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- excel | csv | pdf
  columns TEXT NOT NULL DEFAULT '[]',
  rows TEXT NOT NULL DEFAULT '[]',
  meta TEXT NOT NULL DEFAULT '{}',
  created REAL NOT NULL,
  updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""

JSON_COLS = {"steps", "compiled", "log", "output", "extra", "data", "columns", "rows", "meta"}


def connect(path: str | None = None) -> sqlite3.Connection:
    global _conn
    with _lock:
        if _conn is None or path is not None:
            _conn = sqlite3.connect(path or str(DB_PATH), check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            _conn.execute("PRAGMA foreign_keys = ON")
            _conn.execute("PRAGMA journal_mode = WAL")
            _conn.executescript(SCHEMA)
            _migrate(_conn)
        return _conn


def _migrate(conn: sqlite3.Connection) -> None:
    cols = {r[1] for r in conn.execute("PRAGMA table_info(flows)")}
    if "data" not in cols:  # per-flow data source config (added in 0.3)
        conn.execute("ALTER TABLE flows ADD COLUMN data TEXT")
    rcols = {r[1] for r in conn.execute("PRAGMA table_info(runs)")}
    if "dataset_id" not in rcols:  # data runs: which data source the rows came from (added in 0.5)
        conn.execute("ALTER TABLE runs ADD COLUMN dataset_id TEXT")
    pcols = {r[1] for r in conn.execute("PRAGMA table_info(profiles)")}
    if "engine" not in pcols:  # chromium (built-in) | firefox (added in 0.4)
        conn.execute("ALTER TABLE profiles ADD COLUMN engine TEXT NOT NULL DEFAULT 'chromium'")
    conn.commit()


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    conn = connect()
    with _lock:
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def now() -> float:
    return time.time()


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    d = dict(row)
    for k in JSON_COLS & d.keys():
        if d[k] is not None:
            d[k] = json.loads(d[k])
    return d


def dumps(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False)
