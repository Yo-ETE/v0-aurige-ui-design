# DBC Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AURIGE a real DBC builder: edit messages (name/DLC/comment), manage standalone reusable DBCs (a library, not tied to a mission), and export a valid `.dbc`.

**Architecture:** Extract all DBC document logic into a support-agnostic module `backend/dbc_store.py` (operates on a `dbc.json`-shaped dict / a file path). Mission DBC endpoints and new library endpoints (`/api/dbc/*`) both call these helpers, so message editing, import, and the hardened exporter are shared. Frontend `app/dbc/page.tsx` gets a source selector (mission vs library) feeding one editor through a small API adapter.

**Tech Stack:** Python/FastAPI (pytest + Starlette TestClient) backend; Next.js 16 / React 19 / shadcn-ui frontend. No frontend unit tests — verify with `npm run build` + `npx tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-10-02-dbc-builder-design.md`

## Global Constraints

- Comments/UI French, code English.
- FLAT backend imports (`from dbc_store import ...`, `from validators import ...`).
- Commands stay list-form, never `shell=True`. No new third-party deps.
- DBC document shape: `{messages:[{can_id, name, dlc, comment, signals:[DBCSignal]}], created_at, updated_at}`; library files add `{id, name}`. `DBCSignal` = `{id, can_id, name, start_bit, length, byte_order("little_endian"|"big_endian"), is_signed, scale, offset, min_val, max_val, unit, comment}`.
- Library storage: `${AURIGE_DATA_DIR}/dbc/<dbc_id>.json`; `dbc_id` matches `^[a-z0-9-]{1,64}$`, generated server-side, path resolved under the dbc dir and `is_within`-checked. Never build a path from a raw client string without `valid_dbc_id`.
- `can_id` validated as hex 1..8 chars (reuse the pattern `^[0-9A-Fa-f]{1,8}$`); `dlc` int 0..64 (default 8).
- Export: `byte_order` little_endian→`@1` (Intel), big_endian→`@0` (Motorola); extended IDs (`int(can_id,16) > 0x7FF`) set bit 31 (`| 0x80000000`); message/signal names sanitized to DBC identifiers.
- Backend runs as root on the Pi; `${AURIGE_DATA_DIR}` default `/opt/aurige/data`. Tests set `AURIGE_DATA_DIR` to a tmp dir.
- No frame injection added. The existing "send signal" is out of scope (AUD-06).

---

### Task 1: `dbc_store` helpers + `valid_dbc_id` + hardened exporter

**Files:**
- Create: `backend/dbc_store.py`
- Modify: `backend/validators.py`
- Test: `backend/tests/test_dbc_store.py`

**Interfaces:**
- Produces:
  - `dbc_store.new_doc() -> dict`
  - `dbc_store.dbc_ident(name: str, fallback: str) -> str`
  - `dbc_store.upsert_signal(doc: dict, signal: dict) -> str` (returns signal id; auto-creates the message with name `MSG_<can_id>`, dlc 8, comment "")
  - `dbc_store.upsert_message(doc: dict, can_id: str, name=None, dlc=None, comment=None) -> None` (metadata only, never touches `signals`; creates the message if absent)
  - `dbc_store.delete_signal(doc: dict, signal_id: str) -> int`
  - `dbc_store.delete_message(doc: dict, can_id: str) -> int`
  - `dbc_store.dbc_to_text(doc: dict) -> str`
  - `validators.valid_dbc_id(s) -> bool`
- Consumes: nothing (pure functions on dicts).

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_dbc_store.py
import dbc_store as ds
import validators


def _sig(can_id="0C6", name="Spd", start_bit=0, length=8, **kw):
    base = dict(id="", can_id=can_id, name=name, start_bit=start_bit, length=length,
                byte_order="little_endian", is_signed=False, scale=1, offset=0,
                min_val=0, max_val=255, unit="", comment="")
    base.update(kw)
    return base


def test_upsert_signal_autocreates_message():
    doc = ds.new_doc()
    sid = ds.upsert_signal(doc, _sig())
    assert sid
    assert len(doc["messages"]) == 1
    msg = doc["messages"][0]
    assert msg["can_id"] == "0C6"
    assert msg["name"] == "MSG_0C6"
    assert msg["dlc"] == 8
    assert len(msg["signals"]) == 1


def test_upsert_message_metadata_only_keeps_signals():
    doc = ds.new_doc()
    ds.upsert_signal(doc, _sig())
    ds.upsert_message(doc, "0C6", name="BrakeStatus", dlc=6, comment="frein")
    msg = doc["messages"][0]
    assert msg["name"] == "BrakeStatus"
    assert msg["dlc"] == 6
    assert msg["comment"] == "frein"
    assert len(msg["signals"]) == 1  # signals untouched


def test_upsert_message_creates_empty_message():
    doc = ds.new_doc()
    ds.upsert_message(doc, "123", name="Empty", dlc=8)
    assert doc["messages"][0]["can_id"] == "123"
    assert doc["messages"][0]["signals"] == []


def test_delete_signal_and_message():
    doc = ds.new_doc()
    sid = ds.upsert_signal(doc, _sig())
    assert ds.delete_signal(doc, sid) == 1
    assert doc["messages"][0]["signals"] == []
    assert ds.delete_message(doc, "0C6") == 1
    assert doc["messages"] == []


def test_dbc_ident_sanitizes():
    assert ds.dbc_ident("Brake Status", "X") == "Brake_Status"
    assert ds.dbc_ident("3phase", "X") == "_3phase"
    assert ds.dbc_ident("", "FALLBACK") == "FALLBACK"
    assert ds.dbc_ident("a-b.c", "X") == "a_b_c"


def test_export_standard_id():
    doc = ds.new_doc()
    ds.upsert_signal(doc, _sig(can_id="1B0", name="Rpm", length=16, byte_order="big_endian"))
    txt = ds.dbc_to_text(doc)
    assert "BO_ 432 MSG_1B0: 8 Vector__XXX" in txt  # 0x1B0 == 432, standard id
    assert " SG_ Rpm : 0|16@0+ (1,0) [0|255] \"\" Vector__XXX" in txt
    assert "NS_ :" in txt and "CM_" in txt  # NS_ block lists standard symbols


