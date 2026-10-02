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
            assert c.get("/api/can/status").status_code == 401
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


# ---------------------------------------------------------------------------
# Fix round 1 : garde OBD, CORS outermost, audit fail-closed
# ---------------------------------------------------------------------------
import re

from permissions import required_permissions


@pytest.fixture
def booted(tmp_path, monkeypatch):
    monkeypatch.setenv("AURIGE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AURIGE_DB_PATH", str(tmp_path / "aurige.db"))
    sys.modules.pop("main", None)
    import main

    sent = []
    monkeypatch.setattr(main, "can_send_frame", lambda i, c, d: (sent.append((c, d)) or (True, "")))

    async def fake_flow(*a, **k):
        sent.append(a)
        return {"success": False, "error": "no hw", "responses": []}

    monkeypatch.setattr(main, "obd_send_with_flow_control", fake_flow)
    with TestClient(main.app) as admin:
        pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].split()[0]
        assert admin.post("/api/auth/login", json={"username": "admin", "password": pw}).status_code == 200
        r = admin.post("/api/auth/users", json={"username": "viewer1", "password": "password-10x", "role": "viewer"})
        assert r.status_code == 200, r.text
        viewer = TestClient(main.app)
        assert viewer.post("/api/auth/login", json={"username": "viewer1", "password": "password-10x"}).status_code == 200
        yield main, admin, viewer, sent
    sys.modules.pop("main", None)


@pytest.mark.parametrize("url", ["/api/obd/pid", "/api/signal-finder/read-pid"])
def test_obd_non_read_service_requires_obd_write(booted, url):
    main, admin, viewer, sent = booted
    assert viewer.post(f"{url}?service=04&pid=00").status_code == 403
    assert viewer.post(f"{url}?service=11&pid=01").status_code == 403
    assert sent == []  # rien n'a atteint le bus
    assert viewer.post(f"{url}?service=01&pid=0C").status_code not in (400, 403)
    assert viewer.post(f"{url}?service=09&pid=02").status_code not in (400, 403)
    assert admin.post(f"{url}?service=04&pid=00").status_code not in (400, 403)


@pytest.mark.parametrize("url", ["/api/obd/pid", "/api/signal-finder/read-pid"])
@pytest.mark.parametrize("qs", ["service=1&pid=0C", "service=011&pid=0C", "service=ZZ&pid=0C",
                                "service=01&pid=C", "service=01&pid=0CC", "service=01&pid=GG"])
def test_obd_malformed_params_400(booted, url, qs):
    main, admin, viewer, sent = booted
    assert viewer.post(f"{url}?{qs}").status_code == 400
    assert admin.post(f"{url}?{qs}").status_code == 400
    assert sent == []


def test_ws_signal_finder_blocks_write_service(booted):
    main, admin, viewer, sent = booted
    with viewer.websocket_connect("/ws/signal-finder") as ws:
        ws.send_text('{"action":"start","service":"04","pid":"00"}')
        assert ws.receive_json()["type"] == "error"
        ws.send_text('{"action":"start","service":"1","pid":"0C"}')
        assert ws.receive_json()["type"] == "error"
        ws.send_text('{"action":"start","service":"01","pid":"ZZ"}')
        assert ws.receive_json()["type"] == "error"
    assert sent == []


def test_cors_headers_on_401(booted):
    main, admin, viewer, sent = booted
    r = TestClient(main.app).get("/api/missions", headers={"Origin": "http://localhost:3000"})
    assert r.status_code == 401
    assert r.headers.get("access-control-allow-origin") == "http://localhost:3000"


READ_ONLY_ALLOWLIST = [
    r"/compare-logs$", r"/co-occurrence$", r"^/api/analysis/family-diff$",
    r"^/api/analysis/byte-heatmap$", r"^/api/analysis/auto-detect-signals$",
    r"^/api/analysis/inter-id-dependencies$", r"^/api/analysis/correlate-obd$",
    r"^/api/fuzzing/analyze-crash$", r"^/api/fuzzing/compare-logs$",
    r"^/api/sniffer/(start|stop)$",
    # OBD : payloads fixes en lecture seule
    r"^/api/obd/(vin|dtc/(read|pending|permanent)|scan-pids|full-scan|pid-read|status|freeze-frame)$",
    # OBD : service valide dans le handler (04/11... => obd_write)
    r"^/api/obd/pid$", r"^/api/signal-finder/(read-pid|extract-obd-from-log)$",
]


def test_every_mutating_route_is_guarded_or_allowlisted(booted):
    main = booted[0]
    allow = [re.compile(p) for p in READ_ONLY_ALLOWLIST]
    unguarded = []
    for route in main.fastapi_app.routes:
        methods = getattr(route, "methods", None) or set()
        path = getattr(route, "path", "")
        if not path.startswith("/api/"):
            continue
        for m in methods & {"POST", "PUT", "PATCH", "DELETE"}:
            if path.startswith("/api/auth/"):
                continue  # login/logout/users : is_admin_route / publics
            concrete = re.sub(r"\{[^}]+\}", "x", path)
            if required_permissions(m, concrete) or any(a.search(concrete) for a in allow):
                continue
            unguarded.append((m, path))
    assert unguarded == []
