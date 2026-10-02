"""AUD-06 : liste critique d'IDs (bloque fuzzing/generator/causalite, pas l'OBD)."""
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
    import hotspot
    import auth
    import main

    async def _noop():
        return None

    monkeypatch.setattr(hotspot, "auto_hotspot_once", _noop)
    monkeypatch.setattr(main, "BLOCKLIST_PATH", tmp_path / "aud06_blocklist.json")
    monkeypatch.setattr(main, "FUZZ_SCRIPT_PATH", tmp_path / "aurige_fuzz.py")
    auth._login_attempts.clear()
    try:
        with TestClient(main.app) as c:
            pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].split()[0].strip()
            assert c.post("/api/auth/login", json={"username": "admin", "password": pw}).status_code == 200
            main.state.fuzzing_process = None
            main.state.cangen_process = None
            yield c, main, monkeypatch, tmp_path
    finally:
        sys.modules.pop("main", None)


def _set(main, ids):
    main._save_blocklist(ids)


def test_obd_never_blocked(ctx):
    _, main, _, _ = ctx
    _set(main, ["7E8", "7DF"])
    assert main.is_id_blocked("7E8") is False
    assert main.is_id_blocked("0x7df") is False


def test_blocked_id(ctx):
    _, main, _, _ = ctx
    _set(main, ["4C8"])
    assert main.is_id_blocked("0x4c8") is True
    assert main.is_id_blocked("4C8") is True
    assert main.is_id_blocked("360") is False
    assert main._norm_id(" 0x4c8 ") == "4C8"


def test_put_rejects_obd_id(ctx):
    c, *_ = ctx
    assert c.put("/api/aud06/blocklist", json={"ids": ["7DF"]}).status_code == 400
    assert c.put("/api/aud06/blocklist", json={"ids": ["ZZ"]}).status_code == 400


def test_blocklist_roundtrip(ctx):
    c, *_ = ctx
    assert c.get("/api/aud06/blocklist").json() == {"ids": []}
    assert c.put("/api/aud06/blocklist", json={"ids": ["4C8", "360"]}).status_code == 200
    assert c.get("/api/aud06/blocklist").json() == {"ids": ["4C8", "360"]}


def test_put_requires_safety_config():
    import permissions
    assert permissions.required_permissions("PUT", "/api/aud06/blocklist") == ["safety_config"]
    assert permissions.effective_permissions("operator", permissions.OPERATOR_DEFAULT)["safety_config"] is True
    assert permissions.effective_permissions("viewer", None)["safety_config"] is False


def _fake_popen(main, mp):
    mock = MagicMock()
    mock.return_value.returncode = None
    mp.setattr(main.subprocess, "Popen", mock)
    return mock


def _fuzz_body(**kw):
    body = {"interface": "can0", "idStart": "000", "idEnd": "7FF", "iterations": 10,
            "enablePreFuzzCapture": False, "dataMode": "random"}
    body.update(kw)
    return body


def test_fuzzing_skips_blocked(ctx):
    c, main, mp, tmp = ctx
    _set(main, ["4C8"])
    _fake_popen(main, mp)
    r = c.post("/api/fuzzing/start", json=_fuzz_body(targetIds=["4C8", "360"]))
    assert r.status_code == 200
    assert r.json()["blocked_skipped"] == 1
    script = (tmp / "aurige_fuzz.py").read_text()
    assert "4C8" not in script
    assert 'TARGET_IDS = ["360"]' in script


def test_fuzzing_range_skips_blocked(ctx):
    c, main, mp, tmp = ctx
    _set(main, ["002"])
    _fake_popen(main, mp)
    r = c.post("/api/fuzzing/start", json=_fuzz_body(idStart="000", idEnd="004"))
    assert r.status_code == 200 and r.json()["blocked_skipped"] == 1
    assert 'TARGET_IDS = ["000", "001", "003", "004"]' in (tmp / "aurige_fuzz.py").read_text()


def test_fuzzing_all_blocked_403(ctx):
    c, main, mp, _ = ctx
    _set(main, ["4C8"])
    _fake_popen(main, mp)
    assert c.post("/api/fuzzing/start", json=_fuzz_body(targetIds=["4C8"])).status_code == 403


def test_generator_blocked_id_403(ctx):
    c, main, mp, _ = ctx
    _set(main, ["4C8"])
    mock = AsyncMock()
    mp.setattr(main, "run_command_async", mock)
    r = c.post("/api/generator/start", json={"interface": "can0", "canId": "4C8"})
    assert r.status_code == 403
    mock.assert_not_called()


def test_generator_random_with_blocklist_403(ctx):
    c, main, mp, _ = ctx
    _set(main, ["4C8"])
    mp.setattr(main, "run_command_async", AsyncMock())
    assert c.post("/api/generator/start", json={"interface": "can0"}).status_code == 403


def test_generator_allowed_when_not_blocked(ctx):
    c, main, mp, _ = ctx
    _set(main, ["4C8"])
    fake = MagicMock()
    fake.returncode = None
    mp.setattr(main, "run_command_async", AsyncMock(return_value=fake))
    assert c.post("/api/generator/start", json={"interface": "can0", "canId": "360"}).status_code == 200


def test_causality_blocked_source_403(ctx):
    c, main, mp, _ = ctx
    _set(main, ["4C8"])
    r = c.post("/api/analysis/validate-causality", json={"source_id": "0x4c8", "target_id": "360"})
    assert r.status_code == 403
