# RE Power Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donner à Comparaison le diff au bit + un bandeau commande candidate, et ajouter un sous-système d'injection de fond (rejeu d'une commande en boucle + keep-alive d'un log) pour actionner les trames trouvées.

**Architecture:** Backend FastAPI — `compare_logs` gagne `changed_bits` par octet ; un nouveau sous-système « injection de fond » (`state.inject_process`, un seul process séparé du replay) sert à la fois le rejeu d'une trame en boucle et le keep-alive d'un log, derrière un chokepoint unique `_injectable_or_block` prêt pour AUD-06. Frontend Next.js/React — client API + bandeau de statut partagé + UI Comparaison (bits, badge, bandeau candidat, bouton rejeu) + action keep-alive sur Capture & Replay.

**Tech Stack:** FastAPI + asyncio + can-utils (cansend/canplayer) ; Next.js 16 / React 19 / shadcn-ui ; pytest + TestClient ; `npm run build` + `npx tsc`.

**Spec:** `docs/superpowers/specs/2026-10-02-re-power-tools-design.md`

## Global Constraints

- Commentaires et libellés UI en **français**, code en **anglais**.
- Pas de `shell=True` ; scripts via `bash` + fichier temporaire, comme `/api/replay/start`.
- Toutes les routes d'injection passent par le chokepoint `_injectable_or_block(frames)` (retourne None pour l'instant — AUD-06 s'y branchera) et sont gardées par la permission `can_inject`.
- Validation stricte des trames : `canId` hex 1..8 chars, `data` hex longueur paire ≤16 chars, `intervalMs` borné 10..5000.
- Le sous-système d'injection de fond tourne dans `state.inject_process`, **distinct** de `state.canplayer_process` (replay) — les deux coexistent.
- Backend : suite pytest verte à chaque task. Frontend : `npm run build` vert, pas de nouvelle erreur `tsc` au-delà du baseline (~80).

---

### Task 1: Diff au bit dans compare_logs

**Files:**
- Modify: `backend/main.py` (append `byte_change_detail`, ~6745)
- Test: `backend/tests/test_compare_bits.py`

**Interfaces:**
- Produces: chaque dict de `byte_change_detail` gagne `"changed_bits": list[int]` (positions 0..7 où `val_a ^ val_b` diffère ; `[]` si parse hex échoue).

- [ ] **Step 1: Test**

```python
# backend/tests/test_compare_bits.py
def _changed_bits(a: int, b: int):
    return [bit for bit in range(8) if (a ^ b) >> bit & 1]

def test_changed_bits_single():
    assert _changed_bits(0x00, 0x04) == [2]

def test_changed_bits_multi():
    assert _changed_bits(0x00, 0x05) == [0, 2]

def test_changed_bits_none():
    assert _changed_bits(0x0F, 0x0F) == []
```

(Ce test fige la formule ; il sert de référence au code inséré dans `compare_logs`.)

- [ ] **Step 2: Run, expect PASS** (test pur) : `python -m pytest backend/tests/test_compare_bits.py -v`

- [ ] **Step 3: Insérer `changed_bits` dans les deux `append`**

Dans `backend/main.py`, bloc `if byte_a != byte_b and (...)` (~6745), ajouter la clé dans le `append` du `try` :

```python
byte_change_detail.append({
    "index": byte_idx,
    "val_a": byte_a,
    "val_b": byte_b,
    "hex_diff": f"{abs(val_a - val_b):02X}",
    "decimal_diff": abs(val_a - val_b),
    "changed_bits": [bit for bit in range(8) if (val_a ^ val_b) >> bit & 1],
})
```

et dans le `except ValueError` : `"changed_bits": []`.

- [ ] **Step 4: Run full backend suite**, expect PASS : `cd backend && python -m pytest -q`

- [ ] **Step 5: Commit** `feat(compare): bits changeants par octet dans compare-logs`

---

### Task 2: Sous-système d'injection de fond (backend)

**Files:**
- Modify: `backend/main.py` (state + chokepoint + 3 endpoints), `backend/permissions.py` (motif `^/api/inject`)
- Test: `backend/tests/test_inject.py`

