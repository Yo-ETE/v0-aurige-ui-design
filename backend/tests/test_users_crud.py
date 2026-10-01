import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

import db
import auth
from routers import users


@pytest.fixture
async def client(tmp_path):
    await db.init_db(tmp_path / "t.db")
    pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].strip()
    auth._login_attempts.clear()
    app = FastAPI()
    app.include_router(auth.router)
    app.include_router(users.router)
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
    me = client.get("/api/auth/me").json()
    client.post("/api/auth/users", json={"username": "v", "password": "password-10x"})
    assert client.delete(f"/api/auth/users/{me['id']}").status_code == 400
