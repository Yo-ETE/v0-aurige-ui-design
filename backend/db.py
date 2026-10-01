"""AURIGE - Stockage SQLite pour l'authentification (comptes + sessions).

Seule exception à la règle "pas de base de données" du projet : uniquement
l'auth. Les missions et logs restent en JSON. Hashing PBKDF2 stdlib.
"""
import asyncio
import hashlib
import hmac
import json
import os
import secrets
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import aiosqlite

PBKDF2_ITERATIONS = 100_000
_SENTINEL = object()

_conn: Optional[aiosqlite.Connection] = None
_write_lock = asyncio.Lock()
_db_dir: Optional[Path] = None
# cache token -> (user_dict, inserted_monotonic)
_session_cache: dict[str, tuple[dict, float]] = {}
_CACHE_TTL = 20.0


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITERATIONS
    ).hex()
    return f"{salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, digest = stored.split("$", 1)
        candidate = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITERATIONS
        ).hex()
    except (ValueError, TypeError, AttributeError):
        return False
    return hmac.compare_digest(candidate, digest)


def _row_to_user(row: aiosqlite.Row) -> dict:
    perms = row["permissions"]
    return {
        "id": row["id"],
        "username": row["username"],
        "role": row["role"],
        "permissions": json.loads(perms) if perms else None,
        "is_active": bool(row["is_active"]),
        "created_at": row["created_at"],
        "last_login": row["last_login"],
    }


async def init_db(db_path: Path) -> None:
    global _conn, _db_dir
    db_path = Path(db_path)
    _db_dir = db_path.parent
    _db_dir.mkdir(parents=True, exist_ok=True)
    _conn = await aiosqlite.connect(str(db_path))
    _conn.row_factory = aiosqlite.Row
    await _conn.execute("PRAGMA journal_mode=WAL")
    await _conn.execute("PRAGMA foreign_keys=ON")
    await _init_tables()
    await _seed_admin()
    await cleanup_expired_sessions()


async def close_db() -> None:
    global _conn
    _session_cache.clear()
    if _conn is not None:
        await _conn.close()
        _conn = None


async def _init_tables() -> None:
    await _conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          username      TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role          TEXT NOT NULL DEFAULT 'viewer',
          permissions   TEXT DEFAULT NULL,
          is_active     INTEGER NOT NULL DEFAULT 1,
          created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          last_login    TEXT
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token      TEXT PRIMARY KEY,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          expires_at TEXT NOT NULL,
          last_seen  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
        """
    )
    await _conn.commit()


async def _seed_admin() -> None:
    if await count_admins() != 0:
        return
    cur = await _conn.execute("SELECT COUNT(*) AS n FROM users")
    if (await cur.fetchone())["n"] != 0:
        return
    password = secrets.token_urlsafe(12)
    # Écrire le fichier AVANT d'insérer l'admin : un échec d'écriture ne doit
    # jamais laisser un admin au mot de passe inconnu (le seed ne rejouerait pas).
    if _db_dir is not None:
        path = _db_dir / "initial_admin_password.txt"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(f"username: admin\npassword: {password}\n")
    await create_user("admin", password, role="admin", permissions=None)


async def create_user(username, password, role="viewer", permissions=None) -> int:
    async with _write_lock:
        cur = await _conn.execute(
            "INSERT INTO users (username, password_hash, role, permissions) "
            "VALUES (?, ?, ?, ?)",
            (username, hash_password(password), role,
             json.dumps(permissions) if permissions is not None else None),
        )
        await _conn.commit()
        return cur.lastrowid


async def get_user_by_username(username) -> Optional[dict]:
    cur = await _conn.execute("SELECT * FROM users WHERE username = ?", (username,))
    row = await cur.fetchone()
    return _row_to_user(row) if row else None


async def get_user_by_id(user_id) -> Optional[dict]:
    cur = await _conn.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    row = await cur.fetchone()
    return _row_to_user(row) if row else None


async def _get_password_hash(username) -> Optional[str]:
    cur = await _conn.execute(
        "SELECT password_hash FROM users WHERE username = ? AND is_active = 1",
        (username,),
    )
    row = await cur.fetchone()
    return row["password_hash"] if row else None


async def list_users() -> list[dict]:
    cur = await _conn.execute("SELECT * FROM users ORDER BY id")
    return [_row_to_user(r) for r in await cur.fetchall()]


async def update_user(user_id, *, password=None, role=None,
                      permissions=_SENTINEL, is_active=None) -> None:
    sets, params = [], []
    if password is not None:
        sets.append("password_hash = ?"); params.append(hash_password(password))
    if role is not None:
        sets.append("role = ?"); params.append(role)
    if permissions is not _SENTINEL:
        sets.append("permissions = ?")
        params.append(json.dumps(permissions) if permissions is not None else None)
    if is_active is not None:
        sets.append("is_active = ?"); params.append(1 if is_active else 0)
    if not sets:
        return
    params.append(user_id)
    async with _write_lock:
        await _conn.execute(f"UPDATE users SET {', '.join(sets)} WHERE id = ?", params)
        await _conn.commit()
    invalidate_user_cache(user_id)


async def delete_user(user_id) -> None:
    async with _write_lock:
        await _conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        await _conn.commit()
    invalidate_user_cache(user_id)


async def count_admins() -> int:
    cur = await _conn.execute(
        "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1"
    )
    return (await cur.fetchone())["n"]


async def touch_last_login(user_id) -> None:
    async with _write_lock:
        await _conn.execute(
            "UPDATE users SET last_login = datetime('now','localtime') WHERE id = ?",
            (user_id,),
        )
        await _conn.commit()


async def create_session(user_id, ttl_seconds=2592000) -> str:
    token = secrets.token_urlsafe(32)
    expires = (datetime.now() + timedelta(seconds=ttl_seconds)).strftime("%Y-%m-%d %H:%M:%S")
    async with _write_lock:
        await _conn.execute(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
            (token, user_id, expires),
        )
        await _conn.commit()
    return token


async def get_session_user(token) -> Optional[dict]:
    if not token:
        return None
    cached = _session_cache.get(token)
    if cached and (asyncio.get_event_loop().time() - cached[1]) < _CACHE_TTL:
        # Re-check d'expiration volontairement ignoré dans la fenêtre de 20s (expiry naturelle <=20s de retard ; tout changement de droits appelle invalidate_user_cache).
        return cached[0]
    cur = await _conn.execute(
        """SELECT u.*, s.token AS session_token, s.expires_at AS expires_at
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token = ?""",
        (token,),
    )
    row = await cur.fetchone()
    if not row:
        return None
    if row["expires_at"] <= datetime.now().strftime("%Y-%m-%d %H:%M:%S"):
        await delete_session(token)
        return None
    if not bool(row["is_active"]):
        return None
    user = _row_to_user(row)
    user["token"] = token
    _session_cache[token] = (user, asyncio.get_event_loop().time())
    return user


async def delete_session(token) -> None:
    _session_cache.pop(token, None)
    async with _write_lock:
        await _conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        await _conn.commit()


async def delete_user_sessions(user_id) -> None:
    async with _write_lock:
        await _conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        await _conn.commit()
    invalidate_user_cache(user_id)


async def cleanup_expired_sessions() -> None:
    async with _write_lock:
        await _conn.execute(
            "DELETE FROM sessions WHERE expires_at <= datetime('now','localtime')"
        )
        await _conn.commit()


def invalidate_user_cache(user_id) -> None:
    for tok in [t for t, (u, _) in _session_cache.items() if u.get("id") == user_id]:
        _session_cache.pop(tok, None)
