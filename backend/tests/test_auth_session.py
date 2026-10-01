import pytest
from fastapi import FastAPI, WebSocket
from starlette.testclient import TestClient

import db
import auth
from permissions import OPERATOR_DEFAULT


@pytest.fixture
async def client(tmp_path):
    await db.init_db(tmp_path / "t.db")
    await db.create_user("op", "password-10x", role="viewer", permissions=OPERATOR_DEFAULT)
    await db.create_user("vw", "password-10x", role="viewer", permissions=None)
    auth._login_attempts.clear()
    app = FastAPI()
    app.include_router(auth.router)

    @app.post("/api/can/send")
    async def _send():
        return {"ok": True}

    @app.post("/api/auth/users")
    async def _users():
        return {"ok": True}

    @app.websocket("/ws/whatever")
    async def _ws(websocket: WebSocket):
        await websocket.accept()
        await websocket.close()

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


# --- Tests complémentaires (revue Task 3) ---

BAD = {"detail": "Identifiants invalides"}


def _login(c, user="op", pw="password-10x"):
    return c.post("/api/auth/login", json={"username": user, "password": pw})


def test_cookie_flags(client):
    r = _login(client)
    sc = r.headers["set-cookie"].lower()
    assert "httponly" in sc and "samesite=strict" in sc and "max-age=2592000" in sc


async def test_unknown_inactive_and_bad_password_same_body(client, tmp_path):
    uid = await db.create_user("gone", "password-10x", role="viewer", permissions=None)
    await db.update_user(uid, is_active=False)
    r1 = client.post("/api/auth/login", json={"username": "op", "password": "bad"})
    r2 = client.post("/api/auth/login", json={"username": "nobody", "password": "bad"})
    r3 = client.post("/api/auth/login", json={"username": "gone", "password": "password-10x"})
    for r in (r1, r2, r3):
        assert r.status_code == 401 and r.json() == BAD


def test_viewer_admin_route_forbidden(client):
    _login(client, "vw")
    assert client.post("/api/auth/users").status_code == 403


def test_bearer_token_works(client):
    token = _login(client).cookies["aurige_session"]
    client.cookies.clear()
    r = client.post("/api/can/send", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200


def test_forged_and_empty_credentials_rejected(client):
    client.cookies.set("aurige_session", "forged-token")
    assert client.post("/api/can/send").status_code == 401
    client.cookies.clear()
    client.cookies.set("aurige_session", "")
    assert client.post("/api/can/send").status_code == 401
    client.cookies.clear()
    assert client.post("/api/can/send", headers={"Authorization": "Bearer "}).status_code == 401


def test_options_bypasses_auth(client):
    assert client.options("/api/can/send").status_code != 401


def test_websocket_without_session_rejected(client):
    with pytest.raises(Exception):
        with client.websocket_connect("/ws/whatever"):
            pass


def test_rate_limit_per_username(client):
    for _ in range(5):
        _login(client, "op", "x")
    assert _login(client, "op", "x").status_code == 429
    assert _login(client, "vw", "password-10x").status_code == 200


def test_success_resets_counter(client):
    for _ in range(4):
        _login(client, "op", "x")
    assert _login(client).status_code == 200
    for _ in range(4):
        _login(client, "op", "x")
    assert _login(client, "op", "x").status_code == 401
