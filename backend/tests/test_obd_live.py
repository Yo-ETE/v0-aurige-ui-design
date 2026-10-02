"""Lecture synchrone de PID (Mode 01), statut MIL/DTC et freeze frame (Mode 02)."""
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
    captured = []
    monkeypatch.setattr(main, "_captured_request_data", captured, raising=False)
    auth._login_attempts.clear()
    try:
        with TestClient(main.app) as c:
            pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].split()[0].strip()
            assert c.post("/api/auth/login", json={"username": "admin", "password": pw}).status_code == 200
            yield c, monkeypatch, captured
    finally:
        sys.modules.pop("main", None)


def _mock(mp, captured, responses):
    import main

    async def fake(interface, rid, data, response_id="7E8"):
        captured.append(data)
        return {"success": True, "responses": responses}

    mp.setattr(main, "obd_send_with_flow_control", fake)


def test_pid_read_rpm(client):
    c, mp, cap = client
    # 41 0C 1A F8 -> ((26*256)+248)/4 = 1726 tr/min
    _mock(mp, cap, ["(0) can0 7E8#04410C1AF80000"])
    r = c.post("/api/obd/pid-read", json={"interface": "can0", "pid": "0C"})
    assert r.status_code == 200
    assert round(r.json()["value"]) == 1726
    assert r.json()["unit"] == "tr/min"
    assert len(cap[-1]) <= 16 and cap[-1].startswith("02010C")


def test_pid_read_no_response(client):
    c, mp, cap = client
    _mock(mp, cap, [])
    r = c.post("/api/obd/pid-read", json={"interface": "can0", "pid": "0C"})
    assert r.status_code == 200
    assert r.json().get("value") is None
    assert r.json()["status"] == "no_data"


def test_pid_read_rejects_bad_pid(client):
    c, mp, cap = client
    _mock(mp, cap, [])
    r = c.post("/api/obd/pid-read", json={"interface": "can0", "pid": "ZZ"})
    assert r.status_code in (400, 422)
    assert cap == []


def test_status_mil(client):
    c, mp, cap = client
    # 41 01 A B C D ; A=0x83 -> MIL on (bit7), 3 DTC
    _mock(mp, cap, ["(0) can0 7E8#06410183070000"])
    j = c.post("/api/obd/status", json={"interface": "can0"}).json()
    assert j["mil_on"] is True and j["dtc_count"] == 3
    assert len(cap[-1]) <= 16


def test_freeze_frame_coolant(client):
    c, mp, cap = client
    # 42 05 <frame 00> <A=0x7B> -> 123-40 = 83 C
    _mock(mp, cap, ["(0) can0 7E8#044205007B0000"])
    j = c.post("/api/obd/freeze-frame", json={"interface": "can0", "pid": "05"}).json()
    assert j["status"] == "success" and j["value"] == 83
    assert len(cap[-1]) <= 16 and cap[-1].startswith("030205")
