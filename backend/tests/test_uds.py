"""Panneau UDS : framing single-frame, décodage NRC, endpoint /api/uds/request."""
import sys
from unittest.mock import AsyncMock

import pytest
from starlette.testclient import TestClient

import uds_client


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
            yield c, main, monkeypatch
    finally:
        sys.modules.pop("main", None)


# ---- uds_client (helpers purs) ----

def test_build_single_frame():
    # service 2F + data 0203FF = 4 octets → PCI 04, padé à 8 octets (16 hex)
    assert uds_client.build_single_frame("2F", "0203FF") == "042F0203FF000000"


def test_build_single_frame_too_long():
    with pytest.raises(ValueError):
        uds_client.build_single_frame("2F", "01020304050607")  # 1+7 = 8 octets > 7


def test_decode_positive():
    # single frame : 04 6F 02 03 FF .. → positive, service_echo 0x6F
    r = uds_client.decode_response(["046F0203FF0000"])
    assert r["positive"] is True and r["service_echo"] == 0x6F and r["data_hex"] == "0203FF"


def test_decode_negative_nrc():
    # 03 7F 2F 33 → négative, NRC 0x33 (acces securite refuse)
    r = uds_client.decode_response(["037F2F330000"])
    assert r["positive"] is False and r["nrc"]["code"] == 0x33
    assert "securite" in r["nrc"]["label"]


def test_decode_empty():
    r = uds_client.decode_response([])
    assert r["positive"] is False and r.get("error")


# ---- endpoint ----

def test_uds_request_positive(ctx):
    c, main, monkeypatch = ctx
    # Mock le transport ISO-TP : renvoie une ligne candump de réponse positive sur 7E8.
    async def fake_send(interface, request_id, request_data, response_id="7E8"):
        return {"success": True, "responses": ["(0.0) can0 7E8#046F0203FF0000"], "error": None}
    monkeypatch.setattr(main, "obd_send_with_flow_control", fake_send)
    r = c.post("/api/uds/request", json={"interface": "can0", "request_id": "7E0", "response_id": "7E8", "service": "2F", "data": "0203FF"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok" and body["response"]["positive"] is True and body["response"]["service_echo"] == 0x6F


def test_uds_request_negative(ctx):
    c, main, monkeypatch = ctx
    async def fake_send(interface, request_id, request_data, response_id="7E8"):
        return {"success": True, "responses": ["(0.0) can0 7E8#037F2F330000"], "error": None}
    monkeypatch.setattr(main, "obd_send_with_flow_control", fake_send)
    r = c.post("/api/uds/request", json={"interface": "can0", "request_id": "7E0", "service": "2F", "data": "0203FF"})
    assert r.json()["response"]["nrc"]["code"] == 0x33


def test_uds_request_transport_error(ctx):
    c, main, monkeypatch = ctx
    async def fake_send(interface, request_id, request_data, response_id="7E8"):
        return {"success": False, "responses": [], "error": "candump KO"}
    monkeypatch.setattr(main, "obd_send_with_flow_control", fake_send)
    r = c.post("/api/uds/request", json={"interface": "can0", "request_id": "7E0", "service": "22", "data": "F190"})
    assert r.status_code == 200 and r.json()["status"] == "error"


def test_uds_request_too_long_400(ctx):
    c, main, monkeypatch = ctx
    r = c.post("/api/uds/request", json={"interface": "can0", "request_id": "7E0", "service": "2E", "data": "01020304050607"})
    assert r.status_code == 400


def test_uds_request_bad_inputs(ctx):
    c, main, monkeypatch = ctx
    assert c.post("/api/uds/request", json={"interface": "canX", "request_id": "7E0", "service": "2F"}).status_code == 400
    assert c.post("/api/uds/request", json={"interface": "can0", "request_id": "ZZ", "service": "2F"}).status_code == 400
    assert c.post("/api/uds/request", json={"interface": "can0", "request_id": "7E0", "service": "2FF"}).status_code == 400
