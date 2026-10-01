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
