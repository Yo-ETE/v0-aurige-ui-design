import pytest
from fastapi import FastAPI
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
