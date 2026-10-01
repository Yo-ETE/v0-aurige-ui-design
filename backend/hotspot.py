"""AURIGE - Point d'accès WiFi de secours (SSID local). Mirroir de Theia.

Toutes les commandes passent par _run (liste, jamais shell=True) : pas
d'injection, et les tests peuvent le monkeypatcher.
"""
import asyncio
import os
import re
import secrets
import subprocess
import time
from pathlib import Path

from error_logger import log_info

DATA_DIR = Path(os.getenv("AURIGE_DATA_DIR", "/opt/aurige/data"))
PASSWORD_FILE = DATA_DIR / "hotspot_password.txt"

AP_BAND = "bg"
AP_CHANNEL = "6"
AP_IP = "192.168.4.1"

SSID_DEFAULT = os.getenv("AURIGE_AUTO_HOTSPOT_SSID", "AURIGE")
AUTO = os.getenv("AURIGE_AUTO_HOTSPOT", "1").strip().lower() not in ("0", "false", "no")
AUTO_DELAY_S = float(os.getenv("AURIGE_AUTO_HOTSPOT_DELAY_S", "45"))
AUTO_BOOT_WINDOW_S = float(os.getenv("AURIGE_AUTO_HOTSPOT_BOOT_WINDOW_S", "300"))

HOSTAPD_DRIVERS = ("nl80211", "rtl871xdrv", "wext")


