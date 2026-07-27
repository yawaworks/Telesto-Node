import os

from pymongo import MongoClient
from pymongo.errors import PyMongoError

MONGODB_URI = os.getenv("MONGODB_URI", "")

_client = None
_db = None
_connection_ok = False


def get_db():
    """Lazily connects to MongoDB Atlas once per process. Returns None if
    no URI is configured or the connection fails, so callers can fall back
    to in-memory storage instead of crashing the app."""
    global _client, _db, _connection_ok

    if _db is not None:
        return _db

    if not MONGODB_URI:
        return None

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
        return None


def is_connected() -> bool:
    return _connection_ok