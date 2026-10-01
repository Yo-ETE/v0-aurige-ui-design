# Account-Based Auth & RBAC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AURIGE's shared-token auth (AUD-01) with named user accounts, roles, and fine-grained permissions backed by SQLite.

**Architecture:** FastAPI backend gains a SQLite auth store (`aiosqlite`) with `users`/`sessions` tables, a rewritten pure-ASGI `SessionAuthMiddleware` enforcing authentication (HTTP + WebSocket) and coarse authorization, a permissions module, and admin-only user-CRUD routes. The Next.js frontend replaces the token field with a username/password login, an auth context exposing permissions, permission-gated navigation, and an admin page. Session is an opaque server-side token in an httpOnly cookie (not JWT); frontend talks to backend same-origin through nginx.

**Tech Stack:** Python 3.11, FastAPI, Starlette, `aiosqlite`, stdlib `hashlib`/`hmac`/`secrets`; pytest + pytest-asyncio + Starlette `TestClient`. Next.js 16, React 19, TypeScript, shadcn/ui, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-10-01-account-auth-rbac-design.md`

## Global Constraints

- Backend binding stays `127.0.0.1` (AUD-24); do not touch `deploy/aurige-api.service`.
- Frontend calls backend same-origin via `apiFetch` from `lib/api-config.ts`; never introduce cross-origin `:8000` calls or loosen CORS.
- Password hashing: PBKDF2-HMAC-SHA256, 100000 iterations, 16-byte hex salt, stored `"{salt}${digest}"`. No bcrypt/passlib/PyJWT.
- Session cookie name `aurige_session`: `httponly=True`, `samesite="strict"`, `secure` dynamic (HTTPS only via `x-forwarded-proto`), `max_age=2592000` (30 days), `path="/"`.
- DB path: `${AURIGE_DATA_DIR}/aurige.db` (default `AURIGE_DATA_DIR=/opt/aurige/data`), override `AURIGE_DB_PATH`.
- Password min length 10; username min length 2.
- Permission flags (22, exact names): areas `area_dashboard, area_missions, area_control, area_analysis, area_capture, area_configuration, area_administration`; actions `can_inject, fuzzing_run, crash_recovery_run, causality_validate, capture_run, replay_run, missions_create, missions_edit, missions_delete, dbc_manage, obd_write, system_update, system_reboot, system_network, system_backup`.
- Roles: `admin` | `viewer`. `operator` is a permission preset on a `viewer` account, not a DB role.
- Comments and UI copy in French, code in English (project convention).

## File Structure

**Backend (create):**
- `backend/db.py` — aiosqlite connection (WAL, FK on), schema init, password hashing, user CRUD, session CRUD, admin seed, expired-session cleanup, 20s session-user cache + invalidation.
- `backend/permissions.py` — flag lists, presets, `effective_permissions`, `allows`, `required_permissions(method, path)`, admin-route detection.
- `backend/routers/__init__.py`, `backend/routers/users.py` — admin-only user CRUD under `/api/auth/users`.

**Backend (modify):**
- `backend/auth.py` — rewritten: hashing re-export, session helpers, `SessionAuthMiddleware`, `/api/auth` router (login/logout/me), login rate limit. Remove `load_or_create_token`, `token_matches`, `TokenAuthMiddleware`, `init_auth`, `LoginRequest(token)`.
- `backend/main.py` — startup inits DB; swap middleware; include users router.
- `backend/requirements.txt` — add `aiosqlite==0.20.0`.
- `backend/requirements-dev.txt` — add `pytest-asyncio`.

**Frontend (create):**
- `lib/auth-context.tsx` — `AuthProvider`, `useAuth()`.
- `app/administration/page.tsx` — admin console (client guard).
- `components/admin/user-management.tsx`, `components/admin/permission-editor.tsx`.

**Frontend (modify):**
- `lib/api.ts` — auth helpers rewritten (`login(username,password)`, `getMe`, user CRUD, permission types).
- `components/auth-gate.tsx` — username/password form.
- `components/sidebar.tsx` — nav gating by area + admin link + logout via context.
- `app/layout.tsx` — wrap in `AuthProvider`.

**Tests (create):** `backend/tests/test_db.py`, `test_permissions.py`, `test_auth_session.py`, `test_users_crud.py`.

---

### Task 1: SQLite auth store (`backend/db.py`)

**Files:**
- Create: `backend/db.py`
- Test: `backend/tests/test_db.py`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `async def init_db(db_path: Path) -> None`
  - `async def close_db() -> None`
  - `def hash_password(password: str) -> str`
  - `def verify_password(password: str, stored: str) -> bool`
  - `async def create_user(username: str, password: str, role: str = "viewer", permissions: dict | None = None) -> int`
  - `async def get_user_by_username(username: str) -> dict | None`
  - `async def get_user_by_id(user_id: int) -> dict | None`
  - `async def list_users() -> list[dict]`
  - `async def update_user(user_id: int, *, password: str | None = None, role: str | None = None, permissions: dict | None = ..., is_active: bool | None = None) -> None`
  - `async def delete_user(user_id: int) -> None`
  - `async def count_admins() -> int`
  - `async def touch_last_login(user_id: int) -> None`
  - `async def create_session(user_id: int, ttl_seconds: int = 2592000) -> str`
  - `async def get_session_user(token: str) -> dict | None` (joins sessions+users, checks expiry + is_active, 20s cache)
  - `async def delete_session(token: str) -> None`
  - `async def delete_user_sessions(user_id: int) -> None`
  - `async def cleanup_expired_sessions() -> None`
  - `def invalidate_user_cache(user_id: int) -> None`
  - User dict shape: `{id, username, role, permissions(dict|None), is_active(bool), created_at, last_login}`. `get_session_user` adds `token`.

- [ ] **Step 1: Write failing tests**

```python
# backend/tests/test_db.py
import pytest
from pathlib import Path
import backend.db as db

@pytest.fixture
async def store(tmp_path):
    await db.init_db(tmp_path / "test.db")
    yield db
    await db.close_db()

def test_hash_roundtrip():
    h = db.hash_password("correct horse battery")
    assert "$" in h
    assert db.verify_password("correct horse battery", h)
    assert not db.verify_password("wrong", h)

def test_verify_rejects_malformed():
    assert not db.verify_password("x", "no-dollar-sign")

@pytest.mark.asyncio
async def test_create_and_fetch_user(store):
    uid = await store.create_user("alice", "password-123", role="viewer",
                                  permissions={"area_dashboard": True})
    u = await store.get_user_by_username("alice")
    assert u["id"] == uid and u["role"] == "viewer"
    assert u["permissions"] == {"area_dashboard": True}
    assert u["is_active"] is True
    assert not db.verify_password("password-123", "") and \
        (await store.get_user_by_id(uid))["username"] == "alice"

