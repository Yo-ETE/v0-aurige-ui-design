import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

import db
import auth
from permissions import ALL_FLAGS
from routers import users

PW = "password-10x"


class Env:
    def __init__(self, app, admin_pw):
        self.app = auth.SessionAuthMiddleware(app)
        self.admin_pw = admin_pw

    def login(self, username, password):
        c = TestClient(self.app)
        r = c.post("/api/auth/login", json={"username": username, "password": password})
        assert r.status_code == 200, r.text
        return c


@pytest.fixture
async def env(tmp_path):
    await db.init_db(tmp_path / "t.db")
    pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].strip()
    auth._login_attempts.clear()
    app = FastAPI()
    app.include_router(auth.router)
    app.include_router(users.router)
    yield Env(app, pw)
    await db.close_db()


@pytest.fixture
def client(env):
    return env.login("admin", env.admin_pw)


def _create(client, username, **kw):
    r = client.post("/api/auth/users", json={"username": username, "password": PW, **kw})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _names(client):
    return [u["username"] for u in client.get("/api/auth/users").json()]


# ---------- gating ----------

def test_viewer_gets_403_everywhere(env, client):
    _create(client, "vw")
    other = _create(client, "other")
    vw = env.login("vw", PW)
    assert vw.get("/api/auth/users").status_code == 403
    assert vw.post("/api/auth/users", json={"username": "zz", "password": PW}).status_code == 403
    assert vw.patch(f"/api/auth/users/{other}", json={"role": "admin"}).status_code == 403
    assert vw.delete(f"/api/auth/users/{other}").status_code == 403
    # aucun effet
    names = _names(client)
    assert "zz" not in names and "other" in names


def test_handlers_assert_admin_defensively(client, monkeypatch):
    monkeypatch.setattr(users, "current_user", lambda r: {"id": 1, "role": "viewer"})
    assert client.get("/api/auth/users").status_code == 403
    assert client.post("/api/auth/users", json={"username": "zz", "password": PW}).status_code == 403
    assert client.patch("/api/auth/users/1", json={"role": "viewer"}).status_code == 403
    assert client.delete("/api/auth/users/1").status_code == 403


# ---------- create / list / delete ----------

def test_create_list_delete(client):
    uid = _create(client, "guest", role="viewer")
    assert "guest" in _names(client)
    assert client.delete(f"/api/auth/users/{uid}").status_code == 200
    assert "guest" not in _names(client)


async def test_delete_removes_user_from_db(client):
    uid = _create(client, "gone")
    assert await db.get_user_by_id(uid) is not None
    assert client.delete(f"/api/auth/users/{uid}").status_code == 200
    assert await db.get_user_by_id(uid) is None


def test_delete_missing_is_404(client):
    assert client.delete("/api/auth/users/99999").status_code == 404


def test_reject_short_password(client):
    assert client.post("/api/auth/users", json={"username": "xx", "password": "short"}).status_code == 400
    assert "xx" not in _names(client)


def test_reject_short_username_with_valid_password(client):
    r = client.post("/api/auth/users", json={"username": "x", "password": PW})
    assert r.status_code == 400
    assert "Nom d'utilisateur" in r.json()["detail"]
    assert "x" not in _names(client)


def test_reject_overlong_fields(client):
    assert client.post("/api/auth/users", json={"username": "a" * 65, "password": PW}).status_code == 422
    assert client.post("/api/auth/users", json={"username": "okname", "password": "p" * 129}).status_code == 422


def test_reject_invalid_role(client):
    r = client.post("/api/auth/users", json={"username": "rr", "password": PW, "role": "root"})
    assert r.status_code == 400
    assert "rr" not in _names(client)


def test_reject_duplicate_username(client):
    _create(client, "dup")
    r = client.post("/api/auth/users", json={"username": "dup", "password": PW})
    assert r.status_code == 400
    assert _names(client).count("dup") == 1


async def test_create_viewer_permissions_sanitized(client):
    flag = ALL_FLAGS[0]
    uid = _create(client, "pv", permissions={flag: True, "bogus_flag": True, ALL_FLAGS[1]: "yes"})
    assert (await db.get_user_by_id(uid))["permissions"] == {flag: True}


async def test_create_admin_permissions_null(client):
    uid = _create(client, "adm2", role="admin", permissions={ALL_FLAGS[0]: True})
    u = await db.get_user_by_id(uid)
    assert u["role"] == "admin" and u["permissions"] is None


# ---------- last admin ----------

def test_cannot_delete_self(client):
    me = client.get("/api/auth/me").json()
    assert client.delete(f"/api/auth/users/{me['id']}").status_code == 400
    assert any(u["id"] == me["id"] for u in client.get("/api/auth/users").json())


def test_last_admin_protected_with_second_admin(env, client):
    first = client.get("/api/auth/me").json()["id"]
    second = _create(client, "admin2", role="admin")
    c2 = env.login("admin2", PW)
    # deux admins actifs : supprimer le premier est permis
    assert c2.delete(f"/api/auth/users/{first}").status_code == 200
    assert not any(u["id"] == first for u in c2.get("/api/auth/users").json())
    # admin2 est maintenant le dernier : tout retrait est refusé
    assert c2.delete(f"/api/auth/users/{second}").status_code == 400
    assert c2.patch(f"/api/auth/users/{second}", json={"role": "viewer"}).status_code == 400
    assert c2.patch(f"/api/auth/users/{second}", json={"is_active": False}).status_code == 400
    me = c2.get("/api/auth/me")
    assert me.status_code == 200 and me.json()["role"] == "admin"