**Interfaces:**
- Consumes: `run_command_async`, `state`, `cleanup` pattern de `canplayer_process`.
- Produces:
  - `POST /api/inject/start` body `{interface:str, mode:"frame"|"log", canId?:str, data?:str, missionId?:str, logId?:str, intervalMs?:int}` → `{status:"started", description:str}` ; 409 si déjà en cours ; 400 si trame invalide.
  - `POST /api/inject/stop` → `{status:"stopped"}`.
  - `GET /api/inject/status` → `{running:bool, description:str}`.
  - `def _injectable_or_block(frames: list[str]) -> Optional[str]` (None = autorisé).

- [ ] **Step 1: Test (mock run_command_async)**

```python
# backend/tests/test_inject.py
import re
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient
import main
from main import app, state

client = TestClient(app)

def _reset():
    state.inject_process = None

def test_injectable_or_block_allows_for_now():
    assert main._injectable_or_block(["123#1122"]) is None

def test_inject_frame_rejects_bad_data():
    _reset()
    r = client.post("/api/inject/start", json={"interface": "can0", "mode": "frame", "canId": "123", "data": "ZZ"})
    assert r.status_code == 400

def test_inject_frame_rejects_long_data():
    _reset()
    r = client.post("/api/inject/start", json={"interface": "can0", "mode": "frame", "canId": "123", "data": "11223344556677889900"})
    assert r.status_code == 400

def test_inject_frame_starts_and_status_and_stop():
    _reset()
    fake = AsyncMock(); fake.returncode = None
    with patch("main.run_command_async", AsyncMock(return_value=fake)) as m:
        r = client.post("/api/inject/start", json={"interface": "can0", "mode": "frame", "canId": "3B7", "data": "0004", "intervalMs": 100})
        assert r.status_code == 200
        # script built with cansend loop, bounded interval
        script = m.call_args[0][0]
        joined = " ".join(script)
        assert "cansend" in joined and "3B7#0004" in joined
    s = client.get("/api/inject/status").json()
    assert s["running"] is True
    with patch.object(fake, "wait", AsyncMock(return_value=0)):
        st = client.post("/api/inject/stop")
        assert st.status_code == 200
    assert client.get("/api/inject/status").json()["running"] is False

def test_inject_second_start_conflicts():
    _reset()
    fake = AsyncMock(); fake.returncode = None
    with patch("main.run_command_async", AsyncMock(return_value=fake)):
        client.post("/api/inject/start", json={"interface": "can0", "mode": "frame", "canId": "100", "data": "01"})
        r2 = client.post("/api/inject/start", json={"interface": "can0", "mode": "frame", "canId": "101", "data": "02"})
        assert r2.status_code == 409
    state.inject_process = None
```

- [ ] **Step 2: Run, expect FAIL** (routes manquantes).

- [ ] **Step 3: Implémenter**

Dans `SystemState` (près de `canplayer_process`, ~72) ajouter :

```python
    inject_process: Optional[asyncio.subprocess.Process] = None
    inject_desc: str = ""
```

Ajouter dans le `cleanup` global (liste ~94) `state.inject_process`.

Helpers + endpoints (nouveau bloc, ex. après les routes replay) :