@pytest.mark.asyncio
async def test_update_and_delete_user(store):
    uid = await store.create_user("bob", "password-123")
    await store.update_user(uid, role="admin", is_active=False)
    u = await store.get_user_by_id(uid)
    assert u["role"] == "admin" and u["is_active"] is False
    await store.delete_user(uid)
    assert await store.get_user_by_id(uid) is None

@pytest.mark.asyncio
async def test_seed_admin_creates_one_admin(store, tmp_path):
    # init_db already seeded because users was empty
    assert await store.count_admins() == 1
    assert (tmp_path / "initial_admin_password.txt").exists()

@pytest.mark.asyncio
async def test_session_lifecycle(store):
    uid = await store.create_user("carol", "password-123")
    tok = await store.create_session(uid)
    s = await store.get_session_user(tok)
    assert s["id"] == uid and s["token"] == tok
    await store.delete_session(tok)
    store.invalidate_user_cache(uid)
    assert await store.get_session_user(tok) is None

@pytest.mark.asyncio
async def test_expired_session_rejected(store):
    uid = await store.create_user("dave", "password-123")
    tok = await store.create_session(uid, ttl_seconds=-1)
    store.invalidate_user_cache(uid)
    assert await store.get_session_user(tok) is None
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd backend && python -m pytest tests/test_db.py -v`
Expected: FAIL (module/functions missing).

- [ ] **Step 3: Implement `backend/db.py`**

```python
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
    except (ValueError, TypeError):
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
    await create_user("admin", password, role="admin", permissions=None)
    if _db_dir is not None:
        path = _db_dir / "initial_admin_password.txt"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(f"username: admin\npassword: {password}\n")


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
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd backend && python -m pytest tests/test_db.py -v`
Expected: PASS (all).
Note: `tests/conftest.py` must register pytest-asyncio. Add to `backend/requirements-dev.txt`: `pytest-asyncio`, and to `backend/pytest.ini` under `[pytest]`: `asyncio_mode = auto`.

- [ ] **Step 5: Commit**

```bash
git add backend/db.py backend/tests/test_db.py backend/requirements-dev.txt backend/pytest.ini
git commit -m "feat(auth): SQLite auth store (users + sessions, PBKDF2 hashing)"
```

---

### Task 2: Permissions module (`backend/permissions.py`)

**Files:**
- Create: `backend/permissions.py`
- Test: `backend/tests/test_permissions.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `AREA_FLAGS: list[str]`, `ACTION_FLAGS: list[str]`, `ALL_FLAGS: list[str]`
  - `VIEWER_DEFAULT: dict`, `OPERATOR_DEFAULT: dict`, `PRESETS: dict`, `DEFAULT_PERMISSIONS: dict`
  - `def effective_permissions(role: str, permissions: dict | None) -> dict`
  - `def allows(role: str, permissions: dict | None, needed: list[str]) -> bool`
  - `def required_permissions(method: str, path: str) -> list[str]`
  - `def is_admin_route(method: str, path: str) -> bool`
  - `def sanitize_permissions(raw: dict | None) -> dict | None`

- [ ] **Step 1: Write failing tests**

```python
# backend/tests/test_permissions.py
import backend.permissions as perms

def test_admin_has_everything():
    eff = perms.effective_permissions("admin", None)
    assert all(eff[f] for f in perms.ALL_FLAGS)

def test_viewer_default_read_only():
    eff = perms.effective_permissions("viewer", None)
    assert eff["area_dashboard"] and eff["area_missions"]
    assert not eff["can_inject"] and not eff["area_administration"]

def test_operator_can_inject_not_system():
    eff = perms.effective_permissions("viewer", perms.OPERATOR_DEFAULT)
    assert eff["can_inject"] and eff["missions_create"]
    assert not eff["system_reboot"] and not eff["area_administration"]

def test_allows_any_of():
    assert perms.allows("viewer", perms.OPERATOR_DEFAULT, ["can_inject"])
    assert not perms.allows("viewer", None, ["can_inject"])
    assert perms.allows("admin", None, ["system_reboot"])

def test_required_permissions_matches_dangerous_routes():
    assert perms.required_permissions("POST", "/api/can/send") == ["can_inject"]
    assert perms.required_permissions("POST", "/api/fuzzing/start") == ["fuzzing_run"]
    assert perms.required_permissions("GET", "/api/missions") == []

def test_is_admin_route():
    assert perms.is_admin_route("POST", "/api/auth/users")
    assert perms.is_admin_route("DELETE", "/api/auth/users/3")
    assert not perms.is_admin_route("GET", "/api/missions")

def test_sanitize_drops_unknown_keys():
    out = perms.sanitize_permissions({"can_inject": True, "bogus": True})
    assert out == {"can_inject": True}
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd backend && python -m pytest tests/test_permissions.py -v`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `backend/permissions.py`**

```python
"""AURIGE - Permissions fines (RBAC). Voir la spec pour la matrice complète."""
import re

AREA_FLAGS = [
    "area_dashboard", "area_missions", "area_control", "area_analysis",
    "area_capture", "area_configuration", "area_administration",
]
ACTION_FLAGS = [
    "can_inject", "fuzzing_run", "crash_recovery_run", "causality_validate",
    "capture_run", "replay_run", "missions_create", "missions_edit",
    "missions_delete", "dbc_manage", "obd_write", "system_update",
    "system_reboot", "system_network", "system_backup",
]
ALL_FLAGS = AREA_FLAGS + ACTION_FLAGS

VIEWER_DEFAULT = {f: False for f in ALL_FLAGS}
VIEWER_DEFAULT.update({
    "area_dashboard": True, "area_missions": True,
    "area_analysis": True, "area_capture": True,
})

OPERATOR_DEFAULT = {f: True for f in ALL_FLAGS}
OPERATOR_DEFAULT.update({
    "area_administration": False, "system_update": False,
    "system_reboot": False, "system_network": False, "system_backup": False,
})

PRESETS = {"admin": None, "operator": OPERATOR_DEFAULT, "viewer": VIEWER_DEFAULT}
DEFAULT_PERMISSIONS = VIEWER_DEFAULT


def sanitize_permissions(raw):
    if raw is None:
        return None
    return {k: bool(v) for k, v in raw.items() if k in ALL_FLAGS}


def effective_permissions(role, permissions):
    if role == "admin":
        return {f: True for f in ALL_FLAGS}
    eff = dict(VIEWER_DEFAULT)
    if permissions:
        eff.update({k: bool(v) for k, v in permissions.items() if k in ALL_FLAGS})
    return eff


def allows(role, permissions, needed):
    eff = effective_permissions(role, permissions)
    return any(eff.get(f, False) for f in needed)


# (method, compiled regex on path) -> required flags (any-of). Fail-closed:
# add an entry for every injection/stateful/system route. Starter set covers
# the dangerous routes; extend by auditing main.py (see Task 5, Step 6).
_ROUTE_RULES = [
    ("POST", r"^/api/can/send", ["can_inject"]),
    ("POST", r"^/api/generator/.*send", ["can_inject"]),
    ("POST", r"^/api/fuzzing/(start|run)", ["fuzzing_run"]),
    ("POST", r"^/api/fuzzing/crash-recovery", ["crash_recovery_run"]),
    ("POST", r"^/api/analysis/validate-causality", ["causality_validate"]),
    ("POST", r"^/api/capture/", ["capture_run"]),
    ("POST", r"^/api/replay/", ["replay_run"]),
    ("POST", r"^/api/missions$", ["missions_create"]),
    ("DELETE", r"^/api/missions/[^/]+$", ["missions_delete"]),
    ("POST", r"^/api/system/(apt|update)", ["system_update"]),
    ("POST", r"^/api/system/(reboot|restart-services)", ["system_reboot"]),
    ("POST", r"^/api/network/", ["system_network"]),
    ("POST", r"^/api/tailscale/", ["system_network"]),
    ("POST", r"^/api/system/backups", ["system_backup"]),
]
_COMPILED = [(m, re.compile(p), flags) for m, p, flags in _ROUTE_RULES]


def required_permissions(method, path):
    for m, rx, flags in _COMPILED:
        if m == method and rx.search(path):
            return flags
    return []


def is_admin_route(method, path):
    if re.match(r"^/api/auth/users(/[^/]+)?$", path) and method in ("POST", "PATCH", "DELETE"):
        return True
    return False
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd backend && python -m pytest tests/test_permissions.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/permissions.py backend/tests/test_permissions.py
git commit -m "feat(auth): fine-grained permission model (22 flags, presets)"
```

