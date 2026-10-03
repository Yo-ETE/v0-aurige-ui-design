"""scan-bitrate : l'interface doit rester UP au meilleur debit (DOWN si aucun trafic)."""
import asyncio
import subprocess
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest
from starlette.testclient import TestClient

BUS_BITRATE = 500000


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


def _install_fakes(main, mp, bus_bitrate):
    """Mocke run_command (enregistre les appels) et candump (trames seulement si debit == bus_bitrate)."""
    calls = []
    current = {"bitrate": None}

    def fake_run(cmd, check=True, **kw):
        calls.append(list(cmd))
        if "bitrate" in cmd:
            current["bitrate"] = int(cmd[cmd.index("bitrate") + 1])
        return subprocess.CompletedProcess(cmd, 0, stdout="[]", stderr="")

    async def fake_exec(*args, **kw):
        proc = MagicMock()
        lines = []
        if bus_bitrate is not None and current["bitrate"] == bus_bitrate:
            lines = [b"(1.0) can0 123#AABB\n", b"(1.1) can0 456#01\n"]

        async def readline():
            return lines.pop(0) if lines else b""

        proc.stdout.readline = readline
        proc.wait = AsyncMock(return_value=0)
        return proc

    mp.setattr(main, "run_command", fake_run)
    mp.setattr(asyncio, "create_subprocess_exec", fake_exec)
    return calls


def _bitrate_sets(calls):
    return [i for i, c in enumerate(calls) if "bitrate" in c]


def test_scan_leaves_interface_up_at_best_bitrate(ctx):
    c, main, mp = ctx
    calls = _install_fakes(main, mp, BUS_BITRATE)
    r = c.post("/api/can/scan-bitrate?interface=can0&timeout=0.1")
    assert r.status_code == 200
    body = r.json()
    assert body["best_bitrate"] == BUS_BITRATE
    # Derniere commande = "up", precedee du reglage du meilleur debit
    assert calls[-1] == ["ip", "link", "set", "can0", "up"]
    last_set = calls[_bitrate_sets(calls)[-1]]
    assert last_set[-1] == str(BUS_BITRATE)
    assert _bitrate_sets(calls)[-1] > 0 and calls[_bitrate_sets(calls)[-1] - 1] == ["ip", "link", "set", "can0", "down"]


def test_scan_leaves_interface_down_without_traffic(ctx):
    c, main, mp = ctx
    calls = _install_fakes(main, mp, None)
    r = c.post("/api/can/scan-bitrate?interface=can0&timeout=0.1")
    assert r.status_code == 200
    assert r.json()["best_bitrate"] is None
    # Pas de remise UP : la derniere commande est "down"
    assert calls[-1] == ["ip", "link", "set", "can0", "down"]
