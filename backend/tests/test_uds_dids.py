"""Bibliotheque de DID UDS : seed ISO F1xx + CRUD (metadonnees, aucune injection)."""
import sys

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
    auth._login_attempts.clear()
    try:
        with TestClient(main.app) as c:
            pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].split()[0].strip()
            assert c.post("/api/auth/login", json={"username": "admin", "password": pw}).status_code == 200
            yield c
    finally:
        sys.modules.pop("main", None)


def test_seed_and_crud(ctx):
    c = ctx
    dids = c.get("/api/uds/dids").json()["dids"]
    assert any(d["did"] == "F190" for d in dids)
    assert len(dids) == 8

    r = c.post("/api/uds/dids", json={"did": "2201", "name": "Test"})
    assert r.status_code == 200
    created = r.json()["did"]
    assert created["did"] == "2201"
    assert any(d["id"] == created["id"] for d in c.get("/api/uds/dids").json()["dids"])

    assert c.post("/api/uds/dids", json={"did": "ZZ", "name": "x"}).status_code == 400
    assert c.post("/api/uds/dids", json={"did": "F1", "name": "x"}).status_code == 200
    assert c.post("/api/uds/dids", json={"did": "F190A", "name": "x"}).status_code == 400
    assert c.post("/api/uds/dids", json={"did": "F190", "name": "x", "ecu_request_id": "XYZ"}).status_code == 400

    r = c.patch(f"/api/uds/dids/{created['id']}", json={"name": "Renomme", "did": "f1a0"})
    assert r.status_code == 200
    assert r.json()["did"]["name"] == "Renomme"
    assert r.json()["did"]["did"] == "F1A0"
    assert c.patch(f"/api/uds/dids/{created['id']}", json={"did": "ZZ"}).status_code == 400
    assert c.patch("/api/uds/dids/nope", json={"name": "x"}).status_code == 404
    got = [d for d in c.get("/api/uds/dids").json()["dids"] if d["id"] == created["id"]][0]
    assert got["name"] == "Renomme"

    assert c.delete(f"/api/uds/dids/{created['id']}").status_code == 200
    assert c.delete(f"/api/uds/dids/{created['id']}").status_code == 404