---

### Task 3: Session auth middleware + `/api/auth` router (`backend/auth.py` rewrite)

**Files:**
- Modify (full rewrite): `backend/auth.py`
- Test: `backend/tests/test_auth_session.py`

**Interfaces:**
- Consumes: `backend.db` (session + user ops, `verify_password`), `backend.permissions` (`required_permissions`, `is_admin_route`, `allows`).
- Produces:
  - `class SessionAuthMiddleware` (ASGI; authN + coarse authZ; injects `scope["state"]["user"]`)
  - `router: APIRouter` with `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
  - `def current_user(request) -> dict` (reads `request.state.user`)
  - `def require_permission(request, *flags) -> None` (raises 403 if the user lacks all flags; admin bypass) — used by handlers for double-intent routes.
  - `TOKEN_COOKIE = "aurige_session"`, `PUBLIC_PATHS`

- [ ] **Step 1: Write failing tests**

```python
# backend/tests/test_auth_session.py
import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient
import backend.db as db
import backend.auth as auth

@pytest.fixture
async def client(tmp_path):
    await db.init_db(tmp_path / "t.db")
    await db.create_user("op", "password-10x", role="viewer",
                         permissions=__import__("backend.permissions", fromlist=["x"]).OPERATOR_DEFAULT)
    await db.create_user("vw", "password-10x", role="viewer", permissions=None)
    app = FastAPI()
    app.add_middleware(auth.SessionAuthMiddleware) if False else None
    # pure-ASGI middleware: wrap manually
    app.include_router(auth.router)
    from backend.permissions import required_permissions
    @app.post("/api/can/send")
    async def _send(): return {"ok": True}
    app.add_middleware  # noop placeholder
    wrapped = auth.SessionAuthMiddleware(app)
    yield TestClient(wrapped)
    await db.close_db()

def test_login_bad_credentials(client):
    r = client.post("/api/auth/login", json={"username": "op", "password": "nope"})
    assert r.status_code == 401

def test_login_sets_cookie_and_me(client):
    r = client.post("/api/auth/login", json={"username": "op", "password": "password-10x"})
    assert r.status_code == 200 and "aurige_session" in r.cookies
    me = client.get("/api/auth/me")
    assert me.status_code == 200 and me.json()["username"] == "op"

def test_protected_route_requires_session(client):
    assert client.post("/api/can/send").status_code == 401

def test_viewer_forbidden_operator_allowed(client):
    client.post("/api/auth/login", json={"username": "vw", "password": "password-10x"})
    assert client.post("/api/can/send").status_code == 403
    client.post("/api/auth/logout")
    client.post("/api/auth/login", json={"username": "op", "password": "password-10x"})
    assert client.post("/api/can/send").status_code == 200

def test_rate_limit(client):
    for _ in range(5):
        client.post("/api/auth/login", json={"username": "op", "password": "x"})
    r = client.post("/api/auth/login", json={"username": "op", "password": "x"})
    assert r.status_code == 429
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd backend && python -m pytest tests/test_auth_session.py -v`
Expected: FAIL.

- [ ] **Step 3: Rewrite `backend/auth.py`**

```python
"""AURIGE - Authentification par comptes (sessions serveur + RBAC).

Remplace l'auth par token partagé (AUD-01). Session opaque stockée en DB,
transmise par le cookie HttpOnly `aurige_session`. Le middleware ASGI couvre
HTTP et WebSocket : il refuse l'accès sans session valide, applique
l'autorisation grossière (permissions par route, rôle admin pour la gestion
des comptes) et injecte l'utilisateur dans `scope["state"]["user"]`.
"""
import asyncio
import time
from http.cookies import SimpleCookie
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import backend.db as db
from backend.permissions import allows, is_admin_route, required_permissions

TOKEN_COOKIE = "aurige_session"
COOKIE_MAX_AGE = 30 * 24 * 3600
MIN_PASSWORD_LEN = 10

PUBLIC_PATHS = frozenset({"/api/health", "/api/auth/login", "/api/auth/logout"})

# rate limit login : {ip: [timestamps]}
_login_attempts: dict[str, list[float]] = {}
_RL_MAX = 5
_RL_WINDOW = 300.0


def _rate_limited(ip: str) -> bool:
    now = time.time()
    hits = [t for t in _login_attempts.get(ip, []) if now - t < _RL_WINDOW]
    _login_attempts[ip] = hits
    return len(hits) >= _RL_MAX


def _record_attempt(ip: str) -> None:
    _login_attempts.setdefault(ip, []).append(time.time())


def _scope_headers(scope) -> dict[str, str]:
    return {k.decode("latin-1").lower(): v.decode("latin-1")
            for k, v in scope.get("headers", [])}


def _extract_token(headers: dict[str, str]) -> Optional[str]:
    auth = headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    cookie_header = headers.get("cookie")
    if cookie_header:
        jar = SimpleCookie()
        try:
            jar.load(cookie_header)
        except Exception:
            return None
        m = jar.get(TOKEN_COOKIE)
        if m:
            return m.value
    return None


class SessionAuthMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        method = scope.get("method", "")
        if path in PUBLIC_PATHS or (scope["type"] == "http" and method == "OPTIONS"):
            await self.app(scope, receive, send)
            return

        token = _extract_token(_scope_headers(scope))
        user = await db.get_session_user(token) if token else None
        if not user:
            await self._reject(scope, receive, send, 401, "Authentification requise")
            return

        if scope["type"] == "http":
            needed = required_permissions(method, path)
            if needed and user["role"] != "admin" and not allows(
                user["role"], user["permissions"], needed
            ):
                await self._reject(scope, receive, send, 403, "Permission refusée")
                return
            if is_admin_route(method, path) and user["role"] != "admin":
                await self._reject(scope, receive, send, 403, "Réservé à l'administrateur")
                return

        scope.setdefault("state", {})["user"] = user
        await self.app(scope, receive, send)

    async def _reject(self, scope, receive, send, status, detail):
        if scope["type"] == "http":
            resp = JSONResponse({"detail": detail}, status_code=status)
            await resp(scope, receive, send)
            return
        message = await receive()
        if message["type"] == "websocket.connect":
            await send({"type": "websocket.close", "code": 1008})


router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str
    password: str


def _is_https(request: Request) -> bool:
    fwd = request.headers.get("x-forwarded-proto", "")
    return request.url.scheme == "https" or fwd.lower() == "https"


def _public_user(user: dict) -> dict:
    return {"id": user["id"], "username": user["username"],
            "role": user["role"], "permissions": user["permissions"]}


def current_user(request: Request) -> dict:
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Authentification requise")
    return user


def require_permission(request: Request, *flags: str) -> None:
    user = current_user(request)
    if user["role"] == "admin":
        return
    if not allows(user["role"], user["permissions"], list(flags)):
        raise HTTPException(status_code=403, detail="Permission refusée")


@router.post("/login")
async def login(body: LoginRequest, request: Request, response: Response):
    ip = request.client.host if request.client else "?"
    if _rate_limited(ip):
        raise HTTPException(status_code=429, detail="Trop d'essais. Réessayez plus tard.")
    user = await db.get_user_by_username(body.username.strip())
    stored = await db._get_password_hash(body.username.strip()) if user else None
    if not user or not user["is_active"] or not stored or not db.verify_password(body.password, stored):
        _record_attempt(ip)
        await asyncio.sleep(0.3)
        raise HTTPException(status_code=401, detail="Identifiants invalides")
    token = await db.create_session(user["id"])
    await db.touch_last_login(user["id"])
    response.set_cookie(TOKEN_COOKIE, token, max_age=COOKIE_MAX_AGE, httponly=True,
                        samesite="strict", secure=_is_https(request), path="/")
    return {"user": _public_user(user)}


@router.post("/logout")
async def logout(request: Request, response: Response):
    token = _extract_token({k.lower(): v for k, v in request.headers.items()})
    if token:
        await db.delete_session(token)
    response.delete_cookie(TOKEN_COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
async def me(request: Request):
    user = current_user(request)
    return _public_user(user)
```

Note on the test fixture: `app.add_middleware(auth.SessionAuthMiddleware)` cannot be used for a pure-ASGI class with FastAPI's BaseHTTPMiddleware stack; wrap the app manually as shown (`wrapped = auth.SessionAuthMiddleware(app)`) and point `TestClient` at `wrapped`. Clean up the fixture's placeholder lines when implementing — the decisive calls are: create users, define `/api/can/send`, wrap, yield `TestClient(wrapped)`.

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd backend && python -m pytest tests/test_auth_session.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auth.py backend/tests/test_auth_session.py
git commit -m "feat(auth): session middleware + login/logout/me (replaces shared token)"
```

---

### Task 4: User CRUD router (`backend/routers/users.py`)

**Files:**
- Create: `backend/routers/__init__.py` (empty), `backend/routers/users.py`
- Test: `backend/tests/test_users_crud.py`

**Interfaces:**
- Consumes: `backend.db`, `backend.permissions` (`sanitize_permissions`, `PRESETS`), `backend.auth` (`current_user`).
- Produces: `router: APIRouter` — `GET/POST /api/auth/users`, `PATCH/DELETE /api/auth/users/{id}`. Admin gating is enforced by `SessionAuthMiddleware.is_admin_route`; handlers also assert admin defensively.

- [ ] **Step 1: Write failing tests** (reuse the wrapped-app pattern from Task 3, logging in as the seeded `admin` using the password from `initial_admin_password.txt`, written by `init_db`; read it in the fixture).

```python
# backend/tests/test_users_crud.py
import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient
import backend.db as db, backend.auth as auth
from backend.routers import users

@pytest.fixture
async def client(tmp_path):
    await db.init_db(tmp_path / "t.db")
    pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].strip()
    app = FastAPI(); app.include_router(auth.router); app.include_router(users.router)
    c = TestClient(auth.SessionAuthMiddleware(app))
    c.post("/api/auth/login", json={"username": "admin", "password": pw})
    yield c
    await db.close_db()

def test_create_list_delete(client):
    r = client.post("/api/auth/users", json={"username": "guest", "password": "password-10x", "role": "viewer"})
    assert r.status_code == 200
    assert any(u["username"] == "guest" for u in client.get("/api/auth/users").json())
    uid = r.json()["id"]
    assert client.delete(f"/api/auth/users/{uid}").status_code == 200

def test_reject_short_password(client):
    assert client.post("/api/auth/users", json={"username": "x", "password": "short"}).status_code == 400

def test_reject_duplicate_username(client):
    client.post("/api/auth/users", json={"username": "dup", "password": "password-10x"})
    assert client.post("/api/auth/users", json={"username": "dup", "password": "password-10x"}).status_code == 400

def test_cannot_delete_self(client):
    me = client.get("/api/auth/me").json()
    assert client.delete(f"/api/auth/users/{me['id']}").status_code == 400

def test_cannot_delete_last_admin(client):
    # seeded admin is the only admin; create a viewer, deleting admin must fail
    me = client.get("/api/auth/me").json()
    client.post("/api/auth/users", json={"username": "v", "password": "password-10x"})
    assert client.delete(f"/api/auth/users/{me['id']}").status_code == 400
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd backend && python -m pytest tests/test_users_crud.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement `backend/routers/users.py`**

```python
"""AURIGE - Gestion des comptes (admin only). Monté sous /api/auth/users."""
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import backend.db as db
from backend.auth import current_user
from backend.permissions import PRESETS, sanitize_permissions

router = APIRouter(prefix="/api/auth/users", tags=["users"])


class UserCreate(BaseModel):
    username: str = Field(min_length=2)
    password: str
    role: str = "viewer"
    permissions: Optional[dict] = None


class UserUpdate(BaseModel):
    password: Optional[str] = None
    role: Optional[str] = None
    permissions: Optional[dict] = None
    is_active: Optional[bool] = None


def _require_admin(request: Request) -> dict:
    user = current_user(request)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Réservé à l'administrateur")
    return user


@router.get("")
async def list_users(request: Request):
    _require_admin(request)
    return [
        {"id": u["id"], "username": u["username"], "role": u["role"],
         "permissions": u["permissions"], "is_active": u["is_active"],
         "last_login": u["last_login"]}
        for u in await db.list_users()
    ]


@router.post("")
async def create_user(body: UserCreate, request: Request):
    _require_admin(request)
    if len(body.password) < 10:
        raise HTTPException(status_code=400, detail="Mot de passe trop court (min 10)")
    if body.role not in ("admin", "viewer"):
        raise HTTPException(status_code=400, detail="Rôle invalide")
    if await db.get_user_by_username(body.username.strip()):
        raise HTTPException(status_code=400, detail="Nom d'utilisateur déjà pris")
    perms = None if body.role == "admin" else sanitize_permissions(body.permissions)
    uid = await db.create_user(body.username.strip(), body.password, body.role, perms)
    return {"id": uid}


@router.patch("/{user_id}")
async def update_user(user_id: int, body: UserUpdate, request: Request):
    _require_admin(request)
    target = await db.get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="Compte introuvable")
    if body.password is not None and len(body.password) < 10:
        raise HTTPException(status_code=400, detail="Mot de passe trop court (min 10)")
    if body.role is not None and body.role not in ("admin", "viewer"):
        raise HTTPException(status_code=400, detail="Rôle invalide")
    if target["role"] == "admin" and body.role == "viewer" and await db.count_admins() <= 1:
        raise HTTPException(status_code=400, detail="Impossible de rétrograder le dernier admin")
    kwargs = {}
    if body.password is not None:
        kwargs["password"] = body.password
    if body.role is not None:
        kwargs["role"] = body.role
    if body.permissions is not None or (body.role == "viewer"):
        kwargs["permissions"] = sanitize_permissions(body.permissions)
    if body.role == "admin":
        kwargs["permissions"] = None
    if body.is_active is not None:
        kwargs["is_active"] = body.is_active
    await db.update_user(user_id, **kwargs)
    await db.delete_user_sessions(user_id)  # force re-login with new rights
    return {"ok": True}