```python
_HEX_ID = re.compile(r"^[0-9A-Fa-f]{1,8}$")
_HEX_DATA = re.compile(r"^([0-9A-Fa-f]{2}){0,8}$")

def _injectable_or_block(frames: list[str]) -> Optional[str]:
    """Point de garde unique pour toute injection de fond.
    AUD-06 (is_id_blocked) se branchera ICI. Pour l'instant : aucun blocage."""
    return None

class InjectRequest(BaseModel):
    interface: str = "can0"
    mode: str = "frame"            # "frame" | "log"
    canId: Optional[str] = None
    data: Optional[str] = None
    missionId: Optional[str] = None
    logId: Optional[str] = None
    intervalMs: int = 100

@app.post("/api/inject/start")
async def inject_start(req: InjectRequest):
    if state.inject_process and state.inject_process.returncode is None:
        raise HTTPException(status_code=409, detail="Injection de fond deja en cours")
    interval = max(10, min(5000, int(req.intervalMs)))
    sleep_s = interval / 1000.0
    frames: list[str] = []
    if req.mode == "frame":
        cid = (req.canId or "").strip()
        data = (req.data or "").strip()
        if not _HEX_ID.match(cid) or not _HEX_DATA.match(data):
            raise HTTPException(status_code=400, detail="Trame invalide (ID 1..8 hex, data hex paire <=16)")
        frames = [f"{cid.upper()}#{data.upper()}"]
        desc = f"Trame {frames[0]} ({interval} ms)"
    elif req.mode == "log":
        if not req.missionId or not req.logId:
            raise HTTPException(status_code=400, detail="missionId et logId requis")
        log_path = _mission_log_path(req.missionId, req.logId)   # reuse replay helper
        frames = _parse_log_frames(log_path)                      # reuse replay parser -> ["ID#DATA", ...]
        if not frames:
            raise HTTPException(status_code=400, detail="Log vide ou illisible")
        desc = f"Keep-alive log {req.logId} ({len(frames)} trames)"
    else:
        raise HTTPException(status_code=400, detail="mode invalide")

    blocked = _injectable_or_block(frames)
    if blocked:
        raise HTTPException(status_code=403, detail=blocked)

    iface = req.interface
    lines = "\n".join(f"  cansend {iface} {f}\n  sleep {sleep_s}" for f in frames)
    script = f"#!/bin/bash\nwhile true; do\n{lines}\ndone\n"
    path = Path(tempfile.gettempdir()) / f"aurige_inject_{os.getpid()}.sh"
    path.write_text(script)
    state.inject_process = await run_command_async(["bash", str(path)])
    state.inject_desc = desc
    return {"status": "started", "description": desc}

@app.post("/api/inject/stop")
async def inject_stop():
    p = state.inject_process
    if p and p.returncode is None:
        p.terminate()
        try:
            await asyncio.wait_for(p.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            p.kill()
    state.inject_process = None
    state.inject_desc = ""
    return {"status": "stopped"}

@app.get("/api/inject/status")
async def inject_status():
    running = bool(state.inject_process and state.inject_process.returncode is None)
    return {"running": running, "description": state.inject_desc if running else ""}
```

NOTE implémenteur : réutiliser les helpers EXISTANTS du replay pour `_mission_log_path` et le parsing de log en liste `ID#DATA` ; s'ils ont d'autres noms, adapter l'appel et le noter dans le rapport. `tempfile`, `os`, `re`, `Path`, `BaseModel`, `HTTPException` sont déjà importés (vérifier).

Dans `backend/permissions.py` : ajouter `^/api/inject` à l'ensemble des routes exigeant `can_inject` (suivre le motif des routes `can/send`, `replay`, etc.).

- [ ] **Step 4: Run** `cd backend && python -m pytest -q`, expect PASS.

- [ ] **Step 5: Commit** `feat(inject): sous-systeme injection de fond (frame loop + keep-alive log) + chokepoint AUD-06`

---

### Task 3: Client API + bandeau de statut (frontend)

**Files:**
- Modify: `lib/api.ts`
- Create: `components/inject-status.tsx`

**Interfaces:**
- Consumes: endpoints Task 2.
- Produces : `InjectStatus {running:boolean; description:string}` ; `startInjectFrame(iface,canId,data,intervalMs?)`, `startInjectLog(iface,missionId,logId,intervalMs?)`, `stopInject()`, `getInjectStatus()` ; composant `<InjectStatusBar />`.

- [ ] **Step 1: Client API** dans `lib/api.ts` (suivre le style `fetchApi` existant) :

```typescript
export interface InjectStatus { running: boolean; description: string }

export async function startInjectFrame(iface: CANInterface, canId: string, data: string, intervalMs = 100) {
  return fetchApi(`/inject/start`, { method: "POST", body: JSON.stringify({ interface: iface, mode: "frame", canId, data, intervalMs }) })
}
export async function startInjectLog(iface: CANInterface, missionId: string, logId: string, intervalMs = 100) {
  return fetchApi(`/inject/start`, { method: "POST", body: JSON.stringify({ interface: iface, mode: "log", missionId, logId, intervalMs }) })
}
export async function stopInject() {
  return fetchApi(`/inject/stop`, { method: "POST" })
}
export async function getInjectStatus(): Promise<InjectStatus> {
  return fetchApi(`/inject/status`)
}
```

(Vérifier le préfixe réel — si `fetchApi` ajoute déjà `/api`, garder `/inject/...`.)

