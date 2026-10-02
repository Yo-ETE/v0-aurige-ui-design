"""Bibliotheque DBC autonome (/api/dbc/*) + ponts mission <-> bibliotheque."""
import json as _j
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
            assert c.post("/api/auth/login", json={"username": "admin", "password": pw}).status_code == 200
            yield c, tmp_path
    finally:
        sys.modules.pop("main", None)


def test_library_crud(client):
    c, _ = client
    r = c.post("/api/dbc", json={"name": "Clio RE"})
    assert r.status_code == 200, r.text
    did = r.json()["id"]
    assert r.json()["name"] == "Clio RE"
    assert c.get("/api/dbc").json()["libraries"][0]["id"] == did
    c.patch(f"/api/dbc/{did}", json={"name": "Clio v2"})
    assert c.get(f"/api/dbc/{did}").json()["name"] == "Clio v2"
    assert c.delete(f"/api/dbc/{did}").status_code == 200
    assert c.get("/api/dbc").json()["libraries"] == []


def test_library_rejects_bad_id(client):
    c, _ = client
    assert c.get("/api/dbc/../etc").status_code in (400, 404)
    assert c.get("/api/dbc/NOThex..").status_code in (400, 404)
    assert c.get("/api/dbc/..%2Fx").status_code in (400, 404)


def test_library_signal_and_export_roundtrip(client):
    c, _ = client
    did = c.post("/api/dbc", json={"name": "lib"}).json()["id"]
    c.post(f"/api/dbc/{did}/message", json={"can_id": "0C6", "name": "Brake", "dlc": 8})
    r = c.post(f"/api/dbc/{did}/signal", json={"can_id": "0C6", "name": "Pressure", "start_bit": 0, "length": 8,
              "byte_order": "little_endian", "is_signed": False, "scale": 1, "offset": 0,
              "min_val": 0, "max_val": 255, "unit": "", "comment": ""})
    assert r.status_code == 200, r.text
    exp = c.get(f"/api/dbc/{did}/export")
    assert exp.status_code == 200 and "BO_ 198 Brake: 8 Vector__XXX" in exp.text
    did2 = c.post("/api/dbc", json={"name": "lib2"}).json()["id"]
    r = c.post(f"/api/dbc/{did2}/import", files={"file": ("x.dbc", exp.text, "application/octet-stream")})
    assert r.status_code == 200, r.text
    assert r.json()["imported_signals"] == 1
    got = c.get(f"/api/dbc/{did2}")
    assert any(m["can_id"].upper() == "0C6" for m in got.json()["messages"])


def test_mission_import_unchanged(client):
    c, tmp = client
    mid = "m2"
    (tmp / "missions" / mid).mkdir(parents=True)
    did = c.post("/api/dbc", json={"name": "src"}).json()["id"]
    c.post(f"/api/dbc/{did}/signal", json={"can_id": "0C6", "name": "P", "start_bit": 0, "length": 8,
           "byte_order": "little_endian", "is_signed": False, "scale": 1, "offset": 0,
           "min_val": 0, "max_val": 255, "unit": "", "comment": ""})
    txt = c.get(f"/api/dbc/{did}/export").text
    r = c.post(f"/api/missions/{mid}/dbc/import", files={"file": ("a.dbc", txt, "application/octet-stream")})
    assert r.status_code == 200, r.text
    assert r.json()["imported_signals"] == 1 and r.json()["total_messages"] == 1 and r.json()["filename"] == "a.dbc"


def test_bridges_mission_library(client):
    c, tmp = client
    mid = "m1"
    (tmp / "missions" / mid / "logs").mkdir(parents=True)
    (tmp / "missions" / mid / "mission.json").write_text(_j.dumps({"id": mid, "name": "Clio"}))
    c.post(f"/api/missions/{mid}/dbc/message", json={"can_id": "090", "name": "WheelSpeed"})
    did = c.post("/api/dbc", json={"name": "lib"}).json()["id"]
    assert c.post(f"/api/dbc/{did}/from-mission/{mid}").status_code == 200
    assert any(m["can_id"] == "090" for m in c.get(f"/api/dbc/{did}").json()["messages"])
    c.post(f"/api/dbc/{did}/message", json={"can_id": "1B0", "name": "Rpm"})
    assert c.post(f"/api/missions/{mid}/dbc/from-library/{did}").status_code == 200
    ids = {m["can_id"] for m in c.get(f"/api/missions/{mid}/dbc").json()["messages"]}
    assert "1B0" in ids
    assert c.post(f"/api/dbc/{did}/from-mission/nope").status_code == 404
    assert c.post(f"/api/missions/{mid}/dbc/from-library/zzz").status_code == 404


def test_dbc_lib_path_rejects_bad_ids(client):
    from fastapi import HTTPException
    import main
    for bad in ["../x", "a..b", "UPPER", "a/b", "a\b", ""]:
        with pytest.raises(HTTPException) as e:
            main._dbc_lib_path(bad)
        assert e.value.status_code == 400


def test_mission_dbc_path_rejects_bad_ids(client):
    from fastapi import HTTPException
    import main
    for bad in ["..", ".", "a/b", "a\b", ""]:
        with pytest.raises(HTTPException) as e:
            main._mission_dbc_path(bad)
        assert e.value.status_code == 400