@router.delete("/{user_id}")
async def delete_user(user_id: int, request: Request):
    admin = _require_admin(request)
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="Impossible de supprimer son propre compte")
    target = await db.get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="Compte introuvable")
    if target["role"] == "admin" and await db.count_admins() <= 1:
        raise HTTPException(status_code=400, detail="Impossible de supprimer le dernier admin")
    await db.delete_user(user_id)
    await db.delete_user_sessions(user_id)
    return {"ok": True}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd backend && python -m pytest tests/test_users_crud.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/routers/ backend/tests/test_users_crud.py
git commit -m "feat(auth): admin-only user CRUD endpoints"
```

---

### Task 5: Wire into `main.py`, deps, route audit

**Files:**
- Modify: `backend/main.py` (startup init DB; swap middleware; include users router; remove old token wiring), `backend/requirements.txt`
- Test: extend `backend/tests/` with one integration test `test_integration_boot.py`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: a running app with auth enforced on first boot.

- [ ] **Step 1: Add dependency**

Edit `backend/requirements.txt`: add line `aiosqlite==0.20.0`. Install: `cd backend && ./venv/bin/pip install aiosqlite==0.20.0` (dev: `pip install aiosqlite`).

- [ ] **Step 2: Modify `backend/main.py`**

Replace the AUD-01 token wiring. Remove:
```python
from auth import TokenAuthMiddleware, init_auth, router as auth_router
...
TOKEN_FILE = Path(os.getenv("AURIGE_TOKEN_FILE", str(DATA_DIR.parent / "api_token")))
init_auth(TOKEN_FILE)
...
app.add_middleware(TokenAuthMiddleware)
```
Add (imports near the other backend imports):
```python
import backend.db as db
from backend.auth import SessionAuthMiddleware, router as auth_router
from backend.routers.users import router as users_router

DB_PATH = Path(os.getenv("AURIGE_DB_PATH", str(DATA_DIR / "aurige.db")))
```
In the existing `lifespan` async context manager, before `yield`:
```python
    await db.init_db(DB_PATH)
```
and after `yield` (shutdown):
```python
    await db.close_db()
```
Middleware wiring — pure-ASGI class must wrap the whole app *outside* `add_middleware`. Keep CORS as `add_middleware`, and wrap at the end:
```python
app.add_middleware(
    CORSMiddleware, allow_origins=CORS_ORIGINS, allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)
app.include_router(auth_router)
app.include_router(users_router)
# SessionAuthMiddleware is pure ASGI (covers WebSocket) → wrap last, outermost
app = SessionAuthMiddleware(app)
```
Ensure `uvicorn` target still resolves (`main:app`). If the module imports use `from auth import ...` elsewhere, update them to the new names. Confirm `backend/` is importable as a package for `backend.db` imports: add empty `backend/__init__.py` if missing, and run the API from the repo root, or keep flat imports (`import db`) consistently — match whatever the existing `main.py` uses (it uses flat `from error_logger import ...`, so use flat imports: `import db`, `from auth import ...`, `from routers.users import router as users_router`, and in `db.py`/`auth.py`/`permissions.py`/`routers/users.py` use flat imports too: `import db`, `from permissions import ...`). **Adjust all test imports accordingly** (`import db`, `import auth`, `import permissions`, `from routers import users`) and run pytest from `backend/` with `pytest.ini` setting `pythonpath = .`.

- [ ] **Step 3: Write integration test**

```python
# backend/tests/test_integration_boot.py
import pytest
from starlette.testclient import TestClient

@pytest.mark.asyncio
async def test_boot_seeds_admin_and_enforces_auth(tmp_path, monkeypatch):
    monkeypatch.setenv("AURIGE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AURIGE_DB_PATH", str(tmp_path / "aurige.db"))
    import importlib, main
    importlib.reload(main)
    async with main.lifespan(main._inner_app if hasattr(main, "_inner_app") else None):
        c = TestClient(main.app)
        assert c.get("/api/missions").status_code == 401  # protected
        pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].strip()
        assert c.post("/api/auth/login", json={"username": "admin", "password": pw}).status_code == 200