- [ ] **Step 2: Composant** `components/inject-status.tsx` : `"use client"`, poll `getInjectStatus()` toutes ~1 s via `setInterval` (cleanup au démontage), n'affiche rien si `!running`, sinon une barre d'alerte « Injection de fond : {description} » + bouton Stop qui appelle `stopInject()` puis re-poll. Props `className?`. Utiliser les composants shadcn déjà présents (Alert/Button) + une icône lucide (`Radio`/`Square`).

- [ ] **Step 3: Vérifier** `npm run build` + `npx tsc --noEmit` (compter avant/après).

- [ ] **Step 4: Commit** `feat(inject): client API + bandeau de statut injection de fond`

---

### Task 4: Comparaison — bits, badge, bandeau candidat, rejeu en boucle

**Files:**
- Modify: `lib/api.ts` (type `ByteChangeDetail` + `changed_bits`), `app/comparaison/page.tsx`

**Interfaces:**
- Consumes: `CompareFrameDiff.byte_change_detail[].changed_bits` (Task 1), `startInjectFrame` + `<InjectStatusBar/>` (Task 3), `command_score`, `payload_b`, `bytes_changed`.

- [ ] **Step 1:** dans `lib/api.ts`, au type `ByteChangeDetail`, ajouter `changed_bits?: number[]`.

- [ ] **Step 2:** `app/comparaison/page.tsx`, détail `byte_change_detail` (~871) : après `hex_diff`, si `bd.changed_bits?.length`, afficher `bit{n}` pour chaque (ex `bit2`). Calculer, par trame, le total de bits changeants (somme des `changed_bits.length`) ; si `=== 1`, afficher un badge « bit unique » sur la ligne.

- [ ] **Step 3:** Bandeau « Commande candidate » en tête du résultat (vue détail), choisissant la trame au plus fort `command_score` (si >0) : montrer `can_id`, les octets/bits changeants, `payload_b`, + bouton « Rejouer en boucle » → `startInjectFrame(selectedInterface, frame.can_id, frame.payload_b)`. `selectedInterface` : réutiliser l'interface déjà utilisée par la page pour `handleSendToReplay` / le store (sinon défaut `"can0"`).

- [ ] **Step 4:** Par ligne, à côté de « Envoyer vers Replay », bouton « Rejouer en boucle » → `startInjectFrame(iface, frame.can_id, frame.payload_b)`. Rendre `<InjectStatusBar className="mb-4" />` en haut de la vue résultat pour Stop/statut. Boutons en `flex flex-wrap gap-2`.

- [ ] **Step 5:** Vérifier `npm run build` + `npx tsc --noEmit` (pas de nouvelle erreur). Commit `feat(comparaison): diff au bit, badge bit unique, bandeau commande candidate, rejeu en boucle`.

---

### Task 5: Capture & Replay — keep-alive log + bandeau

**Files:**
- Modify: `app/capture-replay/page.tsx`

**Interfaces:**
- Consumes: `startInjectLog` + `<InjectStatusBar/>` (Task 3).

- [ ] **Step 1:** Pour chaque log listé (là où se trouvent les actions Rejouer/Supprimer), ajouter une action « Rejeu de fond (keep-alive) » → `startInjectLog(selectedInterface, missionId, log.id)`. Réutiliser l'interface et le `missionId` déjà employés par la page pour le replay.

- [ ] **Step 2:** Rendre `<InjectStatusBar className="mb-4" />` en haut de la page (Stop/statut partagé). Boutons d'action du log en `flex flex-wrap gap-2` (responsive).

- [ ] **Step 3:** Vérifier `npm run build` + `npx tsc --noEmit`. Commit `feat(capture-replay): keep-alive (rejeu de fond d'un log) + bandeau injection`.

---

## Self-Review

- Couverture spec : A=Task1+Task4(affichage) ; B=Task2(frame)+Task4(bouton) ; C=Task2(log)+Task5 ; D=Task4(bandeau). ✅
- Chokepoint AUD-06 : `_injectable_or_block` appelé dans `/inject/start` (Task 2), testé. ✅
- Types cohérents : `changed_bits` produit en Task 1, typé en Task 4 ; fonctions inject produites en Task 3, consommées en Task 4/5. ✅
- Placeholders : helpers de log du replay à confirmer par l'implémenteur (noté explicitement). ⚠️ seul point ouvert, volontaire.
