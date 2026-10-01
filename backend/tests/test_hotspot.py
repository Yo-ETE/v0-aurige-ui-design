import os, stat, pytest
import hotspot


def test_valid_ssid():
    assert hotspot.valid_ssid("AURIGE")
    assert hotspot.valid_ssid("x")
    assert hotspot.valid_ssid("x" * 32)
    assert not hotspot.valid_ssid("")
    assert not hotspot.valid_ssid("-lead")
    assert not hotspot.valid_ssid("x" * 33)
    assert not hotspot.valid_ssid(123)
    assert not hotspot.valid_ssid(None)
    assert hotspot.valid_ssid("\ud800") is False  # surrogate isolé : pas d'exception


def test_valid_wpa_passphrase():
    assert hotspot.valid_wpa_passphrase("password10")
    assert hotspot.valid_wpa_passphrase("x" * 8)
    assert hotspot.valid_wpa_passphrase("x" * 63)
    assert not hotspot.valid_wpa_passphrase("x" * 7)
    assert not hotspot.valid_wpa_passphrase("x" * 64)
    assert not hotspot.valid_wpa_passphrase(123)
    assert not hotspot.valid_wpa_passphrase(None)
    assert not hotspot.valid_wpa_passphrase("  pw with pad  ")
    assert hotspot.valid_wpa_passphrase("pw interior space")


@pytest.fixture
def pwfile(tmp_path, monkeypatch):
    f = tmp_path / "hotspot_password.txt"
    monkeypatch.setattr(hotspot, "PASSWORD_FILE", f)
    return f


def test_password_create_and_reuse(pwfile):
    p1 = hotspot.get_or_create_hotspot_password()
    assert len(p1) >= 8 and not p1.startswith("-")
    assert pwfile.exists()
    if os.name == "posix":
        assert stat.S_IMODE(pwfile.stat().st_mode) == 0o600
    assert hotspot.get_or_create_hotspot_password() == p1


def test_invalid_stored_password_regenerated(pwfile):
    pwfile.write_text("weak\n", encoding="utf-8")
    p = hotspot.get_or_create_hotspot_password()
    assert p != "weak" and hotspot.valid_wpa_passphrase(p)


def test_set_password_validates(pwfile):
    with pytest.raises(ValueError):
        hotspot.set_hotspot_password("short")
    assert not pwfile.exists()
    hotspot.set_hotspot_password("goodpassword")
    assert hotspot.get_or_create_hotspot_password() == "goodpassword"


@pytest.mark.skipif(os.name != "posix", reason="modes POSIX")
def test_write_password_forces_0600(pwfile):
    pwfile.write_text("old\n")
    os.chmod(pwfile, 0o644)
    hotspot._write_password("goodpassword")
    assert stat.S_IMODE(pwfile.stat().st_mode) == 0o600


def _fake_run(ip_out, ping_rc):
    def run(cmd, timeout=10):
        if cmd[0] == "ip":
            return 0, ip_out
        return ping_rc, ""
    return run


WLAN = "3: wlan0    inet 192.168.1.5/24 brd 192.168.1.255 scope global wlan0\n"
ETH = "2: eth0    inet 192.168.1.9/24 brd 192.168.1.255 scope global eth0\n"
ETH_LL = "2: eth0    inet 169.254.3.4/16 brd 169.254.255.255 scope link eth0\n"


def test_has_working_network(monkeypatch):
    monkeypatch.setattr(hotspot, "_run", _fake_run(WLAN, 1))
    assert hotspot.has_working_network() is False   # wlan0 seul, ping KO
    monkeypatch.setattr(hotspot, "_run", _fake_run(WLAN + ETH, 1))
    assert hotspot.has_working_network() is True    # eth0 IPv4 globale
    monkeypatch.setattr(hotspot, "_run", _fake_run(ETH_LL, 1))
    assert hotspot.has_working_network() is False   # link-local ignorée
    monkeypatch.setattr(hotspot, "_run", _fake_run(WLAN, 0))
    assert hotspot.has_working_network() is True    # ping OK


def test_get_ap_capable_interface_fallback(monkeypatch):
    monkeypatch.setattr(hotspot, "_wireless_interfaces", lambda: [])
    assert hotspot.get_ap_capable_interface() == "wlan0"


import asyncio

_REAL_SLEEP = asyncio.sleep  # capturé avant monkeypatch (évite la récursion)


