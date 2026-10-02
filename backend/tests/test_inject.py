"""Injection de fond : boucle d'une trame / keep-alive d'un log."""
import sys
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
    monkeypatch.setattr(main, "INJECT_SCRIPT_PATH", tmp_path / "aurige_inject.sh")
    auth._login_attempts.clear()
    try:
        with TestClient(main.app) as c:
            pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].split()[0].strip()
            assert c.post("/api/auth/login", json={"username": "admin", "password": pw}).status_code == 200
            main.state.inject_process = None
            yield c, main, monkeypatch, tmp_path
    finally:
        sys.modules.pop("main", None)


def _fake():
    fake = AsyncMock()
    fake.returncode = None
    fake.terminate = lambda: None
    fake.kill = lambda: None
    fake.wait = AsyncMock(return_value=0)
    return fake


def test_injectable_or_block_allows_for_now(ctx):
    _, main, _, _ = ctx
    assert main._injectable_or_block(["123#1122"]) is None


def test_inject_frame_rejects_bad_data(ctx):
    c, *_ = ctx
    r = c.post("/api/inject/start", json={"interface": "can0", "mode": "frame", "canId": "123", "data": "ZZ"})
    assert r.status_code == 400


def test_inject_frame_rejects_long_data(ctx):
    c, *_ = ctx
    r = c.post("/api/inject/start", json={"interface": "can0", "mode": "frame", "canId": "123", "data": "11223344556677889900"})
    assert r.status_code == 400


def test_inject_rejects_bad_interface(ctx):
    c, *_ = ctx
    r = c.post("/api/inject/start", json={"interface": "can0; rm -rf /", "mode": "frame", "canId": "123", "data": "00"})
    assert r.status_code == 400


def test_inject_frame_starts_status_and_stop(ctx):
    c, main, mp, tmp = ctx
    mock = AsyncMock(return_value=_fake())
    mp.setattr(main, "run_command_async", mock)
    r = c.post("/api/inject/start", json={"interface": "can0", "mode": "frame", "canId": "3b7", "data": "0004", "intervalMs": 1})
    assert r.status_code == 200
    assert mock.call_args[0][0][0] == "bash"
    script = (tmp / "aurige_inject.sh").read_text()
    assert "cansend can0 '3B7#0004'" in script
    assert "sleep 0.01" in script  # intervalle clampe a 10 ms
    s = c.get("/api/inject/status").json()
    assert s["running"] is True and "3B7#0004" in s["description"]
    assert c.post("/api/inject/stop").status_code == 200
    assert c.get("/api/inject/status").json() == {"running": False, "description": ""}


def test_inject_second_start_conflicts(ctx):
    c, main, mp, _ = ctx
    mp.setattr(main, "run_command_async", AsyncMock(return_value=_fake()))
    body = {"interface": "can0", "mode": "frame", "canId": "100", "data": "01"}
    assert c.post("/api/inject/start", json=body).status_code == 200
    assert c.post("/api/inject/start", json={**body, "canId": "101"}).status_code == 409


def test_inject_log_mode_loops_frames(ctx):
    c, main, mp, tmp = ctx
    logs = tmp / "logs"
    logs.mkdir()
    (logs / "L1.log").write_text("(1.0) can0 123#AABB\n(1.1) can0 7DF#0201\njunk\n")
    mp.setattr(main, "get_mission_logs_dir", lambda mid: logs)
    mp.setattr(main, "run_command_async", AsyncMock(return_value=_fake()))
    r = c.post("/api/inject/start", json={"interface": "can0", "mode": "log", "missionId": "m1", "logId": "L1", "intervalMs": 50})
    assert r.status_code == 200
    script = (tmp / "aurige_inject.sh").read_text()
    assert "cansend can0 '123#AABB'" in script and "cansend can0 '7DF#0201'" in script
    assert "while true" in script


def test_inject_log_empty_is_400(ctx):
    c, main, mp, tmp = ctx
    logs = tmp / "logs"
    logs.mkdir()
    (logs / "E.log").write_text("nothing here\n")
    mp.setattr(main, "get_mission_logs_dir", lambda mid: logs)
    r = c.post("/api/inject/start", json={"interface": "can0", "mode": "log", "missionId": "m1", "logId": "E"})
    assert r.status_code == 400


def test_inject_blocked_returns_403(ctx):
    c, main, mp, _ = ctx
    mp.setattr(main, "_injectable_or_block", lambda frames: "interdit")
    r = c.post("/api/inject/start", json={"interface": "can0", "mode": "frame", "canId": "100", "data": "01"})
    assert r.status_code == 403


def test_inject_requires_can_inject_permission():
    import permissions
    assert permissions.required_permissions("POST", "/api/inject/start") == ["can_inject"]
    assert permissions.required_permissions("POST", "/api/inject/stop") == ["can_inject"]


def test_inject_rejects_trailing_newline_interface(ctx):
    c, *_ = ctx
    r = c.post("/api/inject/start", json={"interface": "can0\nrm", "mode": "frame", "canId": "123", "data": "00"})
    assert r.status_code == 400
    r2 = c.post("/api/inject/start", json={"interface": "can0", "mode": "frame", "canId": "12\n3", "data": "00"})
    assert r2.status_code == 400


def test_inject_rejects_dotdot_ids(ctx):
    c, *_ = ctx
    for mid, lid in (("..", "x"), ("m", ".."), (".hidden", "x"), ("m", "a/b")):
        r = c.post("/api/inject/start", json={"interface": "can0", "mode": "log", "missionId": mid, "logId": lid})
        assert r.status_code == 400


def test_inject_log_hostile_lines_skipped(ctx):
    c, main, mp, tmp = ctx
    logs = tmp / "logs"
    logs.mkdir()
    (logs / "H.log").write_text(
        "(1.0) can0 x;rm#1\n(1.1) can0 $(reboot)#1\n(1.2) can0 `id`#00\n"
        "(1.3) can0 123#AA&&reboot\n(1.4) can0 1a2#0b\n"
    )
    mp.setattr(main, "get_mission_logs_dir", lambda mid: logs)
    mp.setattr(main, "run_command_async", AsyncMock(return_value=_fake()))
    r = c.post("/api/inject/start", json={"interface": "can0", "mode": "log", "missionId": "m1", "logId": "H"})
    assert r.status_code == 200
    script = (tmp / "aurige_inject.sh").read_text()
    for bad in (";rm", "$(", "`", "&&", "reboot", "x;"):
        assert bad not in script
    assert "1A2#0B" in script
    assert "1 trames" in r.json()["description"]


def test_inject_log_frame_cap(ctx):
    c, main, mp, tmp = ctx
    logs = tmp / "logs"
    logs.mkdir()
    mp.setattr(main, "INJECT_MAX_FRAMES", 3)
    (logs / "B.log").write_text("".join(f"({i}.0) can0 10{i}#01\n" for i in range(6)))
    mp.setattr(main, "get_mission_logs_dir", lambda mid: logs)
    mp.setattr(main, "run_command_async", AsyncMock(return_value=_fake()))
    r = c.post("/api/inject/start", json={"interface": "can0", "mode": "log", "missionId": "m1", "logId": "B"})
    assert r.status_code == 200 and "tronque" in r.json()["description"]
    assert (tmp / "aurige_inject.sh").read_text().count("cansend") == 3
