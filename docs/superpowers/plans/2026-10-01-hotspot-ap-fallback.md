# Hotspot / Local-SSID Fallback Implementation Plan (Admin Lot 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The AURIGE Pi raises its own WiFi SSID (AP mode) so an operator can reach it locally — automatically at boot when there is no usable network, and manually from the UI.

**Architecture:** A new `backend/hotspot.py` module provides pure validators/credential helpers plus subprocess orchestration (nmcli AP primary, hostapd+dnsmasq raw fallback) behind a single `_run()` shim so it is unit-testable. A boot-only one-shot async task in `main.py`'s lifespan raises the AP when the Pi has no network. Five `/api/network/hotspot/*` endpoints expose status/credentials/start/stop. install_pi.sh installs hostapd+dnsmasq. The frontend gets a Hotspot card on the existing `/configuration` page (Lot 2 later moves it into a tabbed console).

**Tech Stack:** Python 3.11, FastAPI/Starlette, stdlib subprocess/asyncio/secrets; pytest + pytest-asyncio + Starlette TestClient. Next.js 16 / React 19 / shadcn-ui.

**Spec:** `docs/superpowers/specs/2026-10-01-hotspot-ap-fallback-design.md`

## Global Constraints

- FLAT imports (`import hotspot`, `from auth import ...`, `import db`) — matches existing backend. No `backend.` prefix.
- Backend runs as root (`deploy/aurige-api.service` User=root); `sudo` prefix on commands is harmless and kept for consistency.
- All shell commands go through `hotspot._run(cmd: list[str], timeout: float)` (list form, never `shell=True`) so there is no shell injection and tests can monkeypatch it.
- SSID validated by `valid_ssid` (1–32 bytes, printable, no leading `-`); passphrase by `valid_wpa_passphrase` (8–63 printable ASCII) BEFORE any command uses them.
- Password file: `${AURIGE_DATA_DIR}/hotspot_password.txt` (default AURIGE_DATA_DIR=/opt/aurige/data), mode 0600.
- Env: `AURIGE_AUTO_HOTSPOT` (default "1"), `AURIGE_AUTO_HOTSPOT_DELAY_S` ("45"), `AURIGE_AUTO_HOTSPOT_BOOT_WINDOW_S` ("300"), `AURIGE_AUTO_HOTSPOT_SSID` ("AURIGE").
- AP: band bg, channel 6, WPA2 (wpa_key_mgmt WPA-PSK, rsn_pairwise CCMP); raw fallback 192.168.4.1/24, dhcp-range 192.168.4.2–254.
- Permission: POST `/api/network/*` already needs `system_network` (existing `_ROUTE_RULES`); only add GET `/api/network/hotspot/credentials` → `system_network`. `GET status` stays auth-only.
- Comments/UI French, code English.

## File Structure

- Create: `backend/hotspot.py`, `backend/tests/test_hotspot.py`.
- Modify: `backend/main.py` (5 endpoints + lifespan task), `backend/permissions.py` (one rule + test), `scripts/install_pi.sh` (apt hostapd/dnsmasq + env docs), `lib/api.ts` (5 client fns), `app/configuration/page.tsx` (Hotspot card + fix guide text).

---

### Task 1: hotspot.py pure helpers — validators, password, connectivity

**Files:**
- Create: `backend/hotspot.py` (first half)
- Test: `backend/tests/test_hotspot.py`

**Interfaces:**
- Consumes: nothing of ours (stdlib + `from error_logger import log_info` deferred to Task 2).
- Produces: `def _run(cmd, timeout=10) -> tuple[int,str]`; `def valid_ssid(s)->bool`; `def valid_wpa_passphrase(p)->bool`; `PASSWORD_FILE` resolution; `def get_or_create_hotspot_password()->str`; `def set_hotspot_password(p)->None` (raises ValueError if invalid); `def has_working_network()->bool`; `def get_ap_capable_interface()->str`.

- [ ] **Step 1: Write failing tests**

```python
# backend/tests/test_hotspot.py
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
    # eth with IP -> True
    monkeypatch.setattr(hotspot, "_run", lambda cmd, timeout=10: (0, "ok") if cmd[0] == "ping" else (0, ""))
    # force ping path: make ip checks return no IP, ping returns 0
    calls = {"ip": (0, "[]"), "ping": (0, "")}
    monkeypatch.setattr(hotspot, "_iface_has_ip", lambda prefixes: False)
    monkeypatch.setattr(hotspot, "_run", lambda cmd, timeout=10: (0, "") )
    assert hotspot.has_working_network() is True   # ping rc 0
    monkeypatch.setattr(hotspot, "_run", lambda cmd, timeout=10: (1, ""))
    assert hotspot.has_working_network() is False

def test_get_ap_capable_interface_fallback(monkeypatch):
    monkeypatch.setattr(hotspot, "_wireless_interfaces", lambda: [])
    assert hotspot.get_ap_capable_interface() == "wlan0"
```

