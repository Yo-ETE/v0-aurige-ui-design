"""AURIGE - Point d'accès WiFi de secours (SSID local). Mirroir de Theia.

Toutes les commandes passent par _run (liste, jamais shell=True) : pas
d'injection, et les tests peuvent le monkeypatcher.
"""
import os
import re
import secrets
import subprocess
from pathlib import Path

DATA_DIR = Path(os.getenv("AURIGE_DATA_DIR", "/opt/aurige/data"))
PASSWORD_FILE = DATA_DIR / "hotspot_password.txt"

AP_BAND = "bg"
AP_CHANNEL = "6"
AP_IP = "192.168.4.1"


def _run(cmd, timeout=10):
    """Exécute cmd (liste) ; retourne (returncode, stdout+stderr)."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
        return 1, str(e)


def valid_ssid(s):
    if not isinstance(s, str):
        return False
    b = s.encode("utf-8")
    if not (1 <= len(b) <= 32):
        return False
    if s.startswith("-"):
        return False
    return all(32 <= ord(c) <= 126 for c in s)


def valid_wpa_passphrase(p):
    if not isinstance(p, str):
        return False
    if not (8 <= len(p) <= 63):
        return False
    return all(32 <= ord(c) <= 126 for c in p)


def get_or_create_hotspot_password():
    if PASSWORD_FILE.exists():
        existing = PASSWORD_FILE.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    pw = secrets.token_urlsafe(9)
    _write_password(pw)
    return pw


def _write_password(pw):
    PASSWORD_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(PASSWORD_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(pw + "\n")


def set_hotspot_password(pw):
    if not valid_wpa_passphrase(pw):
        raise ValueError("Mot de passe invalide (8 à 63 caractères ASCII imprimables)")
    _write_password(pw)


def _iface_has_ip(prefixes):
    """True si une interface dont le nom commence par un des prefixes a une IPv4."""
    rc, out = _run(["ip", "-o", "-4", "addr", "show"], timeout=5)
    if rc != 0:
        return False
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and any(parts[1].startswith(p) for p in prefixes):
            return True
    return False


def has_working_network():
    if _iface_has_ip(("eth", "enp", "eno")):
        return True
    if _iface_has_ip(("usb", "wwan", "ppp", "enx")):
        return True
    rc, _ = _run(["ping", "-c", "1", "-W", "2", "8.8.8.8"], timeout=5)
    return rc == 0


def _wireless_interfaces():
    base = Path("/sys/class/net")
    if not base.exists():
        return []
    return [p.name for p in base.iterdir() if (p / "wireless").exists()]


def get_ap_capable_interface():
    for iface in _wireless_interfaces():
        rc, out = _run(["iw", "dev", iface, "info"], timeout=5)
        phy = None
        for line in out.splitlines():
            m = re.search(r"wiphy (\d+)", line)
            if m:
                phy = m.group(1)
        if phy is not None:
            rc2, out2 = _run(["iw", f"phy{phy}", "info"], timeout=5)
            if rc2 == 0 and re.search(r"\*\s*AP", out2):
                return iface
    ifaces = _wireless_interfaces()
    return ifaces[0] if ifaces else "wlan0"
