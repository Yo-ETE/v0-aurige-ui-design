"""AURIGE - Gestion des comptes (admin only). Monté sous /api/auth/users."""
import asyncio
import sqlite3
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import db
from auth import current_user
from permissions import PRESETS, sanitize_permissions

router = APIRouter(prefix="/api/auth/users", tags=["users"])

# Sérialise toute mutation pouvant retirer un admin actif (anti-TOCTOU).
_admin_mutation_lock = asyncio.Lock()


class UserCreate(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=128)
    role: str = "viewer"
    permissions: Optional[dict] = None


class UserUpdate(BaseModel):
    password: Optional[str] = Field(default=None, max_length=128)
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
    username = body.username.strip()
    if len(body.password) < 10:
        raise HTTPException(status_code=400, detail="Mot de passe trop court (min 10)")
    if len(username) < 2:
        raise HTTPException(status_code=400, detail="Nom d'utilisateur trop court (min 2)")
    if body.role not in ("admin", "viewer"):
        raise HTTPException(status_code=400, detail="Rôle invalide")
    perms = None if body.role == "admin" else sanitize_permissions(body.permissions)
    async with _admin_mutation_lock:
        if await db.get_user_by_username(username):
            raise HTTPException(status_code=400, detail="Nom d'utilisateur déjà pris")
        try:
            uid = await db.create_user(username, body.password, body.role, perms)
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=400, detail="Nom d'utilisateur déjà pris")
    return {"id": uid}


@router.patch("/{user_id}")
async def update_user(user_id: int, body: UserUpdate, request: Request):
    _require_admin(request)
    if body.password is not None and len(body.password) < 10:
        raise HTTPException(status_code=400, detail="Mot de passe trop court (min 10)")
    if body.role is not None and body.role not in ("admin", "viewer"):
        raise HTTPException(status_code=400, detail="Rôle invalide")
    async with _admin_mutation_lock:
        target = await db.get_user_by_id(user_id)
        if not target:
            raise HTTPException(status_code=404, detail="Compte introuvable")
        removes_admin = body.role == "viewer" or body.is_active is False
        if (target["role"] == "admin" and target["is_active"] and removes_admin
                and await db.count_admins() <= 1):
            raise HTTPException(
                status_code=400,
                detail="Impossible de rétrograder ou désactiver le dernier admin")
        new_role = body.role if body.role is not None else target["role"]
        kwargs = {}
        if body.password is not None:
            kwargs["password"] = body.password
        if body.role is not None:
            kwargs["role"] = body.role
        if new_role == "admin":
            new_perms = None
        elif body.permissions is not None:
            new_perms = sanitize_permissions(body.permissions)
        else:
            new_perms = target["permissions"]
        if new_perms != target["permissions"]:
            kwargs["permissions"] = new_perms
        if body.is_active is not None:
            kwargs["is_active"] = body.is_active
        rights_changed = (
            new_role != target["role"]
            or "permissions" in kwargs
            or (body.is_active is not None and body.is_active != target["is_active"])
        )
        await db.update_user(user_id, **kwargs)
        if rights_changed:
            await db.delete_user_sessions(user_id)  # force re-login with new rights
    return {"ok": True}


@router.delete("/{user_id}")
async def delete_user(user_id: int, request: Request):
    admin = _require_admin(request)
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="Impossible de supprimer son propre compte")
    async with _admin_mutation_lock:
        target = await db.get_user_by_id(user_id)
        if not target:
            raise HTTPException(status_code=404, detail="Compte introuvable")
        if (target["role"] == "admin" and target["is_active"]
                and await db.count_admins() <= 1):
            raise HTTPException(status_code=400, detail="Impossible de supprimer le dernier admin")
        await db.delete_user(user_id)
        await db.delete_user_sessions(user_id)
    return {"ok": True}
