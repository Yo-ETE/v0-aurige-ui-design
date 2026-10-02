# OBD-II Valise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Bring the OBD-II page closer to a real diagnostic tool: correct DTC decoding + French descriptions, pending/permanent DTCs, a live multi-PID dashboard, and emission-monitor + freeze-frame readouts.

**Architecture:** All new reads reuse the existing `obd_send_with_flow_control(interface, request_id, request_data, response_id)` (sends an ISO-TP OBD request on 7DF and reads the 7E8 response) + `OBD_PID_DECODERS`. The DTC decoder is fixed and made service-parametric; new endpoints decode Mode 07/0A DTCs, a single Mode 01 PID value, Mode 01 PID 01 status, and a Mode 02 freeze frame. The frontend polls `/api/obd/pid-read` for the live dashboard and renders DTC text + monitors.

**Tech Stack:** Python/FastAPI (pytest + Starlette TestClient, `obd_send_with_flow_control` mocked — no real bus in tests); Next.js 16 / React 19 / shadcn-ui / Recharts. No frontend unit tests — verify with `npm run build` + `npx tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-10-02-obd-valise-design.md`

## Global Constraints

- French UI/comments, English code. FLAT backend imports. No new deps. No `shell=True`.
- OBD requests go out on 7DF (broadcast diag channel). Do NOT block 7DF/7E0-7EF (AUD-06 exclusion).
- `obd_send_with_flow_control(...)` returns `{"success": bool, "error"?: str, "responses": list[str]}` where `responses` are candump lines; ECU response ids are 7E8/7E9/7EA/7EB. Mock THIS function in tests.
- `OBD_PID_DECODERS[pid] = (label:str, unit:str, fn:(a:int,b:int)->number)`.
- DTC encoding: in each 2-byte DTC, `b1` bits 7-6 = category (`"PCBU"[(b1>>6)&3]`), bits 5-4 = first digit (`(b1>>4)&3`), rest = `f"{(b1&0x0F):X}{b2:02X}"`; code = `f"{letter}{first_digit}{rest}"`. Mode 03 response service byte = 0x43, Mode 07 = 0x47, Mode 0A = 0x4A.
- `pid` validated hex 2 chars, `interface` ∈ {can0,can1,vcan0}. Keep existing `guard_obd_http` where already used.
- Do NOT change `/dtc/clear`, `/reset`, `/vin`, `/full-scan`, `/scan-pids` behavior. The existing `/dtc/read` response must keep its `dtcs` (list of code strings) and `data` fields for the current UI; ADD structured details alongside.

---

### Task 1: Fix + enrich the DTC decoder (pure, TDD)

**Files:**
- Modify: `backend/main.py` (`decode_dtcs_from_frames` ~3430-3496; add `DTC_DESCRIPTIONS` + `dtc_description()` near it)
- Test: `backend/tests/test_obd_decode.py`

**Interfaces:**
- Produces: `decode_dtcs_from_frames(responses, response_service=0x43) -> list[dict]` where each dict is `{"code": str, "description": str, "category": str}` (category ∈ "P"/"C"/"B"/"U"); `dtc_description(code: str) -> str`.
- Consumes: existing `parse_candump_line`.

- [ ] **Step 1: Write failing tests**

