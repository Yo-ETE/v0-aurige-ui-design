"""
AURIGE - Authentification par token partagé (AUD-01)

Toutes les routes HTTP et WebSocket exigent le token, sauf une courte liste
publique (santé + endpoints d'authentification). Le token est accepté via :
- l'en-tête `Authorization: Bearer <token>` (scripts, curl) ;
- l'en-tête `X-Aurige-Token` ;
- le cookie HttpOnly `aurige_token`, posé par `POST /api/auth/login` (navigateur,
  y compris pour les WebSockets et les liens de téléchargement).

Le token vient de la variable `AURIGE_API_TOKEN`, sinon du fichier
`AURIGE_TOKEN_FILE` (défaut : `/opt/aurige/api_token`), créé au premier
démarrage avec un token aléatoire et des permissions 0600.
"""

import asyncio
import hmac
import os
import secrets
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

TOKEN_COOKIE = "aurige_token"
COOKIE_MAX_AGE = 30 * 24 * 3600  # 30 jours

PUBLIC_PATHS = frozenset({
    "/api/health",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/status",
})


class AuthConfig:
    """Token attendu, fixé au démarrage par init_auth()."""
    token: str = ""


def load_or_create_token(token_file: Path) -> str:
    """Retourne le token configuré, en le générant au premier démarrage."""
    env_token = os.getenv("AURIGE_API_TOKEN", "").strip()
    if env_token:
        return env_token

    if token_file.exists():
        existing = token_file.read_text(encoding="utf-8").strip()
        if existing:
            return existing

    token_file.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(token + "\n")
    return token


def init_auth(token_file: Path) -> None:
    AuthConfig.token = load_or_create_token(token_file)


def token_matches(candidate: Optional[str]) -> bool:
    expected = AuthConfig.token
    if not candidate or not expected:
        return False
    return hmac.compare_digest(candidate.encode("utf-8"), expected.encode("utf-8"))


def _extract_token(headers: dict[str, str]) -> Optional[str]:
    auth = headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()

    header_token = headers.get("x-aurige-token")
    if header_token:
        return header_token.strip()

    cookie_header = headers.get("cookie")
    if cookie_header:
        cookie = SimpleCookie()
        try:
            cookie.load(cookie_header)
        except Exception:
            return None
        morsel = cookie.get(TOKEN_COOKIE)
        if morsel:
            return morsel.value
    return None


def _scope_headers(scope) -> dict[str, str]:
    return {
        k.decode("latin-1").lower(): v.decode("latin-1")
        for k, v in scope.get("headers", [])
    }


class TokenAuthMiddleware:
    """Middleware ASGI : couvre HTTP et WebSocket (BaseHTTPMiddleware ne voit pas les WS)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        scope_type = scope["type"]
        if scope_type not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if path in PUBLIC_PATHS or (scope_type == "http" and scope.get("method") == "OPTIONS"):
            await self.app(scope, receive, send)
            return

        if token_matches(_extract_token(_scope_headers(scope))):
            await self.app(scope, receive, send)
            return

        if scope_type == "http":
            response = JSONResponse({"detail": "Authentification requise"}, status_code=401)
            await response(scope, receive, send)
            return

        # WebSocket : refuser la poignée de main (le serveur répond 403)
        message = await receive()
        if message["type"] == "websocket.connect":
            await send({"type": "websocket.close", "code": 1008})


# =============================================================================
# Endpoints d'authentification
# =============================================================================

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    token: str


def _is_https(request: Request) -> bool:
    forwarded = request.headers.get("x-forwarded-proto", "")
    return request.url.scheme == "https" or forwarded.lower() == "https"


@router.post("/login")
async def login(body: LoginRequest, request: Request, response: Response):
    if not token_matches(body.token.strip()):
        # Ralentit le bruteforce ; le token fait 256 bits de toute façon
        await asyncio.sleep(0.5)
        raise HTTPException(status_code=401, detail="Token invalide")

    response.set_cookie(
        TOKEN_COOKIE,
        AuthConfig.token,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        samesite="strict",
        secure=_is_https(request),
        path="/",
    )
    return {"authenticated": True}


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie(TOKEN_COOKIE, path="/")
    return {"authenticated": False}


@router.get("/status")
async def auth_status(request: Request):
    headers = {k.lower(): v for k, v in request.headers.items()}
    return {"authenticated": token_matches(_extract_token(headers))}
