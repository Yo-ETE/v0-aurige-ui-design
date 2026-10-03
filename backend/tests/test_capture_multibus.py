"""Capture multi-bus simultanee : un slot par interface, meta interface+bitrate."""
import json
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from starlette.testclient import TestClient


@pytest.fixture
def ctx(tmp_path, monkeypatch):
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
    logs = tmp_path / "missions" / "m1" / "logs"
    logs.mkdir(parents=True)
    monkeypatch.setattr(main, "load_mission", lambda mid: None)
    monkeypatch.setattr(main, "get_mission_logs_dir", lambda mid: logs)
    stats = []
    monkeypatch.setattr(main, "update_mission_stats", lambda mid, **kw: stats.append((mid, kw)))
    monkeypatch.setattr(
        main, "get_can_interface_status",
        lambda i: SimpleNamespace(bitrate=500000 if i == "can0" else 250000),
    )

    async def fake_exec(*args, **kwargs):
        fake = AsyncMock()
        fake.returncode = None
        fake.terminate = lambda: None
        fake.kill = lambda: None
        fake.wait = AsyncMock(return_value=0)
        return fake

    monkeypatch.setattr(main.asyncio, "create_subprocess_exec", fake_exec)
    auth._login_attempts.clear()
    try:
        with TestClient(main.app) as c:
            pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].split()[0].strip()
            assert c.post("/api/auth/login", json={"username": "admin", "password": pw}).status_code == 200
            main.state.captures.clear()
            yield c, main, logs, stats
    finally:
        sys.modules.pop("main", None)


def _start(c, iface, **kw):
    return c.post("/api/capture/start", json={"missionId": "m1", "interface": iface, **kw})


def test_two_buses_simultaneous(ctx):
    c, main, logs, _ = ctx
    assert _start(c, "can0").status_code == 200
    assert _start(c, "can1").status_code == 200
    assert set(main.state.captures) == {"can0", "can1"}
    st = c.get("/api/capture/status").json()
    assert {s["interface"] for s in st["captures"]} == {"can0", "can1"}
    assert all(s["running"] for s in st["captures"])


def test_same_interface_conflict(ctx):
    c, *_ = ctx
    assert _start(c, "can0").status_code == 200
    assert _start(c, "can0").status_code == 409


def test_invalid_interface_400(ctx):
    c, *_ = ctx
    assert _start(c, "eth0").status_code == 400


def test_stop_one_leaves_other(ctx):
    c, main, _, stats = ctx
    _start(c, "can0")
    _start(c, "can1")
    r = c.post("/api/capture/stop", params={"interface": "can0"})
    assert r.status_code == 200 and r.json()["status"] == "stopped"
    assert set(main.state.captures) == {"can1"}
    assert [s["interface"] for s in c.get("/api/capture/status").json()["captures"]] == ["can1"]
    assert stats and stats[0][0] == "m1"


def test_stop_body_interface(ctx):
    c, main, *_ = ctx
    _start(c, "can0")
    _start(c, "can1")
    assert c.post("/api/capture/stop", json={"interface": "can1"}).status_code == 200
    assert set(main.state.captures) == {"can0"}


def test_stop_ambiguous_400(ctx):
    c, *_ = ctx
    _start(c, "can0")
    _start(c, "can1")
    assert c.post("/api/capture/stop").status_code == 400


def test_stop_single_without_interface(ctx):
    c, main, *_ = ctx
    _start(c, "can1")
    assert c.post("/api/capture/stop").status_code == 200
    assert main.state.captures == {}


def test_stop_not_live_404(ctx):
    c, *_ = ctx
    _start(c, "can0")
    assert c.post("/api/capture/stop", params={"interface": "can1"}).status_code == 404
    assert c.post("/api/capture/stop", params={"interface": "can0"}).status_code == 200
    assert c.post("/api/capture/stop").status_code == 404


def test_meta_has_interface_bitrate_and_logs_list(ctx):
    c, main, logs, _ = ctx
    fn = _start(c, "can1").json()["filename"]
    meta = json.loads((logs / fn).with_suffix(".meta.json").read_text())
    assert meta["interface"] == "can1" and meta["bitrate"] == 250000
    c.post("/api/capture/stop")
    meta = json.loads((logs / fn).with_suffix(".meta.json").read_text())
    assert "durationSeconds" in meta
    entries = c.get("/api/missions/m1/logs").json()
    e = next(x for x in entries if x["filename"] == fn)
    assert e["interface"] == "can1" and e["bitrate"] == 250000
