"""AURIGE - Authentification par comptes (sessions serveur + RBAC).

Remplace l'auth par token partagé (AUD-01). Session opaque stockée en DB,
transmise par le cookie HttpOnly `aurige_session`. Le middleware ASGI couvre
HTTP et WebSocket : il refuse l'accès sans session valide, applique
l'autorisation grossière (permissions par route, rôle admin pour la gestion
des comptes) et injecte l'utilisateur dans `scope["state"]["user"]`.

L'objet utilisateur est partagé par référence (cache de db.py) : lecture seule.
"""
import asyncio
import time
from http.cookies import SimpleCookie
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import db
from permissions import allows, is_admin_route, required_permissions

TOKEN_COOKIE = "aurige_session"
COOKIE_MAX_AGE = 30 * 24 * 3600
MIN_PASSWORD_LEN = 10

PUBLIC_PATHS = frozenset({"/api/health", "/api/auth/login", "/api/auth/logout"})

DUMMY_HASH = db.hash_password("x")

# rate limit login : {username: [timestamps]}
_login_attempts: dict[str, list[float]] = {}
_RL_MAX = 5
_RL_WINDOW = 300.0


def _prune_attempts() -> None:
    now = time.time()
    for k in list(_login_attempts):
        hits = [t for t in _login_attempts[k] if now - t < _RL_WINDOW]
        if hits:
            _login_attempts[k] = hits
        else:
            del _login_attempts[k]


def _rate_limited(key: str) -> bool:
    now = time.time()
    hits = [t for t in _login_attempts.get(key, []) if now - t < _RL_WINDOW]
    _login_attempts[key] = hits
    return len(hits) >= _RL_MAX


def _record_attempt(key: str) -> None:
    _login_attempts.setdefault(key, []).append(time.time())


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
    username: str = Field(max_length=64)
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
    # Clé = nom d'utilisateur (nginx same-origin : l'IP client est toujours locale).
    username = body.username.strip()
    key = username.lower()
    _prune_attempts()
    if _rate_limited(key):
        raise HTTPException(status_code=429, detail="Trop d'essais. Réessayez plus tard.")
    # Enregistré de façon synchrone AVANT tout await (anti-TOCTOU sur rafale).
    _record_attempt(key)
    user = await db.get_user_by_username(username)
    stored = await db._get_password_hash(username) if user else None
    # PBKDF2 hors boucle d'événements ; hash factice si compte absent/inactif
    # pour que le temps de réponse ne révèle pas l'existence du compte.
    ok = await asyncio.to_thread(db.verify_password, body.password, stored or DUMMY_HASH)
    if not user or not user["is_active"] or not stored or not ok:
        await asyncio.sleep(0.3)
        raise HTTPException(status_code=401, detail="Identifiants invalides")
    _login_attempts.pop(key, None)
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