def test_export_extended_id_sets_bit31():
    doc = ds.new_doc()
    ds.upsert_signal(doc, _sig(can_id="18DAF110", name="Diag"))
    txt = ds.dbc_to_text(doc)
    bo_id = int("18DAF110", 16) | 0x80000000
    assert f"BO_ {bo_id} MSG_18DAF110: 8 Vector__XXX" in txt


def test_export_sanitizes_names():
    doc = ds.new_doc()
    ds.upsert_message(doc, "090", name="3Wheel Speed")
    ds.upsert_signal(doc, _sig(can_id="090", name="FL Speed"))
    txt = ds.dbc_to_text(doc)
    assert "BO_ 144 _3Wheel_Speed: 8 Vector__XXX" in txt
    assert " SG_ FL_Speed :" in txt


def test_valid_dbc_id():
    for ok in ["clio", "my-dbc-1", "a", "0"]:
        assert validators.valid_dbc_id(ok), ok
    for bad in ["", "A", "../x", "a/b", "a.b", "x" * 65, "a_b", None, 123]:
        assert not validators.valid_dbc_id(bad), bad
```

- [ ] **Step 2: Run, verify fail**

Run: `cd backend && python -m pytest tests/test_dbc_store.py -v`
Expected: FAIL (module `dbc_store` missing; `validators.valid_dbc_id` missing).

- [ ] **Step 3: Implement**

`backend/dbc_store.py`:
```python
"""AURIGE - Stockage/édition DBC indépendant du support (mission ou bibliothèque).

Un "document DBC" est un dict:
  {messages:[{can_id, name, dlc, comment, signals:[DBCSignal]}], created_at, updated_at}
Ces helpers n'écrivent pas sur disque (sauf load_doc/save_doc); ils opèrent sur le dict.
"""
import re
import time
import json
from pathlib import Path
from datetime import datetime

_IDENT_KEEP = re.compile(r"[^A-Za-z0-9_]")


def dbc_ident(name, fallback):
    """Normalise un nom en identifiant DBC valide: [A-Za-z_][A-Za-z0-9_]*."""
    s = _IDENT_KEEP.sub("_", str(name or "").strip())
    if not s:
        return fallback
    if s[0].isdigit():
        s = "_" + s
    return s


def new_doc():
    now = datetime.now().isoformat()
    return {"messages": [], "created_at": now, "updated_at": now}


def load_doc(path: Path) -> dict:
    with open(path, "r") as f:
        return json.load(f)


def save_doc(path: Path, doc: dict) -> None:
    doc["updated_at"] = datetime.now().isoformat()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(doc, f, indent=2)


def _find_message(doc, can_id):
    for m in doc["messages"]:
        if m["can_id"] == can_id:
            return m
    return None


def upsert_message(doc, can_id, name=None, dlc=None, comment=None):
    """Crée le message si absent; met à jour UNIQUEMENT name/dlc/comment fournis.
    Ne touche jamais aux signaux."""
    msg = _find_message(doc, can_id)
    if msg is None:
        msg = {"can_id": can_id, "name": f"MSG_{can_id}", "dlc": 8, "comment": "", "signals": []}
        doc["messages"].append(msg)
    if name is not None:
        msg["name"] = dbc_ident(name, f"MSG_{can_id}")
    if dlc is not None:
        msg["dlc"] = int(dlc)
    if comment is not None:
        msg["comment"] = str(comment)
    return None


def upsert_signal(doc, signal: dict) -> str:
    """Ajoute/maj un signal (match par id). Auto-crée le message de son can_id."""
    can_id = signal["can_id"]
    msg = _find_message(doc, can_id)
    if msg is None:
        msg = {"can_id": can_id, "name": f"MSG_{can_id}", "dlc": 8, "comment": "", "signals": []}
        doc["messages"].append(msg)
    sig = dict(signal)
    sig["name"] = dbc_ident(sig.get("name"), f"SIG_{can_id}_{sig.get('start_bit', 0)}")
    if not sig.get("id"):
        sig["id"] = f"{can_id}_{sig['name']}_{datetime.now().strftime('%H%M%S')}{int(time.time()*1000)%1000}"
    idx = next((i for i, s in enumerate(msg["signals"]) if s.get("id") == sig["id"]), None)
    if idx is not None:
        msg["signals"][idx] = sig
    else:
        msg["signals"].append(sig)
    return sig["id"]


def delete_signal(doc, signal_id: str) -> int:
    removed = 0
    for m in doc["messages"]:
        before = len(m["signals"])
        m["signals"] = [s for s in m["signals"] if s.get("id") != signal_id]
        removed += before - len(m["signals"])
    return removed


def delete_message(doc, can_id: str) -> int:
    before = len(doc["messages"])
    doc["messages"] = [m for m in doc["messages"] if m.get("can_id") != can_id]
    return before - len(doc["messages"])


# Liste standard des symboles NS_ (compat candb++/SavvyCAN).
_NS_SYMBOLS = [
    "NS_DESC_", "CM_", "BA_DEF_", "BA_", "VAL_", "CAT_DEF_", "CAT_", "FILTER",
    "BA_DEF_DEF_", "EV_DATA_", "ENVVAR_DATA_", "SGTYPE_", "SGTYPE_VAL_",
    "BA_DEF_SGTYPE_", "BA_SGTYPE_", "SIG_TYPE_REF_", "VAL_TABLE_", "SIG_GROUP_",
    "SIG_VALTYPE_", "SIGTYPE_VALTYPE_", "BO_TX_BU_", "BA_DEF_REL_", "BA_REL_",
    "BA_DEF_DEF_REL_", "BU_SG_REL_", "BU_EV_REL_", "BU_BO_REL_", "SG_MUL_VAL_",
]


