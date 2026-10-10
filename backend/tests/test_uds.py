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


# ---- scan UDS ----

import asyncio as _asyncio


class _FakeStdout:
    def __init__(self, lines, delay=0.2):
        self._lines = list(lines)
        self._delay = delay
    async def readline(self):
        if self._lines:
            await _asyncio.sleep(self._delay)
            return self._lines.pop(0).encode()
        await _asyncio.sleep(3600)  # bloque jusqu'a annulation
        return b""


class _FakeProc:
    def __init__(self, lines):
        self.stdout = _FakeStdout(lines)
        self.returncode = None
    def terminate(self): pass
    def kill(self): pass
    async def wait(self): return 0


def _patch_candump(monkeypatch, main, lines):
    async def fake_exec(*a, **k):
        return _FakeProc(lines)
    monkeypatch.setattr(main, "can_send_frame", lambda *a, **k: (True, ""))
    monkeypatch.setattr(_asyncio, "create_subprocess_exec", fake_exec)


def test_uds_scan_detects_positive(ctx):
    c, main, monkeypatch = ctx
    _patch_candump(monkeypatch, main, ["(0.0) can0 7E8#027E0000000000"])
    r = c.post("/api/uds/scan", json={"interface": "can0", "start_id": "700", "end_id": "700", "listen_ms": 400, "gap_ms": 10})
    assert r.status_code == 200
    body = r.json()
    assert body["scanned"] == 1
    resp = body["responders"]
    assert len(resp) == 1 and resp[0]["response_id"] == "7E8" and resp[0]["kind"] == "positive"


def test_uds_scan_detects_negative(ctx):
    c, main, monkeypatch = ctx
    _patch_candump(monkeypatch, main, ["(0.0) can0 7E8#037F3E11000000"])
    r = c.post("/api/uds/scan", json={"interface": "can0", "start_id": "700", "end_id": "700", "listen_ms": 400, "gap_ms": 10})
    assert r.json()["responders"][0]["kind"] == "negative"


def test_uds_scan_blocked_id_skipped(ctx):
    c, main, monkeypatch = ctx
    _patch_candump(monkeypatch, main, [])
    monkeypatch.setattr(main, "is_id_blocked", lambda rid: rid == "700")
    r = c.post("/api/uds/scan", json={"interface": "can0", "start_id": "700", "end_id": "700", "listen_ms": 20, "gap_ms": 10})
    body = r.json()
    assert body["scanned"] == 0 and body["blocked_skipped"] == 1 and body["responders"] == []


def test_uds_scan_range_too_large_400(ctx):
    c, main, monkeypatch = ctx
    r = c.post("/api/uds/scan", json={"interface": "can0", "start_id": "0", "end_id": "FFF"})
    assert r.status_code == 400


def test_uds_scan_bad_inputs(ctx):
    c, main, monkeypatch = ctx
    assert c.post("/api/uds/scan", json={"interface": "canX", "start_id": "700", "end_id": "7FF"}).status_code == 400
    assert c.post("/api/uds/scan", json={"interface": "can0", "start_id": "7FF", "end_id": "700"}).status_code == 400


# ---- scan DID (0x22) ----

def test_scan_dids_positive(ctx):
    c, main, monkeypatch = ctx
    _patch_candump(monkeypatch, main, ["(0.0) can0 7E8#0762F19012345678"])
    r = c.post("/api/uds/scan-dids", json={"interface": "can0", "request_id": "7E0", "response_id": "7E8", "start_did": "F190", "end_did": "F190", "listen_ms": 400, "gap_ms": 10})
    assert r.status_code == 200
    body = r.json()
    assert body["scanned"] == 1
    sup = body["supported"]
    assert len(sup) == 1 and sup[0]["did"] == "F190" and sup[0]["kind"] == "positive"


def test_scan_dids_unsupported(ctx):
    c, main, monkeypatch = ctx
    _patch_candump(monkeypatch, main, ["(0.0) can0 7E8#037F223100000000"])
    r = c.post("/api/uds/scan-dids", json={"interface": "can0", "request_id": "7E0", "response_id": "7E8", "start_did": "0101", "end_did": "0101", "listen_ms": 400, "gap_ms": 10})
    body = r.json()
    assert body["unsupported"] == 1 and body["supported"] == []


def test_scan_dids_locked(ctx):
    c, main, monkeypatch = ctx
    _patch_candump(monkeypatch, main, ["(0.0) can0 7E8#037F223300000000"])
    r = c.post("/api/uds/scan-dids", json={"interface": "can0", "request_id": "7E0", "response_id": "7E8", "start_did": "0200", "end_did": "0200", "listen_ms": 400, "gap_ms": 10})
    sup = r.json()["supported"]
    assert len(sup) == 1 and sup[0]["kind"] == "locked" and sup[0]["nrc"] == "33"


def test_scan_dids_blocked_id_403(ctx):
    c, main, monkeypatch = ctx
    _patch_candump(monkeypatch, main, [])
    monkeypatch.setattr(main, "is_id_blocked", lambda cid: cid.upper() == "7E0")
    r = c.post("/api/uds/scan-dids", json={"interface": "can0", "request_id": "7E0", "response_id": "7E8", "start_did": "F100", "end_did": "F1FF"})
    assert r.status_code == 403


def test_scan_dids_range_too_large_400(ctx):
    c, main, monkeypatch = ctx
    r = c.post("/api/uds/scan-dids", json={"interface": "can0", "request_id": "7E0", "response_id": "7E8", "start_did": "0", "end_did": "FFFF"})
    assert r.status_code == 400
