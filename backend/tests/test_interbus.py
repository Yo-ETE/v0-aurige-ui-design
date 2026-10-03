"""Correlation inter-bus : parse de deux logs candump -L, alignement par timestamp absolu."""
import sys

import pytest
from starlette.testclient import TestClient

URL = "/api/analysis/inter-bus-correlation"


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
            logs = tmp_path / "missions" / "m1" / "logs"
            logs.mkdir(parents=True)
            yield c, logs
    finally:
        sys.modules.pop("main", None)


def _write(logs, name, lines):
    (logs / f"{name}.log").write_text("\n".join(lines) + "\n")


def test_relay_translated_and_blocked(client):
    c, logs = client
    _write(logs, "a", [
        "(100.000) can0 200#1122",   # relaye a l'identique sur B
        "(100.100) can0 200#1122",
        "(100.200) can0 300#AABB",   # traduit : payload different
        "(100.300) can0 400#FF",     # aucun echo -> bloque
    ])
    _write(logs, "b", [
        "(100.005) can1 7E8#1122",
        "(100.105) can1 7E8#1122",
        "(100.206) can1 7E9#0102",
    ])
    r = c.post(URL, json={"mission_id": "m1", "log_a_id": "a", "log_b_id": "b", "window_ms": 20})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["total_a"] == 4 and d["total_b"] == 3
    pairs = {(p["id_a"], p["id_b"]): p for p in d["pairs"]}
    relay = pairs[("200", "7E8")]
    assert relay["co"] == 2 and relay["p_forward"] == 1 and relay["kind"] == "relay"
    assert 4.9 <= relay["avg_delay_ms"] <= 5.1
    assert pairs[("300", "7E9")]["kind"] == "translated"
    assert d["blocked_ids"] == ["400"]


def test_missing_log_404(client):
    c, logs = client
    _write(logs, "a", ["(100.000) can0 200#11"])
    r = c.post(URL, json={"mission_id": "m1", "log_a_id": "a", "log_b_id": "nope"})
    assert r.status_code == 404