def dbc_to_text(doc: dict) -> str:
    lines = ['VERSION ""', "", "NS_ :"]
    for sym in _NS_SYMBOLS:
        lines.append(f"\t{sym}")
    lines += ["", "BS_:", "", "BU_:", ""]
    for msg in doc.get("messages", []):
        bo_id = int(msg["can_id"], 16)
        if bo_id > 0x7FF:
            bo_id |= 0x80000000
        name = dbc_ident(msg.get("name"), f"MSG_{msg['can_id']}")
        dlc = int(msg.get("dlc", 8))
        lines.append(f"BO_ {bo_id} {name}: {dlc} Vector__XXX")
        for sig in msg.get("signals", []):
            sname = dbc_ident(sig.get("name"), f"SIG_{msg['can_id']}_{sig.get('start_bit',0)}")
            bo = 1 if sig.get("byte_order") == "little_endian" else 0
            sign = "-" if sig.get("is_signed") else "+"
            scale = sig.get("scale", 1)
            offset = sig.get("offset", 0)
            mn = sig.get("min_val", 0)
            mx = sig.get("max_val", 0)
            unit = sig.get("unit", "")
            lines.append(
                f' SG_ {sname} : {sig.get("start_bit",0)}|{sig.get("length",8)}@{bo}{sign}'
                f' ({scale},{offset}) [{mn}|{mx}] "{unit}" Vector__XXX'
            )
        lines.append("")
    lines.append("")
    for msg in doc.get("messages", []):
        bo_id = int(msg["can_id"], 16)
        if bo_id > 0x7FF:
            bo_id |= 0x80000000
        if msg.get("comment"):
            lines.append(f'CM_ BO_ {bo_id} "{msg["comment"]}";')
        for sig in msg.get("signals", []):
            if sig.get("comment"):
                sname = dbc_ident(sig.get("name"), f"SIG_{msg['can_id']}_{sig.get('start_bit',0)}")
                lines.append(f'CM_ SG_ {bo_id} {sname} "{sig["comment"]}";')
    return "\n".join(lines)
```

In `backend/validators.py`, add after `valid_backup_filename`:
```python
_DBC_ID = re.compile(r"^[a-z0-9-]{1,64}$")


def valid_dbc_id(s) -> bool:
    """Identifiant de DBC bibliothèque : slug sûr, pas de traversée de chemin."""
    if not isinstance(s, str):
        return False
    if "/" in s or "\\" in s or ".." in s:
        return False
    return bool(_DBC_ID.fullmatch(s))
```

- [ ] **Step 4: Run, verify pass**

Run: `cd backend && python -m pytest tests/test_dbc_store.py -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/dbc_store.py backend/validators.py backend/tests/test_dbc_store.py
git commit -m "feat(dbc): shared dbc_store helpers (message/signal upsert, hardened .dbc export) + valid_dbc_id"
```

---

### Task 2: Mission message endpoint + route mission DBC through `dbc_store`

**Files:**
- Modify: `backend/main.py` (the mission DBC endpoints block, approx `add_dbc_signal` ~5853, `export_dbc` ~5984, plus a new message route)
- Test: `backend/tests/test_dbc_mission.py`

**Interfaces:**
- Consumes: `dbc_store` (Task 1).
- Produces: `POST /api/missions/{mission_id}/dbc/message` body `{can_id, name?, dlc?, comment?}` → `{status:"ok", can_id}`; `export_dbc` now uses `dbc_store.dbc_to_text`.

- [ ] **Step 1: Write failing tests**

```python
# backend/tests/test_dbc_mission.py
import pytest
from pathlib import Path
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
    # create a mission dir
    mid = "m-test"
    (tmp_path / "missions" / mid / "logs").mkdir(parents=True)
    import json as _j
    (tmp_path / "missions" / mid / "mission.json").write_text(_j.dumps({"id": mid, "name": "Clio"}))
    yield c, mid
    await db.close_db()


def test_add_message_then_signal(client):
    c, mid = client
    r = c.post(f"/api/missions/{mid}/dbc/message", json={"can_id": "0C6", "name": "BrakeStatus", "dlc": 6, "comment": "frein"})
    assert r.status_code == 200, r.text
    r = c.get(f"/api/missions/{mid}/dbc")
    msg = next(m for m in r.json()["messages"] if m["can_id"] == "0C6")
    assert msg["name"] == "BrakeStatus" and msg["dlc"] == 6 and msg["signals"] == []
    # adding a signal keeps the message metadata
    c.post(f"/api/missions/{mid}/dbc/signal", json={"can_id": "0C6", "name": "Pressure", "start_bit": 0, "length": 8,
            "byte_order": "little_endian", "is_signed": False, "scale": 1, "offset": 0, "min_val": 0, "max_val": 255, "unit": "", "comment": ""})
    r = c.get(f"/api/missions/{mid}/dbc")
    msg = next(m for m in r.json()["messages"] if m["can_id"] == "0C6")
    assert msg["name"] == "BrakeStatus" and len(msg["signals"]) == 1


def test_message_rejects_bad_can_id(client):
    c, mid = client
    r = c.post(f"/api/missions/{mid}/dbc/message", json={"can_id": "ZZZ", "name": "X"})
    assert r.status_code == 400


def test_export_uses_hardened_text(client):
    c, mid = client
    c.post(f"/api/missions/{mid}/dbc/signal", json={"can_id": "18DAF110", "name": "Diag", "start_bit": 0, "length": 8,
            "byte_order": "little_endian", "is_signed": False, "scale": 1, "offset": 0, "min_val": 0, "max_val": 255, "unit": "", "comment": ""})
    r = c.get(f"/api/missions/{mid}/dbc/export")
    assert r.status_code == 200
    bo_id = int("18DAF110", 16) | 0x80000000
    assert f"BO_ {bo_id} MSG_18DAF110: 8 Vector__XXX" in r.text
