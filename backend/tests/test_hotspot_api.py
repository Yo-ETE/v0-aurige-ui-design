"""API hotspot : routes /api/network/hotspot/*, garde d'auth et de permissions."""
import sys

import pytest
from starlette.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("AURIGE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AURIGE_DB_PATH", str(tmp_path / "aurige.db"))
    monkeypatch.setenv("AURIGE_AUTO_HOTSPOT", "0")
    sys.modules.pop("main", None)
    import hotspot
    import auth
    import main

    async def _noop():
        return None

    monkeypatch.setattr(hotspot, "auto_hotspot_once", _noop)
    monkeypatch.setattr(hotspot, "hotspot_status", lambda: {"active": False, "ssid": "", "interface": "wlan0", "clients": 0})
    monkeypatch.setattr(hotspot, "get_or_create_hotspot_password", lambda: "password10")
    monkeypatch.setattr(hotspot, "start_hotspot_blocking", lambda s, p: {"status": "success", "detail": "ok", "interface": "wlan0"})
    monkeypatch.setattr(hotspot, "stop_hotspot", lambda: {"status": "success", "detail": "ok", "interface": "wlan0"})
    auth._login_attempts.clear()
    try:
        with TestClient(main.app) as c:
            pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].split()[0].strip()
            yield c, pw
    finally:
        sys.modules.pop("main", None)


def _make_viewer(c, pw):
    r = c.post("/api/auth/login", json={"username": "admin", "password": pw})
    assert r.status_code == 200
    r = c.post("/api/auth/users", json={"username": "vw", "password": "password-10x", "role": "viewer"})
    assert r.status_code in (200, 201), r.text
    c.post("/api/auth/logout")
    c.cookies.clear()


def test_status_requires_auth(client):
    c, _ = client
    assert c.get("/api/network/hotspot/status").status_code == 401


def test_viewer_forbidden_on_start_and_credentials(client):
    c, pw = client
    _make_viewer(c, pw)
    r = c.post("/api/auth/login", json={"username": "vw", "password": "password-10x"})
    assert r.status_code == 200
    assert c.post("/api/network/hotspot/start").status_code == 403
    assert c.get("/api/network/hotspot/credentials").status_code == 403


def test_admin_start_and_credentials(client):
    c, pw = client
    assert c.post("/api/auth/login", json={"username": "admin", "password": pw}).status_code == 200
    assert c.get("/api/network/hotspot/status").status_code == 200
    assert c.post("/api/network/hotspot/start").json()["status"] == "success"
    assert c.post("/api/network/hotspot/stop").json()["status"] == "success"
    assert "password" in c.get("/api/network/hotspot/credentials").json()
    assert c.post("/api/network/hotspot/credentials", json={"password": "short"}).status_code == 400
