import os, stat, pytest
import hotspot

def test_valid_ssid():
    assert hotspot.valid_ssid("AURIGE")
    assert not hotspot.valid_ssid("")
    assert not hotspot.valid_ssid("-lead")
    assert not hotspot.valid_ssid("x" * 33)

def test_valid_wpa_passphrase():
    assert hotspot.valid_wpa_passphrase("password10")
    assert not hotspot.valid_wpa_passphrase("short")        # <8
    assert not hotspot.valid_wpa_passphrase("x" * 64)        # >63

def test_password_create_and_reuse(tmp_path, monkeypatch):
    monkeypatch.setenv("AURIGE_DATA_DIR", str(tmp_path))
    import importlib; importlib.reload(hotspot)
    p1 = hotspot.get_or_create_hotspot_password()
    assert len(p1) >= 8
    f = tmp_path / "hotspot_password.txt"
    assert f.exists()
    if os.name == "posix":
        assert stat.S_IMODE(f.stat().st_mode) == 0o600
    assert hotspot.get_or_create_hotspot_password() == p1   # reused

def test_set_password_validates(tmp_path, monkeypatch):
    monkeypatch.setenv("AURIGE_DATA_DIR", str(tmp_path))
    import importlib; importlib.reload(hotspot)
    with pytest.raises(ValueError):
        hotspot.set_hotspot_password("short")
    hotspot.set_hotspot_password("goodpassword")
    assert hotspot.get_or_create_hotspot_password() == "goodpassword"

def test_has_working_network(monkeypatch):
    # no IP on eth/usb -> falls through to the ping path
    monkeypatch.setattr(hotspot, "_iface_has_ip", lambda prefixes: False)
    monkeypatch.setattr(hotspot, "_run", lambda cmd, timeout=10: (0, ""))
    assert hotspot.has_working_network() is True   # ping rc 0
    monkeypatch.setattr(hotspot, "_run", lambda cmd, timeout=10: (1, ""))
    assert hotspot.has_working_network() is False

def test_get_ap_capable_interface_fallback(monkeypatch):
    monkeypatch.setattr(hotspot, "_wireless_interfaces", lambda: [])
    assert hotspot.get_ap_capable_interface() == "wlan0"
