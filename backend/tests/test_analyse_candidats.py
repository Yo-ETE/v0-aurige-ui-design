"""Classification cardinalite des octets (analyse candidats) : helper + byte-heatmap."""
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
            yield c, main, monkeypatch, tmp_path
    finally:
        sys.modules.pop("main", None)


def test_constant(ctx):
    _, main, *_ = ctx
    assert main._classify_action_byte([0x55] * 20, 20) == ("constant", ["55"], 0.0)


def test_etat_sorted(ctx):
    _, main, *_ = ctx
    k, dv, sc = main._classify_action_byte([0x55, 0x95, 0x56] * 7, 21)
    assert k == "etat"
    assert dv == ["55", "56", "95"]
    assert sc == round(14 / 16, 4)


def test_aleatoire(ctx):
    _, main, *_ = ctx
    vals = list(range(18)) + [0, 1]
    assert main._classify_action_byte(vals, 20) == ("aleatoire", [f"{v:02X}" for v in range(16)], 0.0)


def test_distinct_cap(ctx):
    _, main, *_ = ctx
    _, dv, _ = main._classify_action_byte(list(range(20)), 20)
    assert len(dv) == 16


def test_compteur_checksum(ctx):
    _, main, *_ = ctx
    assert main._classify_action_byte([1, 2, 3, 4] * 5, 20, is_counter=True)[0] == "compteur"
    assert main._classify_action_byte([1, 2, 3, 4] * 5, 20, is_checksum=True)[0] == "checksum"


def test_heatmap_endpoint_fields(ctx):
    c, main, mp, tmp = ctx
    lines = []
    for i in range(30):
        # b0 constant, b1 etat (3 valeurs), b2 compteur
        lines.append(f"({1000 + i * 0.01:.6f}) can0 123#AA{[0x55, 0x95, 0x56][i % 3]:02X}{i % 256:02X}")
    log = tmp / "t.log"
    log.write_text("\n".join(lines) + "\n")
    mp.setattr(main, "_resolve_log_path", lambda *a, **k: log)
    r = c.post("/api/analysis/byte-heatmap", json={"log_path": str(log)})
    assert r.status_code == 200, r.text
    ids = r.json()["ids"] if "ids" in r.json() else None
    assert ids, r.json()
    by = {b["index"]: b for b in ids[0]["bytes"]}
    for b in by.values():
        assert {"klass", "distinct_values", "score", "change_rate", "entropy"} <= set(b)
    assert by[0]["klass"] == "constant"
    assert by[1]["klass"] == "etat"
    assert by[2]["klass"] == "compteur"
