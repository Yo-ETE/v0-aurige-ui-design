"""Endpoints DTC en attente (Mode 07) et permanents (Mode 0A)."""
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

    async def fake_flow(interface, request_id, request_data, response_id="7E8"):
        # Réponse à un DTC ; octet de service = mode demandé + 0x40 (47 / 4A)
        mode = request_data[2:4]
        svc = f"{(int(mode, 16) + 0x40):02X}"
        return {"success": True, "responses": [f"(0) can0 7E8#04{svc}010300000000"]}

    monkeypatch.setattr(main, "obd_send_with_flow_control", fake_flow)
    auth._login_attempts.clear()
    try:
        with TestClient(main.app) as c:
            pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].split()[0].strip()
            assert c.post("/api/auth/login", json={"username": "admin", "password": pw}).status_code == 200
            yield c
    finally:
        sys.modules.pop("main", None)


def test_pending(client):
    r = client.post("/api/obd/dtc/pending", json={"interface": "can0"})
    assert r.status_code == 200
    j = r.json()
    assert j["dtcs"] == ["P0103"]
    assert j["dtc_details"][0]["category"] == "P"


def test_permanent(client):
    r = client.post("/api/obd/dtc/permanent", json={"interface": "can0"})
    assert r.json()["dtcs"] == ["P0103"]


def test_read_still_works(client):
    r = client.post("/api/obd/dtc/read", json={"interface": "can0"})
    assert r.json()["dtcs"] == ["P0103"]
    assert r.json()["data"] == "P0103"