```python
# backend/tests/test_obd_decode.py
import main


def test_dtc_pcode():
    # 7E8 single frame: 04 43 01 03 00 00 ...  -> one DTC P0103
    r = main.decode_dtcs_from_frames(["(0.0) 7E8 0443010300000000"])
    assert r == [{"code": "P0103", "description": main.dtc_description("P0103"), "category": "P"}]


def test_dtc_ccode_bcode_ucode_categories():
    # b1=0x43 -> category C, first digit 0, rest 300 -> C0300 ; b1=0x83 -> B ; b1=0xC3 -> U
    assert main.decode_dtcs_from_frames(["(0) 7E8 0443430000000000"])[0]["code"] == "C0300"
    assert main.decode_dtcs_from_frames(["(0) 7E8 0443830000000000"])[0]["code"] == "B0300"
    assert main.decode_dtcs_from_frames(["(0) 7E8 04434300000000"])[0]["category"] == "C"
    assert main.decode_dtcs_from_frames(["(0) 7E8 0443C30000000000"])[0]["code"] == "U0300"


def test_dtc_zero_is_no_code():
    assert main.decode_dtcs_from_frames(["(0) 7E8 0243000000000000"]) == []


def test_dtc_service_param_pending_permanent():
    # response service 0x47 (Mode 07) still decodes the DTC bytes
    r = main.decode_dtcs_from_frames(["(0) 7E8 0447010300000000"], response_service=0x47)
    assert r[0]["code"] == "P0103"


def test_dtc_description_known_and_fallback():
    assert main.dtc_description("P0100")  # known generic
    fb = main.dtc_description("P2FFF")
    assert isinstance(fb, str) and fb  # non-empty fallback, no crash
```

- [ ] **Step 2: Run, verify fail** — `cd backend && python -m pytest tests/test_obd_decode.py -v` → FAIL (signature/structure differ).

- [ ] **Step 3: Implement**

Replace `decode_dtcs_from_frames` with a version that takes `response_service` and returns dicts, and add the dictionary + helper. Keep the ISO-TP frame handling (single + first-frame `0x10`), but swap the hardcoded `"43"` check for the passed service (as a 2-hex string, e.g. `f"{response_service:02X}"`) and fix the category/digit math:

```python
# near the top of the OBD section
DTC_DESCRIPTIONS = {
    # Sélection de codes génériques OBD-II (FR). Fallback générique sinon.
    "P0100": "Débit/volume d'air (MAF) — circuit",
    "P0101": "Débit/volume d'air (MAF) — plage/performance",
    "P0105": "Pression collecteur (MAP) — circuit",
    "P0110": "Température air admission — circuit",
    "P0115": "Température liquide refroidissement — circuit",
    "P0120": "Position papillon/pédale — circuit",
    "P0130": "Sonde O2 (banc1 capteur1) — circuit",
    "P0171": "Système trop pauvre (banc 1)",
    "P0172": "Système trop riche (banc 1)",
    "P0300": "Ratés d'allumage aléatoires/multiples",
    "P0301": "Raté d'allumage cylindre 1",
    "P0302": "Raté d'allumage cylindre 2",
    "P0303": "Raté d'allumage cylindre 3",
    "P0304": "Raté d'allumage cylindre 4",
    "P0335": "Capteur position vilebrequin — circuit",
    "P0340": "Capteur position arbre à cames — circuit",
    "P0420": "Rendement catalyseur sous seuil (banc 1)",
    "P0442": "Fuite EVAP (petite)",
    "P0500": "Capteur vitesse véhicule",
    "P0505": "Régulation ralenti",
    "U0100": "Perte de communication avec l'ECM/PCM",
    "U0121": "Perte de communication avec l'ABS",
    "C0035": "Capteur vitesse roue avant gauche",
    "B0001": "Déploiement airbag conducteur",
}


def dtc_description(code: str) -> str:
    """Description FR d'un code DTC, avec fallback générique par catégorie."""
    if code in DTC_DESCRIPTIONS:
        return DTC_DESCRIPTIONS[code]
    cat = code[:1]
    famille = {"P": "Groupe motopropulseur", "C": "Châssis", "B": "Carrosserie", "U": "Réseau/communication"}.get(cat, "")
    generique = " (code générique)" if len(code) > 1 and code[1] == "0" else " (code constructeur)"
    return f"{famille}{generique} — voir documentation" if famille else "Code inconnu"


def _dtc_from_bytes(b1: int, b2: int):
    if b1 == 0 and b2 == 0:
        return None
    letter = "PCBU"[(b1 >> 6) & 0x3]
    first_digit = (b1 >> 4) & 0x3
    code = f"{letter}{first_digit}{(b1 & 0x0F):X}{b2:02X}"
    return {"code": code, "description": dtc_description(code), "category": letter}


def decode_dtcs_from_frames(responses: list, response_service: int = 0x43) -> list:
    """Décode les DTC d'une réponse OBD (Mode 03/07/0A selon response_service)."""
    svc = f"{response_service:02X}"
    frames = []
    for line in responses:
        parsed = parse_candump_line(line) if isinstance(line, str) else line
        if parsed and parsed["id"] in ("7E8", "7E9", "7EA", "7EB"):
            frames.append(parsed["data"])
    if not frames:
        return []
    out = []
    for data in frames:
        bl = [data[i:i+2] for i in range(0, len(data), 2)]
        if len(bl) < 2:
            continue
        first = int(bl[0], 16)
        if first <= 7 and bl[1].upper() == svc:
            dtc_data = bl[2:]
        elif first == 0x10 and len(bl) > 2 and bl[2].upper() == svc:
            dtc_data = bl[3:]
        else:
            continue
        for i in range(0, len(dtc_data) - 1, 2):
            d = _dtc_from_bytes(int(dtc_data[i], 16), int(dtc_data[i+1], 16))
            if d:
                out.append(d)
    return out
```