```
If reloading `main` is awkward (module-level app wrap), instead assert the pieces: boot DB via `db.init_db`, build the app exactly as `main` does, and verify `/api/auth/login` + a 401 on a protected route. Keep the decisive assertions: protected route → 401; seeded admin login → 200.

- [ ] **Step 4: Run full backend suite**

Run: `cd backend && python -m pytest -v`
Expected: all tests PASS (Tasks 1–5).

- [ ] **Step 5: Manual smoke**

```bash
cd backend && AURIGE_DATA_DIR=/tmp/aurige-dev ./venv/bin/uvicorn main:app --port 8000 &
curl -s -o /dev/null -w "%{http_code}\n" localhost:8000/api/missions   # 401
cat /tmp/aurige-dev/initial_admin_password.txt
```

- [ ] **Step 6: Audit injection/system routes vs `permissions._ROUTE_RULES`**

Run: `grep -nE '@app\.(post|delete|patch)\("/api/(can|generator|fuzzing|capture|replay|missions|analysis|system|network|tailscale|obd)' backend/main.py`
For each dangerous/stateful route not already matched by a rule in `backend/permissions.py::_ROUTE_RULES`, add a rule following the existing `(METHOD, regex, [flag])` pattern (e.g. OBD write routes → `["obd_write"]`, DBC import → `["dbc_manage"]`). Re-run `python -m pytest tests/test_permissions.py` after extending (add an assertion per new rule).

- [ ] **Step 7: Commit**

```bash
git add backend/main.py backend/requirements.txt backend/permissions.py backend/tests/test_integration_boot.py
git commit -m "feat(auth): wire session auth into app, init DB on startup, audit route guards"
```

---

### Task 6: Frontend auth client + context

**Files:**
- Modify: `lib/api.ts` (auth section, lines ~191–206)
- Create: `lib/auth-context.tsx`
- Modify: `app/layout.tsx` (wrap with `AuthProvider`)

**Interfaces:**
- Consumes: `apiFetch`, `getApiBaseUrl`, `AUTH_REQUIRED_EVENT` from `lib/api-config.ts`; `fetchApi`/`APIError` from `lib/api.ts`.
- Produces: `login`, `logout`, `getMe`, `listUsers`, `createUser`, `updateUser`, `deleteUser`, types `AuthUser`, `UserPermissions`, `ManagedUser`; `AuthProvider`, `useAuth`.

- [ ] **Step 1: Rewrite the auth section of `lib/api.ts`**

Replace `getAuthStatus`/`login(token)`/`logout` (lines ~191–206) with:
```typescript
export const ALL_PERMISSION_FLAGS = [
  "area_dashboard","area_missions","area_control","area_analysis","area_capture",
  "area_configuration","area_administration","can_inject","fuzzing_run",
  "crash_recovery_run","causality_validate","capture_run","replay_run",
  "missions_create","missions_edit","missions_delete","dbc_manage","obd_write",
  "system_update","system_reboot","system_network","system_backup",
] as const
export type PermissionFlag = (typeof ALL_PERMISSION_FLAGS)[number]
export type UserPermissions = Partial<Record<PermissionFlag, boolean>>

export interface AuthUser {
  id: number
  username: string
  role: "admin" | "viewer"
  permissions: UserPermissions | null
}
export interface ManagedUser extends AuthUser {
  is_active: boolean
  last_login: string | null
}

