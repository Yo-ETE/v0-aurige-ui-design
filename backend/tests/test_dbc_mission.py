"""Endpoints DBC de mission : message, signal, export durci (via dbc_store)."""
import sys

import pytest
from starlette.testclient import TestClient

SIG = {"can_id": "0C6", "name": "Pressure", "start_bit": 0, "length": 8,
       "byte_order": "little_endian", "is_signed": False, "scale": 1, "offset": 0,
       "min_val": 0, "max_val": 255, "unit": "", "comment": ""}


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
    auth._login_attempts.clear()
    try:
        with TestClient(auth.SessionAuthMiddleware(main.fastapi_app)) as c:
            pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].split()[0].strip()
            assert c.post("/api/auth/login", json={"username": "admin", "password": pw}).status_code == 200
            mid = "m-test"
            # Les endpoints DBC exigent seulement que le dossier de mission existe.
            (tmp_path / "missions" / mid).mkdir(parents=True)
            yield c, mid
    finally:
        sys.modules.pop("main", None)


def test_add_message_then_signal(client):
    c, mid = client
    r = c.post(f"/api/missions/{mid}/dbc/message", json={"can_id": "0C6", "name": "BrakeStatus", "dlc": 6, "comment": "frein"})
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "ok", "can_id": "0C6"}
    msg = next(m for m in c.get(f"/api/missions/{mid}/dbc").json()["messages"] if m["can_id"] == "0C6")
    assert msg["name"] == "BrakeStatus" and msg["dlc"] == 6 and msg["signals"] == []
    r = c.post(f"/api/missions/{mid}/dbc/signal", json=SIG)
    assert r.status_code == 200, r.text
    msg = next(m for m in c.get(f"/api/missions/{mid}/dbc").json()["messages"] if m["can_id"] == "0C6")
    assert msg["name"] == "BrakeStatus" and len(msg["signals"]) == 1


def test_message_rejects_bad_can_id(client):
    c, mid = client
    assert c.post(f"/api/missions/{mid}/dbc/message", json={"can_id": "ZZZ", "name": "X"}).status_code == 400


def test_message_unknown_mission_404(client):
    c, _ = client
    assert c.post("/api/missions/nope/dbc/message", json={"can_id": "123"}).status_code == 404


def test_export_uses_hardened_text(client):
    c, mid = client
    c.post(f"/api/missions/{mid}/dbc/signal", json={**SIG, "can_id": "18DAF110", "name": "Diag"})
    r = c.get(f"/api/missions/{mid}/dbc/export")
    assert r.status_code == 200
    bo_id = int("18DAF110", 16) | 0x80000000
    assert f"BO_ {bo_id} MSG_18DAF110: 8 Vector__XXX" in r.text