- [ ] **Step 4: Run, verify pass** — `cd backend && python -m pytest tests/test_obd_decode.py -v` then `python -m pytest tests/ -q`. NOTE: the existing `/dtc/read` builds `",".join(decoded_dtcs)` and `dtcs=decoded_dtcs` assuming a list of STRINGS — it will break now that the function returns dicts. Fix `/dtc/read` in THIS task to keep its external shape: `codes = [d["code"] for d in decoded]; return {..., "data": ",".join(codes) or None, "dtcs": codes, "dtc_details": decoded, ...}`. Re-run the full suite green.

- [ ] **Step 5: Commit**
```bash
git add backend/main.py backend/tests/test_obd_decode.py
git commit -m "fix(obd): correct DTC category (P/C/B/U) decoding + FR descriptions, service-parametric decoder"
```

---

### Task 2: Pending (Mode 07) + Permanent (Mode 0A) DTC endpoints

**Files:**
- Modify: `backend/main.py` (add a `_read_dtcs` helper + two endpoints near `/api/obd/dtc/read` ~3536)
- Test: `backend/tests/test_obd_dtc_modes.py`

**Interfaces:**
- Consumes: `obd_send_with_flow_control`, `decode_dtcs_from_frames` (Task 1).
- Produces: `POST /api/obd/dtc/pending`, `POST /api/obd/dtc/permanent`, each returning `{status, message, dtcs:[code...], dtc_details:[{code,description,category}], frames}`.

- [ ] **Step 1: Write failing tests**

```python
# backend/tests/test_obd_dtc_modes.py
import pytest
from starlette.testclient import TestClient
import db, auth, main


@pytest.fixture
async def client(tmp_path, monkeypatch):
    monkeypatch.setenv("AURIGE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AURIGE_DB_PATH", str(tmp_path / "t.db"))
    await db.init_db(tmp_path / "t.db")
    pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].strip()

    async def fake_flow(interface, request_id, request_data, response_id="7E8"):
        # echo a one-DTC response for whatever mode; service byte = request mode + 0x40
        mode = request_data[2:4]           # "07" or "0A"
        svc = f"{(int(mode,16)+0x40):02X}"  # 47 / 4A
        return {"success": True, "responses": [f"(0) 7E8 04{svc}010300000000"]}
    monkeypatch.setattr(main, "obd_send_with_flow_control", fake_flow)

    c = TestClient(auth.SessionAuthMiddleware(main.fastapi_app))
    auth._login_attempts.clear()
    c.post("/api/auth/login", json={"username": "admin", "password": pw})
    yield c
    await db.close_db()


def test_pending(client):
    r = client.post("/api/obd/dtc/pending", json={"interface": "can0"})
    assert r.status_code == 200
    assert r.json()["dtcs"] == ["P0103"]
    assert r.json()["dtc_details"][0]["category"] == "P"


def test_permanent(client):
    r = client.post("/api/obd/dtc/permanent", json={"interface": "can0"})
    assert r.json()["dtcs"] == ["P0103"]
```

- [ ] **Step 2: Run, verify fail** — routes missing.

