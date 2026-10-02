"""Bibliotheque globale de trames connues (crash / reinit) + rejeu one-shot/boucle."""
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest
from starlette.testclient import TestClient


@pytest.fixture
def ctx(tmp_path, monkeypatch):
    monkeypatch.setenv("AURIGE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AURIGE_DB_PATH", str(tmp_path / "aurige.db"))
    monkeypatch.setenv("AURIGE_AUTO_HOTSPOT", "0")
    sys.modules.pop("main", None)
    sys.modules.pop("known_frames", None)
    import hotspot
    import auth
    import known_frames
    import main

    async def _noop():
        return None

    monkeypatch.setattr(hotspot, "auto_hotspot_once", _noop)
    monkeypatch.setattr(known_frames, "KNOWN_FRAMES_PATH", tmp_path / "known_frames.json")
    monkeypatch.setattr(main, "INJECT_SCRIPT_PATH", tmp_path / "aurige_inject.sh")
    auth._login_attempts.clear()
    try:
        with TestClient(main.app) as c:
            pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].split()[0].strip()
            assert c.post("/api/auth/login", json={"username": "admin", "password": pw}).status_code == 200
            main.state.inject_process = None
            yield c, main, known_frames, monkeypatch, tmp_path
    finally:
        sys.modules.pop("main", None)
        sys.modules.pop("known_frames", None)


def _fake():
    fake = AsyncMock()
    fake.returncode = None
    fake.terminate = lambda: None
    fake.kill = lambda: None
    fake.wait = AsyncMock(return_value=0)
    return fake


def _create_body(**kw):
    body = {"can_id": "4C8", "crash_data": "0003000000000000", "reset_data": "0000000000000000",
            "label": "Peugeot - reinit tableau de bord"}
    body.update(kw)
    return body


def test_crud(ctx):
    c, *_ = ctx
    r = c.post("/api/known-frames", json=_create_body())
    assert r.status_code == 200
    frame = r.json()
    assert frame["can_id"] == "4C8"
    assert frame["severity"] == "danger"  # defaut
    assert "id" in frame and "created_at" in frame
    fid = frame["id"]

    r = c.get("/api/known-frames")
    assert r.status_code == 200
    assert [f["id"] for f in r.json()["frames"]] == [fid]

    r = c.patch(f"/api/known-frames/{fid}", json={"label": "Nouveau libelle"})
    assert r.status_code == 200
    assert r.json()["label"] == "Nouveau libelle"
    assert r.json()["can_id"] == "4C8"  # inchange

    r = c.delete(f"/api/known-frames/{fid}")
    assert r.status_code == 200
    assert c.get("/api/known-frames").json() == {"frames": []}


def test_delete_missing_404(ctx):
    c, *_ = ctx
    assert c.delete("/api/known-frames/doesnotexist").status_code == 404


def test_patch_missing_404(ctx):
    c, *_ = ctx
    assert c.patch("/api/known-frames/doesnotexist", json={"label": "x"}).status_code == 404


def test_bad_hex_400(ctx):
    c, *_ = ctx
    r = c.post("/api/known-frames", json=_create_body(can_id="ZZ"))
    assert r.status_code == 400
    r = c.post("/api/known-frames", json=_create_body(crash_data="GG"))
    assert r.status_code == 400


def test_replay_oneshot(ctx):
    c, main, kf, mp, _ = ctx
    r = c.post("/api/known-frames", json=_create_body())
    fid = r.json()["id"]
    mock = MagicMock(return_value=(True, ""))
    mp.setattr(main, "can_send_frame", mock)
    r = c.post(f"/api/known-frames/{fid}/replay", json={"interface": "can0", "kind": "crash", "loop": False})
    assert r.status_code == 200
    mock.assert_called_once_with("can0", "4C8", "0003000000000000")


def test_replay_reset_missing_400(ctx):
    c, main, kf, mp, _ = ctx
    r = c.post("/api/known-frames", json=_create_body(reset_data=""))
    fid = r.json()["id"]
    mock = MagicMock(return_value=(True, ""))
    mp.setattr(main, "can_send_frame", mock)
    r = c.post(f"/api/known-frames/{fid}/replay", json={"interface": "can0", "kind": "reset", "loop": False})
    assert r.status_code == 400
    mock.assert_not_called()


def test_replay_loop(ctx):
    c, main, kf, mp, tmp = ctx
    r = c.post("/api/known-frames", json=_create_body())
    fid = r.json()["id"]
    mock = AsyncMock(return_value=_fake())
    mp.setattr(main, "run_command_async", mock)
    r = c.post(f"/api/known-frames/{fid}/replay", json={"interface": "can0", "kind": "crash", "loop": True, "intervalMs": 50})
    assert r.status_code == 200
    assert mock.call_args[0][0][0] == "bash"
    script = (tmp / "aurige_inject.sh").read_text()
    assert "cansend can0 '4C8#0003000000000000'" in script
    s = c.get("/api/inject/status").json()
    assert s["running"] is True


def test_replay_not_blocked(ctx):
    c, main, kf, mp, _ = ctx
    # AUD-06 : 4C8 sur liste critique -> bloquerait le fuzzing/generator, mais PAS le rejeu cible
    main._save_blocklist(["4C8"])
    called = {"count": 0}
    orig = main.is_id_blocked

    def _spy(can_id):
        called["count"] += 1
        return orig(can_id)

    mp.setattr(main, "is_id_blocked", _spy)
    r = c.post("/api/known-frames", json=_create_body(can_id="4C8"))
    fid = r.json()["id"]
    mp.setattr(main, "can_send_frame", MagicMock(return_value=(True, "")))
    r = c.post(f"/api/known-frames/{fid}/replay", json={"interface": "can0", "kind": "crash", "loop": False})
    assert r.status_code == 200
    assert called["count"] == 0  # is_id_blocked jamais appele par le rejeu


def test_replay_requires_can_inject_permission():
    import permissions
    assert permissions.required_permissions("POST", "/api/known-frames") == ["can_inject"]
    assert permissions.required_permissions("POST", "/api/known-frames/abc/replay") == ["can_inject"]
    assert permissions.required_permissions("PATCH", "/api/known-frames/abc") == ["can_inject"]
    assert permissions.required_permissions("DELETE", "/api/known-frames/abc") == ["can_inject"]


def test_replay_stored_invalid_400(ctx):
    c, main, kf, mp, _ = ctx
    # Entrees corrompues ecrites en contournant la validation
    kf.save_frames([
        {"id": "bad1", "can_id": "4C8;rm", "crash_data": "00", "reset_data": "", "label": "x", "severity": "danger"},
        {"id": "bad2", "can_id": "4C8", "crash_data": "0G", "reset_data": "", "label": "y", "severity": "danger"},
    ])
    send = MagicMock(return_value=(True, ""))
    run = AsyncMock(return_value=_fake())
    mp.setattr(main, "can_send_frame", send)
    mp.setattr(main, "run_command_async", run)
    for fid in ("bad1", "bad2"):
        for loop in (False, True):
            r = c.post(f"/api/known-frames/{fid}/replay", json={"interface": "can0", "kind": "crash", "loop": loop})
            assert r.status_code == 400
    send.assert_not_called()
    run.assert_not_called()