def _run(cmd, timeout=10):
    """Exécute cmd (liste) ; retourne (returncode, stdout+stderr)."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                           errors="replace")
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError, ValueError) as e:
        return 1, str(e)


def valid_ssid(s):
    if not isinstance(s, str):
        return False
    if not all(32 <= ord(c) <= 126 for c in s):
        return False
    # ASCII imprimable : longueur en octets == longueur en caractères
    if not (1 <= len(s) <= 32):
        return False
    return not s.startswith("-")


def valid_wpa_passphrase(p):
    if not isinstance(p, str):
        return False
    if p != p.strip():
        return False  # la lecture du fichier fait strip() : pas d'aller-retour sûr
    if not (8 <= len(p) <= 63):
        return False
    return all(32 <= ord(c) <= 126 for c in p)


def get_or_create_hotspot_password():
    if PASSWORD_FILE.exists():
        existing = PASSWORD_FILE.read_text(encoding="utf-8").strip()
        if valid_wpa_passphrase(existing):
            return existing
    pw = secrets.token_urlsafe(9)
    while pw.startswith("-"):  # évite qu'un nmcli/hostapd le lise comme une option
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
    """True si une interface dont le nom commence par un des prefixes a une IPv4
    routable (les adresses link-local 169.254.0.0/16 sont ignorées)."""
    rc, out = _run(["ip", "-o", "-4", "addr", "show"], timeout=5)
    if rc != 0:
        return False
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 4 or not any(parts[1].startswith(p) for p in prefixes):
            continue
        if parts[3].startswith("169.254."):
            continue
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


def start_hotspot_blocking(ssid, password):
    if not valid_ssid(ssid):
        return {"status": "error", "detail": "SSID invalide", "interface": ""}
    if not valid_wpa_passphrase(password):
        return {"status": "error", "detail": "Mot de passe invalide", "interface": ""}
    iface = get_ap_capable_interface()
    rc, _ = _run(["which", "hostapd"], timeout=5)
    if rc != 0:
        return {"status": "error", "detail": "hostapd absent (apt install hostapd)", "interface": iface}

    _run(["sudo", "iw", "reg", "set", "FR"], timeout=5)
    _run(["sudo", "nmcli", "device", "disconnect", iface], timeout=10)
    _run(["sudo", "pkill", "hostapd"], timeout=5)
    _run(["sudo", "pkill", "dnsmasq"], timeout=5)

    # Primaire : NetworkManager
    rc, out = _run(["sudo", "nmcli", "device", "wifi", "hotspot", "ifname", iface,
                    "ssid", ssid, "password", password, "band", AP_BAND,
                    "channel", AP_CHANNEL], timeout=30)
    time.sleep(3)
    _, active = _run(["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show", "--active"], timeout=10)
    _, info = _run(["iw", "dev", iface, "info"], timeout=5)
    if rc == 0 and "802-11-wireless" in active:
        if "type AP" in info:
            return {"status": "success", "detail": "Hotspot actif (NetworkManager)", "interface": iface}
        return {"status": "warning", "detail": "Connexion active mais mode AP non confirmé", "interface": iface}

    # Fallback : hostapd + dnsmasq bruts
    return _start_hotspot_raw(iface, ssid, password)


def _start_hotspot_raw(iface, ssid, password):
    _run(["sudo", "ip", "link", "set", iface, "down"], timeout=5)
    _run(["sudo", "ip", "addr", "flush", "dev", iface], timeout=5)
    _run(["sudo", "ip", "addr", "add", f"{AP_IP}/24", "dev", iface], timeout=5)
    _run(["sudo", "ip", "link", "set", iface, "up"], timeout=5)

    dnsmasq_conf = Path("/tmp/aurige_dnsmasq.conf")
    dnsmasq_conf.write_text(
        f"interface={iface}\n"
        f"dhcp-range=192.168.4.2,192.168.4.254,255.255.255.0,24h\n"
        "no-resolv\nbind-interfaces\n", encoding="utf-8")
    _run(["sudo", "dnsmasq", "-C", str(dnsmasq_conf)], timeout=10)

    for driver in HOSTAPD_DRIVERS:
        conf = Path(f"/tmp/aurige_hostapd_{driver}.conf")
        fd = os.open(conf, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(
                f"interface={iface}\ndriver={driver}\nssid={ssid}\n"
                f"hw_mode=g\nchannel={AP_CHANNEL}\nwmm_enabled=0\nmacaddr_acl=0\n"
                f"auth_algs=1\nignore_broadcast_ssid=0\nwpa=2\n"
                f"wpa_passphrase={password}\nwpa_key_mgmt=WPA-PSK\nrsn_pairwise=CCMP\n")
        _run(["sudo", "hostapd", "-B", str(conf)], timeout=10)
        rc, _ = _run(["pgrep", "-a", "hostapd"], timeout=5)
        if rc == 0:
            return {"status": "success", "detail": f"Hotspot actif (hostapd/{driver})", "interface": iface}
    rc, _ = _run(["pgrep", "dnsmasq"], timeout=5)
    if rc == 0:
        return {"status": "warning", "detail": "DHCP démarré mais hostapd échoue", "interface": iface}
    return {"status": "error", "detail": "Échec hostapd et dnsmasq", "interface": iface}


def stop_hotspot():
    iface = get_ap_capable_interface()
    _, active = _run(["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show", "--active"], timeout=10)
    for line in active.splitlines():
        name = line.split(":")[0]
        if "hotspot" in name.lower() or "aurige" in name.lower():
            _run(["sudo", "nmcli", "connection", "down", name], timeout=10)
    _run(["sudo", "pkill", "hostapd"], timeout=5)
    _run(["sudo", "pkill", "dnsmasq"], timeout=5)
    _run(["sudo", "ip", "addr", "flush", "dev", iface], timeout=5)
    _run(["sudo", "ip", "link", "set", iface, "up"], timeout=5)
    _run(["sudo", "wpa_cli", "-i", iface, "reconnect"], timeout=5)
    return {"status": "success", "detail": "Hotspot arrêté", "interface": iface}


def hotspot_status():
    iface = get_ap_capable_interface()
    _, active = _run(["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show", "--active"], timeout=10)
    _, info = _run(["iw", "dev", iface, "info"], timeout=5)
    is_ap = "802-11-wireless" in active and "type AP" in info
    if not is_ap:
        rc, _ = _run(["systemctl", "is-active", "hostapd"], timeout=5)
        is_ap = rc == 0
    ssid = ""
    m = re.search(r"ssid (.+)", info)
    if m:
        ssid = m.group(1).strip()
    clients = 0
    rc, dump = _run(["iw", "dev", iface, "station", "dump"], timeout=5)
    if rc == 0:
        clients = dump.count("Station ")
    return {"active": is_ap, "ssid": ssid, "interface": iface, "clients": clients}


def _uptime_seconds():
    try:
        return float(Path("/proc/uptime").read_text().split()[0])
    except (OSError, ValueError, IndexError):
        return 0.0


async def auto_hotspot_once():
    if not AUTO:
        return
    await asyncio.sleep(AUTO_DELAY_S)
    if _uptime_seconds() > AUTO_BOOT_WINDOW_S:
        return
    loop = asyncio.get_event_loop()
    if await loop.run_in_executor(None, has_working_network):
        return
    password = get_or_create_hotspot_password()
    await loop.run_in_executor(None, start_hotspot_blocking, SSID_DEFAULT, password)
    log_info("Hotspot de secours démarré automatiquement (aucun réseau au boot)")