- [ ] **Step 2: Run, verify fail**

Run: `cd backend && python -m pytest tests/test_hotspot.py -v`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the first half of `backend/hotspot.py`**

```python
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
```

- [ ] **Step 4: Run, verify pass**

Run: `cd backend && python -m pytest tests/test_hotspot.py -v`
Expected: PASS. (Adjust the two monkeypatch-heavy tests if the helper names differ; the decisive assertions are the validators, password 0600 create/reuse, set-password validation, and the AP-iface fallback.)

- [ ] **Step 5: Commit**

```bash
git add backend/hotspot.py backend/tests/test_hotspot.py
git commit -m "feat(hotspot): validators, persisted password, connectivity + AP-iface helpers"
```

---

### Task 2: hotspot.py orchestration — start/stop/status + boot watchdog

**Files:**
- Modify: `backend/hotspot.py` (second half)
- Modify: `backend/tests/test_hotspot.py` (add orchestration tests)

**Interfaces:**
- Consumes: Task 1 helpers; `from error_logger import log_info`.
- Produces: `def start_hotspot_blocking(ssid, password) -> dict`; `def stop_hotspot() -> dict`; `def hotspot_status() -> dict`; `async def auto_hotspot_once() -> None`. Each dict: `{"status": "success"|"warning"|"error", "detail": str, "interface": str, ...}`.

- [ ] **Step 1: Write failing tests** (scripted `_run` fake)

```python
# append to backend/tests/test_hotspot.py
import asyncio
import hotspot

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
    monkeypatch.setattr(hotspot.asyncio, "sleep", lambda s: asyncio.sleep(0))
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
    monkeypatch.setattr(hotspot.asyncio, "sleep", lambda s: asyncio.sleep(0))
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
    monkeypatch.setattr(hotspot.asyncio, "sleep", lambda s: asyncio.sleep(0))
    monkeypatch.setattr(hotspot, "_uptime_seconds", lambda: 9999.0)
    monkeypatch.setattr(hotspot, "has_working_network", lambda: False)
    started = []
    monkeypatch.setattr(hotspot, "start_hotspot_blocking", lambda s, p: started.append(1) or {"status": "success"})
    await hotspot.auto_hotspot_once()
    assert started == []           # uptime > window -> no AP
```

- [ ] **Step 2: Run, verify fail.** Run: `cd backend && python -m pytest tests/test_hotspot.py -v` → FAIL on the new tests.

- [ ] **Step 3: Implement the second half of `backend/hotspot.py`**

```python
import asyncio
import time

from error_logger import log_info

SSID_DEFAULT = os.getenv("AURIGE_AUTO_HOTSPOT_SSID", "AURIGE")
AUTO = os.getenv("AURIGE_AUTO_HOTSPOT", "1").strip().lower() not in ("0", "false", "no")
AUTO_DELAY_S = float(os.getenv("AURIGE_AUTO_HOTSPOT_DELAY_S", "45"))
AUTO_BOOT_WINDOW_S = float(os.getenv("AURIGE_AUTO_HOTSPOT_BOOT_WINDOW_S", "300"))

HOSTAPD_DRIVERS = ("nl80211", "rtl871xdrv", "wext")


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
```

- [ ] **Step 4: Run, verify pass.** `cd backend && python -m pytest tests/test_hotspot.py -v` → all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/hotspot.py backend/tests/test_hotspot.py
git commit -m "feat(hotspot): nmcli AP + hostapd/dnsmasq fallback, status, boot watchdog"
```

---

### Task 3: Wire endpoints + lifespan task + permission rule

**Files:**
- Modify: `backend/main.py`, `backend/permissions.py`
- Test: `backend/tests/test_hotspot_api.py` (new), extend `backend/tests/test_permissions.py`

**Interfaces:**
- Consumes: `hotspot.*`, existing `SessionAuthMiddleware`.
- Produces: 5 routes under `/api/network/hotspot/`; lifespan schedules `auto_hotspot_once`.

- [ ] **Step 1: Write failing tests**

```python
# backend/tests/test_hotspot_api.py
import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient
import db, auth, hotspot
from permissions import OPERATOR_DEFAULT

@pytest.fixture
async def client(tmp_path, monkeypatch):
    await db.init_db(tmp_path / "t.db")
    pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].strip()
    await db.create_user("vw", "password-10x", role="viewer", permissions=None)
    # stub the blocking hotspot calls
    monkeypatch.setattr(hotspot, "hotspot_status", lambda: {"active": False, "ssid": "", "interface": "wlan0", "clients": 0})
    monkeypatch.setattr(hotspot, "get_or_create_hotspot_password", lambda: "password10")
    monkeypatch.setattr(hotspot, "start_hotspot_blocking", lambda s, p: {"status": "success", "detail": "ok", "interface": "wlan0"})
    monkeypatch.setattr(hotspot, "stop_hotspot", lambda: {"status": "success", "detail": "ok", "interface": "wlan0"})
    import main
    app = main.build_app() if hasattr(main, "build_app") else main.fastapi_app
    c = TestClient(auth.SessionAuthMiddleware(app))
    auth._login_attempts.clear()
    yield c, pw
    await db.close_db()