export async function login(username: string, password: string): Promise<{ user: AuthUser }> {
  return fetchApi("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  })
}
export async function logout(): Promise<void> {
  await fetchApi("/auth/logout", { method: "POST" })
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
}
export async function getMe(): Promise<AuthUser> {
  return fetchApi("/auth/me", { cache: "no-store" })
}
export async function listUsers(): Promise<ManagedUser[]> {
  return fetchApi("/auth/users", { cache: "no-store" })
}
export async function createUser(input: {
  username: string; password: string; role: "admin" | "viewer"; permissions: UserPermissions | null
}): Promise<{ id: number }> {
  return fetchApi("/auth/users", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  })
}
export async function updateUser(id: number, patch: {
  password?: string; role?: "admin" | "viewer"; permissions?: UserPermissions | null; is_active?: boolean
}): Promise<void> {
  await fetchApi(`/auth/users/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
  })
}
export async function deleteUser(id: number): Promise<void> {
  await fetchApi(`/auth/users/${id}`, { method: "DELETE" })
}
```
Remove the now-unused `getAuthStatus`. Grep for its callers: `grep -rn getAuthStatus app components lib` — the only caller is `auth-gate.tsx`, rewritten in Task 7.

- [ ] **Step 2: Create `lib/auth-context.tsx`**

```typescript
"use client"
import React, { createContext, useCallback, useContext, useEffect, useState } from "react"
import { AUTH_REQUIRED_EVENT } from "@/lib/api-config"
import { APIError, getMe, login as apiLogin, logout as apiLogout,
         type AuthUser, type PermissionFlag } from "@/lib/api"

// zones en lecture seule par défaut pour un viewer sans permissions explicites
const VIEWER_DEFAULT: Partial<Record<PermissionFlag, boolean>> = {
  area_dashboard: true, area_missions: true, area_analysis: true, area_capture: true,
}

interface AuthCtx {
  user: AuthUser | null
  isAdmin: boolean
  isLoading: boolean
  hubUnreachable: boolean
  hasPermission: (flag: PermissionFlag) => boolean
  hasArea: (flag: PermissionFlag) => boolean
  login: (u: string, p: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}
const Ctx = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setLoading] = useState(true)
  const [hubUnreachable, setUnreachable] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setUser(await getMe()); setUnreachable(false)
    } catch (err) {
      if (err instanceof APIError && err.status === 401) { setUser(null); setUnreachable(false) }
      else setUnreachable(true)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    refresh()
    const onAuthRequired = () => setUser(null)
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
  }, [refresh])

  const login = useCallback(async (u: string, p: string) => {
    const { user } = await apiLogin(u, p); setUser(user); setUnreachable(false)
  }, [])
  const logout = useCallback(async () => { await apiLogout(); setUser(null) }, [])

  const hasPermission = useCallback((flag: PermissionFlag) => {
    if (!user) return false
    if (user.role === "admin") return true
    if (user.permissions) return !!user.permissions[flag]
    return !!VIEWER_DEFAULT[flag]
  }, [user])

  return (
    <Ctx.Provider value={{
      user, isAdmin: user?.role === "admin", isLoading, hubUnreachable,
      hasPermission, hasArea: hasPermission, login, logout, refresh,
    }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}
```

- [ ] **Step 3: Wrap app in `app/layout.tsx`**

Import `AuthProvider` and wrap the existing `<AuthGate>` (or body children) so provider is outside the gate:
```tsx
import { AuthProvider } from "@/lib/auth-context"
// ...
<AuthProvider>
  <AuthGate>{children}</AuthGate>
</AuthProvider>
```
(Keep existing providers/ThemeProvider ordering; `AuthProvider` goes outside `AuthGate`.)

- [ ] **Step 4: Typecheck + build**

Run: `npm run build`
Expected: build succeeds (note: `next.config.mjs` ignores TS errors, so also run `npx tsc --noEmit` and confirm no new errors in `lib/api.ts` / `lib/auth-context.tsx`).

- [ ] **Step 5: Commit**

```bash
git add lib/api.ts lib/auth-context.tsx app/layout.tsx
git commit -m "feat(auth): frontend auth client (login/me/user-CRUD) + auth context"
```

---

### Task 7: Rewrite `components/auth-gate.tsx` (username/password)

**Files:**
- Modify (rewrite): `components/auth-gate.tsx`

**Interfaces:**
- Consumes: `useAuth()` from `lib/auth-context.tsx`.

- [ ] **Step 1: Rewrite the component**

```tsx
"use client"
/**
 * AuthGate — bloque l'interface tant qu'aucune session valide n'existe.
 * Formulaire identifiant + mot de passe (remplace le champ token AUD-01).
 */
import React, { useState } from "react"
import { KeyRound, Loader2 } from "lucide-react"
import { useAuth } from "@/lib/auth-context"
import { APIError } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, isLoading, hubUnreachable, login, refresh } = useAuth()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!username.trim() || !password) return
    setSubmitting(true); setError(null)
    try {
      await login(username.trim(), password); setPassword("")
    } catch (err) {
      if (err instanceof APIError && err.status === 429) setError("Trop d'essais. Réessayez dans quelques minutes.")
      else if (err instanceof APIError && err.status === 401) setError("Identifiants invalides.")
      else setError("Backend injoignable. Vérifiez que le service aurige-api tourne.")
    } finally { setSubmitting(false) }
  }

  if (user) return <>{children}</>

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Vérification de la session" />
      </div>
    )
  }

  if (hubUnreachable) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 text-center">
          <p className="text-sm text-destructive">Backend injoignable.</p>
          <Button className="w-full" onClick={() => void refresh()}>Réessayer</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-5 rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10">
            <KeyRound className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground">AURIGE</h1>
            <p className="text-xs text-muted-foreground">Connexion</p>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="aurige-username">Identifiant</Label>
          <Input id="aurige-username" autoFocus autoComplete="username"
                 value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="aurige-password">Mot de passe</Label>
          <Input id="aurige-password" type="password" autoComplete="current-password"
                 value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={submitting || !username.trim() || !password}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Se connecter
        </Button>
      </form>
    </div>
  )
}
```

- [ ] **Step 2: Build + manual check**

Run: `npm run build`, then dev-run and verify the login form renders, bad creds show "Identifiants invalides", good creds reveal the app.

- [ ] **Step 3: Commit**

```bash
git add components/auth-gate.tsx
git commit -m "feat(auth): username/password login form in AuthGate"
```

---

### Task 8: Permission-gated navigation (`components/sidebar.tsx`)

**Files:**
- Modify: `components/sidebar.tsx`

**Interfaces:**
- Consumes: `useAuth()` (`hasArea`, `isAdmin`, `logout`).

Map each nav section to an area flag:

| Section / href | area flag |
|---|---|
| `/` (Dashboard) | `area_dashboard` |
| `/controle-can`, `/fuzzing`, `/crash-recovery`, `/generateur` | `area_control` |
| `/capture-replay`, `/replay-rapide` | `area_capture` |
| `/isolation`, `/comparaison`, `/analyse-can`, `/dbc`, `/obd-ii`, `/signal-finder` | `area_analysis` |
| `/missions/...` | `area_missions` |
| `/configuration` | `area_configuration` |
| `/administration` | `area_administration` |

- [ ] **Step 1: Add an `area` field to nav items and filter**

In the `NavItem` type add `area?: PermissionFlag`. Annotate each item in `baseNavigation` with its area per the table. Then in the render (`navigation.map(... section.items.map(item => ...))`) filter items: show an item only if `!item.area || hasArea(item.area)`; hide a whole section if it ends up with zero visible items. Add an Administration section:
```tsx
{ title: "Administration", items: [
  { name: "Comptes", href: "/administration", icon: Users, area: "area_administration" },
  { name: "Configuration Pi", href: "/configuration", icon: Cog, area: "area_configuration" },
]},
```
(Import `Users` from `lucide-react`; `area_*` type from `@/lib/api`.)

- [ ] **Step 2: Route the logout button through context**

Replace the existing `onClick={() => { void logout() }}` (importing `logout` from `@/lib/api`) with the context logout + redirect:
```tsx
const { hasArea, logout } = useAuth()
// ...
<button onClick={() => { void logout() }} ...>
```
Remove the direct `import { logout } from "@/lib/api"` (now from context). Keep the existing status fetch.

- [ ] **Step 3: Build + manual check**

Run: `npm run build`. Manual: as `viewer`, confirm Contrôle CAN / Fuzzing / Administration are hidden; as `admin`, all visible.

- [ ] **Step 4: Commit**

```bash
git add components/sidebar.tsx
git commit -m "feat(auth): permission-gated sidebar navigation + context logout"
```

---

### Task 9: Administration page + user management UI

**Files:**
- Create: `app/administration/page.tsx`, `components/admin/user-management.tsx`, `components/admin/permission-editor.tsx`

**Interfaces:**
- Consumes: `useAuth()`, `listUsers/createUser/updateUser/deleteUser`, `ManagedUser`, `UserPermissions`, `ALL_PERMISSION_FLAGS`.

- [ ] **Step 1: `components/admin/permission-editor.tsx`**

```tsx
"use client"
import { ALL_PERMISSION_FLAGS, type PermissionFlag, type UserPermissions } from "@/lib/api"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"

const AREA = ALL_PERMISSION_FLAGS.filter((f) => f.startsWith("area_"))
const ACTION = ALL_PERMISSION_FLAGS.filter((f) => !f.startsWith("area_"))

const OPERATOR: UserPermissions = Object.fromEntries(
  ALL_PERMISSION_FLAGS.map((f) => [f, !(["area_administration","system_update","system_reboot","system_network","system_backup"] as string[]).includes(f)]),
) as UserPermissions
const VIEWER: UserPermissions = { area_dashboard: true, area_missions: true, area_analysis: true, area_capture: true }

export function PermissionEditor({ value, onChange }: {
  value: UserPermissions; onChange: (v: UserPermissions) => void
}) {
  const set = (flag: PermissionFlag, on: boolean) => onChange({ ...value, [flag]: on })
  const applyPreset = (p: UserPermissions) => onChange({ ...p })
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => applyPreset(OPERATOR)}>Preset operator</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => applyPreset(VIEWER)}>Preset viewer</Button>
      </div>
      {[{ title: "Zones", flags: AREA }, { title: "Actions", flags: ACTION }].map((grp) => (
        <div key={grp.title} className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground">{grp.title}</p>
          <div className="grid grid-cols-2 gap-2">
            {grp.flags.map((f) => (
              <label key={f} className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1 text-xs">
                <span className="font-mono">{f}</span>
                <Switch checked={!!value[f]} onCheckedChange={(on) => set(f, on)} />
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: `components/admin/user-management.tsx`**

```tsx
"use client"
import { useEffect, useState } from "react"
import { Loader2, Trash2 } from "lucide-react"
import { createUser, deleteUser, listUsers, updateUser,
         type ManagedUser, type UserPermissions } from "@/lib/api"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PermissionEditor } from "@/components/admin/permission-editor"

const VIEWER: UserPermissions = { area_dashboard: true, area_missions: true, area_analysis: true, area_capture: true }

export function UserManagement() {
  const { user: me } = useAuth()
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [role, setRole] = useState<"admin" | "viewer">("viewer")
  const [perms, setPerms] = useState<UserPermissions>({ ...VIEWER })

  async function reload() {
    setLoading(true)
    try { setUsers(await listUsers()); setError(null) }
    catch { setError("Chargement impossible.") }
    finally { setLoading(false) }
  }
  useEffect(() => { void reload() }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault(); setError(null)
    try {
      await createUser({ username: username.trim(), password, role,
                         permissions: role === "admin" ? null : perms })
      setUsername(""); setPassword(""); setRole("viewer"); setPerms({ ...VIEWER })
      await reload()
    } catch (err) { setError(err instanceof Error ? err.message : "Création impossible.") }
  }

  if (loading) return <Loader2 className="h-5 w-5 animate-spin" />

  return (
    <div className="space-y-6">
      {error && <p className="text-xs text-destructive">{error}</p>}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Comptes</h2>
        <ul className="divide-y divide-border rounded border border-border">
          {users.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span>{u.username}
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">{u.role}</span>
                {!u.is_active && <span className="ml-2 text-[10px] text-destructive">inactif</span>}
                {me?.id === u.id && <span className="ml-2 text-[10px] text-muted-foreground">(vous)</span>}
              </span>
              {me?.id !== u.id && (
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm"
                    onClick={() => void updateUser(u.id, { is_active: !u.is_active }).then(reload)}>
                    {u.is_active ? "Désactiver" : "Activer"}
                  </Button>
                  <Button variant="ghost" size="sm"
                    onClick={() => void deleteUser(u.id).then(reload).catch(() => setError("Suppression refusée."))}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <form onSubmit={handleCreate} className="space-y-4 rounded border border-border p-4">
        <h2 className="text-sm font-semibold">Nouveau compte</h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="nu">Identifiant</Label>
            <Input id="nu" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="np">Mot de passe (min 10)</Label>
            <Input id="np" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Label>Rôle</Label>
          <select className="rounded border border-border bg-background px-2 py-1"
                  value={role} onChange={(e) => setRole(e.target.value as "admin" | "viewer")}>
            <option value="viewer">viewer</option>
            <option value="admin">admin</option>
          </select>
        </div>
        {role === "viewer" && <PermissionEditor value={perms} onChange={setPerms} />}
        <Button type="submit" disabled={username.trim().length < 2 || password.length < 10}>Créer</Button>
      </form>
    </div>
  )
}
```

- [ ] **Step 3: `app/administration/page.tsx` (client guard)**

```tsx
"use client"
import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/lib/auth-context"
import { UserManagement } from "@/components/admin/user-management"

export default function AdministrationPage() {
  const { isAdmin, isLoading, user } = useAuth()
  const router = useRouter()
  useEffect(() => {
    if (!isLoading && (!user || !isAdmin)) router.replace("/")
  }, [isLoading, user, isAdmin, router])
  if (isLoading || !isAdmin) return null
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-6 text-xl font-semibold">Administration — Comptes</h1>
      <UserManagement />
    </div>
  )
}
```

- [ ] **Step 4: Build + manual check**

Run: `npm run build`. Manual (on Pi, Task 10 deploy): admin opens `/administration`, creates a `viewer` guest with the operator preset, logs out, logs in as guest, confirms Contrôle CAN visible for operator / hidden for plain viewer, inject blocked (403) for plain viewer.

- [ ] **Step 5: Commit**

```bash
git add app/administration/page.tsx components/admin/
git commit -m "feat(auth): administration page with user management + permission editor"
```

---

### Task 10: Cleanup, docs, deploy

**Files:**
- Modify: `scripts/install_pi.sh` (replace token-display block ~line 590 with initial-admin-password display), `components/auth-gate.tsx` (already done), `CLAUDE.md` (security note), delete stale token references.

- [ ] **Step 1: Update `scripts/install_pi.sh`**

Replace the AUD-01 token block (reads `$AURIGE_DIR/api_token`) with reading `$AURIGE_DIR/data/initial_admin_password.txt`:
```bash
    ADMIN_FILE="$AURIGE_DIR/data/initial_admin_password.txt"
    for _ in $(seq 1 15); do [ -s "$ADMIN_FILE" ] && break; sleep 1; done
    if [ -s "$ADMIN_FILE" ]; then
        echo -e "Compte administrateur initial :"
        echo -e "  ${YELLOW}$(cat "$ADMIN_FILE")${NC}"
        echo -e "  ${YELLOW}Changez ce mot de passe après la première connexion, puis supprimez ce fichier :${NC}"
        echo -e "  ${YELLOW}sudo rm $ADMIN_FILE${NC}"
    else
        log_warn "Compte admin introuvable. Vérifier : sudo journalctl -u aurige-api -n 50"
    fi
```

- [ ] **Step 2: Update `CLAUDE.md` security section**

Replace the AUD-01 token description with: auth is now account-based (users/roles/permissions, SQLite `aurige.db`); the `can_inject` permission gates injection per-user and is distinct from the AUD-06 `is_id_blocked()` ID filter. Note `/opt/aurige/api_token` is obsolete.

- [ ] **Step 3: Full backend test run**

Run: `cd backend && python -m pytest -v` — expected all PASS (~30 tests).

- [ ] **Step 4: Commit**

```bash
git add scripts/install_pi.sh CLAUDE.md
git commit -m "chore(auth): update install script and docs for account-based auth"
```

- [ ] **Step 5: Deploy to Pi (manual, after merge approval)**

```bash
cd /opt/aurige/repo && sudo git pull
sudo cp -r backend/* /opt/aurige/backend/
cd /opt/aurige/backend && sudo ./venv/bin/pip install -r requirements.txt
sudo cp -r /opt/aurige/repo/{app,components,lib} /opt/aurige/frontend/
cd /opt/aurige/frontend && sudo npm run build
sudo systemctl restart aurige-api aurige-web
sudo cat /opt/aurige/data/initial_admin_password.txt
```
Then browser-verify the manual checklist (login, create guest, viewer cannot inject, operator can, logout). Optionally `sudo rm /opt/aurige/api_token`.

---

## Self-Review

**Spec coverage:** §2 architecture → Tasks 1–9; §3 permissions → Task 2 (+ Task 6 frontend mirror); §4 schema → Task 1; §5 endpoints/enforcement → Tasks 3–4 (+ route audit Task 5 Step 6); §6 frontend → Tasks 6–9; §7 migration/deploy → Tasks 5, 10; §8 tests → embedded per task. No uncovered section.

**Placeholder scan:** route-permission table is a concrete starter set + an explicit audit step (Task 5 Step 6) with the exact pattern to follow — not a vague "handle routes". Test fixtures note the pure-ASGI wrap explicitly. No TBD/TODO.

**Type consistency:** `effective_permissions`/`allows`/`required_permissions`/`sanitize_permissions` names match across Tasks 2–4; `AuthUser`/`ManagedUser`/`UserPermissions`/`PermissionFlag`/`ALL_PERMISSION_FLAGS` consistent across Tasks 6–9; cookie `aurige_session`, DB funcs (`get_session_user`, `create_session`, `delete_user_sessions`, `invalidate_user_cache`) consistent across Tasks 1, 3, 4. Flat-import decision (Task 5 Step 2) applied to all backend modules and tests.

**Known follow-on:** `permissions.ensure()` fine-grained double-intent enforcement (spec §5 layer 3) is provided as `require_permission(request, *flags)` in Task 3 and wired opportunistically where a route serves two intents; the route audit (Task 5 Step 6) flags such routes.
