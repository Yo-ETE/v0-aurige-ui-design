"""Tests de l'authentification par token (AUD-01)."""

import stat
import sys

import pytest
from starlette.websockets import WebSocketDisconnect

from auth import TOKEN_COOKIE, load_or_create_token
from conftest import TEST_TOKEN

AUTH = {"Authorization": f"Bearer {TEST_TOKEN}"}


def test_health_is_public(client):
    assert client.get("/api/health").status_code == 200


@pytest.mark.parametrize("path", ["/api/status", "/status", "/api/missions", "/docs", "/openapi.json"])
def test_protected_routes_require_token(client, path):
    response = client.get(path)
    assert response.status_code == 401
    assert response.json() == {"detail": "Authentification requise"}


def test_system_action_rejected_without_token(client):
    # Route dangereuse : ne doit jamais atteindre le handler sans token
    assert client.post("/api/system/reboot").status_code == 401


def test_bearer_header_grants_access(client):
    assert client.get("/api/missions", headers=AUTH).status_code == 200


def test_custom_header_grants_access(client):
    assert client.get("/api/missions", headers={"X-Aurige-Token": TEST_TOKEN}).status_code == 200


def test_wrong_token_rejected(client):
    response = client.get("/api/missions", headers={"Authorization": "Bearer nope"})
    assert response.status_code == 401


def test_login_sets_httponly_strict_cookie(client):
    response = client.post("/api/auth/login", json={"token": TEST_TOKEN})
    assert response.status_code == 200
    set_cookie = response.headers["set-cookie"]
    assert f"{TOKEN_COOKIE}=" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "SameSite=strict" in set_cookie
    # Le client garde le cookie : les requêtes suivantes passent
    assert client.get("/api/missions").status_code == 200
    assert client.get("/api/auth/status").json() == {"authenticated": True}


def test_login_with_wrong_token_fails(client):
    response = client.post("/api/auth/login", json={"token": "nope"})
    assert response.status_code == 401
    assert "set-cookie" not in response.headers


def test_logout_clears_cookie(client):
    client.post("/api/auth/login", json={"token": TEST_TOKEN})
    client.post("/api/auth/logout")
    assert client.get("/api/auth/status").json() == {"authenticated": False}
    assert client.get("/api/missions").status_code == 401


def test_status_reports_anonymous(client):
    assert client.get("/api/auth/status").json() == {"authenticated": False}


def test_websocket_rejected_without_token(client):
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws/cansniffer?interface=vcan0"):
            pass
    assert exc.value.code == 1008


def test_cors_rejects_unknown_origin(client):
    response = client.get("/api/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in response.headers


def test_cors_allows_local_dev_origin(client):
    response = client.get("/api/health", headers={"Origin": "http://localhost:3000"})
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"


def test_401_carries_cors_headers_for_allowed_origin(client):
    response = client.get("/api/missions", headers={"Origin": "http://localhost:3000"})
    assert response.status_code == 401
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"


def test_token_file_created_once_with_private_permissions(tmp_path, monkeypatch):
    monkeypatch.delenv("AURIGE_API_TOKEN", raising=False)
    token_file = tmp_path / "sub" / "api_token"
    first = load_or_create_token(token_file)
    assert len(first) >= 40
    assert load_or_create_token(token_file) == first
    if sys.platform != "win32":
        assert stat.S_IMODE(token_file.stat().st_mode) == 0o600


def test_env_token_overrides_file(tmp_path, monkeypatch):
    token_file = tmp_path / "api_token"
    token_file.write_text("from-file\n")
    monkeypatch.setenv("AURIGE_API_TOKEN", "from-env")
    assert load_or_create_token(token_file) == "from-env"
