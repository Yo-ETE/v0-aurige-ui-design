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
    """Scripted _run: première règle dont l'aiguille est dans la commande."""
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
    nm = [c for c in rec if c[:5] == ["sudo", "nmcli", "device", "wifi", "hotspot"]]
    assert len(nm) == 1
    cmd = nm[0]
    assert cmd[cmd.index("ssid") + 1] == "AURIGE"
    assert cmd[cmd.index("password") + 1] == "password10"
    assert cmd[cmd.index("band") + 1] == "bg"
    assert cmd[cmd.index("channel") + 1] == "6"
    assert cmd.index("ssid") < cmd.index("password") < cmd.index("band") < cmd.index("channel")
    assert not any("hostapd" in c and "-B" in c for c in rec)  # pas de fallback brut


def test_start_hotspot_rejects_bad_input_without_shell(monkeypatch):
    rec = []
    monkeypatch.setattr(hotspot, "_run", FakeRun([], rec))
    assert hotspot.start_hotspot_blocking("-bad", "password10")["status"] == "error"
    assert hotspot.start_hotspot_blocking("AURIGE", "short")["status"] == "error"
    assert rec == []  # aucune commande lancée avant validation


def test_start_hotspot_missing_hostapd(monkeypatch):
    monkeypatch.setattr(hotspot, "get_ap_capable_interface", lambda: "wlan0")
    monkeypatch.setattr(hotspot, "_run", FakeRun([("which hostapd", (1, ""))], []))
    res = hotspot.start_hotspot_blocking("AURIGE", "password10")
    assert res["status"] == "error" and "hostapd" in res["detail"].lower()


def _status_run(info, hostapd_rc=3):
    return FakeRun([
        ("iw dev wlan0 info", (0, info)),
        ("is-active hostapd", (hostapd_rc, "inactive")),
        ("station dump", (0, "Station aa:bb\nStation cc:dd\n")),
    ], [])


def test_hotspot_status_inactive_client_mode(monkeypatch):
    monkeypatch.setattr(hotspot, "get_ap_capable_interface", lambda: "wlan0")
    monkeypatch.setattr(hotspot, "_run", _status_run("type managed\n\tssid HomeWifi"))
    st = hotspot.hotspot_status()
    assert st["active"] is False and st["ssid"] == ""  # pas de fuite du SSID client


def test_hotspot_status_active_raw_fallback(monkeypatch):
    # hostapd brut : aucune connexion NM, aucune unité systemd, mais iw dit AP
    monkeypatch.setattr(hotspot, "get_ap_capable_interface", lambda: "wlan0")
    monkeypatch.setattr(hotspot, "_run", _status_run("type AP\n\tssid AURIGE"))
    st = hotspot.hotspot_status()
    assert st["active"] is True and st["ssid"] == "AURIGE" and st["clients"] == 2


def test_stop_hotspot_targets_only_ap_and_our_dnsmasq(monkeypatch, tmp_path):
    rec = []
    monkeypatch.setattr(hotspot, "RUN_DIR", tmp_path / "hotspot")
    hotspot._ensure_run_dir()
    leftover = hotspot.RUN_DIR / "aurige_hostapd_nl80211.conf"
    leftover.write_text("wpa_passphrase=x")
    monkeypatch.setattr(hotspot, "get_ap_capable_interface", lambda: "wlan0")
    monkeypatch.setattr(hotspot, "_run", FakeRun([
        ("connection show --active", (0, "Hotspot:802-11-wireless\naurige-wifi:802-11-wireless\nWired:802-3-ethernet")),
        ("802-11-wireless.mode connection show Hotspot", (0, "ap\n")),
        ("802-11-wireless.mode connection show aurige-wifi", (0, "infrastructure\n")),
    ], rec))
    assert hotspot.stop_hotspot()["status"] == "success"
    downs = [c for c in rec if c[:4] == ["sudo", "nmcli", "connection", "down"]]
    assert downs == [["sudo", "nmcli", "connection", "down", "Hotspot"]]
    assert ["sudo", "pkill", "-f", "aurige_dnsmasq.conf"] in rec
    assert ["sudo", "pkill", "dnsmasq"] not in rec
    assert not leftover.exists()


def test_raw_confs_private_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(hotspot, "RUN_DIR", tmp_path / "hotspot")
    monkeypatch.setattr(hotspot, "_run", FakeRun([("pgrep -a hostapd", (0, "1 hostapd"))], []))
    res = hotspot._start_hotspot_raw("wlan0", "AURIGE", "password10")
    assert res["status"] == "success"
    conf = hotspot.RUN_DIR / "aurige_hostapd_nl80211.conf"
    assert "wpa_passphrase=password10" in conf.read_text()
    if os.name == "posix":
        assert stat.S_IMODE(hotspot.RUN_DIR.stat().st_mode) == 0o700
        assert stat.S_IMODE(conf.stat().st_mode) == 0o600


def test_uptime_unknown_is_infinite(monkeypatch):
    def boom(*a, **k):
        raise OSError("no /proc")
    monkeypatch.setattr(hotspot.Path, "read_text", boom)
    assert hotspot._uptime_seconds() == float("inf")


def _auto_env(monkeypatch, uptime=10.0, network=False, auto=True):
    sleeps = []

    async def fake_sleep(s):
        sleeps.append(s)
        await _REAL_SLEEP(0)

    monkeypatch.setattr(hotspot, "AUTO", auto)
    monkeypatch.setattr(hotspot.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(hotspot, "_uptime_seconds", lambda: uptime)
    monkeypatch.setattr(hotspot, "has_working_network", lambda: network)
    monkeypatch.setattr(hotspot, "get_or_create_hotspot_password", lambda: "password10")
    started = []
    monkeypatch.setattr(hotspot, "start_hotspot_blocking",
                        lambda s, p: started.append((s, p)) or {"status": "success", "detail": "ok"})
    return sleeps, started


@pytest.mark.asyncio
async def test_auto_hotspot_disabled(monkeypatch):
    sleeps, started = _auto_env(monkeypatch, auto=False)
    await hotspot.auto_hotspot_once()
    assert sleeps == [] and started == []


@pytest.mark.asyncio
async def test_auto_hotspot_skips_when_network_ok(monkeypatch):
    _, started = _auto_env(monkeypatch, network=True)
    await hotspot.auto_hotspot_once()
    assert started == []


@pytest.mark.asyncio
async def test_auto_hotspot_starts_when_no_network(monkeypatch):
    _, started = _auto_env(monkeypatch)
    await hotspot.auto_hotspot_once()
    assert started == [("AURIGE", "password10")]


@pytest.mark.asyncio
async def test_auto_hotspot_skips_after_boot_window(monkeypatch):
    _, started = _auto_env(monkeypatch, uptime=9999.0)
    await hotspot.auto_hotspot_once()
    assert started == []


@pytest.mark.asyncio
async def test_auto_hotspot_swallows_errors_and_logs_status(monkeypatch):
    _auto_env(monkeypatch)
    logs = []
    monkeypatch.setattr(hotspot, "log_info", logs.append)

    def boom(s, p):
        raise OSError("disk")
    monkeypatch.setattr(hotspot, "start_hotspot_blocking", boom)
    await hotspot.auto_hotspot_once()  # ne lève pas
    assert any("échec" in m for m in logs)
    logs.clear()
    monkeypatch.setattr(hotspot, "start_hotspot_blocking",
                        lambda s, p: {"status": "error", "detail": "hostapd absent"})
    await hotspot.auto_hotspot_once()
    assert any("error" in m and "hostapd absent" in m for m in logs)