```

(If the mission-creation helper in `main.py` differs, adapt the fixture to create whatever `load_mission` expects — the goal is a mission dir the DBC endpoints accept.)

- [ ] **Step 2: Run, verify fail**

Run: `cd backend && python -m pytest tests/test_dbc_mission.py -v` → FAIL (no message route; export still inline).

- [ ] **Step 3: Implement**

In `backend/main.py`, near the flat imports add `import dbc_store` and `from validators import valid_git_ref, valid_backup_filename, valid_dbc_id` (extend the existing import).

Add a `CAN_ID` guard helper near the DBC section:
```python
import re as _re
_CAN_ID_RE = _re.compile(r"^[0-9A-Fa-f]{1,8}$")
def _valid_can_id(s) -> bool:
    return isinstance(s, str) and bool(_CAN_ID_RE.fullmatch(s.strip()))
```

Add the mission message endpoint (next to `add_dbc_signal`):
```python
class DBCMessageMeta(BaseModel):
    can_id: str
    name: Optional[str] = None
    dlc: Optional[int] = None
    comment: Optional[str] = None


@app.post("/api/missions/{mission_id}/dbc/message")
async def add_dbc_message(mission_id: str, meta: DBCMessageMeta):
    if not _valid_can_id(meta.can_id):
        raise HTTPException(status_code=400, detail="CAN ID invalide (hex 1-8)")
    if meta.dlc is not None and not (0 <= meta.dlc <= 64):
        raise HTTPException(status_code=400, detail="DLC invalide (0-64)")
    mission_dir = Path(MISSIONS_DIR) / mission_id
    if not mission_dir.exists():
        raise HTTPException(status_code=404, detail="Mission non trouvee")
    dbc_file = mission_dir / "dbc.json"
    doc = dbc_store.load_doc(dbc_file) if dbc_file.exists() else dbc_store.new_doc()
    doc.setdefault("mission_id", mission_id)
    dbc_store.upsert_message(doc, meta.can_id.strip(), name=meta.name, dlc=meta.dlc, comment=meta.comment)
    dbc_store.save_doc(dbc_file, doc)
    return {"status": "ok", "can_id": meta.can_id.strip()}
```

Refactor `add_dbc_signal` to validate `can_id` and use the store (keep the same route + response `{status:"ok", signal_id}`):
```python
    if not _valid_can_id(signal.can_id):
        raise HTTPException(status_code=400, detail="CAN ID invalide (hex 1-8)")
    dbc_file = Path(MISSIONS_DIR) / mission_id / "dbc.json"
    if not (Path(MISSIONS_DIR) / mission_id).exists():
        raise HTTPException(status_code=404, detail="Mission non trouvee")
    doc = dbc_store.load_doc(dbc_file) if dbc_file.exists() else dbc_store.new_doc()
    doc.setdefault("mission_id", mission_id)
    sid = dbc_store.upsert_signal(doc, signal.model_dump())
    dbc_store.save_doc(dbc_file, doc)
    return {"status": "ok", "signal_id": sid}
```

Replace the body of `export_dbc` (the whole `lines = [...]` generation through the return) with:
```python
    doc = dbc_store.load_doc(dbc_file)
    dbc_content = dbc_store.dbc_to_text(doc)
    return Response(
        content=dbc_content,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="mission_{mission_id}.dbc"'},
    )
```
(Keep the `if not dbc_file.exists(): raise 404` guard above it.)

Leave `delete_dbc_signal`, `delete_dbc_message`, `clear_mission_dbc`, `get_active_dbc_ids`, and the import endpoint as-is (they already work; optionally route delete through `dbc_store` but not required).

- [ ] **Step 4: Run, verify pass**

Run: `cd backend && python -m pytest tests/test_dbc_mission.py tests/test_dbc_store.py -v` → PASS. Then `cd backend && python -m pytest tests/ -q` → whole suite green.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_dbc_mission.py
git commit -m "feat(dbc): mission message endpoint + route mission DBC add-signal/export through dbc_store"
```

---

### Task 3: Standalone DBC library backend (`/api/dbc/*`) + bridges

**Files:**
- Modify: `backend/main.py` (new `/api/dbc` endpoints block)
- Test: `backend/tests/test_dbc_library.py`

**Interfaces:**
- Consumes: `dbc_store`, `valid_dbc_id`, `_valid_can_id` (Tasks 1-2).
- Produces: `/api/dbc` (GET list, POST create), `/api/dbc/{id}` (GET, PATCH rename, DELETE), `/api/dbc/{id}/signal` (POST), `/api/dbc/{id}/signal/{sid}` (DELETE), `/api/dbc/{id}/message` (POST), `/api/dbc/{id}/message/{can_id}` (DELETE), `/api/dbc/{id}/import` (POST multipart), `/api/dbc/{id}/export` (GET), `/api/dbc/{id}/from-mission/{mission_id}` (POST), `/api/missions/{mission_id}/dbc/from-library/{dbc_id}` (POST).

- [ ] **Step 1: Write failing tests**