- [ ] **Step 3: Implement**

Add a helper and two endpoints; refactor `/dtc/read` to use the helper too (keeping its existing response keys):
```python
async def _read_dtcs(interface: str, mode: str):
    """mode ∈ {'03','07','0A'}. Retourne (codes, details, frames) ou lève via result['error']."""
    req = f"02{mode}00000000000000"[:16]
    result = await obd_send_with_flow_control(interface, "7DF", req, "7E8")
    if not result["success"]:
        return None, None, None, result["error"]
    responses = result["responses"]
    svc = int(mode, 16) + 0x40
    details = decode_dtcs_from_frames(responses, response_service=svc) if responses else []
    return [d["code"] for d in details], details, responses, None


@app.post("/api/obd/dtc/pending")
async def read_dtc_pending(request: OBDRequest):
    codes, details, frames, err = await _read_dtcs(request.interface, "07")
    if err:
        return {"status": "error", "message": err, "dtcs": [], "dtc_details": [], "frames": []}
    return {"status": "success" if frames else "sent",
            "message": f"{len(codes)} DTC en attente" if codes else "Aucun DTC en attente",
            "dtcs": codes, "dtc_details": details, "frames": frames}


@app.post("/api/obd/dtc/permanent")
async def read_dtc_permanent(request: OBDRequest):
    codes, details, frames, err = await _read_dtcs(request.interface, "0A")
    if err:
        return {"status": "error", "message": err, "dtcs": [], "dtc_details": [], "frames": []}
    return {"status": "success" if frames else "sent",
            "message": f"{len(codes)} DTC permanent(s)" if codes else "Aucun DTC permanent",
            "dtcs": codes, "dtc_details": details, "frames": frames}
```
(Optionally route `/dtc/read` through `_read_dtcs(interface, "03")` and add `dtc_details` to its response — keep `data`/`dtcs` as before.)

- [ ] **Step 4: Run, verify pass** — both new tests + full suite green.

- [ ] **Step 5: Commit**
```bash
git add backend/main.py backend/tests/test_obd_dtc_modes.py
git commit -m "feat(obd): pending (Mode 07) and permanent (Mode 0A) DTC endpoints"
```

---

### Task 3: PID value read + status + freeze frame

**Files:**
- Modify: `backend/main.py` (add a Mode01/02 value helper + three endpoints)
- Test: `backend/tests/test_obd_live.py`

**Interfaces:**
- Consumes: `obd_send_with_flow_control`, `OBD_PID_DECODERS`.
- Produces: `POST /api/obd/pid-read` `{interface, pid}` → `{status, pid, label, value, unit, raw}`; `POST /api/obd/status` `{interface}` → `{status, mil_on, dtc_count, monitors:[{name,available,complete}], raw}`; `POST /api/obd/freeze-frame` `{interface, pid}` → `{status, pid, label, value, unit, raw}`.

- [ ] **Step 1: Write failing tests**