def test_status_requires_auth(client):
    c, _ = client
    assert c.get("/api/network/hotspot/status").status_code == 401

def test_viewer_forbidden_on_start_and_credentials(client):
    c, _ = client
    c.post("/api/auth/login", json={"username": "vw", "password": "password-10x"})
    assert c.post("/api/network/hotspot/start").status_code == 403
    assert c.get("/api/network/hotspot/credentials").status_code == 403

def test_admin_start_and_credentials(client):
    c, pw = client
    c.post("/api/auth/login", json={"username": "admin", "password": pw})
    assert c.get("/api/network/hotspot/status").status_code == 200
    assert c.post("/api/network/hotspot/start").json()["status"] == "success"
    assert "password" in c.get("/api/network/hotspot/credentials").json()
    assert c.post("/api/network/hotspot/credentials", json={"password": "short"}).status_code == 400
```

And in `backend/tests/test_permissions.py` add:
```python
def test_hotspot_credentials_gated():
    import permissions as perms
    assert perms.required_permissions("GET", "/api/network/hotspot/credentials") == ["system_network"]
    assert perms.required_permissions("POST", "/api/network/hotspot/start") == ["system_network"]
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement.**

In `backend/permissions.py` `_ROUTE_RULES`, add BEFORE the generic `("POST", r"^/api/network/", ["system_network"])` line (so both match, order is fine since same flag) the credentials GET rule:
```python
("GET", r"^/api/network/hotspot/credentials", ["system_network"]),
```
(The existing `("POST", r"^/api/network/", ["system_network"])` already covers the POST hotspot routes.)

In `backend/main.py`:
- `import hotspot` near the other flat imports.
- Add the 5 endpoints in the network group (async, executor for blocking calls):
```python
from pydantic import BaseModel

class HotspotPassword(BaseModel):
    password: str

@app.get("/api/network/hotspot/status")
async def hotspot_status_ep():
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, hotspot.hotspot_status)

@app.get("/api/network/hotspot/credentials")
async def hotspot_credentials_ep():
    loop = asyncio.get_event_loop()
    pw = await loop.run_in_executor(None, hotspot.get_or_create_hotspot_password)
    return {"ssid": hotspot.SSID_DEFAULT, "password": pw}

@app.post("/api/network/hotspot/credentials")
async def hotspot_set_credentials_ep(body: HotspotPassword):
    try:
        hotspot.set_hotspot_password(body.password)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}

@app.post("/api/network/hotspot/start")
async def hotspot_start_ep():
    loop = asyncio.get_event_loop()
    pw = await loop.run_in_executor(None, hotspot.get_or_create_hotspot_password)
    res = await loop.run_in_executor(None, hotspot.start_hotspot_blocking, hotspot.SSID_DEFAULT, pw)
    return res

@app.post("/api/network/hotspot/stop")
async def hotspot_stop_ep():
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, hotspot.stop_hotspot)
```
- In the `lifespan`, after `await db.init_db(DB_PATH)`, schedule the watchdog and cancel it on shutdown:
```python
    hotspot_task = asyncio.create_task(hotspot.auto_hotspot_once())
    try:
        yield
    finally:
        hotspot_task.cancel()
        await db.close_db()
```
(Keep the existing `db.close_db()` call exactly once — fold it into this finally.)
- If the fixture needs a handle to the pre-wrap FastAPI app, ensure `fastapi_app` (the module var introduced in the auth work) still references the app before `app = CORSMiddleware(SessionAuthMiddleware(fastapi_app), ...)`. The hotspot routes must be registered on `fastapi_app` BEFORE the wrap. Add them next to the other network routes.