```python
# backend/tests/test_dbc_library.py
import pytest, json as _j
from pathlib import Path
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
    yield c, tmp_path
    await db.close_db()


def test_library_crud(client):
    c, _ = client
    r = c.post("/api/dbc", json={"name": "Clio RE"})
    assert r.status_code == 200, r.text
    did = r.json()["id"]
    assert r.json()["name"] == "Clio RE"
    assert c.get("/api/dbc").json()["libraries"][0]["id"] == did
    r = c.patch(f"/api/dbc/{did}", json={"name": "Clio v2"})
    assert c.get(f"/api/dbc/{did}").json()["name"] == "Clio v2"
    assert c.delete(f"/api/dbc/{did}").status_code == 200
    assert c.get("/api/dbc").json()["libraries"] == []


def test_library_rejects_bad_id(client):
    c, _ = client
    assert c.get("/api/dbc/../etc").status_code in (400, 404)
    assert c.get("/api/dbc/NOThex..").status_code in (400, 404)


def test_library_signal_and_export_roundtrip(client):
    c, _ = client
    did = c.post("/api/dbc", json={"name": "lib"}).json()["id"]
    c.post(f"/api/dbc/{did}/message", json={"can_id": "0C6", "name": "Brake", "dlc": 8})
    c.post(f"/api/dbc/{did}/signal", json={"can_id": "0C6", "name": "Pressure", "start_bit": 0, "length": 8,
            "byte_order": "little_endian", "is_signed": False, "scale": 1, "offset": 0, "min_val": 0, "max_val": 255, "unit": "", "comment": ""})
    exp = c.get(f"/api/dbc/{did}/export")
    assert exp.status_code == 200 and "BO_ 198 Brake: 8 Vector__XXX" in exp.text
    # round-trip: import the exported text into a new library
    did2 = c.post("/api/dbc", json={"name": "lib2"}).json()["id"]
    r = c.post(f"/api/dbc/{did2}/import", files={"file": ("x.dbc", exp.text, "application/octet-stream")})
    assert r.status_code == 200
    got = c.get(f"/api/dbc/{did2}")
    assert any(m["can_id"].upper() == "0C6" for m in got.json()["messages"])


def test_bridges_mission_library(client):
    c, tmp = client
    mid = "m1"
    (tmp / "missions" / mid / "logs").mkdir(parents=True)
    (tmp / "missions" / mid / "mission.json").write_text(_j.dumps({"id": mid, "name": "Clio"}))
    c.post(f"/api/missions/{mid}/dbc/message", json={"can_id": "090", "name": "WheelSpeed"})
    did = c.post("/api/dbc", json={"name": "lib"}).json()["id"]
    # mission -> library
    assert c.post(f"/api/dbc/{did}/from-mission/{mid}").status_code == 200
    assert any(m["can_id"] == "090" for m in c.get(f"/api/dbc/{did}").json()["messages"])
    # library -> mission (replaces)
    c.post(f"/api/dbc/{did}/message", json={"can_id": "1B0", "name": "Rpm"})
    assert c.post(f"/api/missions/{mid}/dbc/from-library/{did}").status_code == 200
    ids = {m["can_id"] for m in c.get(f"/api/missions/{mid}/dbc").json()["messages"]}
    assert "1B0" in ids
```

- [ ] **Step 2: Run, verify fail**

Run: `cd backend && python -m pytest tests/test_dbc_library.py -v` → FAIL (routes missing).

- [ ] **Step 3: Implement**

In `backend/main.py`, add a DBC-library block (after the mission DBC endpoints). Use a helper for paths:
```python
def _dbc_lib_dir() -> Path:
    d = Path(os.environ.get("AURIGE_DATA_DIR", "/opt/aurige/data")) / "dbc"
    d.mkdir(parents=True, exist_ok=True)
    return d

def _dbc_lib_path(dbc_id: str) -> Path:
    if not valid_dbc_id(dbc_id):
        raise HTTPException(status_code=400, detail="Identifiant DBC invalide")
    p = (_dbc_lib_dir() / f"{dbc_id}.json").resolve()
    if _dbc_lib_dir().resolve() not in p.parents:
        raise HTTPException(status_code=400, detail="Chemin DBC invalide")
    return p


class DBCLibCreate(BaseModel):
    name: str

def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return s[:40] or "dbc"


@app.get("/api/dbc")
async def list_dbc_libraries():
    out = []
    for p in _dbc_lib_dir().glob("*.json"):
        try:
            doc = dbc_store.load_doc(p)
        except Exception:
            continue
        msgs = doc.get("messages", [])
        out.append({
            "id": doc.get("id", p.stem),
            "name": doc.get("name", p.stem),
            "message_count": len(msgs),
            "signal_count": sum(len(m.get("signals", [])) for m in msgs),
            "updated_at": doc.get("updated_at", ""),
        })
    out.sort(key=lambda x: x["updated_at"], reverse=True)
    return {"libraries": out}


@app.post("/api/dbc")
async def create_dbc_library(body: DBCLibCreate):
    name = (body.name or "").strip() or "DBC"
    base = _slug(name)
    dbc_id = base
    i = 1
    while (_dbc_lib_dir() / f"{dbc_id}.json").exists():
        i += 1
        dbc_id = f"{base}-{i}"
    if not valid_dbc_id(dbc_id):
        dbc_id = f"dbc-{int(time.time())}"
    doc = dbc_store.new_doc()
    doc["id"] = dbc_id
    doc["name"] = name
    dbc_store.save_doc(_dbc_lib_path(dbc_id), doc)
    return {"id": dbc_id, "name": name}


@app.get("/api/dbc/{dbc_id}")
async def get_dbc_library(dbc_id: str):
    p = _dbc_lib_path(dbc_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail="DBC introuvable")
    return dbc_store.load_doc(p)


@app.patch("/api/dbc/{dbc_id}")
async def rename_dbc_library(dbc_id: str, body: DBCLibCreate):
    p = _dbc_lib_path(dbc_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail="DBC introuvable")
    doc = dbc_store.load_doc(p)
    doc["name"] = (body.name or "").strip() or doc.get("name", dbc_id)
    dbc_store.save_doc(p, doc)
    return {"id": dbc_id, "name": doc["name"]}


@app.delete("/api/dbc/{dbc_id}")
async def delete_dbc_library(dbc_id: str):
    p = _dbc_lib_path(dbc_id)
    if p.exists():
        p.unlink()
    return {"status": "ok"}


@app.post("/api/dbc/{dbc_id}/message")
async def lib_add_message(dbc_id: str, meta: DBCMessageMeta):
    if not _valid_can_id(meta.can_id):
        raise HTTPException(status_code=400, detail="CAN ID invalide (hex 1-8)")
    if meta.dlc is not None and not (0 <= meta.dlc <= 64):
        raise HTTPException(status_code=400, detail="DLC invalide (0-64)")
    p = _dbc_lib_path(dbc_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail="DBC introuvable")
    doc = dbc_store.load_doc(p)
    dbc_store.upsert_message(doc, meta.can_id.strip(), name=meta.name, dlc=meta.dlc, comment=meta.comment)
    dbc_store.save_doc(p, doc)
    return {"status": "ok", "can_id": meta.can_id.strip()}


@app.post("/api/dbc/{dbc_id}/signal")
async def lib_add_signal(dbc_id: str, signal: DBCSignal):
    if not _valid_can_id(signal.can_id):
        raise HTTPException(status_code=400, detail="CAN ID invalide (hex 1-8)")
    p = _dbc_lib_path(dbc_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail="DBC introuvable")
    doc = dbc_store.load_doc(p)
    sid = dbc_store.upsert_signal(doc, signal.model_dump())
    dbc_store.save_doc(p, doc)
    return {"status": "ok", "signal_id": sid}


@app.delete("/api/dbc/{dbc_id}/signal/{signal_id}")
async def lib_delete_signal(dbc_id: str, signal_id: str):
    p = _dbc_lib_path(dbc_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail="DBC introuvable")
    doc = dbc_store.load_doc(p)
    n = dbc_store.delete_signal(doc, signal_id)
    dbc_store.save_doc(p, doc)
    return {"status": "ok", "removed": n}


@app.delete("/api/dbc/{dbc_id}/message/{can_id}")
async def lib_delete_message(dbc_id: str, can_id: str):
    p = _dbc_lib_path(dbc_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail="DBC introuvable")
    doc = dbc_store.load_doc(p)
    n = dbc_store.delete_message(doc, can_id)
    dbc_store.save_doc(p, doc)
    return {"status": "ok", "removed": n}


@app.get("/api/dbc/{dbc_id}/export")
async def lib_export(dbc_id: str):
    p = _dbc_lib_path(dbc_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail="DBC introuvable")
    doc = dbc_store.load_doc(p)
    return Response(content=dbc_store.dbc_to_text(doc), media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{dbc_id}.dbc"'})
```