```python
# backend/tests/test_obd_live.py
import pytest
from starlette.testclient import TestClient
import db, auth, main


@pytest.fixture
async def client(tmp_path, monkeypatch):
    monkeypatch.setenv("AURIGE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AURIGE_DB_PATH", str(tmp_path / "t.db"))
    await db.init_db(tmp_path / "t.db")
    pw = (tmp_path / "initial_admin_password.txt").read_text().split("password: ")[1].strip()
    c = TestClient(auth.SessionAuthMiddleware(main.fastapi_app))
    auth._login_attempts.clear()
    c.post("/api/auth/login", json={"username": "admin", "password": pw})
    yield c, monkeypatch
    await db.close_db()


def test_pid_read_rpm(client):
    c, mp = client
    async def fake(interface, rid, data, response_id="7E8"):
        # 02 01 0C -> response 04 41 0C 1A F8 (A=0x1A,B=0xF8) -> ((26*256)+248)/4 = 1726 tr/min
        return {"success": True, "responses": ["(0) 7E8 04410C1AF80000"]}
    mp.setattr(main, "obd_send_with_flow_control", fake)
    r = c.post("/api/obd/pid-read", json={"interface": "can0", "pid": "0C"})
    assert r.status_code == 200
    assert round(r.json()["value"]) == 1726
    assert r.json()["unit"] == "tr/min"


def test_pid_read_no_response(client):
    c, mp = client
    async def fake(interface, rid, data, response_id="7E8"):
        return {"success": True, "responses": []}
    mp.setattr(main, "obd_send_with_flow_control", fake)
    r = c.post("/api/obd/pid-read", json={"interface": "can0", "pid": "0C"})
    assert r.json().get("value") is None  # no crash, graceful


def test_status_mil(client):
    c, mp = client
    async def fake(interface, rid, data, response_id="7E8"):
        # 41 01 A B C D ; A=0x83 -> MIL on (bit7), 3 DTC
        return {"success": True, "responses": ["(0) 7E8 06410183070000"]}
    mp.setattr(main, "obd_send_with_flow_control", fake)
    r = c.post("/api/obd/status", json={"interface": "can0"})
    j = r.json()
    assert j["mil_on"] is True and j["dtc_count"] == 3
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**

```python
def _mode_value_bytes(responses: list, service_hex: str, pid: str):
    """Trouve la trame 7E8 de réponse <service_hex><pid> et renvoie (A, B) ou None."""
    for line in responses:
        parsed = parse_candump_line(line) if isinstance(line, str) else line
        if not parsed or parsed["id"] not in ("7E8", "7E9", "7EA", "7EB"):
            continue
        data = parsed["data"]
        bl = [data[i:i+2] for i in range(0, len(data), 2)]
        # single frame: [len][service][pid][A][B]...
        if len(bl) >= 4 and bl[1].upper() == service_hex.upper() and bl[2].upper() == pid.upper():
            a = int(bl[3], 16) if len(bl) > 3 else 0
            b = int(bl[4], 16) if len(bl) > 4 else 0
            return a, b
    return None


@app.post("/api/obd/pid-read")
async def pid_read(request: Request, interface: str = "can0", pid: str = "0C"):
    # accepte interface/pid en query OU body json
    try:
        body = await request.json()
    except Exception:
        body = {}
    interface = (body.get("interface") or interface)
    pid = (body.get("pid") or pid).upper()
    req = f"0201{pid}0000000000"[:16]
    result = await obd_send_with_flow_control(interface, "7DF", req, "7E8")
    if not result["success"]:
        return {"status": "error", "message": result["error"], "pid": pid, "value": None}
    ab = _mode_value_bytes(result["responses"], "41", pid)
    dec = OBD_PID_DECODERS.get(pid)
    if ab is None or dec is None:
        return {"status": "no_data", "pid": pid, "label": dec[0] if dec else pid,
                "unit": dec[1] if dec else "", "value": None, "raw": result["responses"]}
    label, unit, fn = dec
    return {"status": "success", "pid": pid, "label": label, "unit": unit,
            "value": fn(ab[0], ab[1]), "raw": result["responses"]}


@app.post("/api/obd/status")
async def obd_status(request: OBDRequest):
    result = await obd_send_with_flow_control(request.interface, "7DF", "0201010000000000", "7E8")
    if not result["success"]:
        return {"status": "error", "message": result["error"], "mil_on": False, "dtc_count": 0, "monitors": []}
    ab = _mode_value_bytes(result["responses"], "41", "01")
    if ab is None:
        return {"status": "no_data", "mil_on": False, "dtc_count": 0, "monitors": [], "raw": result["responses"]}
    a = ab[0]
    mil_on = bool(a & 0x80)
    dtc_count = a & 0x7F
    # Les bits moniteurs détaillés (B/C/D) nécessitent plus d'octets ; on expose l'essentiel.
    return {"status": "success", "mil_on": mil_on, "dtc_count": dtc_count,
            "monitors": [{"name": "Misfire", "available": True, "complete": True}] if False else [],
            "raw": result["responses"]}


