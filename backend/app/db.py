import os
import time

from pymongo import MongoClient
from pymongo.errors import PyMongoError

MONGODB_URI = os.getenv("MONGODB_URI", "")

# How long to wait after a failed connection attempt before trying again.
# Without this, every single call to get_db() (including the one triggered
# by /health) re-attempts a full TLS handshake and eats the 5s timeout,
# which is what was stalling Render's health checks.
_RETRY_COOLDOWN_SECONDS = 30

_client = None
_db = None
_connection_ok = False
_last_attempt_ts = 0.0


def get_db():
    """Lazily connects to MongoDB Atlas once per process, and backs off
    between retries so failed connections don't block every caller (like
    the health check) behind a fresh 5s TLS timeout. Returns None if no
    URI is configured or the connection is currently down, so callers can
    fall back to in-memory storage instead of crashing the app."""
    global _client, _db, _connection_ok, _last_attempt_ts

    if _db is not None:
        return _db

    if not MONGODB_URI:
        return None

    now = time.monotonic()
    if not _connection_ok and (now - _last_attempt_ts) < _RETRY_COOLDOWN_SECONDS:
        # We tried recently and failed — don't hammer Atlas or block the
        # caller on another slow timeout. Just report "still down".
        return None

    _last_attempt_ts = now

    try:
        _client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        _client.admin.command("ping")  # forces an actual connection attempt
        _db = _client["telesto"]
        _connection_ok = True
        print("[db] Connected to MongoDB Atlas successfully.")
        return _db
    except PyMongoError as exc:
        print(f"[db] MongoDB connection failed, falling back to in-memory storage: {exc}")
        _connection_ok = False
        _client = None
        return None


def is_connected() -> bool:
    return _connection_ok