For `POST /api/dbc/{dbc_id}/import`: reuse the SAME parsing code as the mission import endpoint. Extract the mission import's parse-and-merge body into a helper `def _import_dbc_into_doc(doc: dict, content_bytes: bytes) -> int` (returns imported signal count) in `main.py`, call it from BOTH the mission import endpoint and:
```python
@app.post("/api/dbc/{dbc_id}/import")
async def lib_import(dbc_id: str, file: UploadFile = File(...)):
    p = _dbc_lib_path(dbc_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail="DBC introuvable")
    doc = dbc_store.load_doc(p)
    content = await file.read()
    n = _import_dbc_into_doc(doc, content)
    dbc_store.save_doc(p, doc)
    return {"status": "success", "imported_signals": n}
```
(When extracting `_import_dbc_into_doc`, keep the mission import endpoint's external behavior and response unchanged — it still returns `imported_signals`/`total_messages`.)

Bridges:
```python
@app.post("/api/dbc/{dbc_id}/from-mission/{mission_id}")
async def lib_from_mission(dbc_id: str, mission_id: str):
    p = _dbc_lib_path(dbc_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail="DBC introuvable")
    mdbc = Path(MISSIONS_DIR) / mission_id / "dbc.json"
    if not mdbc.exists():
        raise HTTPException(status_code=404, detail="DBC mission introuvable")
    src = dbc_store.load_doc(mdbc)
    doc = dbc_store.load_doc(p)
    doc["messages"] = src.get("messages", [])
    dbc_store.save_doc(p, doc)
    return {"status": "ok", "message_count": len(doc["messages"])}


@app.post("/api/missions/{mission_id}/dbc/from-library/{dbc_id}")
async def mission_from_library(mission_id: str, dbc_id: str):
    if not (Path(MISSIONS_DIR) / mission_id).exists():
        raise HTTPException(status_code=404, detail="Mission non trouvee")
    p = _dbc_lib_path(dbc_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail="DBC introuvable")
    src = dbc_store.load_doc(p)
    mdbc = Path(MISSIONS_DIR) / mission_id / "dbc.json"
    doc = dbc_store.load_doc(mdbc) if mdbc.exists() else dbc_store.new_doc()
    doc["mission_id"] = mission_id
    doc["messages"] = src.get("messages", [])
    dbc_store.save_doc(mdbc, doc)
    return {"status": "ok", "message_count": len(doc["messages"])}
```
Ensure `import os`, `import re`, `import time` are available at module top (they are).

- [ ] **Step 4: Run, verify pass**

Run: `cd backend && python -m pytest tests/test_dbc_library.py tests/test_dbc_mission.py tests/test_dbc_store.py -v` → PASS. Then `cd backend && python -m pytest tests/ -q` → whole suite green.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_dbc_library.py
git commit -m "feat(dbc): standalone DBC library endpoints (CRUD, signal/message, import/export, mission bridges)"
```

---

### Task 4: Frontend API client (library + message routes)

**Files:**
- Modify: `lib/api.ts` (DBC section ~1343-1409)

**Interfaces:**
- Consumes: Task 3 routes.
- Produces: TS functions + types used by Task 5.

- [ ] **Step 1: Add types + functions**

After the existing DBC functions in `lib/api.ts`, add:
```typescript
export interface DBCLibrarySummary {
  id: string
  name: string
  message_count: number
  signal_count: number
  updated_at: string
}

export interface DBCLibraryDoc {
  id: string
  name: string
  messages: DBCMessage[]
  created_at: string
  updated_at: string
}

// --- Édition message (mission) ---
export async function addDBCMessage(
  missionId: string,
  meta: { can_id: string; name?: string; dlc?: number; comment?: string },
): Promise<{ status: string; can_id: string }> {
  return fetchApi(`/missions/${missionId}/dbc/message`, { method: "POST", body: JSON.stringify(meta) })
}

// --- Bibliothèque DBC autonome ---
export async function listDBCLibraries(): Promise<{ libraries: DBCLibrarySummary[] }> {
  return fetchApi(`/dbc`)
}
export async function createDBCLibrary(name: string): Promise<{ id: string; name: string }> {
  return fetchApi(`/dbc`, { method: "POST", body: JSON.stringify({ name }) })
}
export async function getDBCLibrary(dbcId: string): Promise<DBCLibraryDoc> {
  return fetchApi(`/dbc/${dbcId}`)
}
export async function renameDBCLibrary(dbcId: string, name: string): Promise<{ id: string; name: string }> {
  return fetchApi(`/dbc/${dbcId}`, { method: "PATCH", body: JSON.stringify({ name }) })
}
export async function deleteDBCLibrary(dbcId: string): Promise<{ status: string }> {
  return fetchApi(`/dbc/${dbcId}`, { method: "DELETE" })
}
export async function addLibDBCSignal(dbcId: string, signal: Partial<DBCSignal>): Promise<{ status: string; signal_id: string }> {
  return fetchApi(`/dbc/${dbcId}/signal`, { method: "POST", body: JSON.stringify(signal) })
}
export async function deleteLibDBCSignal(dbcId: string, signalId: string): Promise<{ status: string }> {
  return fetchApi(`/dbc/${dbcId}/signal/${signalId}`, { method: "DELETE" })
}
export async function addLibDBCMessage(dbcId: string, meta: { can_id: string; name?: string; dlc?: number; comment?: string }): Promise<{ status: string }> {
  return fetchApi(`/dbc/${dbcId}/message`, { method: "POST", body: JSON.stringify(meta) })
}
export async function deleteLibDBCMessage(dbcId: string, canId: string): Promise<{ status: string }> {
  return fetchApi(`/dbc/${dbcId}/message/${canId}`, { method: "DELETE" })
}
export function getLibDBCExportUrl(dbcId: string): string {
  return `${getApiBaseUrl()}/api/dbc/${dbcId}/export`
}
export async function dbcFromMission(dbcId: string, missionId: string): Promise<{ status: string; message_count: number }> {
  return fetchApi(`/dbc/${dbcId}/from-mission/${missionId}`, { method: "POST" })
}
export async function missionDbcFromLibrary(missionId: string, dbcId: string): Promise<{ status: string; message_count: number }> {
  return fetchApi(`/missions/${missionId}/dbc/from-library/${dbcId}`, { method: "POST" })
}
```

- [ ] **Step 2: Verify + commit**

Run: `npx tsc --noEmit` (no new errors beyond baseline). Commit:
```bash
git add lib/api.ts
git commit -m "feat(dbc): api client for message editing + DBC library + bridges"
```

---

### Task 5: Frontend DBC page — source selector, message editing, library UI, bridges

**Files:**
- Modify: `app/dbc/page.tsx`
- Create: `components/dbc/message-dialog.tsx`, `components/dbc/library-panel.tsx`

**Interfaces:**
- Consumes: Task 4 functions/types.
- Produces: the UI; no new exports consumed elsewhere.

**Architecture note:** the editor already renders mission messages/signals and calls `addDBCSignal`/`deleteDBCSignal`/etc. Introduce a `source` concept: `{ kind: "mission", id } | { kind: "library", id }`. A small adapter maps CRUD calls to the right route:
```typescript
// inside app/dbc/page.tsx
type DbcSource = { kind: "mission"; id: string } | { kind: "library"; id: string }
const api = {
  addSignal: (src: DbcSource, s: Partial<DBCSignal>) =>
    src.kind === "mission" ? addDBCSignal(src.id, s) : addLibDBCSignal(src.id, s),
  delSignal: (src: DbcSource, sid: string) =>
    src.kind === "mission" ? deleteDBCSignal(src.id, sid) : deleteLibDBCSignal(src.id, sid),
  addMessage: (src: DbcSource, m: {can_id:string;name?:string;dlc?:number;comment?:string}) =>
    src.kind === "mission" ? addDBCMessage(src.id, m) : addLibDBCMessage(src.id, m),
  delMessage: (src: DbcSource, canId: string) =>
    src.kind === "mission" ? deleteDBCMessage(src.id, canId) : deleteLibDBCMessage(src.id, canId),
  load: (src: DbcSource): Promise<{messages: DBCMessage[]}> =>
    src.kind === "mission" ? getMissionDBC(src.id) : getDBCLibrary(src.id),
  exportUrl: (src: DbcSource) =>
    src.kind === "mission" ? getDBCExportUrl(src.id) : getLibDBCExportUrl(src.id),
}
```

- [ ] **Step 1: Message dialog component**

Create `components/dbc/message-dialog.tsx`: a shadcn `Dialog` with fields CAN ID (hex), Nom, DLC (number 0..64), Commentaire, and `onSubmit({can_id,name,dlc,comment})`. Props: `{ open, onOpenChange, initial?, onSubmit }`. When `initial` is set, CAN ID is read-only (edit mode) and the title is "Éditer le message", else "Nouveau message". Validate CAN ID client-side with `/^[0-9A-Fa-f]{1,8}$/` and block submit otherwise (show an inline error). Use the same shadcn imports as `app/dbc/page.tsx` (Dialog, Input, Label, Button, Select).

Full component:
```tsx
"use client"
import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"

export interface MessageMeta { can_id: string; name: string; dlc: number; comment: string }

export function MessageDialog({
  open, onOpenChange, initial, onSubmit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial?: MessageMeta | null
  onSubmit: (m: MessageMeta) => void
}) {
  const [m, setM] = useState<MessageMeta>({ can_id: "", name: "", dlc: 8, comment: "" })
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    setM(initial ?? { can_id: "", name: "", dlc: 8, comment: "" })
    setErr(null)
  }, [initial, open])
  const editMode = !!initial
  const submit = () => {
    if (!/^[0-9A-Fa-f]{1,8}$/.test(m.can_id.trim())) { setErr("CAN ID invalide (hex, 1-8 caracteres)"); return }
    if (m.dlc < 0 || m.dlc > 64) { setErr("DLC invalide (0-64)"); return }
    onSubmit({ ...m, can_id: m.can_id.trim() })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border">
        <DialogHeader>
          <DialogTitle>{editMode ? "Éditer le message" : "Nouveau message"}</DialogTitle>
          <DialogDescription>Métadonnées du message CAN (les signaux se gèrent séparément).</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label>CAN ID (hex)</Label>
            <Input className="font-mono" value={m.can_id} disabled={editMode}
              onChange={(e) => setM({ ...m, can_id: e.target.value.replace(/[^0-9A-Fa-f]/g, "").toUpperCase() })} placeholder="0C6" />
          </div>
          <div className="space-y-1.5">
            <Label>Nom</Label>
            <Input value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} placeholder="BrakeStatus" />
          </div>
          <div className="space-y-1.5">
            <Label>DLC</Label>
            <Input type="number" min={0} max={64} value={m.dlc} onChange={(e) => setM({ ...m, dlc: Number(e.target.value) })} />
          </div>
          <div className="space-y-1.5">
            <Label>Commentaire</Label>
            <Input value={m.comment} onChange={(e) => setM({ ...m, comment: e.target.value })} />
          </div>
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Annuler</Button>
          <Button onClick={submit}>{editMode ? "Enregistrer" : "Créer"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Library panel component**

Create `components/dbc/library-panel.tsx`: lists libraries (`listDBCLibraries`), create (prompt name → `createDBCLibrary`), rename (`renameDBCLibrary`), delete (confirm → `deleteDBCLibrary`), and an "Ouvrir" button calling `onOpen(id, name)`. Also a per-row export link (`getLibDBCExportUrl`). Keep headers wrapping (`flex flex-wrap`). Props: `{ onOpen: (id: string, name: string) => void, activeId?: string }`. Expose a `refresh()` via `useEffect` on mount + after mutations. (Mirror the saved-comparisons list layout from `app/comparaison/page.tsx` for styling consistency.)

- [ ] **Step 3: Wire into `app/dbc/page.tsx`**

- Add a `source` state defaulting to the mission when a mission is active: `const [source, setSource] = useState<DbcSource | null>(missionId ? {kind:"mission", id:missionId} : null)`.
- Replace direct `missionId` CRUD calls in `loadDBC`, `handleAddSignal`, `handleSaveSignal`, `handleDeleteSignal`, `handleClearAll`, export link, with the `api` adapter against `source`. (`handleClearAll` only applies to mission — hide it for library, or implement per-message delete loop; keep mission-only.)
- Add a source switcher at the top: a segmented control "DBC de la mission" / "Bibliothèque", and when "Bibliothèque" is chosen, render `<LibraryPanel onOpen={(id)=>setSource({kind:"library",id})} activeId={...}/>` above the editor; selecting a library sets `source` and loads it.
- Add a "Nouveau message" button (opens `MessageDialog` in create mode → `api.addMessage(source, meta)` → reload) and, per message row, an "Éditer" action (opens `MessageDialog` with `initial` → `api.addMessage` updates metadata). Import `MessageDialog`.
- Bridges: when `source.kind === "mission"`, a button "Copier vers la bibliothèque" (pick/create a library then `dbcFromMission(dbcId, missionId)`, confirm overwrite). When `source.kind === "library"` and a mission is active, a button "Appliquer à la mission active" (`missionDbcFromLibrary(missionId, dbcId)`, confirm overwrite).
- Responsive: all new header/button rows use `flex flex-wrap items-center gap-2`; long names `break-all`/`truncate`.
- The empty-state ("Aucune mission sélectionnée") must no longer block the page when the user wants the library: if no mission, still allow the "Bibliothèque" source.

- [ ] **Step 4: Verify**

Run: `npm run build` (green) and `npx tsc --noEmit` (no new errors beyond baseline). Read the diff: the editor works against both sources; message create/edit calls the adapter; library CRUD + bridges wired; headers wrap.

- [ ] **Step 5: Commit**

```bash
git add app/dbc/page.tsx components/dbc/message-dialog.tsx components/dbc/library-panel.tsx
git commit -m "feat(dbc): source selector (mission/library), message create/edit, library UI + bridges"
```

---

## Self-Review

**Spec coverage:** §A message editing → Task 2 (mission) + Task 3 (library) + Task 5 (UI dialog). §B library → Task 3 (backend CRUD/import/export/bridges) + Task 4 (api) + Task 5 (UI). §C export hardening → Task 1 (`dbc_to_text`: NS_, extended-id bit31, name sanitize) + Task 2 (mission export routed through it) + Task 3 (library export). §3 data model → Task 1 shape + library `{id,name}`. §6 security → `valid_dbc_id` + `_dbc_lib_path` is_within (Tasks 1,3); `can_id` validation (Tasks 2,3); bridges overwrite with UI confirm (Task 5). §7 tests → Tasks 1-3 pytest; Task 5 build/tsc. All covered.

**Placeholder scan:** backend tasks carry full code + tests; the import-extraction step names a concrete helper `_import_dbc_into_doc` and says to keep the mission import response unchanged. Task 5 is frontend (no unit tests by project convention) and names exact files, functions, and the adapter shape — the only prose-described steps are UI wiring, with the adapter and dialog given as full code.

**Type consistency:** `DBCSignal`/`DBCMessage` reused from `lib/api.ts`; `dbc_store.upsert_signal(doc, dict)->str`, `upsert_message(doc, can_id, name?, dlc?, comment?)->None`, `dbc_to_text(doc)->str`, `valid_dbc_id(s)->bool` identical across plan, tests, and callers. Routes consistent between Task 3 (backend) and Task 4 (api client): `/api/dbc`, `/api/dbc/{id}`, `/api/dbc/{id}/signal`, `/api/dbc/{id}/message`, `/api/dbc/{id}/export`, `/api/dbc/{id}/from-mission/{mid}`, `/api/missions/{mid}/dbc/from-library/{id}`.

**Risk:** the mission-creation shape in the test fixtures (`mission.json`) must match what `load_mission`/the DBC endpoints expect — the implementer adapts the fixture to the real loader if it differs (noted in Task 2). Extracting `_import_dbc_into_doc` must preserve the existing mission import behavior; the round-trip test (Task 3) guards the exporter↔parser compatibility.
