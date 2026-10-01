"""Integration : le vrai main.py demarre, la DB est initialisee, l'auth est appliquee."""
import sys

import pytest
from starlette.testclient import TestClient


@pytest.mark.asyncio
async def test_boot_seeds_admin_and_enforces_auth(tmp_path, monkeypatch):
    monkeypatch.setenv("AURIGE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AURIGE_DB_PATH", str(tmp_path / "aurige.db"))
    sys.modules.pop("main", None)
    import main

    try:
        # main.app est enveloppe par SessionAuthMiddleware ; main.lifespan est celui de FastAPI
        async with main.lifespan(None):
            c = TestClient(main.app)
            assert c.get("/api/missions").status_code == 401
            assert c.get("/api/can/status").status_code in (401,)
            txt = (tmp_path / "initial_admin_password.txt").read_text()
            pw = txt.split("password: ")[1].split()[0].strip()
            r = c.post("/api/auth/login", json={"username": "admin", "password": pw})
            assert r.status_code == 200
            assert c.get("/api/missions").status_code == 200
    finally:
        sys.modules.pop("main", None)


def test_lifespan_runs_through_wrapper(tmp_path, monkeypatch):
    """TestClient en context manager : le scope lifespan traverse le wrapper ASGI."""
    monkeypatch.setenv("AURIGE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AURIGE_DB_PATH", str(tmp_path / "aurige.db"))
    sys.modules.pop("main", None)
    import main

    try:
        with TestClient(main.app) as c:
            assert (tmp_path / "aurige.db").exists()
            assert c.get("/api/missions").status_code == 401
    finally:
        sys.modules.pop("main", None)
