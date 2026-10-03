"""POST /api/can/identify : profil de bus en lecture seule (candump mocké)."""
import sys

import pytest
from starlette.testclient import TestClient

URL = "/api/can/identify"


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
            yield c, main
    finally:
        sys.modules.pop("main", None)


class _Status:
    def __init__(self, up):
        self.up = up


def _mock(monkeypatch, main, lines, up=True):
    from routers import can as can_router
    seen = {}

    async def fake(interface, duration):
        seen["duration"] = duration
        return lines

    monkeypatch.setattr(can_router, "_candump_sample", fake)
    monkeypatch.setattr(main, "get_can_interface_status", lambda i: _Status(up))
    return seen


SAMPLE = (
    ["(1.000) can0 0C0#1122"] * 5
    + ["(1.100) can0 1A0#00"] * 3
    + ["(1.200) can0 5F0#FF"] * 2
    + ["(1.300) can0 18DAF110#0102"]
    + ["(1.400) can0 0C1#00", "(1.500) can0 2B0#00", "(1.600) can0 4E0#00", "bruit"]
)


def test_sample_stats(client, monkeypatch):
    c, main = client
    _mock(monkeypatch, main, SAMPLE)
    r = c.post(URL, json={"interface": "can0", "durationSec": 2})
    assert r.status_code == 200
    j = r.json()
    assert j["frameCount"] == 14
    assert j["uniqueIds"] == 7
    assert j["loadHz"] == 7  # round(14 / 2)
    assert j["idRanges"] == {"0x000-0x0FF": 6, "0x100-0x3FF": 4, "0x400-0x7FF": 3, "extended": 1}
    assert j["topIds"][0] == {"id": "0C0", "count": 5}
    assert "peu actif" in j["estimate"]


def test_powertrain_estimate(client, monkeypatch):
    c, main = client
    _mock(monkeypatch, main, ["(1.0) can0 0C0#00"] * 3000)
    j = c.post(URL, json={"interface": "can0", "durationSec": 2}).json()
    assert j["loadHz"] == 1500
    assert "powertrain" in j["estimate"]


def test_body_estimate(client, monkeypatch):
    c, main = client
    ids = ["0A0", "0B0", "1A0", "1B0", "2A0", "4A0", "4B0", "5A0", "5B0"]
    lines = [f"(1.0) can0 {i}#00" for i in ids] * 50  # 450 trames / 1 s
    _mock(monkeypatch, main, lines)
    j = c.post(URL, json={"interface": "can0", "durationSec": 1}).json()
    assert j["loadHz"] == 450
    assert "body" in j["estimate"]


def test_no_traffic(client, monkeypatch):
    c, main = client
    _mock(monkeypatch, main, [])
    j = c.post(URL, json={"interface": "can0"}).json()
    assert j["frameCount"] == 0 and "Aucun trafic" in j["estimate"]


def test_interface_down(client, monkeypatch):
    c, main = client
    _mock(monkeypatch, main, SAMPLE, up=False)
    r = c.post(URL, json={"interface": "can0"})
    assert r.status_code == 400
    assert "Interface down" in r.json()["detail"]


def test_invalid_interface(client, monkeypatch):
    c, main = client
    _mock(monkeypatch, main, SAMPLE)
    assert c.post(URL, json={"interface": "eth0"}).status_code == 400


def test_duration_clamped(client, monkeypatch):
    c, main = client
    seen = _mock(monkeypatch, main, SAMPLE)
    assert c.post(URL, json={"interface": "can0", "durationSec": 100}).json()["durationSec"] == 10
    assert seen["duration"] == 10
    assert c.post(URL, json={"interface": "can0", "durationSec": 0.1}).json()["durationSec"] == 0.5