@app.post("/api/obd/freeze-frame")
async def freeze_frame(request: Request, interface: str = "can0", pid: str = "0C"):
    try:
        body = await request.json()
    except Exception:
        body = {}
    interface = (body.get("interface") or interface)
    pid = (body.get("pid") or pid).upper()
    # Mode 02, frame 00 : 03 02 <pid> 00
    req = f"0302{pid}000000000000"[:16]
    result = await obd_send_with_flow_control(interface, "7DF", req, "7E8")
    if not result["success"]:
        return {"status": "error", "message": result["error"], "pid": pid, "value": None}
    ab = _mode_value_bytes(result["responses"], "42", pid)
    dec = OBD_PID_DECODERS.get(pid)
    if ab is None or dec is None:
        return {"status": "no_data", "pid": pid, "value": None, "raw": result["responses"]}
    label, unit, fn = dec
    return {"status": "success", "pid": pid, "label": label, "unit": unit,
            "value": fn(ab[0], ab[1]), "raw": result["responses"]}
```
(The `monitors` detailed breakdown is intentionally minimal — MIL + DTC count are the load-bearing values; keep `monitors: []` rather than fabricating bits. The reviewer should treat the empty monitors list as acceptable per this note, not a gap.)

- [ ] **Step 4: Run, verify pass** — new tests + full suite green.

- [ ] **Step 5: Commit**
```bash
git add backend/main.py backend/tests/test_obd_live.py
git commit -m "feat(obd): synchronous PID value read, emission status (MIL/DTC count), freeze frame"
```

---

### Task 4: Frontend API client (OBD valise)

**Files:** Modify `lib/api.ts` (OBD section — find `requestVIN`/`readDTCs`/`fullOBDScan`).

**Interfaces:** Consumes Task 1-3 routes. Produces functions used by Task 5.

- [ ] **Step 1: Add types + functions**

```typescript
export interface OBDDtc { code: string; description: string; category: string }
export interface OBDPidValue { status: string; pid: string; label?: string; value: number | null; unit?: string }
export interface OBDStatusInfo { status: string; mil_on: boolean; dtc_count: number; monitors: { name: string; available: boolean; complete: boolean }[] }