- [ ] **Step 4: Run.** `cd backend && python -m pytest tests/ -v` — whole suite green (hotspot + api + permissions + all prior). Then smoke: boot uvicorn with `AURIGE_AUTO_HOTSPOT=0` (so no AP attempt locally) and curl `/api/network/hotspot/status` after an admin login → 200.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/permissions.py backend/tests/test_hotspot_api.py backend/tests/test_permissions.py
git commit -m "feat(hotspot): /api/network/hotspot endpoints + boot watchdog wiring + perm rule"
```

---

### Task 4: install_pi.sh deps + guide text

**Files:**
- Modify: `scripts/install_pi.sh`, `app/configuration/page.tsx` (guide text only), `CLAUDE.md` (one line)

- [ ] **Step 1: install_pi.sh** — in the apt install section, add `hostapd dnsmasq` to the package list. After install, add:
```bash
systemctl stop hostapd 2>/dev/null || true
systemctl disable hostapd 2>/dev/null || true
systemctl unmask hostapd 2>/dev/null || true
systemctl stop dnsmasq 2>/dev/null || true
systemctl disable dnsmasq 2>/dev/null || true
log_info "hostapd/dnsmasq installés (lancés à la demande par le backend)"
```
Document the `AURIGE_AUTO_HOTSPOT*` env vars in a comment near the service env or in the summary.
Verify: `bash -n scripts/install_pi.sh` passes.

- [ ] **Step 2: Fix the misleading guide text** in `app/configuration/page.tsx` (~l.2108, 2136): replace the "Bouton Mode Hotspot" promise with the real behavior (auto at boot when offline + manual Démarrer/Arrêter in the Hotspot card). CLAUDE.md: add one line under the network notes that the hotspot AP is created by `backend/hotspot.py` (nmcli primary, hostapd/dnsmasq fallback), SSID `AURIGE`, boot-only auto.

- [ ] **Step 3: Commit**

```bash
git add scripts/install_pi.sh app/configuration/page.tsx CLAUDE.md
git commit -m "chore(hotspot): install hostapd/dnsmasq, fix guide text"
```

---

### Task 5: Frontend Hotspot card

**Files:**
- Modify: `lib/api.ts`, `app/configuration/page.tsx`

**Interfaces:**
- Consumes: `apiFetch`; endpoints from Task 3.

- [ ] **Step 1: `lib/api.ts`** — add near the other network fns:
```typescript
export interface HotspotStatus { active: boolean; ssid: string; interface: string; clients: number }
export async function getHotspotStatus(): Promise<HotspotStatus> { return fetchApi("/network/hotspot/status", { cache: "no-store" }) }
export async function getHotspotCredentials(): Promise<{ ssid: string; password: string }> { return fetchApi("/network/hotspot/credentials", { cache: "no-store" }) }
export async function setHotspotPassword(password: string): Promise<void> { await fetchApi("/network/hotspot/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }) }
export async function startHotspot(): Promise<{ status: string; detail: string }> { return fetchApi("/network/hotspot/start", { method: "POST" }) }
export async function stopHotspot(): Promise<{ status: string; detail: string }> { return fetchApi("/network/hotspot/stop", { method: "POST" }) }
```

- [ ] **Step 2: `app/configuration/page.tsx`** — add a **Hotspot (SSID local)** Card in the network section: status (actif/SSID/interface/clients from getHotspotStatus, refresh), SSID + password from getHotspotCredentials with a copy button, a password field (8–63) calling setHotspotPassword, Démarrer/Arrêter buttons calling startHotspot/stopHotspot then refreshing status, and the warning "sur une seule carte WiFi, démarrer le hotspot coupe la connexion client". Guard any time/live rendering (clients, status) with the page's existing client-mount pattern / suppressHydrationWarning (hydration history). Follow the existing card styling on this page.

- [ ] **Step 3: Verify** — `npm run build` succeeds; `npx tsc --noEmit` no new errors in lib/api.ts / app/configuration/page.tsx (baseline 81). Read the diff: the card calls the five functions and refreshes status after start/stop.

- [ ] **Step 4: Commit**

```bash
git add lib/api.ts app/configuration/page.tsx
git commit -m "feat(hotspot): configuration page Hotspot card (status, credentials, start/stop)"
```

---

## Self-Review

**Spec coverage:** §3 module → Tasks 1–2; endpoints + watchdog wiring → Task 3; install deps → Task 4; frontend card → Task 5. §4 security (validators before shell, system_network gating, 0600) → Tasks 1,3. §5 tests → embedded. All covered.

**Placeholder scan:** the two monkeypatch-heavy helper tests in Task 1 Step 1 note that helper names may need alignment — the module code in Step 3 defines `_iface_has_ip`, `_wireless_interfaces`, `_uptime_seconds` exactly as the tests reference; no TODO/TBD.

**Type consistency:** `start_hotspot_blocking`/`stop_hotspot`/`hotspot_status`/`auto_hotspot_once`/`get_or_create_hotspot_password`/`SSID_DEFAULT` names identical across Tasks 2–3 and the frontend `/network/hotspot/*` paths match the endpoints. The lifespan edit folds the existing single `db.close_db()` into the new try/finally — the implementer must not leave a duplicate close.

**Known risk:** `main.py` is ~8400 lines; the implementer adds the 5 routes near the existing network group and must register them on `fastapi_app` before the CORS/Session wrap. If the app-var layout differs from the auth work's `fastapi_app`, Task 3 reports it rather than guessing.
