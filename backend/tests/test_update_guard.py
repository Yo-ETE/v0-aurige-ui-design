"""Garde de la branche sur POST /api/system/update + route restart-services unique."""
import pathlib
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
    auth._login_attempts.clear()
    try:
        with TestClient(auth.SessionAuthMiddleware(main.fastapi_app)) as c:
            pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].split()[0].strip()
            r = c.post("/api/auth/login", json={"username": "admin", "password": pw})
            assert r.status_code == 200
            main.update_output_store = {"lines": [], "running": False, "command": None}
            yield c, main
    finally:
        sys.modules.pop("main", None)


@pytest.fixture
def no_side_effects(monkeypatch):
    """Neutralise le clone/install (run_update est local au handler) et l'ecriture de branch.txt."""
    import asyncio

    spawned = []
    writes = []

    async def _fake_exec(*a, **k):
        spawned.append(a)
        raise RuntimeError("subprocess neutralise (test)")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_exec)
    monkeypatch.setattr(pathlib.Path, "write_text", lambda self, *a, **k: writes.append(str(self)))
    monkeypatch.setattr(pathlib.Path, "mkdir", lambda self, *a, **k: None)
    return spawned, writes


def test_update_rejects_bad_branch(client, no_side_effects):
    c, main = client
    spawned, writes = no_side_effects
    for bad in ["-rm", "a;b", "a b", "x" * 201, "a..b"]:
        r = c.post("/api/system/update", json={"branch": bad})
        assert r.status_code == 400, bad
    # rien n'a ete planifie ni ecrit
    assert main.update_output_store["running"] is False
    assert main.update_output_store["lines"] == []
    assert writes == []
    assert spawned == []


def test_update_accepts_good_branch(client, no_side_effects):
    c, main = client
    r = c.post("/api/system/update", json={"branch": "main"})
    assert r.status_code != 400
    assert r.status_code == 200


def test_single_restart_services_route():
    import main

    paths = [r.path for r in main.fastapi_app.routes if getattr(r, "path", "") == "/api/system/restart-services"]
    assert len(paths) == 1