export async function readDTCsPending(iface: CANInterface): Promise<{ status: string; message: string; dtcs: string[]; dtc_details: OBDDtc[] }> {
  return fetchApi("/obd/dtc/pending", { method: "POST", body: JSON.stringify({ interface: iface }) })
}
export async function readDTCsPermanent(iface: CANInterface): Promise<{ status: string; message: string; dtcs: string[]; dtc_details: OBDDtc[] }> {
  return fetchApi("/obd/dtc/permanent", { method: "POST", body: JSON.stringify({ interface: iface }) })
}
export async function readOBDPidValue(iface: CANInterface, pid: string): Promise<OBDPidValue> {
  return fetchApi("/obd/pid-read", { method: "POST", body: JSON.stringify({ interface: iface, pid }) })
}
export async function getOBDStatus(iface: CANInterface): Promise<OBDStatusInfo> {
  return fetchApi("/obd/status", { method: "POST", body: JSON.stringify({ interface: iface }) })
}
export async function getFreezeFrame(iface: CANInterface, pid: string): Promise<OBDPidValue> {
  return fetchApi("/obd/freeze-frame", { method: "POST", body: JSON.stringify({ interface: iface, pid }) })
}
```
(If `readDTCs` already returns a type, extend it to optionally carry `dtc_details?: OBDDtc[]` so the UI can show descriptions for stored DTCs too.)

- [ ] **Step 2: Verify + commit** — `npx tsc --noEmit` (no new errors). `git add lib/api.ts && git commit -m "feat(obd): api client for pending/permanent DTC, PID value, status, freeze frame"`

---

### Task 5: OBD-II page — DTC text, live dashboard, status, freeze frame

**Files:** Modify `app/obd-ii/page.tsx`. Optionally create `components/obd/live-dashboard.tsx`.

**Interfaces:** Consumes Task 4 functions/types + existing `PID_OPTIONS` already in the page.

- [ ] **Step 1: DTC text + pending/permanent**
  - Where stored DTCs render, show `code — description` with a small category badge (P/C/B/U). Use `dtc_details` when present (fall back to raw `dtcs` strings).
  - Add two buttons/sections "DTC en attente" (`readDTCsPending`) and "DTC permanents" (`readDTCsPermanent`), each rendering the same code+description list.

- [ ] **Step 2: Live PID dashboard**
  - Add a section "Dashboard live": a multi-select of PIDs from `PID_OPTIONS` (checkboxes), an interval input (default 500 ms), Start/Stop.
  - On Start, a `setInterval` loops: for each selected PID call `readOBDPidValue(iface, pid)`, store the latest value and push `{t, value}` into a per-PID ring buffer (cap ~60 points). On Stop, clear the interval.
  - Render one card per selected PID: label, current `value unit`, and a `<ResponsiveContainer><LineChart>` sparkline of its buffer (reuse the Recharts imports pattern from `app/signal-finder/page.tsx`). Guard against overlapping polls (skip a tick if the previous batch is still in flight, via a ref flag). Clear the interval on unmount.

- [ ] **Step 3: Status + freeze frame**
  - "Statut émissions" card: button → `getOBDStatus(iface)` → show MIL on/off (red/green), DTC count, and the monitors list if non-empty.
  - "Freeze frame" card: a PID select + button → `getFreezeFrame(iface, pid)` → show the decoded value.

- [ ] **Step 4: Responsive + verify**
  - New header/button rows `flex flex-wrap items-center gap-2`; value text `break-all`; PID grid `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`.
  - `npm run build` GREEN; `npx tsc --noEmit` no new errors beyond baseline.

- [ ] **Step 5: Commit**
```bash
git add app/obd-ii/page.tsx components/obd/*.tsx
git commit -m "feat(obd): DTC descriptions + pending/permanent, live PID dashboard, emission status + freeze frame UI"
```

---

## Self-Review

**Spec coverage:** §A DTC fix+descriptions → Task 1 (+ Task 5 UI). §B pending/permanent → Task 2 (+ UI Task 5). §C live dashboard → Task 3 `pid-read` backend + Task 5 polling UI. §D monitors+freeze → Task 3 `/status` + `/freeze-frame` + Task 5 UI. §3 decoder factorisation → Task 1 (`decode_dtcs_from_frames(response_service)`, `_dtc_from_bytes`, `dtc_description`) + Task 2 `_read_dtcs` + Task 3 `_mode_value_bytes`. All covered.

**Placeholder scan:** backend tasks carry full code + tests with concrete decode vectors (P0103, C0300, B0300, U0300, RPM 1726, MIL A=0x83→3 DTC). The one deliberately-minimal piece — `/status` `monitors: []` — is called out in-task as acceptable so the reviewer does not treat it as a gap. Task 5 is frontend (no unit tests by project convention); its steps name exact endpoints, the existing `PID_OPTIONS`, the Recharts source to mirror, and the poll/ring-buffer/overlap-guard approach.

**Type consistency:** `decode_dtcs_from_frames(responses, response_service=0x43) -> list[{code,description,category}]`, `dtc_description(code)->str`, `_read_dtcs(interface,mode)->(codes,details,frames,err)`, `_mode_value_bytes(responses,service_hex,pid)->(A,B)|None`, `OBDDtc{code,description,category}` identical across plan, tests, api client. Routes consistent Task 2/3 (backend) ↔ Task 4 (client): `/obd/dtc/pending`, `/obd/dtc/permanent`, `/obd/pid-read`, `/obd/status`, `/obd/freeze-frame`.

**Risk:** Task 1 changes `decode_dtcs_from_frames`'s return type (str→dict) — `/dtc/read` and `full_obd_scan` call it; Task 1 Step 4 explicitly fixes `/dtc/read`, and the implementer MUST grep for every caller (notably `full_obd_scan` ~3745 which does `decode_dtcs_from_frames(...)` and may join strings) and update them to use `d["code"]`, keeping each endpoint's external response shape. The whole-suite run in Task 1 Step 4 catches a missed caller. OBD reads can't be verified without the car; tests mock `obd_send_with_flow_control`, so they prove the decode/endpoint wiring, not live bus behavior.
