"""AURIGE - Gestion des comptes (admin only). Monté sous /api/auth/users."""
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import db
from auth import current_user
from permissions import PRESETS, sanitize_permissions

router = APIRouter(prefix="/api/auth/users", tags=["users"])


class UserCreate(BaseModel):
    username: str
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
    if len(body.username.strip()) < 2:
        raise HTTPException(status_code=400, detail="Nom d'utilisateur trop court (min 2)")
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
