"""Generateur cangen : modes donnees/ID, limite -n, garde AUD-06."""
import sys
from unittest.mock import AsyncMock, MagicMock

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
    monkeypatch.setattr(main, "BLOCKLIST_PATH", tmp_path / "aud06_blocklist.json")
    auth._login_attempts.clear()
    try:
        with TestClient(main.app) as c:
            pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].split()[0].strip()
            assert c.post("/api/auth/login", json={"username": "admin", "password": pw}).status_code == 200
            main.state.cangen_process = None
            fake = MagicMock()
            fake.returncode = None
            mock = AsyncMock(return_value=fake)
            monkeypatch.setattr(main, "run_command_async", mock)
            yield c, main, mock
    finally:
        sys.modules.pop("main", None)


def _start(c, **kw):
    sys.modules["main"].state.cangen_process = None  # le faux process reste "running"
    return c.post("/api/generator/start", json={"interface": "can0", **kw})


def test_fixed_data_uppercased_no_L(ctx):
    c, _, mock = ctx
    assert _start(c, dataMode="fixed", dataValue="aabb01").status_code == 200
    cmd = mock.call_args[0][0]
    assert cmd[cmd.index("-D") + 1] == "AABB01"
    assert "-L" not in cmd
    assert cmd[cmd.index("-I") + 1] == "r"


def test_increment_data(ctx):
    c, _, mock = ctx
    assert _start(c, dataMode="increment").status_code == 200
    cmd = mock.call_args[0][0]
    assert cmd[cmd.index("-D") + 1] == "i" and "-L" in cmd


def test_random_data_omits_D(ctx):
    c, _, mock = ctx
    assert _start(c).status_code == 200
    assert "-D" not in mock.call_args[0][0]


def test_bad_fixed_data_400(ctx):
    c, _, _ = ctx
    assert _start(c, dataMode="fixed", dataValue="ZZ").status_code == 400
    assert _start(c, dataMode="fixed").status_code == 400
    assert _start(c, dataMode="fixed", dataValue="001122334455667788").status_code == 400


def test_count(ctx):
    c, _, mock = ctx
    assert _start(c, count=50).status_code == 200
    cmd = mock.call_args[0][0]
    assert cmd[cmd.index("-n") + 1] == "50"
    assert _start(c, count=0).status_code == 400


def test_fixed_id_requires_can_id(ctx):
    c, _, _ = ctx
    assert _start(c, idMode="fixed").status_code == 400


def test_id_modes_cmd(ctx):
    c, _, mock = ctx
    assert _start(c, idMode="increment").status_code == 200
    cmd = mock.call_args[0][0]
    assert cmd[cmd.index("-I") + 1] == "i"


def test_increment_with_blocklist_403(ctx):
    c, main, mock = ctx
    main._save_blocklist(["4C8"])
    assert _start(c, idMode="increment").status_code == 403
    assert _start(c, idMode="random").status_code == 403
    mock.assert_not_called()


def test_fixed_blocked_403_even_with_fixed_data(ctx):
    c, main, mock = ctx
    main._save_blocklist(["4C8"])
    assert _start(c, idMode="fixed", canId="4C8", dataMode="fixed", dataValue="00").status_code == 403
    mock.assert_not_called()
    assert _start(c, idMode="fixed", canId="360", dataMode="fixed", dataValue="00").status_code == 200