class FakeRun:
    """Scripted _run: maps a command-prefix substring to (rc, out)."""
    def __init__(self, rules, record):
        self.rules, self.record = rules, record

    def __call__(self, cmd, timeout=10):
        self.record.append(cmd)
        joined = " ".join(cmd)
        for needle, resp in self.rules:
            if needle in joined:
                return resp
        return (0, "")


def test_start_hotspot_nmcli_primary(monkeypatch):
    rec = []
    monkeypatch.setattr(hotspot, "get_ap_capable_interface", lambda: "wlan0")
    rules = [
        ("which hostapd", (0, "/usr/sbin/hostapd")),
        ("nmcli device wifi hotspot", (0, "")),
        ("connection show --active", (0, "Hotspot:802-11-wireless")),
        ("iw dev wlan0 info", (0, "type AP")),
    ]
    monkeypatch.setattr(hotspot, "_run", FakeRun(rules, rec))
    monkeypatch.setattr(hotspot.time, "sleep", lambda s: None)
    res = hotspot.start_hotspot_blocking("AURIGE", "password10")
    assert res["status"] == "success"
    assert any("nmcli device wifi hotspot" in " ".join(c) for c in rec)


def test_start_hotspot_rejects_bad_ssid(monkeypatch):
    res = hotspot.start_hotspot_blocking("-bad", "password10")
    assert res["status"] == "error"


def test_start_hotspot_missing_hostapd(monkeypatch):
    monkeypatch.setattr(hotspot, "get_ap_capable_interface", lambda: "wlan0")
    monkeypatch.setattr(hotspot, "_run", FakeRun([("which hostapd", (1, ""))], []))
    res = hotspot.start_hotspot_blocking("AURIGE", "password10")
    assert res["status"] == "error" and "hostapd" in res["detail"].lower()


def test_hotspot_status_inactive(monkeypatch):
    monkeypatch.setattr(hotspot, "get_ap_capable_interface", lambda: "wlan0")
    monkeypatch.setattr(hotspot, "_run", FakeRun([
        ("connection show --active", (0, "wifi-client:802-11-wireless")),
        ("iw dev wlan0 info", (0, "type managed")),
        ("is-active hostapd", (3, "inactive")),
    ], []))
    assert hotspot.hotspot_status()["active"] is False


@pytest.mark.asyncio
async def test_auto_hotspot_skips_when_network_ok(monkeypatch):
    monkeypatch.setenv("AURIGE_AUTO_HOTSPOT", "1")
    import importlib; importlib.reload(hotspot)
    monkeypatch.setattr(hotspot.asyncio, "sleep", lambda s: _REAL_SLEEP(0))
    monkeypatch.setattr(hotspot, "_uptime_seconds", lambda: 10.0)
    monkeypatch.setattr(hotspot, "has_working_network", lambda: True)
    started = []
    monkeypatch.setattr(hotspot, "start_hotspot_blocking", lambda s, p: started.append((s, p)) or {"status": "success"})
    await hotspot.auto_hotspot_once()
    assert started == []           # network OK -> no AP


@pytest.mark.asyncio
async def test_auto_hotspot_starts_when_no_network(monkeypatch):
    monkeypatch.setenv("AURIGE_AUTO_HOTSPOT", "1")
    import importlib; importlib.reload(hotspot)
    monkeypatch.setattr(hotspot.asyncio, "sleep", lambda s: _REAL_SLEEP(0))
    monkeypatch.setattr(hotspot, "_uptime_seconds", lambda: 10.0)
    monkeypatch.setattr(hotspot, "has_working_network", lambda: False)
    monkeypatch.setattr(hotspot, "get_or_create_hotspot_password", lambda: "password10")
    started = []
    monkeypatch.setattr(hotspot, "start_hotspot_blocking", lambda s, p: started.append((s, p)) or {"status": "success"})
    await hotspot.auto_hotspot_once()
    assert len(started) == 1 and started[0][0] == "AURIGE"


@pytest.mark.asyncio
async def test_auto_hotspot_skips_after_boot_window(monkeypatch):
    monkeypatch.setenv("AURIGE_AUTO_HOTSPOT", "1")
    import importlib; importlib.reload(hotspot)
    monkeypatch.setattr(hotspot.asyncio, "sleep", lambda s: _REAL_SLEEP(0))
    monkeypatch.setattr(hotspot, "_uptime_seconds", lambda: 9999.0)
    monkeypatch.setattr(hotspot, "has_working_network", lambda: False)
    started = []
    monkeypatch.setattr(hotspot, "start_hotspot_blocking", lambda s, p: started.append(1) or {"status": "success"})
    await hotspot.auto_hotspot_once()
    assert started == []           # uptime > window -> no AP
