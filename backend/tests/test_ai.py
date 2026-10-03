"""Analyse IA : config (cle jamais renvoyee) + analyze (fournisseur mocke)."""
import json
import os
import sys

import pytest
from starlette.testclient import TestClient

KEY = "sk-secret-VALUE-12345"


@pytest.fixture
def ctx(tmp_path, monkeypatch):
    monkeypatch.setenv("AURIGE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AURIGE_DB_PATH", str(tmp_path / "aurige.db"))
    monkeypatch.setenv("AURIGE_AUTO_HOTSPOT", "0")
    sys.modules.pop("main", None)
    import hotspot
    import auth
    import main
    import ai_client

    async def _noop():
        return None

    monkeypatch.setattr(hotspot, "auto_hotspot_once", _noop)
    cfg_path = tmp_path / "ai_config.json"
    monkeypatch.setattr(ai_client, "AI_CONFIG_PATH", cfg_path)
    auth._login_attempts.clear()
    try:
        with TestClient(main.app) as c:
            pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].split()[0].strip()
            assert c.post("/api/auth/login", json={"username": "admin", "password": pw}).status_code == 200
            yield c, ai_client, cfg_path, monkeypatch
    finally:
        sys.modules.pop("main", None)


class _Resp:
    def __init__(self, status, payload):
        self.status_code = status
        self._p = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._p

    def raise_for_status(self):
        if self.status_code >= 400:
            import httpx
            req = httpx.Request("POST", "http://x")
            raise httpx.HTTPStatusError("boom", request=req, response=httpx.Response(self.status_code, text=self.text, request=req))


def _mock(ai_client, monkeypatch, status, payload, calls):
    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, json=None):
            calls.append((url, headers, json))
            return _Resp(status, payload)

    monkeypatch.setattr(ai_client.httpx, "AsyncClient", FakeClient)


def _put(c, **kw):
    body = {"provider": "anthropic", "model": "m1"}
    body.update(kw)
    return c.put("/api/ai/config", json=body)


def test_get_no_key(ctx):
    c, *_ = ctx
    r = c.get("/api/ai/config")
    assert r.status_code == 200 and r.json()["has_key"] is False


def test_put_key_file_and_not_leaked(ctx):
    c, ai_client, path, _ = ctx
    r = _put(c, api_key=KEY)
    assert r.status_code == 200 and KEY not in r.text
    assert json.loads(path.read_text())["api_key"] == KEY
    if os.name != "nt":
        assert (path.stat().st_mode & 0o777) == 0o600
    g = c.get("/api/ai/config")
    assert g.json()["has_key"] is True and KEY not in g.text


def test_put_keeps_and_clears_key(ctx):
    c, _, path, _ = ctx
    _put(c, api_key=KEY)
    _put(c, model="m2")
    assert json.loads(path.read_text())["api_key"] == KEY
    r = _put(c, clear_key=True)
    assert r.json()["has_key"] is False
    assert json.loads(path.read_text())["api_key"] == ""


def test_put_validation(ctx):
    c, *_ = ctx
    assert _put(c, base_url="ftp://x").status_code == 400
    assert _put(c, provider="x").status_code == 400


def test_analyze_no_key(ctx):
    c, *_ = ctx
    r = c.post("/api/ai/analyze", json={"context": "c", "question": "q"})
    assert r.status_code == 400


def test_analyze_anthropic(ctx):
    c, ai_client, _, mp = ctx
    _put(c, api_key=KEY)
    calls = []
    _mock(ai_client, mp, 200, {"content": [{"text": "reponse"}]}, calls)
    r = c.post("/api/ai/analyze", json={"context": "ctx", "question": "q"})
    assert r.status_code == 200 and r.json() == {"answer": "reponse"}
    url, headers, body = calls[0]
    assert url == "https://api.anthropic.com/v1/messages"
    assert headers["x-api-key"] == KEY and body["messages"][0]["content"] == "q\n\nctx"


def test_analyze_openai(ctx):
    c, ai_client, _, mp = ctx
    _put(c, provider="openai", base_url="https://api.openai.com/", api_key=KEY)
    calls = []
    _mock(ai_client, mp, 200, {"choices": [{"message": {"content": "ok-openai"}}]}, calls)
    r = c.post("/api/ai/analyze", json={"context": "ctx", "question": "q"})
    assert r.json() == {"answer": "ok-openai"}
    assert calls[0][0] == "https://api.openai.com/v1/chat/completions"
    assert calls[0][1]["Authorization"] == f"Bearer {KEY}"


def test_analyze_provider_401_hides_key(ctx):
    c, ai_client, _, mp = ctx
    _put(c, api_key=KEY)
    _mock(ai_client, mp, 401, {"error": "bad key"}, [])
    r = c.post("/api/ai/analyze", json={"context": "ctx", "question": "q"})
    assert r.status_code == 502 and "401" in r.text and KEY not in r.text


def test_analyze_too_long(ctx):
    c, *_ = ctx
    assert c.post("/api/ai/analyze", json={"context": "x" * 100001, "question": "q"}).status_code == 400
    assert c.post("/api/ai/analyze", json={"context": "c", "question": "q" * 4001}).status_code == 400