def test_delete_last_admin_branch_reached_by_other_caller(client, monkeypatch):
    """Appelant different de la cible : la garde 'dernier admin' doit refuser."""
    admin_id = client.get("/api/auth/me").json()["id"]
    monkeypatch.setattr(users, "current_user", lambda r: {"id": 99999, "role": "admin"})
    r = client.delete(f"/api/auth/users/{admin_id}")
    assert r.status_code == 400
    assert "dernier admin" in r.json()["detail"]
    monkeypatch.undo()
    assert any(u["id"] == admin_id for u in client.get("/api/auth/users").json())


def test_cannot_demote_or_deactivate_sole_admin_self(client):
    me = client.get("/api/auth/me").json()["id"]
    assert client.patch(f"/api/auth/users/{me}", json={"role": "viewer"}).status_code == 400
    assert client.patch(f"/api/auth/users/{me}", json={"is_active": False}).status_code == 400
    assert client.get("/api/auth/me").json()["role"] == "admin"


def test_inactive_admin_does_not_count(client):
    me = client.get("/api/auth/me").json()["id"]
    other = _create(client, "adm3", role="admin")
    assert client.patch(f"/api/auth/users/{other}", json={"is_active": False}).status_code == 200
    # un seul admin actif : soi-meme reste protege
    assert client.patch(f"/api/auth/users/{me}", json={"is_active": False}).status_code == 400
    # supprimer l'admin inactif est autorise
    assert client.delete(f"/api/auth/users/{other}").status_code == 200


# ---------- PATCH ----------

def test_patch_missing_is_404(client):
    assert client.patch("/api/auth/users/99999", json={"role": "viewer"}).status_code == 404


def test_patch_validation(client):
    uid = _create(client, "pp")
    assert client.patch(f"/api/auth/users/{uid}", json={"password": "short"}).status_code == 400
    assert client.patch(f"/api/auth/users/{uid}", json={"role": "root"}).status_code == 400


async def test_patch_permissions_updates_and_invalidates_session(env, client):
    uid = _create(client, "tgt")
    tgt = env.login("tgt", PW)
    assert tgt.get("/api/auth/me").status_code == 200
    r = client.patch(f"/api/auth/users/{uid}", json={"permissions": {ALL_FLAGS[0]: True, "junk": True}})
    assert r.status_code == 200
    assert (await db.get_user_by_id(uid))["permissions"] == {ALL_FLAGS[0]: True}
    assert tgt.get("/api/auth/me").status_code == 401


async def test_patch_role_updates_and_invalidates_session(env, client):
    uid = _create(client, "tgt2")
    tgt = env.login("tgt2", PW)
    assert client.patch(f"/api/auth/users/{uid}", json={"role": "admin"}).status_code == 200
    u = await db.get_user_by_id(uid)
    assert u["role"] == "admin" and u["permissions"] is None
    assert tgt.get("/api/auth/me").status_code == 401


async def test_patch_admin_stays_admin_permissions_null(client):
    uid = _create(client, "adm4", role="admin")
    assert client.patch(f"/api/auth/users/{uid}",
                        json={"permissions": {ALL_FLAGS[0]: True}}).status_code == 200
    assert (await db.get_user_by_id(uid))["permissions"] is None


async def test_patch_demote_admin_to_viewer(client):
    uid = _create(client, "adm5", role="admin")
    assert client.patch(f"/api/auth/users/{uid}", json={"role": "viewer"}).status_code == 200
    assert (await db.get_user_by_id(uid))["role"] == "viewer"


async def test_patch_deactivate_invalidates_and_blocks_login(env, client):
    uid = _create(client, "tgt3")
    tgt = env.login("tgt3", PW)
    assert client.patch(f"/api/auth/users/{uid}", json={"is_active": False}).status_code == 200
    assert (await db.get_user_by_id(uid))["is_active"] is False
    assert tgt.get("/api/auth/me").status_code == 401
    r = TestClient(env.app).post("/api/auth/login", json={"username": "tgt3", "password": PW})
    assert r.status_code == 401


def test_password_only_patch_keeps_session_and_changes_password(env, client):
    uid = _create(client, "tgt4")
    tgt = env.login("tgt4", PW)
    assert client.patch(f"/api/auth/users/{uid}", json={"password": "new-password-11"}).status_code == 200
    assert tgt.get("/api/auth/me").status_code == 200
    env.login("tgt4", "new-password-11")
    old = TestClient(env.app).post("/api/auth/login", json={"username": "tgt4", "password": PW})
    assert old.status_code == 401


def test_empty_patch_keeps_session(env, client):
    uid = _create(client, "tgt5")
    tgt = env.login("tgt5", PW)
    assert client.patch(f"/api/auth/users/{uid}", json={}).status_code == 200
    assert tgt.get("/api/auth/me").status_code == 200
